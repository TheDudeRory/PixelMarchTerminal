import { beforeEach, describe, expect, it } from "vitest";
import {
  DIAG_TYPE, feedStreamOutput, isStreamPane, lastStreamError, notePromptSent, paneReady,
  paneTurnActive, paneTurnSince, parseStreamLine, registerStreamPane, resetStreamPanes,
  streamPane, unregisterStreamPane, userMessageFrame,
} from "./agentStream";
import { lastTurnEndAt, lastPromptAcceptedAt, resetAgentEvents, turnActive } from "./agentEvents";

const P = "proj";
const ROLE = "builder-1";
const PANE = "pane-1";

// Real objects, copied verbatim from a live `claude` 2.1.218 run of
// `-p --verbose --input-format stream-json --output-format stream-json`.
// Trimmed of payload the control path does not read, never reshaped.
const INIT = `{"type":"system","subtype":"init","cwd":"/tmp","session_id":"d82dae12-5a39-4000-9507-10bc082bbf76","model":"claude-opus-4-8","tools":["Bash"]}`;
const HOOK_START = `{"type":"system","subtype":"hook_started","hook_name":"SessionStart:startup","hook_event":"SessionStart","session_id":"d82dae12"}`;
const ASSISTANT = `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"OK"}]},"session_id":"d82dae12"}`;
const RESULT = `{"is_error":false,"num_turns":1,"stop_reason":"end_turn","session_id":"d82dae12","subtype":"success","result":"OK","type":"result","duration_ms":2404}`;
const RESULT_ERR = `{"is_error":true,"subtype":"error_during_execution","session_id":"d82dae12","type":"result","api_error_status":"529"}`;
const RATE_OK = `{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1784793000}}`;
const RATE_BAD = `{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":1784793000}}`;

beforeEach(() => {
  resetStreamPanes();
  resetAgentEvents();
});

describe("parsing a headless CLI's event stream", () => {
  it("classifies the objects a real session emits", () => {
    expect(parseStreamLine(INIT)).toMatchObject({ kind: "session-ready", type: "system", sessionId: "d82dae12-5a39-4000-9507-10bc082bbf76" });
    expect(parseStreamLine(RESULT)).toMatchObject({ kind: "turn-end", type: "result" });
    expect(parseStreamLine(ASSISTANT)).toMatchObject({ kind: "output", type: "assistant" });
    expect(parseStreamLine("")).toBeNull();
    expect(parseStreamLine("   \n")).toBeNull();
  });

  it("does NOT read a hook object as a turn boundary", () => {
    // hook_started/hook_response are `type:"system"` too, and a SessionStart hook
    // fires BEFORE the turn while a PreToolUse hook fires in the middle of one.
    // Treating either as a boundary would report the turn over while the agent
    // is still working — the exact false-idle bug this whole phase exists to kill.
    expect(parseStreamLine(HOOK_START)).toMatchObject({ kind: "other" });
  });

  it("treats a failed result and a wrapped stderr line as error episodes", () => {
    expect(parseStreamLine(RESULT_ERR)).toMatchObject({ kind: "error", type: "result" });
    expect(parseStreamLine(`{"type":"${DIAG_TYPE}","text":"error: unknown option --nope"}`))
      .toMatchObject({ kind: "error", text: "error: unknown option --nope" });
    expect(parseStreamLine(RATE_BAD)).toMatchObject({ kind: "error" });
    expect(parseStreamLine(RATE_OK)).toMatchObject({ kind: "other" });
  });

  it("reports a non-JSON line instead of swallowing it", () => {
    // Every line in a headless pane is supposed to be JSON (the host wraps even
    // stderr), so raw text means something bypassed that — which is exactly the
    // output that explains a pane producing nothing.
    expect(parseStreamLine("Segmentation fault")).toMatchObject({ kind: "error", text: "Segmentation fault" });
    expect(parseStreamLine("[1,2,3]")).toMatchObject({ kind: "error" }); // JSON, but not an object
  });

  it("never lets an unknown object move a boundary", () => {
    expect(parseStreamLine(`{"type":"something_new_in_2_2","payload":{}}`)).toMatchObject({ kind: "other" });
  });
});

