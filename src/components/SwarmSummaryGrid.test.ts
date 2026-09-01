import { afterEach, describe, expect, it, vi } from "vitest";

// Same stub the other component tests use: importing the module pulls the layout
// store -> terminalPool -> xterm, which touches `self` at import time and dies
// under vitest's node environment (no jsdom in this repo). Nothing below renders.
const noop = () => undefined;

// Mutable pool state so the sampler-cost tests can make a pane "produce output"
// and count what that costs. `tails` counts every tailText call — the expensive
// read (translateToString over N buffer lines) the grid must stop making for
// panes that cannot have changed.
const pool = { bytes: new Map<string, number>(), lastOutput: new Map<string, number>(), tails: 0 };

vi.mock("../lib/terminalPool", () => ({
  droppedBytes: () => 0,
  isPaused: () => false,
  lastOutputAt: (id: string) => pool.lastOutput.get(id) ?? 0,
  outputBytes: (id: string) => pool.bytes.get(id) ?? 0,
  paneTier: () => "headless",
  poolStats: () => ({ panes: 0, full: 0, headless: 0, webgl: 0, droppedBytes: 0, truncatedHandoffs: 0 }),
  tailText: (id: string) => { pool.tails++; return `tail of ${id} @ ${pool.bytes.get(id) ?? 0}`; },
  setBroadcast: noop,
  setScrollbackLimit: noop,
  setLogging: noop,
  restartTerminal: noop,
  applyTerminalSettings: noop,
  markRestoredPanes: noop,
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.resolve(null) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => undefined) }));
vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ setZoom: () => Promise.resolve() }) }));

const { formatRate, formatBytes, pushSample, nextSpark, sparkPoints, gridColumns, visibleRange, truncationNote,
  sameCard, sameStats, sampleCards } = await import("./SwarmSummaryGrid");
// Real modules, not stubs: "is this pane headless" must be the control path's
// own answer here exactly as it is in the app, or the preview split could be
// green in a test and wrong in the product.
const { registerStreamPane, unregisterStreamPane } = await import("../lib/agentStream");
const { feedTranscript, resetTranscripts } = await import("./panes/agentTranscript");

describe("formatRate", () => {
  // A quiet agent must not read as a broken counter ("0.0 KB/s" looked like the
  // sampler had died).
  it("calls a silent pane idle", () => {
    expect(formatRate(0)).toBe("idle");
    expect(formatRate(0.4)).toBe("idle");
  });

  it("scales the unit with the rate", () => {
    expect(formatRate(500)).toBe("500 B/s");
    expect(formatRate(2048)).toBe("2.0 KB/s");
    expect(formatRate(5 * 1024 * 1024)).toBe("5.0 MB/s");
  });
});

describe("formatBytes", () => {
  it("keeps the dropped-bytes badge short", () => {
    expect(formatBytes(900)).toBe("900 B");
    expect(formatBytes(20 * 1024)).toBe("20 KB");
    expect(formatBytes(3 * 1024 * 1024)).toBe("3.0 MB");
  });
});

describe("pushSample", () => {
  // The grid can stay open for hours at 3.3 Hz; an unbounded history would be a
  // slow leak in the component whose whole job is to be cheap.
  it("caps the ring at max", () => {
    let h: number[] = [];
    for (let i = 0; i < 100; i++) h = pushSample(h, i, 5);
    expect(h).toEqual([95, 96, 97, 98, 99]);
  });

  it("does not mutate the array it was given", () => {
    const h = [1, 2];
    const next = pushSample(h, 3, 5);
    expect(h).toEqual([1, 2]);
    expect(next).toEqual([1, 2, 3]);
  });
});

describe("sparkPoints", () => {
  it("needs two samples before it draws anything", () => {
    expect(sparkPoints([], 60, 14)).toBe("");
    expect(sparkPoints([5], 60, 14)).toBe("");
  });

  // Per-card scaling: a flooding agent must not flatten every other card's
  // sparkline to a dead line.
  it("scales each history to its own peak", () => {
    expect(sparkPoints([0, 10], 60, 10)).toBe("0.0,10.0 60.0,0.0");
    expect(sparkPoints([0, 1000], 60, 10)).toBe("0.0,10.0 60.0,0.0");
  });

  it("spreads samples across the full width", () => {
    expect(sparkPoints([0, 0, 0], 60, 10)).toBe("0.0,10.0 30.0,10.0 60.0,10.0");
  });
});

