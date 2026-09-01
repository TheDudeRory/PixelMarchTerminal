// Headless (piped-stdio) panes: the human-facing transcript (swarm Phase C5).
//
// A headless pane has no TUI. Its stdout is line-delimited stream-json, and the
// pane's xterm buffer therefore contains raw JSON objects — correct, loggable,
// and unreadable. This module turns that same stream into STRUCTURED transcript
// entries (assistant text, tool calls, tool results, turn boundaries, errors,
// token accounting) so a human watching a headless worker sees what the agent is
// doing rather than what it is serialising.
//
// WHY THIS IS A SECOND READER OF THE STREAM, AND NOT A HOOK INTO agentStream.ts:
// agentStream.ts is the CONTROL path — it answers "is the turn over", and its
// events are consumed by the dispatcher, the reset watcher and the runaway
// watcher. It deliberately classifies coarsely (`output`, `other`) and keeps no
// history, because a control path that also owned a UI buffer would have a
// memory profile decided by the renderer. The transcript needs the opposite:
// full content, bounded history, no control authority at all. So this module
// parses the pane's bytes independently and CANNOT affect the control path even
// if it throws — a broken transcript must never wedge a swarm.
//
// COST: one extra `pty://data` listener for the whole app (not one per pane —
// see the O(N^2) note in terminalPool.ts), attached when the FIRST headless pane
// is spawned and never per-pane. Non-headless panes are rejected by a Map lookup
// before anything is decoded, so a swarm of TUI panes pays a `Map.has` per frame
// and nothing else.
//
// CAPTURE STARTS AT SPAWN, NOT AT FIRST VIEW (startTranscriptCapture, wired in
// App.tsx). A view-triggered attach made the transcript lie: a pane opened an
// hour into a run showed nothing under copy that reads as "the agent has done
// nothing", while its whole run sat in the pane's own buffer. It is also what
// lets the swarm grid show a headless worker as prose instead of stream-json.
// The other edge matters as much: a record is dropped when the pane stops being
// a stream pane (closed, restarted, taken over), because MAX_ENTRIES rows plus a
// decoder per pane, kept for the life of the app, is a leak.
import { useSyncExternalStore } from "react";
import { onPtyData } from "../../lib/ipc";
import { isStreamPane, parseStreamLine, watchStreamPanes, type StreamEvent } from "../../lib/agentStream";

/** What one transcript row IS. Coarse on purpose — this is a reading surface,
 *  not a debugger; the raw stream is one button away for anything finer. */
export type EntryKind =
  | "session"     // the CLI announced a session (system/init)
  | "assistant"   // model prose
  | "thinking"    // extended-thinking block
  | "tool"        // a tool call the agent made
  | "tool-result" // what came back
  | "turn"        // turn boundary (`result`), success or failure
  | "error";      // stderr from the child, a rate limit, an unparseable line

export interface TranscriptEntry {
  seq: number;
  at: number;
  kind: EntryKind;
  /** Always present, always one line — the row's heading. */
  title: string;
  /** Optional detail, already truncated. */
  body?: string;
  /** Success flag for the kinds that have one (tool-result, turn). */
  ok?: boolean;
}

/** Token/cost accounting, accumulated from the stream's own numbers. THE point
 *  of Phase C's structured events: today this is regex-scraped out of scrollback
 *  or not known at all. */
export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  turns: number;
  costUsd: number;
}

const zeroUsage = (): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0, costUsd: 0 });

export interface Transcript {
  entries: TranscriptEntry[];
  usage: Usage;
  /** Session id from the last `system/init` — what a takeover resumes. */
  sessionId: string;
  /** Entries evicted by the ring cap, so the view can say "showing the last N"
   *  instead of pretending it has the whole run. */
  dropped: number;
  version: number;
}

