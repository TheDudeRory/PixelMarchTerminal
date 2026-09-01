import { beforeEach, describe, expect, it, vi } from "vitest";

// No jsdom in this repo, and importing the module pulls React + ipc + the
// control-path stream module. Only `atob` and the two Tauri entry points are
// actually needed to exercise the mapping below.
vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.resolve(null) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => undefined) }));

const {
  eventRows, feedTranscript, resetTranscripts, summarizeToolInput, takeoverCommand, transcriptOf,
} = await import("./agentTranscript");
const { parseStreamLine } = await import("../../lib/agentStream");

const PANE = "pane-1";

// Shapes copied from a real `claude` 2.1.218 stream-json run — the mapping is
// only worth anything if it is keyed off what the CLI actually prints.
const INIT = JSON.stringify({ type: "system", subtype: "init", session_id: "abc12345-6789", model: "claude-opus-4-8", tools: ["Bash", "Read"], cwd: "/repo" });
const ASSISTANT_TEXT = JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "on it" }], usage: { input_tokens: 900, output_tokens: 40 } } });
const ASSISTANT_TOOL = JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "cargo test" } }], usage: { output_tokens: 12 } } });
const TOOL_RESULT = JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "259 passed" }] } });
const TOOL_FAILED = JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", is_error: true, content: "exit 1" }] } });
const RESULT = JSON.stringify({ type: "result", subtype: "success", is_error: false, duration_ms: 4200, total_cost_usd: 0.0123, usage: { input_tokens: 1000, output_tokens: 52, cache_read_input_tokens: 20000 } });
const STDERR = JSON.stringify({ type: "pixelmarch_stderr", text: "error: unknown flag --nope" });

const rowsOf = (line: string, names = new Map<string, string>()) =>
  eventRows(parseStreamLine(line)!, names).rows;

beforeEach(() => resetTranscripts());

describe("eventRows", () => {
  it("turns a session announcement into one readable header row", () => {
    const [row] = rowsOf(INIT);
    expect(row.kind).toBe("session");
    expect(row.title).toContain("abc12345");
    expect(row.title).toContain("claude-opus-4-8");
    expect(row.title).toContain("2 tools");
  });

  it("shows a tool call as name + what it is actually doing", () => {
    const [row] = rowsOf(ASSISTANT_TOOL);
    expect(row.kind).toBe("tool");
    expect(row.title).toBe("Bash");
    expect(row.body).toBe("cargo test");
  });

  // The whole point of a structured transcript: a failed tool is a FLAG, not a
  // string somebody has to notice in scrollback.
  it("marks a failed tool result and names the tool it answers", () => {
    const names = new Map<string, string>();
    rowsOf(ASSISTANT_TOOL, names);
    const [row] = rowsOf(TOOL_FAILED, names);
    expect(row.kind).toBe("tool-result");
    expect(row.ok).toBe(false);
    expect(row.title).toBe("Bash failed");
  });

  it("carries the tool name across the call/result pair", () => {
    const names = new Map<string, string>();
    rowsOf(ASSISTANT_TOOL, names);
    const [row] = rowsOf(TOOL_RESULT, names);
    expect(row.title).toBe("Bash ok");
    expect(row.ok).toBe(true);
  });

  it("reports the child's stderr as an error row rather than dropping it", () => {
    const [row] = rowsOf(STDERR);
    expect(row.kind).toBe("error");
    expect(row.body).toContain("--nope");
  });

  // A line that is not JSON means something bypassed the host's stderr wrapper.
  // Silently eating it is how a broken pane looks like a hung one.
  it("keeps an unparseable line visible", () => {
    const [row] = rowsOf("total garbage");
    expect(row.kind).toBe("error");
    expect(row.title).toBe("unparseable output");
    expect(row.body).toBe("total garbage");
  });

  it("renders a turn boundary with its duration and cost", () => {
    const [row] = rowsOf(RESULT);
    expect(row.kind).toBe("turn");
    expect(row.ok).toBe(true);
    expect(row.title).toContain("4.2s");
    expect(row.title).toContain("$0.0123");
  });
});