describe("gridColumns", () => {
  it("never drops below one column", () => {
    expect(gridColumns(0)).toBe(1);
    expect(gridColumns(200)).toBe(1);
  });

  it("fits as many 300px cards as the width allows", () => {
    expect(gridColumns(640)).toBe(2);
    expect(gridColumns(1280)).toBe(4);
  });
});

describe("visibleRange", () => {
  // The point of virtualizing: a 40-agent swarm mounts the cards on screen, not
  // 40 of them.
  it("renders only the rows near the viewport", () => {
    const r = visibleRange(40, 4, 0, 400, 188, 1);
    expect(r.rows).toBe(10);
    expect(r.start).toBe(0);
    expect(r.end).toBeLessThan(40);
    expect(r.topPad).toBe(0);
    expect(r.bottomPad).toBeGreaterThan(0);
  });

  it("pads by the rows it skipped so the scrollbar stays honest", () => {
    const r = visibleRange(40, 4, 940, 400, 188, 0);
    expect(r.topPad).toBe(5 * 188);
    expect(r.topPad + r.bottomPad + (r.end - r.start) / 4 * 188).toBe(r.rows * 188);
  });

  it("clamps to the card count at the end of the list", () => {
    const r = visibleRange(6, 4, 10_000, 400);
    expect(r.end).toBe(6);
    expect(r.bottomPad).toBe(0);
  });

  it("survives a zero-height viewport (first paint, before measurement)", () => {
    const r = visibleRange(8, 1, 0, 0);
    expect(r.start).toBe(0);
    expect(r.end).toBeGreaterThan(0);
  });
});

describe("truncationNote", () => {
  // The rule from for-swarm.md: a silently bounded summary reads as "all agents
  // fine" when one of them is on fire.
  it("says nothing when nothing is hidden", () => {
    expect(truncationNote({ cards: 4, rendered: 4, droppedPanes: 0, droppedTotal: 0, truncatedHandoffs: 0 })).toBe("");
  });

  it("names dropped output, because those previews have holes", () => {
    const n = truncationNote({ cards: 4, rendered: 4, droppedPanes: 2, droppedTotal: 3 * 1024 * 1024, truncatedHandoffs: 0 });
    expect(n).toContain("2 panes dropped 3.0 MB");
    expect(n).toContain("gaps");
  });

  it("admits when cards are off-screen", () => {
    const n = truncationNote({ cards: 40, rendered: 12, droppedPanes: 0, droppedTotal: 0, truncatedHandoffs: 0 });
    expect(n).toContain("showing 12 of 40");
  });

  it("reports truncated tier handoffs", () => {
    const n = truncationNote({ cards: 2, rendered: 2, droppedPanes: 0, droppedTotal: 0, truncatedHandoffs: 1 });
    expect(n).toBe("1 scrollback handoff truncated");
  });
});

describe("nextSpark", () => {
  // The grid is now the DEFAULT swarm view, so an all-idle swarm is the common
  // case: it must not allocate a fresh 40-number ring per card 3.3× a second.
  it("freezes the ring while the whole window is silent", () => {
    const zeros = [0, 0, 0];
    expect(nextSpark(zeros, 0)).toBe(zeros); // same array, no allocation
  });

  it("keeps scrolling while a spike is still in the window", () => {
    const spiked = [0, 500, 0];
    const next = nextSpark(spiked, 0);
    expect(next).not.toBe(spiked);
    expect(next).toEqual([0, 500, 0, 0]); // the spike still walks off the left
  });

  it("always pushes real output", () => {
    expect(nextSpark([0, 0], 12)).toEqual([0, 0, 12]);
  });

  it("starts a ring from empty", () => {
    expect(nextSpark([], 0)).toEqual([0]);
  });
});