// A long agent run produces thousands of rows; a pane view that keeps them all
// is a memory leak with a scrollbar. Old rows are dropped and COUNTED (the view
// renders the count) — the pane's xterm buffer still holds the raw truth, and
// the agent's own transcript on disk holds all of it.
const MAX_ENTRIES = 500;
/** No single row may be a wall of text. The raw stream has the full value. */
const MAX_BODY = 1200;

interface PaneState extends Transcript {
  seq: number;
  buf: string;
  /** Our OWN decoder: terminalPool's runs with `stream: true` and carries
   *  partial multi-byte state, so sharing one across two readers corrupts
   *  whichever decodes second. Two independent decoders over the same byte
   *  sequence are each correct. */
  decoder: TextDecoder;
  /** Open tool calls by id, so a tool_result can name the tool it answers. */
  toolNames: Map<string, string>;
  /** Output tokens counted from assistant frames since the last turn boundary,
   *  so the live figure can be corrected to the turn's authoritative one. */
  turnOutput: number;
}

const panes = new Map<string, PaneState>();
const listeners = new Map<string, Set<() => void>>();
let unlisten: Promise<() => void> | null = null;

/** When this pane's transcript STARTED being captured, which is not always when
 *  the pane started running. Capture normally begins at register (spawn), i.e.
 *  before the pane can print anything — but a pane that was already registered
 *  when the watcher started is adopted mid-run by the shared pty://data listener,
 *  and everything it printed earlier exists only in its own buffer. The view has
 *  to be able to say which of the two it is looking at. */
const capturedAt = new Map<string, number>();

function state(paneId: string): PaneState {
  let s = panes.get(paneId);
  if (!s) {
    s = {
      entries: [], usage: zeroUsage(), sessionId: "", dropped: 0, version: 0,
      seq: 0, buf: "", decoder: new TextDecoder(), toolNames: new Map(), turnOutput: 0,
    };
    panes.set(paneId, s);
  }
  return s;
}

// ---- content mapping (pure) ------------------------------------------------

const text = (v: unknown): string => (typeof v === "string" ? v : "");
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

const clip = (s: string, max = MAX_BODY): string =>
  s.length > max ? `${s.slice(0, max)}… (+${s.length - max} chars)` : s;

/** A tool call in one line. The named cases are the tools an agent actually
 *  spends its turns in — seeing `Bash: cargo test` beats seeing `Bash {…}`,
 *  which is the entire difference between a transcript and a hex dump. */
export function summarizeToolInput(name: string, input: Record<string, unknown>): string {
  const first = (...keys: string[]) => {
    for (const k of keys) if (text(input[k])) return text(input[k]);
    return "";
  };
  switch (name) {
    case "Bash": return first("command");
    case "Read": case "Write": case "NotebookEdit": return first("file_path", "notebook_path");
    case "Edit": return `${first("file_path")}${text(input.old_string) ? ` — ${clip(text(input.old_string), 80)}` : ""}`;
    case "Grep": return `${first("pattern")}${text(input.path) ? ` in ${text(input.path)}` : ""}`;
    case "Glob": return first("pattern");
    case "WebFetch": case "WebSearch": return first("url", "query");
    case "Task": case "Agent": return first("description", "prompt");
    case "TodoWrite": return `${arr(input.todos).length} items`;
    default: {
      const summary = first("command", "file_path", "pattern", "query", "url", "description");
      return summary || clip(JSON.stringify(input ?? {}), 200);
    }
  }
}

/** Content blocks of one assistant/user message, as transcript rows.
 *  `toolNames` is read AND written: a tool_use records its id so the matching
 *  tool_result can be labelled with the tool's name rather than an opaque id. */
