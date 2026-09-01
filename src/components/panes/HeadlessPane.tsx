// The headless pane view (swarm Phase C5).
//
// A headless worker is a piped stdio process: no TUI, no cursor, nothing to
// type at. Its pane's xterm buffer holds the raw stream-json it prints, which is
// the right thing to KEEP (loggable, dumpable, greppable) and the wrong thing to
// SHOW. This component renders the same bytes as a transcript — one row per
// assistant message, tool call, tool result, turn boundary and error — over the
// live terminal, which stays mounted underneath.
//
// The whole reason it exists: PixelMarch's current design is debuggable because
// a human can watch a pane and see exactly what the agent sees. Phase C is a
// reliability win that would have been a usability regression without this, so
// the two escape hatches below are load-bearing, not decoration:
//
//   Raw stream — reveal the terminal underneath, unmodified. Every byte the
//     agent printed, in the pane's own buffer, still logged and still dumpable.
//   Take over  — relaunch this pane as an INTERACTIVE CLI resuming the same
//     session id. The headless process is killed and the human gets the normal
//     TUI, mid-conversation. From that moment the pane is a TUI pane and every
//     control-path branch takes the TUI path for it, because `isStreamPane` is
//     false — there is no "half taken over" state to reason about.
import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { Pane } from "../../lib/layout-tree";
import { streamPane } from "../../lib/agentStream";
import {
  dropTranscript, takeoverCommand, transcriptStartedAt, useTranscript,
  type EntryKind, type TranscriptEntry, type Usage,
} from "./agentTranscript";

const KIND_COLOR: Record<EntryKind, string> = {
  session: "#4c8bf5",
  assistant: "#d8d8d8",
  thinking: "#8a7fbf",
  tool: "#e0a44c",
  "tool-result": "#5fbf6a",
  turn: "#4c8bf5",
  error: "#e06c6c",
};

/** Height of the pane's control bar. The terminal underneath is inset by exactly
 *  this much (TabGroupFrame), so "raw stream" shows the whole buffer instead of
 *  hiding its top line behind the bar. */
export const BAR_H = 26;

const bar: CSSProperties = {
  display: "flex", alignItems: "center", gap: 8, padding: "0 8px", height: BAR_H, minHeight: BAR_H,
  background: "var(--panel-2)", borderBottom: "1px solid var(--border)", fontSize: 11, color: "var(--muted)",
  userSelect: "none",
};

const btn: CSSProperties = {
  background: "transparent", border: "1px solid var(--border)", color: "var(--muted)",
  borderRadius: 4, cursor: "pointer", fontSize: 11, padding: "1px 7px", lineHeight: 1.6,
};

const fmt = (n: number): string =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`;

/** Token accounting as one line. Cache reads are shown separately from fresh
 *  input because they are the difference between a swarm that is affordable and
 *  one that is not, and Phase C is the first time the number is even available. */
export function usageLine(u: Usage): string {
  if (!u.turns && !u.output) return "no turns yet";
  const parts = [`${u.turns} turn${u.turns === 1 ? "" : "s"}`, `in ${fmt(u.input)}`, `out ${fmt(u.output)}`];
  if (u.cacheRead) parts.push(`cache ${fmt(u.cacheRead)}`);
  if (u.costUsd) parts.push(`$${u.costUsd.toFixed(3)}`);
  return parts.join(" · ");
}

/** How much of this pane's run its transcript can possibly contain.
 *
 *  "complete"  — capture started before the pane opened, so nothing is missing.
 *  "partial"   — it started AFTER; what came earlier is in the xterm buffer only.
 *  "unknown"   — no capture or no open time yet, so there is nothing it could
 *                have missed and nothing to claim either way.
 *
 *  Capture normally starts when the pane is SPAWNED (agentTranscript's stream-pane
 *  watcher), which is the complete case and the case in the product. The partial
 *  case is real all the same: a pane already registered when the watcher started
 *  is adopted by the shared listener mid-run. The empty state used to say "no
 *  stream events yet … the agent prints nothing until it has read a message",
 *  which for such a pane was a confident, false statement about an agent that had
 *  been working for an hour. */
export function coverage(startedAt: number, openAt: number): "complete" | "partial" | "unknown" {
  if (!openAt || !startedAt) return "unknown";
  return startedAt > openAt ? "partial" : "complete";
}

const since = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${(s / 3600).toFixed(1)}h`;
};

function Row({ e }: { e: TranscriptEntry }) {
  const color = KIND_COLOR[e.kind];
  const failed = e.ok === false;
  return (
    <div style={{ display: "flex", gap: 8, padding: "3px 8px", borderLeft: `2px solid ${failed ? KIND_COLOR.error : color}` }}>
      <span style={{ color: failed ? KIND_COLOR.error : color, fontSize: 11, minWidth: 88, flex: "0 0 auto", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }} title={e.title}>
        {e.title}
      </span>
      {e.body && (
        <span style={{ color: "var(--text)", fontSize: 11.5, whiteSpace: "pre-wrap", wordBreak: "break-word", flex: 1, opacity: e.kind === "thinking" ? 0.7 : 1 }}>
          {e.body}
        </span>
      )}
    </div>
  );
}