describe("sameCard", () => {
  const base = {
    paneId: "p1", role: "builder-1", title: "builder-1", state: "idle" as const, age: 4000,
    tier: "headless" as const, paused: false, dropped: 0, rate: 0, spark: [0, 0],
    tail: "x", task: "", wedged: "",
  };

  it("ignores sub-second age drift (all a card shows is the label)", () => {
    expect(sameCard(base, { ...base, age: 4300 })).toBe(true);
    expect(sameCard(base, { ...base, age: 9000 })).toBe(false);
  });

  it("ignores rate noise below the formatted resolution", () => {
    expect(sameCard(base, { ...base, rate: 0.4 })).toBe(true);   // both "idle"
    expect(sameCard(base, { ...base, rate: 4000 })).toBe(false);
  });

  it("catches every visible field", () => {
    expect(sameCard(base, { ...base, state: "stalled" })).toBe(false);
    expect(sameCard(base, { ...base, tail: "y" })).toBe(false);
    expect(sameCard(base, { ...base, task: "task-3 (claimed)" })).toBe(false);
    expect(sameCard(base, { ...base, wedged: "nudge budget spent" })).toBe(false);
    expect(sameCard(base, { ...base, paused: true })).toBe(false);
    expect(sameCard(base, { ...base, dropped: 12 })).toBe(false);
    expect(sameCard(base, { ...base, tier: "full" })).toBe(false);
    expect(sameCard(base, { ...base, spark: [0, 0] })).toBe(false); // different array = redraw
  });
});

describe("sameStats", () => {
  const s = { panes: 4, full: 1, headless: 3, webgl: 1, droppedBytes: 0, truncatedHandoffs: 0 };
  it("compares by value (poolStats allocates every call)", () => {
    expect(sameStats(s, { ...s })).toBe(true);
    expect(sameStats(s, { ...s, full: 2 })).toBe(false);
    expect(sameStats(s, { ...s, droppedBytes: 1 })).toBe(false);
  });
});

describe("sampleCards cost", () => {
  const panes = Array.from({ length: 40 }, (_, i) => ({
    id: `p${i}`, title: `builder-${i}`, role: `builder-${i}`,
  }));
  const fresh = () => {
    pool.bytes = new Map(panes.map((p) => [p.id, 100]));
    pool.lastOutput = new Map(panes.map((p) => [p.id, 1000]));
    pool.tails = 0;
    return new Map<string, any>();
  };
  const onScreen = (_id: string, i: number) => i < 10; // what the virtualizer renders
  const tick = (samples: Map<string, any>, now: number) =>
    sampleCards(panes as any, samples, new Map(), "ws1", now, onScreen);

  it("reads every buffer once on first sight, then stops", () => {
    const samples = fresh();
    tick(samples, 10_000);
    expect(pool.tails).toBe(40); // first tick has no prior preview for any pane

    pool.tails = 0;
    for (let i = 1; i <= 10; i++) tick(samples, 10_000 + i * 300);
    // BEFORE: 40 tailText calls per tick = 400 over 3 seconds.
    expect(pool.tails).toBe(0);
  });

  it("only re-reads the panes that actually produced output, and only on screen", () => {
    const samples = fresh();
    tick(samples, 10_000);
    pool.tails = 0;

    pool.bytes.set("p0", 500);   // on screen  -> re-read
    pool.bytes.set("p30", 500);  // off screen -> deferred
    tick(samples, 10_300);
    expect(pool.tails).toBe(1);
  });

  it("refreshes a deferred preview the tick after it scrolls into view", () => {
    const samples = fresh();
    tick(samples, 10_000);
    pool.bytes.set("p30", 500);
    tick(samples, 10_300);            // p30 off screen: preview goes stale
    pool.tails = 0;
    const all = sampleCards(panes as any, samples, new Map(), "ws1", 10_600, () => true);
    expect(pool.tails).toBe(1);       // exactly p30, even though it is quiet now
    expect(all.cards[30].tail).toContain("@ 500");
  });

  it("reports nothing changed when nothing changed, and keeps card identity", () => {
    const samples = fresh();
    const first = tick(samples, 10_000);
    expect(first.changed).toBe(true);
    const second = tick(samples, 10_300);
    expect(second.changed).toBe(false);
    // Same objects -> memo'd Cards do not re-render at all.
    expect(second.cards.every((c, i) => c === first.cards[i])).toBe(true);
  });

  it("re-renders only the card that moved", () => {
    const samples = fresh();
    const first = tick(samples, 10_000);
    pool.bytes.set("p0", 5000);
    pool.lastOutput.set("p0", 10_300);
    const second = tick(samples, 10_300);
    expect(second.changed).toBe(true);
    expect(second.cards[0]).not.toBe(first.cards[0]);
    expect(second.cards.slice(1).every((c, i) => c === first.cards[i + 1])).toBe(true);
  });

  it("still drops samples for panes that went away", () => {
    const samples = fresh();
    tick(samples, 10_000);
    const two = panes.slice(0, 2);
    sampleCards(two as any, samples, new Map(), "ws1", 10_300, () => true);
    expect(samples.size).toBe(2);
  });
});