function messageRows(role: "assistant" | "user", raw: Record<string, unknown>, toolNames: Map<string, string>): Omit<TranscriptEntry, "seq" | "at">[] {
  const msg = obj(raw.message);
  const rows: Omit<TranscriptEntry, "seq" | "at">[] = [];
  // A string content (some CLIs, and the frame we write ourselves) is just text.
  if (typeof msg.content === "string") {
    // Both roles render as prose. A user string used to take the "tool-result"
    // kind, i.e. the green "something came back ok" colour, for a message that
    // is neither — cosmetic only while claude does not echo prompts back, and
    // wrong the moment one does.
    if (msg.content.trim()) rows.push({ kind: "assistant", title: role, body: clip(msg.content) });
    return rows;
  }
  for (const b of arr(msg.content)) {
    const block = obj(b);
    const type = text(block.type);
    if (type === "text" && text(block.text).trim()) {
      rows.push({ kind: "assistant", title: "assistant", body: clip(text(block.text)) });
    } else if (type === "thinking" && text(block.thinking).trim()) {
      rows.push({ kind: "thinking", title: "thinking", body: clip(text(block.thinking)) });
    } else if (type === "tool_use") {
      const name = text(block.name) || "tool";
      const id = text(block.id);
      if (id) toolNames.set(id, name);
      rows.push({ kind: "tool", title: name, body: clip(summarizeToolInput(name, obj(block.input)), 400) });
    } else if (type === "tool_result") {
      const id = text(block.tool_use_id);
      const name = (id && toolNames.get(id)) || "tool";
      if (id) toolNames.delete(id);
      const isErr = block.is_error === true;
      const content = typeof block.content === "string"
        ? block.content
        : arr(block.content).map((c) => text(obj(c).text)).filter(Boolean).join("\n");
      rows.push({ kind: "tool-result", title: `${name} ${isErr ? "failed" : "ok"}`, body: clip(content, 600), ok: !isErr });
    }
  }
  return rows;
}

const shortId = (id: string) => (id.length > 8 ? id.slice(0, 8) : id);

/** Everything one stream event contributes: rows to append, usage to add, and a
 *  session id if it announced one. PURE — the store below is the only mutable
 *  part, which is what makes the mapping testable without a pane. */
export function eventRows(ev: StreamEvent, toolNames: Map<string, string>): {
  rows: Omit<TranscriptEntry, "seq" | "at">[];
  usage: Partial<Usage>;
  sessionId?: string;
  /** Output tokens this frame reported, for the LIVE counter (see the
   *  reconciliation in feedTranscript — the per-message numbers are a running
   *  estimate, the turn result is the truth). */
  liveOutput?: number;
  /** This event ended a turn: `usage.output` is authoritative for it. */
  turnBoundary?: boolean;
} {
  const raw = ev.raw;
  if (ev.kind === "error") {
    // An unparseable line has no type at all — that is itself the finding, and
    // the reason it is shown instead of dropped (agentStream.parseStreamLine).
    const title = ev.type === "result" ? "turn failed" : ev.type || "unparseable output";
    const rows: Omit<TranscriptEntry, "seq" | "at">[] = [{ kind: "error", title, body: clip(ev.text ?? "") }];
    // A FAILED result is still a turn boundary — the same reasoning agentStream
    // applies to the control path: miss it and the accounting never closes.
    if (ev.type === "result") return { rows, usage: resultUsage(raw), turnBoundary: true };
    return { rows, usage: {} };
  }
  if (ev.kind === "session-ready") {
    const model = text(raw.model);
    const tools = arr(raw.tools).length;
    return {
      rows: [{
        kind: "session",
        title: `session ${shortId(ev.sessionId ?? "")}${model ? ` · ${model}` : ""}${tools ? ` · ${tools} tools` : ""}`,
        body: text(raw.cwd),
      }],
      usage: {},
      sessionId: ev.sessionId ?? "",
    };
  }
  if (ev.kind === "turn-end") {
    const ms = num(raw.duration_ms);
    const cost = num(raw.total_cost_usd);
    const parts = [ev.subtype || "success"];
    if (ms) parts.push(`${(ms / 1000).toFixed(1)}s`);
    if (cost) parts.push(`$${cost.toFixed(4)}`);
    return {
      rows: [{ kind: "turn", title: `turn ended · ${parts.join(" · ")}`, ok: true }],
      usage: resultUsage(raw),
      turnBoundary: true,
    };
  }
  if (ev.kind === "output" && (ev.type === "assistant" || ev.type === "user")) {
    const rows = messageRows(ev.type, raw, toolNames);
    return { rows, usage: {}, liveOutput: num(obj(obj(raw.message).usage).output_tokens) };
  }
  return { rows: [], usage: {} };
}

