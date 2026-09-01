// Headless (piped-stdio) panes: the agent's own event stream (swarm Phase C2).
//
// A headless pane is not a terminal. The CLI runs with
// `-p --verbose --input-format stream-json --output-format stream-json`, so its
// stdout is line-delimited JSON and its stdin takes JSON messages — no ANSI, no
// TUI, nothing to type at. The Rust side (Phase C1) spawns it with `mode:
// "piped"` and feeds those bytes down the SAME `pty://data` pipeline a PTY pane
// uses, so this module is a PARSER over the pane's existing byte stream, not a
// second subscription.
//
// What it is for: a headless pane's turn boundary is an OBJECT IN THE STREAM
// (`{"type":"result",...}`), not "the pane stopped printing for 3 seconds". So
// the events parsed here are folded into the same per-role store the Phase A
// lifecycle hooks write to (agentEvents.recordAgentEvent) and every consumer of
// `turnActive` / `lastTurnEndAt` / `lastPromptAcceptedAt` keeps working
// UNMODIFIED — it just gets an exact answer instead of a guessed one.
//
// EVENT SHAPES ARE VERIFIED, NOT ASSUMED. Every `type` classified below was read
// off a real `claude` 2.1.218 run (a live one-turn stream-json session), because
// a wrong "the turn ended" is worse than no signal at all: it types the next
// prompt into a live turn. An unrecognised object is `other` and moves nothing.
import { recordAgentEvent } from "./agentEvents";

/** What one stream object means to the control path. Deliberately coarse: this
 *  module answers "is the turn over / did something break", not "what did the
 *  agent say" (that is the transcript renderer's job, Phase C5). */
export type StreamEventKind =
  | "session-ready" // the CLI announced a session — AFTER it read its first message
  | "turn-end" // the turn is over — EXACT, not a quiet timer
  | "output" // assistant/user content
  | "error" // the CLI, or our own stderr wrapper, reported a failure
  | "other"; // parsed fine, means nothing to the control path

export interface StreamEvent {
  kind: StreamEventKind;
  /** The object's own `type`, kept verbatim for the transcript UI and for logs. */
  type: string;
  subtype?: string;
  sessionId?: string;
  /** Human-readable detail for an `error` (the stderr line, the failure text). */
  text?: string;
  raw: Record<string, unknown>;
}

/** The `type` the host wraps a piped child's stderr lines in (host.rs DIAG_TYPE).
 *  Keeps every line in a headless pane parseable JSON instead of splicing raw
 *  text mid-stream — and these are exactly the lines that explain a pane which
 *  produced nothing (bad flag, auth failure). */
export const DIAG_TYPE = "pixelmarch_stderr";

/** A single line that never terminates would otherwise grow the buffer forever.
 *  1 MiB is far above any real stream object and far below a memory problem. */
const MAX_LINE = 1 << 20;

/** Parse ONE line of a headless pane's stdout.
 *  `null` for a blank line. A line that is not JSON is NOT dropped: the whole
 *  point of the host's stderr wrapper is that everything arrives parseable, so
 *  raw text means something bypassed it — reported as an error episode rather
 *  than silently eaten, which is how a broken pane looks like a hung one. */