// The OVERVIEW is the surface a human watches a whole swarm on, and a headless
// worker's buffer holds line-delimited stream-json. Tailing that put raw JSON on
// every card — the pane view was made readable in Phase C5 and the overview was
// left serialised, which is the half people look at more.
describe("a headless worker's preview", () => {
  const pane = { id: "head-1", title: "builder-1", role: "builder-1" };

  it("shows the transcript, not the raw stream-json, and falls back when there is none", async () => {
    const { registerStreamPane, resetStreamPanes } = await import("../lib/agentStream");
    const { feedTranscript, resetTranscripts } = await import("./panes/agentTranscript");
    resetStreamPanes();
    resetTranscripts();
    pool.bytes = new Map([[pane.id, 10]]);
    pool.lastOutput = new Map([[pane.id, 1000]]);
    registerStreamPane(pane.id, "proj", "builder-1");

    // Registered but silent: nothing parsed yet, so the raw tail is still better
    // than a blank card (a blank one reads as a dead agent).
    let out = sampleCards([pane] as any, new Map(), new Map(), "ws1", 10_000, () => true);
    expect(out.cards[0].tail).toContain("tail of head-1");

    feedTranscript(pane.id, `{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"cargo test"}}]}}\n`, 1000);
    out = sampleCards([pane] as any, new Map(), new Map(), "ws1", 10_300, () => true);
    expect(out.cards[0].tail).toContain("cargo test");
    expect(out.cards[0].tail).not.toContain("{");
    resetStreamPanes();
    resetTranscripts();
  });
});
// ---- headless previews ------------------------------------------------------