export interface HeadlessPaneProps {
  pane: Pane;
  /** Show the terminal underneath instead of the transcript. */
  raw: boolean;
  onToggleRaw: () => void;
  /** Relaunch this pane interactively with `cmd`, resuming the agent's session.
   *  The parent owns it because it also owns the terminal slot that has to be
   *  rebuilt with the new command line. */
  onTakeover: (cmd: string) => void;
}

export default function HeadlessPane({ pane, raw, onToggleRaw, onTakeover }: HeadlessPaneProps) {
  const t = useTranscript(pane.id);
  const scroller = useRef<HTMLDivElement | null>(null);
  const stick = useRef(true);
  const [confirming, setConfirming] = useState(false);

  // Follow the tail, but only while the human is AT the tail — scrolling up to
  // read something must not be yanked back by the next tool call.
  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [t.version, raw]);

  const s = streamPane(pane.id);
  const mid = s ? s.promptAt > s.turnEndAt : false;
  const sessionId = t.sessionId || s?.sessionId || "";
  const startedAt = transcriptStartedAt(pane.id);
  const cover = coverage(startedAt, s?.openAt ?? 0);
  const missed = startedAt - (s?.openAt ?? 0);

  const takeover = () => {
    const cmd = takeoverCommand(pane.startupCommand ?? "", sessionId);
    setConfirming(false);
    dropTranscript(pane.id); // the headless process is about to be killed
    onTakeover(cmd);
  };

  return (
    <div
      style={{
        position: "absolute", inset: 0, display: "flex", flexDirection: "column",
        // In raw mode only the bar is drawn, so the terminal underneath shows
        // through — the same element, the same bytes, nothing re-rendered.
        // Clicking through to it (scroll, select, copy) is safe on purpose:
        // typed and pasted bytes dead-end at terminalPool's isStreamPane guard
        // instead of reaching the piped stdin, so the buffer stays readable
        // without the protocol being writable.
        pointerEvents: raw ? "none" : "auto",
      }}
    >
      <div style={{ ...bar, pointerEvents: "auto" }}>
        <span style={{ color: mid ? "#e0a44c" : "#5fbf6a" }} title={mid ? "a turn is in flight" : "idle — the last turn ended"}>
          ●
        </span>
        <span style={{ color: "var(--text)" }}>{pane.role || pane.title}</span>
        <span title={sessionId ? `session ${sessionId}` : "the CLI has not announced a session yet"}>
          {sessionId ? sessionId.slice(0, 8) : "no session"}
        </span>
        <span title="tokens and cost, from the agent's own turn results">{usageLine(t.usage)}</span>
        {s && s.errors > 0 && (
          <span style={{ color: KIND_COLOR.error }} title={s.errorText}>
            {s.errors} error{s.errors === 1 ? "" : "s"}
          </span>
        )}
        <span style={{ flex: 1 }} />
        {t.dropped > 0 && !raw && (
          <span title={`${t.dropped} older rows dropped — the raw stream still has them`}>+{t.dropped} older</span>
        )}
        {cover === "partial" && !raw && (
          <span style={{ color: "#e0a44c" }}
            title={`This pane was already running when its transcript started (${since(missed)} of the run happened first). Everything before that is in the pane's own buffer — "raw stream" shows it.`}>
            partial
          </span>
        )}
        <button style={{ ...btn, color: raw ? "#4c8bf5" : "var(--muted)" }} onClick={onToggleRaw}
          title="Show the underlying terminal buffer — the raw stream-json this pane printed">
          {raw ? "transcript" : "raw stream"}
        </button>
        {confirming ? (
          <>
            <span style={{ color: "#e0a44c" }}>kill the headless process and reopen interactively?</span>
            <button style={{ ...btn, color: "#e06c6c", borderColor: "#e06c6c" }} onClick={takeover}>take over</button>
            <button style={btn} onClick={() => setConfirming(false)}>cancel</button>
          </>
        ) : (
          <button style={btn} onClick={() => setConfirming(true)}
            title={sessionId
              ? "Relaunch this pane as an interactive CLI resuming this session — you drive it from here on"
              : "Relaunch this pane as an interactive CLI. No session was announced yet, so it starts a fresh context."}>
            take over ⌨
          </button>
        )}
      </div>
      {!raw && (
        <div ref={scroller}
          onScroll={(e) => {
            const el = e.currentTarget;
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
          }}
          style={{ flex: 1, minHeight: 0, overflowY: "auto", background: "var(--bg)", fontFamily: "inherit" }}>
          {t.entries.length === 0 ? (
            <div style={{ padding: 10, fontSize: 11.5, color: "var(--muted)" }}>
              {cover === "partial" ? (
                <>
                  Nothing since this transcript started {since(Date.now() - startedAt)} ago. This pane had
                  already been running for {since(missed)} by then, so what it printed earlier is NOT here —
                  it is in the pane's own buffer. “raw stream” shows all of it.
                </>
              ) : (
                <>
                  No stream events yet. A headless agent prints nothing until it has read a message — the
                  transcript fills in as soon as it has work. “raw stream” shows the pane's bytes meanwhile.
                </>
              )}
            </div>
          ) : (
            t.entries.map((e) => <Row key={e.seq} e={e} />)
          )}
        </div>
      )}
    </div>
  );
}