export function parseStreamLine(line: string): StreamEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let raw: Record<string, unknown>;
  try {
    const v: unknown = JSON.parse(trimmed);
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("not an object");
    raw = v as Record<string, unknown>;
  } catch {
    return { kind: "error", type: "", text: trimmed.slice(0, 2000), raw: {} };
  }
  const type = typeof raw.type === "string" ? raw.type : "";
  const subtype = typeof raw.subtype === "string" ? raw.subtype : undefined;
  const sessionId = typeof raw.session_id === "string" ? raw.session_id : undefined;
  const base = { type, subtype, sessionId, raw };

  // The host's stderr wrapper — a CLI diagnostic, i.e. an error episode.
  if (type === DIAG_TYPE) {
    const text = typeof raw.text === "string" ? raw.text : "";
    return { ...base, kind: "error", text };
  }
  // TURN END. `{"type":"result", ...}` is emitted once per turn, carries
  // `is_error` / `subtype` and is the only exact boundary in the stream.
  if (type === "result") {
    const failed = raw.is_error === true || (subtype !== undefined && subtype !== "success");
    return { ...base, kind: failed ? "error" : "turn-end", text: failed ? resultText(raw) : undefined };
  }
  if (type === "system") {
    // `init` is the CLI announcing it is up (session id, tools, model). The
    // hook_started/hook_response objects are ALSO `system` and are NOT turn
    // boundaries — a SessionStart hook fires before the turn, a PreToolUse hook
    // fires in the middle of one.
    if (subtype === "init") return { ...base, kind: "session-ready" };
    return { ...base, kind: "other" };
  }
  if (type === "assistant" || type === "user") return { ...base, kind: "output" };
  // Rate-limit notices: `allowed` is routine bookkeeping, anything else is the
  // pane about to stop working and is worth surfacing.
  if (type === "rate_limit_event") {
    const info = (raw.rate_limit_info ?? {}) as Record<string, unknown>;
    const status = typeof info.status === "string" ? info.status : "";
    return status && status !== "allowed"
      ? { ...base, kind: "error", text: `rate limit: ${status}` }
      : { ...base, kind: "other" };
  }
  return { ...base, kind: "other" };
}

function resultText(raw: Record<string, unknown>): string {
  const parts = [
    typeof raw.subtype === "string" ? raw.subtype : "",
    typeof raw.api_error_status === "string" ? raw.api_error_status : "",
    typeof raw.result === "string" ? raw.result : "",
  ].filter(Boolean);
  return parts.join(": ").slice(0, 2000) || "turn failed";
}

/** Everything known about one headless pane. Times are `Date.now()` ms, 0 = never. */
export interface PaneStream {
  project: string;
  role: string;
  /** Session id from the CLI's `init` object — changes on every restart, which
   *  is what a headless context reset IS (see swarmReset). */
  sessionId: string;
  /** When the HOST confirmed the pane's session (pty_open resolved), i.e. when
   *  there is something on the far end of a write. Not the same as `readyAt`. */
  openAt: number;
  readyAt: number;
  promptAt: number;
  turnEndAt: number;
  errorAt: number;
  errorText: string;
  /** Error episodes seen since the pane came up — a health-strip number. */
  errors: number;
  /** Incomplete tail of the last chunk (a Data frame is not line-aligned). */
  buf: string;
}

const panes = new Map<string, PaneStream>();

/** Notified when a pane starts or stops being a stream pane. The transcript UI
 *  needs BOTH edges and must not learn either from a view: attaching on first
 *  view means a pane opened an hour into a run shows an empty transcript, and
 *  dropping only on takeover means a closed pane's rows live for the life of the
 *  app. Watchers run after the registry has been updated, so `isStreamPane`
 *  inside one already reads the new answer, and a throwing watcher is swallowed
 *  — a UI listener must never wedge a spawn or a dispose. */
type StreamPaneWatcher = (paneId: string, phase: "register" | "unregister") => void;
const streamWatchers = new Set<StreamPaneWatcher>();

export function watchStreamPanes(cb: StreamPaneWatcher): () => void {
  streamWatchers.add(cb);
  return () => { streamWatchers.delete(cb); };
}

function notifyStreamWatchers(paneId: string, phase: "register" | "unregister"): void {
  for (const cb of streamWatchers) {
    try { cb(paneId, phase); } catch { /* never let the UI take the control path down */ }
  }
}

const blank = (project: string, role: string): PaneStream => ({
  project, role, sessionId: "", openAt: 0, readyAt: 0, promptAt: 0, turnEndAt: 0,
  errorAt: 0, errorText: "", errors: 0, buf: "",
});

/** Start tracking a pane spawned in piped mode. Called from the ONE place that
 *  opens a pane (terminalPool.ensureSession), so "is this pane headless?" has a
 *  single answer that cannot disagree with how it was actually spawned. */