/** End-of-turn usage — the authoritative numbers for the turn as a whole.
 *  VERIFIED against a real claude 2.1.218 turn: the per-assistant-message
 *  `output_tokens` summed to 61 while the turn's own result said 94, so the
 *  message numbers are a live estimate and this is the truth (feedTranscript
 *  reconciles the two at every boundary). The input side is taken ONLY from
 *  here for the same reason in reverse — every assistant frame re-reports the
 *  whole context, so summing those would multiply it by the frame count. */
function resultUsage(raw: Record<string, unknown>): Partial<Usage> {
  const u = obj(raw.usage);
  return {
    input: num(u.input_tokens),
    // LEFT UNDEFINED when the frame has no number, so the reconciliation in
    // feedTranscript can tell "the turn reported 0 output" from "the turn
    // reported nothing". Coercing to 0 made a usage-less result erase the live
    // estimate for that turn.
    output: typeof u.output_tokens === "number" && Number.isFinite(u.output_tokens) ? u.output_tokens : undefined,
    cacheRead: num(u.cache_read_input_tokens),
    cacheWrite: num(u.cache_creation_input_tokens),
    turns: 1,
    costUsd: num(raw.total_cost_usd),
  };
}

function addUsage(into: Usage, add: Partial<Usage>): void {
  into.input += add.input ?? 0;
  into.output += add.output ?? 0;
  into.cacheRead += add.cacheRead ?? 0;
  into.cacheWrite += add.cacheWrite ?? 0;
  into.turns += add.turns ?? 0;
  into.costUsd += add.costUsd ?? 0;
}

// ---- store -----------------------------------------------------------------

/** Feed one decoded chunk of a headless pane's stdout to its transcript.
 *  Exported for tests and for the listener below; chunks are NOT line-aligned,
 *  so the tail is buffered exactly as agentStream does. */
export function feedTranscript(paneId: string, chunk: string, now = Date.now()): TranscriptEntry[] {
  const s = state(paneId);
  // First bytes for a pane nobody announced: the capture adopted it mid-run.
  if (!capturedAt.has(paneId)) capturedAt.set(paneId, now);
  s.buf += chunk;
  const lines = s.buf.split("\n");
  s.buf = lines.pop() ?? "";
  // A single line that never terminates would grow forever. The control path
  // has the same guard for the same reason; here the row is simply dropped.
  if (s.buf.length > 1 << 20) s.buf = "";
  const added: TranscriptEntry[] = [];
  // The token counters move on frames that produce no ROW at all (an assistant
  // frame whose only content is usage, a result object). Notifying on rows alone
  // left the header's figure frozen until the next thing the agent said.
  let usageMoved = false;
  for (const line of lines) {
    const ev = parseStreamLine(line);
    if (!ev) continue;
    const { rows, usage, sessionId, liveOutput, turnBoundary } = eventRows(ev, s.toolNames);
    if (sessionId !== undefined) s.sessionId = sessionId;
    if (liveOutput) {
      // Live estimate, so the counter moves while the turn is still running.
      s.turnOutput += liveOutput;
      s.usage.output += liveOutput;
      usageMoved = true;
    }
    if (turnBoundary) {
      // Correct the estimate to what the turn itself reported, in either
      // direction, then start the next turn's estimate from zero. ONLY when the
      // result actually carried a number: `output` is undefined for a result
      // frame with no usage (a failed turn, an older CLI), and treating that as
      // 0 subtracted the whole turn's live estimate back out — the counter went
      // BACKWARDS in front of the human watching it.
      if (usage.output !== undefined) s.usage.output += usage.output - s.turnOutput;
      s.turnOutput = 0;
      usageMoved = true;
    }
    addUsage(s.usage, { ...usage, output: 0 });
    if (usage.input || usage.cacheRead || usage.cacheWrite || usage.costUsd) usageMoved = true;
    for (const r of rows) {
      const entry: TranscriptEntry = { ...r, seq: ++s.seq, at: now };
      s.entries.push(entry);
      added.push(entry);
    }
  }
  if (s.entries.length > MAX_ENTRIES) {
    const gone = s.entries.length - MAX_ENTRIES;
    s.entries.splice(0, gone);
    s.dropped += gone;
  }
  if (added.length || usageMoved) {
    s.version++;
    notify(paneId);
  }
  return added;
}