describe("summarizeToolInput", () => {
  it("picks the field that says what the call does", () => {
    expect(summarizeToolInput("Bash", { command: "ls -la", timeout: 5 })).toBe("ls -la");
    expect(summarizeToolInput("Read", { file_path: "/a/b.ts" })).toBe("/a/b.ts");
    expect(summarizeToolInput("Grep", { pattern: "TODO", path: "src" })).toBe("TODO in src");
  });

  it("falls back to the raw input for a tool it has never seen", () => {
    expect(summarizeToolInput("mcp__brain__note_set", { key: "plan" })).toBe(`{"key":"plan"}`);
  });
});

describe("feedTranscript", () => {
  it("accumulates rows and token accounting across a whole turn", () => {
    feedTranscript(PANE, `${INIT}\n${ASSISTANT_TEXT}\n${ASSISTANT_TOOL}\n${TOOL_RESULT}\n${RESULT}\n`, 1000);
    const t = transcriptOf(PANE);
    expect(t.entries.map((e) => e.kind)).toEqual(["session", "assistant", "tool", "tool-result", "turn"]);
    expect(t.sessionId).toBe("abc12345-6789");
    expect(t.usage.turns).toBe(1);
    expect(t.usage.input).toBe(1000);
    expect(t.usage.cacheRead).toBe(20000);
    // Output is summed per assistant message (40 + 12); input is taken ONLY from
    // the turn result, because every assistant frame re-reports the whole
    // context and summing it would multiply it by the frame count.
    expect(t.usage.output).toBe(52);
  });

  // The host coalesces PTY reads on a ~16 ms window, so a chunk boundary lands
  // mid-object routinely. Classifying half an object is worse than waiting.
  it("buffers a split line until its newline arrives", () => {
    expect(feedTranscript(PANE, RESULT.slice(0, 30), 1000)).toEqual([]);
    const added = feedTranscript(PANE, `${RESULT.slice(30)}\n`, 1100);
    expect(added).toHaveLength(1);
    expect(added[0].kind).toBe("turn");
  });

  it("bounds history and counts what it dropped", () => {
    const line = `${ASSISTANT_TEXT}\n`;
    feedTranscript(PANE, line.repeat(600), 1000);
    const t = transcriptOf(PANE);
    expect(t.entries).toHaveLength(500);
    expect(t.dropped).toBe(100);
    // The ring keeps the NEWEST rows: seq is monotonic, so the survivors are the tail.
    expect(t.entries[0].seq).toBe(101);
    expect(t.entries[499].seq).toBe(600);
  });

  // A result frame WITHOUT usage (a failed turn, an older CLI) used to subtract
  // the whole turn's live estimate back out, so the token counter went BACKWARDS
  // in front of the human watching it.
  it("keeps the live output estimate when a turn ends with no usage at all", () => {
    feedTranscript(PANE, `${ASSISTANT_TEXT}\n${ASSISTANT_TOOL}\n`, 1000); // 40 + 12 live
    expect(transcriptOf(PANE).usage.output).toBe(52);
    feedTranscript(PANE, `{"type":"result","subtype":"error_during_execution","is_error":true}\n`, 1100);
    expect(transcriptOf(PANE).usage.output).toBe(52);
    expect(transcriptOf(PANE).usage.turns).toBe(1);
  });

  // The counters move on frames that add no ROW. Notifying only on rows left the
  // header's token figure frozen until the agent next said something.
  it("bumps the version when only the accounting changed", () => {
    // An assistant frame carrying usage and no content: tokens move, no row.
    const usageOnly = JSON.stringify({ type: "assistant", message: { role: "assistant", content: [], usage: { output_tokens: 7 } } });
    feedTranscript(PANE, `${ASSISTANT_TEXT}\n`, 1000);
    const before = transcriptOf(PANE).version;
    const added = feedTranscript(PANE, `${usageOnly}\n`, 1100);
    expect(added).toEqual([]);
    expect(transcriptOf(PANE).usage.output).toBe(47);
    expect(transcriptOf(PANE).version).toBeGreaterThan(before);
  });

  // `dropTranscript` has to be a DELETE. transcriptOf used to insert a record for
  // any id it was asked about, so one more read from a still-mounted view put an
  // empty record straight back and a closed pane leaked one anyway.
  it("does not re-create a record for a pane that was dropped", async () => {
    const { dropTranscript } = await import("./agentTranscript");
    feedTranscript(PANE, `${ASSISTANT_TEXT}\n`, 1000);
    expect(transcriptOf(PANE).entries).toHaveLength(1);
    dropTranscript(PANE);
    expect(transcriptOf(PANE).entries).toHaveLength(0); // reading must not insert…
    dropTranscript(PANE);
    expect(transcriptOf(PANE).version).toBe(0);         // …and there is nothing left to drop
  });

  it("renders a headless pane's stream as a prose tail for the summary grid", async () => {
    const { transcriptTail } = await import("./agentTranscript");
    expect(transcriptTail(PANE, 4)).toBe(""); // no transcript yet — the caller falls back to raw
    feedTranscript(PANE, `${INIT}\n${ASSISTANT_TEXT}\n${ASSISTANT_TOOL}\n`, 1000);
    const tail = transcriptTail(PANE, 2);
    expect(tail.split("\n")).toHaveLength(2);
    expect(tail).toContain("cargo test"); // what the agent is DOING, not its JSON
    expect(tail).not.toContain("{");
  });

  it("never lets a transcript failure reach the control path", () => {
    // A frame with a type nobody maps must produce nothing, not throw.
    expect(() => feedTranscript(PANE, `{"type":"rate_limit_event","rate_limit_info":{"status":"allowed"}}\n`)).not.toThrow();
    expect(transcriptOf(PANE).entries).toHaveLength(0);
  });
});