describe("a pane's turn state", () => {
  it("is undefined until something is known, then exact", () => {
    registerStreamPane(PANE, P, ROLE);
    expect(isStreamPane(PANE)).toBe(true);
    expect(paneTurnActive(PANE)).toBeUndefined(); // nothing sent, nothing seen
    expect(paneReady(PANE)).toBe(false);

    feedStreamOutput(PANE, `${INIT}\n`, 1000);
    expect(paneReady(PANE)).toBe(true);
    expect(streamPane(PANE)?.sessionId).toBe("d82dae12-5a39-4000-9507-10bc082bbf76");

    notePromptSent(PANE, 2000);
    expect(paneTurnActive(PANE)).toBe(true);
    expect(paneTurnSince(PANE)).toBe(2000);

    feedStreamOutput(PANE, `${ASSISTANT}\n`, 2500);
    expect(paneTurnActive(PANE)).toBe(true); // output is not a boundary
    feedStreamOutput(PANE, `${RESULT}\n`, 3000);
    expect(paneTurnActive(PANE)).toBe(false);
    expect(paneTurnSince(PANE)).toBe(0);
  });

  it("ends the turn on a FAILED result too", () => {
    // A turn that errored is still over. Missing it would leave the role stuck
    // mid-turn forever and nothing would ever prompt the pane again.
    registerStreamPane(PANE, P, ROLE);
    notePromptSent(PANE, 1000);
    feedStreamOutput(PANE, `${RESULT_ERR}\n`, 2000);
    expect(paneTurnActive(PANE)).toBe(false);
    expect(lastStreamError(PANE)).toMatchObject({ at: 2000, count: 1 });
  });

  it("waits for the newline before classifying a split object", () => {
    // Data frames are coalesced on a ~16 ms window, so they cut objects in half.
    registerStreamPane(PANE, P, ROLE);
    notePromptSent(PANE, 1000);
    const half = RESULT.slice(0, 40);
    expect(feedStreamOutput(PANE, half, 2000)).toEqual([]);
    expect(paneTurnActive(PANE)).toBe(true); // NOT ended by half an object
    const evs = feedStreamOutput(PANE, `${RESULT.slice(40)}\n`, 2100);
    expect(evs.map((e) => e.kind)).toEqual(["turn-end"]);
    expect(paneTurnActive(PANE)).toBe(false);
  });

  it("handles several objects arriving in one frame", () => {
    registerStreamPane(PANE, P, ROLE);
    const evs = feedStreamOutput(PANE, `${INIT}\n${ASSISTANT}\n${RESULT}\n`, 1000);
    expect(evs.map((e) => e.kind)).toEqual(["session-ready", "output", "turn-end"]);
  });

  it("ignores output for a pane it does not track", () => {
    expect(feedStreamOutput("who", `${RESULT}\n`)).toEqual([]);
    expect(isStreamPane("who")).toBe(false);
    unregisterStreamPane(PANE); // no-op, must not throw
  });
});

describe("the bridge into the Phase A per-role store", () => {
  it("answers turnActive/lastTurnEndAt/lastPromptAcceptedAt for a headless role", () => {
    // The point of the bridge: every existing watcher keeps calling exactly
    // these three, with no idea the answer came from a stream this time.
    registerStreamPane(PANE, P, ROLE, 500);
    feedStreamOutput(PANE, `${INIT}\n`, 1000);
    notePromptSent(PANE, 2000);
    expect(turnActive(P, ROLE)).toBe(true);
    expect(lastPromptAcceptedAt(P, ROLE)).toBe(2000);

    feedStreamOutput(PANE, `${RESULT}\n`, 3000);
    expect(turnActive(P, ROLE)).toBe(false);
    expect(lastTurnEndAt(P, ROLE)).toBe(3000);
  });

  it("does not let a late-arriving stale event move a boundary backwards", () => {
    // A headless pane fires its lifecycle hooks as well, and the brain poller is
    // on a 1 s timer — so a hook event can be ingested AFTER a stream event that
    // happened later. A turn-end older than the prompt reads as "still mid-turn"
    // forever, which wedges the pane.
    registerStreamPane(PANE, P, ROLE, 1);
    notePromptSent(PANE, 5000);
    feedStreamOutput(PANE, `${RESULT}\n`, 6000);
    feedStreamOutput(PANE, `${RESULT}\n`, 1000); // stale
    expect(lastTurnEndAt(P, ROLE)).toBe(6000);
    expect(turnActive(P, ROLE)).toBe(false);
  });

  it("clears a stale mid-turn role when the pane is respawned", () => {
    // A context reset for a headless pane IS a restart, and it happens while the
    // role's last recorded state is "prompt sent, never ended".
    registerStreamPane(PANE, P, ROLE, 1);
    notePromptSent(PANE, 1000);
    expect(turnActive(P, ROLE)).toBe(true);
    registerStreamPane(PANE, P, ROLE, 2000); // respawn
    expect(turnActive(P, ROLE)).toBe(false);
    expect(paneTurnActive(PANE)).toBeUndefined(); // and the pane starts blank
  });
});

describe("what a prompt becomes on the wire", () => {
  it("is one newline-terminated stream-json user message", () => {
    const frame = userMessageFrame("do the thing");
    expect(frame.endsWith("\n")).toBe(true);
    expect(JSON.parse(frame)).toEqual({ type: "user", message: { role: "user", content: "do the thing" } });
  });

  it("survives text that would break a hand-built line", () => {
    // No quoting rules, no injectable-ASCII restriction: it is JSON.
    const frame = userMessageFrame(`a "quote", a \\ and a\nnewline`);
    expect(frame.split("\n")).toHaveLength(2); // the payload newline is escaped
    expect(JSON.parse(frame).message.content).toBe(`a "quote", a \\ and a\nnewline`);
  });
});