/** The pane's transcript. Never null — an unknown pane reads as empty, which is
 *  what a just-opened view legitimately is.
 *
 *  READ-ONLY: it must NOT create the record, or `dropTranscript` is not a delete
 *  — the next `getSnapshot` from a still-mounted view would put an empty record
 *  straight back and the pane would leak one anyway. Only `feedTranscript`, i.e.
 *  bytes actually arriving from a live pane, creates state. The empty value is a
 *  frozen singleton so React sees a stable identity for a pane with no rows. */
const EMPTY_TRANSCRIPT: Transcript = Object.freeze({
  entries: Object.freeze([]) as unknown as TranscriptEntry[],
  usage: Object.freeze(zeroUsage()) as Usage,
  sessionId: "", dropped: 0, version: 0,
});

export function transcriptOf(paneId: string): Transcript {
  return panes.get(paneId) ?? EMPTY_TRANSCRIPT;
}

/** Forget a pane's transcript. Called when the pane stops being a stream pane at
 *  all: taken over, closed, or restarted (a restart is a new process and a new
 *  session, so its old rows describe a conversation that no longer exists). Up
 *  to MAX_ENTRIES rows plus a decoder per pane, so leaving them behind is a real
 *  leak on a long-lived window. */
export function dropTranscript(paneId: string): void {
  panes.delete(paneId);
  capturedAt.delete(paneId);
  notify(paneId);
}

/** When capture started for this pane, or 0 if it has none. Compared against the
 *  pane's own openAt by the view: equal-or-earlier means the transcript can show
 *  the whole run, later means the first part of it is in the buffer only. */
export function transcriptStartedAt(paneId: string): number {
  return capturedAt.get(paneId) ?? 0;
}

/** The transcript as a plain-text tail, newest last — what a SUMMARY surface
 *  (the swarm grid) should show for a headless pane instead of its raw
 *  scrollback. The pane's buffer holds stream-json; tailing that puts serialised
 *  JSON on the one screen a human watches a whole swarm on. Empty when the pane
 *  has no rows, so the caller can fall back to the raw tail rather than show a
 *  blank card. */
export function transcriptTail(paneId: string, lines: number): string {
  const t = panes.get(paneId);
  if (!t || t.entries.length === 0) return "";
  return t.entries
    .slice(-lines)
    .map((e) => {
      // One line per row: a card is ~6 lines tall, so a row's body is a hint,
      // not its content. The pane view has the full text.
      const body = e.body ? e.body.replace(/\s+/g, " ").trim() : "";
      return body ? `${e.title}: ${body.slice(0, 160)}` : e.title;
    })
    .join("\n");
}

/** Drop everything (tests). */
export function resetTranscripts(): void {
  panes.clear();
  capturedAt.clear();
}

// Re-render batching: a busy agent emits many rows per second and one React
// re-render per row is how a "cheap log view" becomes the reason the GUI stutters.
const NOTIFY_MS = 100;
const pendingNotify = new Set<string>();
let notifyTimer: ReturnType<typeof setTimeout> | null = null;

function notify(paneId: string): void {
  pendingNotify.add(paneId);
  if (notifyTimer) return;
  notifyTimer = setTimeout(() => {
    notifyTimer = null;
    const ids = [...pendingNotify];
    pendingNotify.clear();
    for (const id of ids) for (const cb of listeners.get(id) ?? []) cb();
  }, NOTIFY_MS);
}