// A REAL turn, captured verbatim from the installed binary and only trimmed of
// fields nothing reads:
//   printf '{"type":"user",…}' | claude -p --verbose --input-format stream-json \
//     --output-format stream-json --dangerously-skip-permissions
// The synthetic cases above prove the mapping is what it says it is; this one
// proves it is aimed at what the CLI actually prints. Both hook frames, the
// rate-limit notice and the `caller` field on a tool_use were all present and
// none of them was anticipated — the same class of surprise that shipped a dead
// swarm twice in this mission.
const REAL_TURN = [
  `{"type":"system","subtype":"hook_started","session_id":"fb31fd4b-646d-4d19-9a09-09272a9e1ae7","hook_id":"82da678d","hook_name":"SessionStart:startup"}`,
  `{"type":"system","subtype":"hook_response","session_id":"fb31fd4b-646d-4d19-9a09-09272a9e1ae7","hook_id":"82da678d","hook_name":"SessionStart:startup"}`,
  `{"type":"system","subtype":"init","cwd":"/tmp/scratch","session_id":"fb31fd4b-646d-4d19-9a09-09272a9e1ae7","tools":["Task","Bash","CronCreate"],"model":"claude-opus-4-8[1m]"}`,
  `{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_013uqp","name":"Bash","input":{"command":"echo hello-from-headless","description":"Echo test string"},"caller":{"type":"direct"}}],"usage":{"input_tokens":2,"output_tokens":60}}}`,
  `{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1784793000,"rateLimitType":"five_hour"},"session_id":"fb31fd4b"}`,
  `{"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_013uqp","type":"tool_result","content":"hello-from-headless","is_error":false}]}}`,
  `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"\`hello-from-headless\`. done."}],"usage":{"input_tokens":2,"output_tokens":1}}}`,
  `{"type":"result","subtype":"success","is_error":false,"duration_ms":3479,"total_cost_usd":0.116468,"usage":{"input_tokens":4,"output_tokens":94,"cache_read_input_tokens":39556,"cache_creation_input_tokens":9432},"num_turns":2}`,
].join("\n") + "\n";