export function registerStreamPane(paneId: string, project: string, role: string, now = Date.now()): void {
  panes.set(paneId, blank(project, role));
  // A pane is (re)spawned with no turn in flight — and a RESTART is how a
  // headless pane gets a fresh context (swarmReset), so the role's last state
  // was very likely "mid-turn". The per-pane state above starts blank, but the
  // per-role store is shared with the hook channel and would keep that stale
  // "prompt sent, never ended" forever, which reads as a permanently busy role
  // and no watcher would ever prompt it again.
  if (project && role) recordAgentEvent(project, role, "turn-end", now);
  notifyStreamWatchers(paneId, "register");
}

/** Pane closed (or restarted — the caller re-registers). */
export function unregisterStreamPane(paneId: string): void {
  const had = panes.delete(paneId);
  if (had) notifyStreamWatchers(paneId, "unregister");
}

/** Is this pane driven by a JSON stream rather than by a terminal? THE predicate
 *  every control-path branch asks: a stream pane is written to with a message
 *  object, a TUI pane with keystrokes, and sending either one the other way is
 *  silently ignored by the far end. */
export function isStreamPane(paneId: string): boolean {
  return panes.has(paneId);
}

export function streamPane(paneId: string): PaneStream | undefined {
  return panes.get(paneId);
}

/** The host has this pane's session open — pty_open resolved, so a write has
 *  somewhere to go. THIS is the gate on writing to a headless pane, and it is
 *  deliberately not `paneReady`: VERIFIED on claude 2.1.218, the CLI emits its
 *  `system/init` object only AFTER it has read a first message, so waiting for
 *  "the agent is ready" before sending one waits forever. Writing early is safe
 *  and is how the CLI is meant to be driven — the bytes wait in the pipe (64 KiB
 *  of room) until it starts reading. Writing before the session exists is NOT:
 *  the host has no writer for an unknown id and drops the bytes silently. */
export function paneOpen(paneId: string): boolean {
  return (panes.get(paneId)?.openAt ?? 0) > 0;
}

/** The host confirmed the pane's session. Called from the one place that opens a
 *  pane, right after `pty_open` returns. */
export function markStreamPaneOpen(paneId: string, now = Date.now()): void {
  const s = panes.get(paneId);
  if (s) s.openAt = now;
}

/** Has the CLI announced a session (`system/init`)? An OBSERVATION, not a gate:
 *  it arrives only after the CLI has read its first message. Useful to confirm a
 *  context reset really produced a new session, and for the transcript UI. */
export function paneReady(paneId: string): boolean {
  return (panes.get(paneId)?.readyAt ?? 0) > 0;
}

/** Wait until a (re)spawned headless pane has a session on the host again.
 *  `restartTerminal` tears the old one down and opens a new one asynchronously,
 *  and a write in that window is dropped by the host with no error to see.
 *  False on timeout — the caller's write then fails loudly instead of vanishing. */