/** Follow headless panes for as long as the app runs: capture a pane's stream
 *  from the moment it is SPAWNED, and forget it when it stops being one.
 *
 *  Attaching on first view (what this used to do) meant a pane opened an hour
 *  into a run showed an empty transcript under copy that reads as "the agent has
 *  done nothing" — the opposite of the truth, with the whole run sitting in the
 *  pane's own buffer. It also meant the swarm grid had nothing to show for a
 *  headless worker but raw JSON.
 *
 *  Still lazy in the sense that matters: the watcher is a Set entry, and the
 *  pty://data listener is attached only when the FIRST stream pane appears, so a
 *  session that never runs a headless agent pays nothing. Idempotent; the
 *  returned function is for tests. */
export function startTranscriptCapture(): () => void {
  return watchStreamPanes((paneId, phase) => {
    if (phase === "register") {
      // A restart re-registers the same id: drop the dead session's rows rather
      // than let the new process append to them.
      dropTranscript(paneId);
      // Capture starts HERE, before the process can print anything — which is
      // what lets the view say the transcript is complete rather than guess.
      capturedAt.set(paneId, Date.now());
      ensureTranscriptListener();
    } else {
      dropTranscript(paneId);
    }
  });
}

/** Attach the single shared pty://data listener, once for the whole app. */
export function ensureTranscriptListener(): void {
  if (unlisten) return;
  unlisten = onPtyData((p) => {
    // The control path decides what a headless pane is; this only ever reads
    // that answer, so the two can never disagree about which panes are streams.
    if (!isStreamPane(p.id)) return;
    const s = state(p.id);
    try {
      feedTranscript(p.id, s.decoder.decode(b64ToBytes(p.data), { stream: true }));
    } catch {
      /* a malformed frame must not take the listener down with it */
    }
  });
}

// terminalPool has its own copy of this; duplicating six lines is better than
// exporting a decoder helper out of the control path for a UI module to reach in.
function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function subscribe(paneId: string, cb: () => void): () => void {
  ensureTranscriptListener();
  let set = listeners.get(paneId);
  if (!set) listeners.set(paneId, (set = new Set()));
  set.add(cb);
  return () => {
    set!.delete(cb);
    if (set!.size === 0) listeners.delete(paneId);
  };
}

/** React binding. Returns the live transcript, re-rendering at most every
 *  NOTIFY_MS while the agent is producing. */
export function useTranscript(paneId: string): Transcript {
  useSyncExternalStore(
    (cb) => subscribe(paneId, cb),
    () => transcriptOf(paneId).version,
    () => 0,
  );
  return transcriptOf(paneId);
}

// ---- the escape hatch ------------------------------------------------------

/** The command line that takes a headless pane over INTERACTIVELY: the same CLI,
 *  same flags, minus the ones that make it a stream process, plus `--resume` so
 *  the human lands in the conversation the agent was having rather than a blank
 *  one.
 *
 *  Removal is by regex on the string rather than by splitting into arguments on
 *  purpose: the command line can carry a QUOTED path with spaces (--settings on
 *  Windows, see decision-config-delivery), and a naive split would corrupt it.
 *  `(?=\s|$)` and not `\b` so `--print-x` is never read as `--print`.
 *
 *  An empty sessionId (the CLI never announced one — it emits `system/init`
 *  only after reading its first message) yields a plain interactive session:
 *  a fresh context, which is honest, rather than `--resume ""`, which fails. */
export function takeoverCommand(startupCommand: string, sessionId: string): string {
  const stripped = startupCommand
    .replace(/\s--(?:output|input)-format(?:\s+|=)\S+/g, "")
    .replace(/\s(?:-p|--print|--verbose|--include-hook-events)(?=\s|$)/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  return sessionId ? `${stripped} --resume ${sessionId}` : stripped;
}