describe("a real claude 2.1.218 turn", () => {
  it("renders as the turn a human would describe", () => {
    feedTranscript(PANE, REAL_TURN, 1000);
    const t = transcriptOf(PANE);
    // The two hook frames and the rate-limit notice contribute NO rows: they are
    // bookkeeping, and a transcript that shows them buries the three lines that
    // matter. (SessionStart hooks are also NOT turn boundaries — mapping them as
    // one is the exact false-idle bug Phase A exists to kill.)
    expect(t.entries.map((e) => `${e.kind}:${e.title}`)).toEqual([
      "session:session fb31fd4b · claude-opus-4-8[1m] · 3 tools",
      "tool:Bash",
      "tool-result:Bash ok",
      "assistant:assistant",
      "turn:turn ended · success · 3.5s · $0.1165",
    ]);
    expect(t.entries[1].body).toBe("echo hello-from-headless");
    expect(t.entries[3].body).toBe("`hello-from-headless`. done.");
    expect(t.sessionId).toBe("fb31fd4b-646d-4d19-9a09-09272a9e1ae7");
  });

  // The live counter ran to 61 (60 + 1) while the turn's own result said 94.
  // Reporting the estimate would understate every headless agent's output by a
  // third; reporting only at the boundary would leave the counter at zero for
  // the whole turn. So it runs live and is corrected at the boundary.
  it("reconciles the live token estimate to the turn's authoritative number", () => {
    feedTranscript(PANE, REAL_TURN.slice(0, REAL_TURN.lastIndexOf("\n", REAL_TURN.length - 2) + 1), 1000);
    expect(transcriptOf(PANE).usage.output).toBe(61); // live estimate, mid-turn
    feedTranscript(PANE, REAL_TURN.slice(REAL_TURN.lastIndexOf("\n", REAL_TURN.length - 2) + 1), 1100);
    const u = transcriptOf(PANE).usage;
    expect(u.output).toBe(94); // corrected by the result
    expect(u.input).toBe(4);
    expect(u.cacheRead).toBe(39556);
    expect(u.cacheWrite).toBe(9432);
    expect(u.costUsd).toBeCloseTo(0.116468, 6);
    expect(u.turns).toBe(1);
  });
});

describe("takeoverCommand", () => {
  const HEADLESS = "claude --dangerously-skip-permissions --settings '/home/a b/hooks.json' -p --verbose --input-format stream-json --output-format stream-json";

  it("strips exactly the flags that make the process headless", () => {
    const cmd = takeoverCommand(HEADLESS, "sess-1");
    expect(cmd).toBe("claude --dangerously-skip-permissions --settings '/home/a b/hooks.json' --resume sess-1");
  });

  // The command line can carry a QUOTED path with spaces (--settings on
  // Windows), which is why removal is by pattern and not by argv splitting.
  it("leaves a quoted path with spaces intact", () => {
    expect(takeoverCommand(HEADLESS, "s")).toContain("'/home/a b/hooks.json'");
  });

  // `--print-x` is not `--print`. The control path makes the same distinction
  // (spawnModeFor matches whole arguments) and the two must agree or a pane
  // relaunches in a mode nobody chose.
  it("does not strip a flag that merely starts with one of them", () => {
    expect(takeoverCommand("claude --print-x --verbose", "")).toBe("claude --print-x");
  });

  // The CLI only announces a session after it has read its first message, so a
  // pane taken over before its first turn has no id. `--resume ""` would fail to
  // start; a fresh interactive session is the honest fallback.
  it("omits --resume when no session was announced", () => {
    expect(takeoverCommand(HEADLESS, "")).toBe("claude --dangerously-skip-permissions --settings '/home/a b/hooks.json'");
  });

  it("produces a command line the control path reads as a TUI pane", async () => {
    const { spawnModeFor } = await import("../../lib/swarm");
    expect(spawnModeFor(HEADLESS)).toBe("piped");
    expect(spawnModeFor(takeoverCommand(HEADLESS, "sess-1"))).toBe("pty");
  });
});