export async function waitForStreamPane(paneId: string, capMs: number, pollMs = 400): Promise<boolean> {
  const start = Date.now();
  for (;;) {
    if (paneOpen(paneId)) return true;
    if (Date.now() - start >= capMs) return false;
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

/** Is this pane mid-turn? `undefined` = no signal yet (nothing sent, nothing
 *  seen), matching agentEvents' contract — the caller falls back rather than
 *  guessing. */
export function paneTurnActive(paneId: string): boolean | undefined {
  const s = panes.get(paneId);
  if (!s || (!s.promptAt && !s.turnEndAt)) return undefined;
  return s.promptAt > s.turnEndAt;
}

/** When the current turn started, or 0 when the pane is not mid-turn. Feeds the
 *  headless runaway watcher, which measures a turn instead of comparing tails. */
export function paneTurnSince(paneId: string): number {
  return paneTurnActive(paneId) === true ? panes.get(paneId)!.promptAt : 0;
}

/** Is the pane SITTING at an error right now — the stream-pane analogue of "the
 *  API error is still on screen"? True when the last thing that decided the
 *  pane's fate was an error: a failed `result` stamps errorAt and turnEndAt with
 *  the same instant (>= keeps that case in), and only a LATER successful
 *  turn-end moves turnEndAt past it — which is exactly what "the error scrolled
 *  away" means for a pane with no screen. The nudge watcher reads this instead
 *  of grepping the raw JSON buffer with a TUI-shaped regex. */
export function streamErrorActive(paneId: string): boolean {
  const s = panes.get(paneId);
  if (!s || !s.errorAt) return false;
  return s.errorAt >= s.turnEndAt;
}

/** The pane's last error episode, or undefined. */
export function lastStreamError(paneId: string): { at: number; text: string; count: number } | undefined {
  const s = panes.get(paneId);
  if (!s || !s.errorAt) return undefined;
  return { at: s.errorAt, text: s.errorText, count: s.errors };
}

/** Drop everything (a test, or the app tearing a swarm down). */
export function resetStreamPanes(): void {
  panes.clear();
}

/** The exact bytes a prompt becomes for a headless pane: one stream-json user
 *  message, newline-terminated. No CR dance, no 300 ms pause, no rescue Enter —
 *  those exist because a TUI input box can swallow a line, and a JSON reader
 *  cannot. Exported so the injection path and its tests agree on one spelling. */
export function userMessageFrame(text: string): string {
  return `${JSON.stringify({ type: "user", message: { role: "user", content: text } })}\n`;
}

/** Record that a prompt was WRITTEN to this pane. The stream has no "I accepted
 *  your message" object, so the send itself is the prompt-submitted boundary —
 *  and it is only recorded after the write actually succeeded (see
 *  swarmReset.injectPrompt), never before. */
export function notePromptSent(paneId: string, at = Date.now()): void {
  const s = panes.get(paneId);
  if (!s) return;
  s.promptAt = at;
  recordAgentEvent(s.project, s.role, "prompt-submitted", at);
}

/** Feed one chunk of a headless pane's stdout. Chunks are NOT line-aligned (the
 *  host coalesces on a ~16 ms window), so the tail is buffered until its newline
 *  arrives — a half-parsed object must never be classified. Returns the events
 *  it completed, for the transcript renderer and for tests. */
export function feedStreamOutput(paneId: string, chunk: string, now = Date.now()): StreamEvent[] {
  const s = panes.get(paneId);
  if (!s) return [];
  const out: StreamEvent[] = [];
  s.buf += chunk;
  // A line this long is not a stream object — some other process is writing to
  // the pane. Drop the buffer (as an error episode) rather than grow forever.
  if (s.buf.length > MAX_LINE && !s.buf.includes("\n")) {
    const ev: StreamEvent = { kind: "error", type: "", text: "unterminated line over 1 MiB — buffer dropped", raw: {} };
    s.buf = "";
    out.push(ev);
    apply(s, ev, now);
    return out;
  }
  const lines = s.buf.split("\n");
  s.buf = lines.pop() ?? ""; // trailing fragment (or "" when the chunk ended clean)
  for (const line of lines) {
    const ev = parseStreamLine(line);
    if (!ev) continue;
    out.push(ev);
    apply(s, ev, now);
  }
  return out;
}

function apply(s: PaneStream, ev: StreamEvent, now: number): void {
  if (ev.kind === "session-ready") {
    s.readyAt = now;
    s.sessionId = ev.sessionId ?? "";
    recordAgentEvent(s.project, s.role, "session-start", now);
    return;
  }
  if (ev.kind === "turn-end") {
    s.turnEndAt = now;
    recordAgentEvent(s.project, s.role, "turn-end", now);
    return;
  }
  if (ev.kind === "error") {
    s.errorAt = now;
    s.errorText = ev.text ?? "";
    s.errors++;
    recordAgentEvent(s.project, s.role, "notification", now);
    // A FAILED `result` is still the end of the turn. Missing that would leave
    // the role stuck "mid-turn" forever and no further prompt would ever be
    // sent to it — the pane would be wedged by an error it survived.
    if (ev.type === "result") {
      s.turnEndAt = now;
      recordAgentEvent(s.project, s.role, "turn-end", now);
    }
  }
}