// A VERBATIM capture from the installed binary, not a hand-written spec:
//   printf '{"type":"user",…}' | claude -p --verbose --input-format stream-json \
//     --output-format stream-json --dangerously-skip-permissions
// on claude 2.1.218, 2026-07-23. Only long string VALUES are clipped (marked
// "(trimmed)") and three verbose fields dropped; every frame, every key and
// every shape is exactly what the CLI printed. This is what a headless worker
// puts in its pane buffer — and therefore what the summary card used to show.
const REAL_CAPTURE = [
  `{"type":"system","subtype":"hook_started","hook_id":"92524b8b-6655-4bcf-b711-1f6d8d90f6c0","hook_name":"SessionStart:startup","hook_event":"SessionStart","uuid":"12eeec04-a3f4-47df-8b26-1a0224ddcdf7","session_id":"47eb7fad-1a49-4ddc-b0b1-385c168660e3"}`,
  `{"type":"system","subtype":"hook_response","hook_id":"92524b8b-6655-4bcf-b711-1f6d8d90f6c0","hook_name":"SessionStart:startup","hook_event":"SessionStart","output":"CAVEMAN MODE ACTIVE — level: full\\n\\nRespond terse like smart caveman. All technical substance stay. Only fluff die.\\n\\n## P… (trimmed)","stdout":"CAVEMAN MODE ACTIVE — level: full\\n\\nRespond terse like smart caveman. All technical substance stay. Only fluff die.\\n\\n## P… (trimmed)","stderr":"","exit_code":0,"outcome":"success","uuid":"8b1e8d6c-b587-4555-bdf2-bf5fe5d979bd","session_id":"47eb7fad-1a49-4ddc-b0b1-385c168660e3"}`,
  `{"type":"system","subtype":"init","cwd":"/tmp/claude-1000/-run-media-veracrypt1-SVN-ai-dashboard/494f05f7-8a85-419e-b4e4-4e0ef0da9432/scratchpad","session_id":"47eb7fad-1a49-4ddc-b0b1-385c168660e3","tools":["Task","Bash","CronCreate","CronDelete"],"mcp_servers":[{"name":"plugin:paddle:paddle-docs","status":"pending"},{"name":"plugin:paddle:paddle-live","status":"pending"},{"name":"plugin:paddle:paddle-sandbox","status":"pending"}],"model":"claude-opus-4-8[1m]","permissionMode":"bypassPermissions","slash_commands":["algorithmic-art","claude-clear","deep-research","caveman:caveman-commit"],"apiKeySource":"none","claude_code_version":"2.1.218","output_style":"default","agents":["caveman:cavecrew-builder","caveman:cavecrew-investigator","caveman:cavecrew-reviewer","claude"],"skills":["algorithmic-art","claude-clear","deep-research","paddle:billing-history"],"plugins":[{"name":"paddle","path":"/home/no/.claude/plugins/cache/claude-community/paddle/72e6fdf6ec31-ab82885f","source":"paddle@claude-community"},{"name":"caveman","path":"/home/no/.claude/plugins/cache/claude-community/caveman/0d95a81d35a9","source":"caveman@claude-community"},{"name":"rust-analyzer-lsp","path":"/home/no/.claude/plugins/cache/claude-plugins-official/rust-analyzer-lsp/1.0.0","source":"rust-analyzer-lsp@claude-plugins-official","version":"1.0.0"},{"name":"frontend-design","path":"/home/no/.claude/plugins/cache/claude-plugins-official/frontend-design/unknown","source":"frontend-design@claude-plugins-official"}],"capabilities":["interrupt_receipt_v1","msg_lifecycle_v1"],"analytics_disabled":false,"product_feedback_disabled":false,"uuid":"a4288990-2954-46cd-aa2d-035f396f46ea","memory_paths":{"auto":"/home/no/.claude/projects/-tmp-claude-1000--run-media-veracrypt1-SVN-ai-dashboard-494f05f7-8a85-419e-b4e4-4e0ef0da9432-s… (trimmed)"},"fast_mode_state":"off"}`,
  `{"type":"assistant","message":{"model":"claude-opus-4-8","id":"msg_011CdJMSuAKJxc2EjTBYmVFp","type":"message","role":"assistant","content":[{"type":"tool_use","id":"toolu_01XxjzUNnAVGuqoau5Mp9BRA","name":"Bash","input":{"command":"echo overview-capture","description":"Echo overview-capture"},"caller":{"type":"direct"}}],"stop_reason":null,"stop_sequence":null,"stop_details":null,"usage":{"input_tokens":2,"cache_creation_input_tokens":9347,"cache_read_input_tokens":15108,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":9347},"output_tokens":64,"service_tier":"standard","inference_geo":"not_available"},"diagnostics":null,"context_management":null},"parent_tool_use_id":null,"session_id":"47eb7fad-1a49-4ddc-b0b1-385c168660e3","uuid":"e7aee68c-426a-4a7f-ae2a-41dafca3a11a","timestamp":"2026-07-23T04:24:45.112Z","request_id":"req_011CdJMStEzm5vTJiRcTLQrd"}`,
  `{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1784793000,"rateLimitType":"five_hour","overageStatus":"rejected","overageDisabledReason":"out_of_credits","isUsingOverage":false},"uuid":"77a5996f-dfec-4ce0-a3ac-db968cd81896","session_id":"47eb7fad-1a49-4ddc-b0b1-385c168660e3"}`,
  `{"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_01XxjzUNnAVGuqoau5Mp9BRA","type":"tool_result","content":"overview-capture","is_error":false}]},"parent_tool_use_id":null,"session_id":"47eb7fad-1a49-4ddc-b0b1-385c168660e3","uuid":"55a8e57c-09fd-429f-b5c7-b3650e72c297","timestamp":"2026-07-23T04:24:45.369Z"}`,
  `{"type":"assistant","message":{"model":"claude-opus-4-8","id":"msg_011CdJMT7L3mpAE6SExegr5e","type":"message","role":"assistant","content":[{"type":"text","text":"done"}],"stop_reason":null,"stop_sequence":null,"stop_details":null,"usage":{"input_tokens":2,"cache_creation_input_tokens":91,"cache_read_input_tokens":24455,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":91},"output_tokens":1,"service_tier":"standard","inference_geo":"not_available"},"diagnostics":null,"context_management":null},"parent_tool_use_id":null,"session_id":"47eb7fad-1a49-4ddc-b0b1-385c168660e3","uuid":"d279c7cf-12ae-4c5b-98ad-60c92c9d2c9a","timestamp":"2026-07-23T04:24:47.731Z","request_id":"req_011CdJMT1kh24CxQN2UrYXjy"}`,
  `{"is_error":false,"duration_api_ms":3903,"num_turns":2,"stop_reason":"end_turn","session_id":"47eb7fad-1a49-4ddc-b0b1-385c168660e3","total_cost_usd":0.1162815,"usage":{"input_tokens":4,"cache_creation_input_tokens":9438,"cache_read_input_tokens":39563,"output_tokens":84,"server_tool_use":{"web_search_requests":0,"web_fetch_requests":0},"service_tier":"standard","cache_creation":{"ephemeral_1h_input_tokens":9438,"ephemeral_5m_input_tokens":0},"inference_geo":"not_available","iterations":[{"input_tokens":2,"output_tokens":3,"cache_read_input_tokens":24455,"cache_creation_input_tokens":91,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":91},"type":"message"}],"speed":"standard"},"terminal_reason":"completed","fast_mode_state":"off","subtype":"success","api_error_status":null,"result":"done","ttft_ms":1613,"ttft_stream_ms":1459,"time_to_request_ms":126,"type":"result","duration_ms":4273,"uuid":"9158d524-2924-4b2e-8bc4-2dcdeeaa4fd5"}`,
].join("\n") + "\n";

describe("headless pane previews", () => {
  const headless = [{ id: "h1", title: "builder-1", role: "builder-1" }];
  const feed = () => {
    resetTranscripts();
    registerStreamPane("h1", "", "");
    feedTranscript("h1", REAL_CAPTURE, 1000);
    pool.bytes.set("h1", 4096);
    pool.lastOutput.set("h1", 1000);
    pool.tails = 0;
  };

  afterEach(() => { unregisterStreamPane("h1"); resetTranscripts(); });

  // THE POINT OF THE WHOLE ITEM: the overview is the surface a human watches a
  // swarm on, and for a headless worker it was showing raw stream-json.
  it("renders the transcript rather than the raw stream-json", () => {
    feed();
    const { cards } = sampleCards(headless as any, new Map(), new Map(), "ws1", 1000);
    expect(cards[0].tail).toContain("Bash: echo overview-capture");
    expect(cards[0].tail).toContain("turn ended · success");
    // What the card used to be: the buffer's own bytes.
    expect(REAL_CAPTURE).toContain('"type":"assistant"');
    expect(cards[0].tail).not.toContain('"type"');
    expect(cards[0].tail).not.toContain("{");
  });

  // The hook frames and the rate-limit notice are in the capture and must not
  // reach the card: eight lines of bookkeeping is the same failure as raw JSON.
  it("keeps the card to the rows a human would describe", () => {
    feed();
    const { cards } = sampleCards(headless as any, new Map(), new Map(), "ws1", 1000);
    expect(cards[0].tail.split("\n")).toEqual([
      "session 47eb7fad · claude-opus-4-8[1m] · 4 tools: /tmp/claude-1000/-run-media-veracrypt1-SVN-ai-dashboard/494f05f7-8a85-419e-b4e4-4e0ef0da9432/scratchpad",
      "Bash: echo overview-capture",
      "Bash ok: overview-capture",
      "assistant: done",
      "turn ended · success · 4.3s · $0.1163",
    ]);
  });

  // The byte-counter skip is what keeps a 40-card grid cheap. A headless pane
  // gets the SAME treatment against its transcript's version counter, so the
  // structured preview did not buy readability with per-tick work.
  it("does not re-read a headless preview while the transcript is unchanged", () => {
    feed();
    const samples = new Map<string, any>();
    const first = sampleCards(headless as any, samples, new Map(), "ws1", 1000);
    pool.bytes.set("h1", 9999); // bytes moved; the transcript did not
    const second = sampleCards(headless as any, samples, new Map(), "ws1", 1300);
    expect(second.cards[0].tail).toBe(first.cards[0].tail);
    expect(pool.tails).toBe(0);  // never the buffer, on either tick
  });

  it("refreshes it as soon as the transcript does move", () => {
    feed();
    const samples = new Map<string, any>();
    sampleCards(headless as any, samples, new Map(), "ws1", 1000);
    feedTranscript("h1", `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"second turn"}]}}\n`, 1300);
    const next = sampleCards(headless as any, samples, new Map(), "ws1", 1300);
    expect(next.cards[0].tail).toContain("second turn");
  });

  // A TUI pane must take exactly the path it takes today.
  it("still tails the buffer for a pane that is not a stream pane", () => {
    resetTranscripts();
    pool.bytes.set("t1", 10);
    pool.lastOutput.set("t1", 1000);
    pool.tails = 0;
    const tui = [{ id: "t1", title: "coordinator", role: "coordinator" }];
    const { cards } = sampleCards(tui as any, new Map(), new Map(), "ws1", 1000);
    expect(pool.tails).toBe(1);
    expect(cards[0].tail).toBe("tail of t1 @ 10");
  });
});
