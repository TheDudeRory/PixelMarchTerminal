import { describe, expect, it, vi } from "vitest";
import type { MacroTestDone, MacroTestStep } from "../lib/ipc";

// MacroEditor pulls in @tauri-apps/api at import time; nothing below invokes it.
vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.resolve(null) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => undefined) }));

const { EMPTY_RUN, runReducer, runStatusText, validateMacro } = await import("./MacroEditor");
type RunState = typeof EMPTY_RUN;

const step = (p: Partial<MacroTestStep>): { kind: "step"; ev: MacroTestStep } => ({
  kind: "step",
  ev: { run_id: 1, index: 0, total: 3, summary: "Wait 500 ms", status: "start", ...p },
});
const done = (p: Partial<MacroTestDone>): { kind: "done"; ev: MacroTestDone } => ({
  kind: "done",
  ev: { run_id: 1, status: "completed", error: null, ...p },
});
const reduce = (start: RunState, ...actions: Parameters<typeof runReducer>[1][]) =>
  actions.reduce(runReducer, start);
const started = (mode: "full" | "step" = "full") =>
  reduce(EMPTY_RUN, { kind: "begin", mode }, { kind: "attach", runId: 1 });

describe("runReducer", () => {
  it("begin clears the previous run", () => {
    const stale = reduce(started(), step({}), step({ status: "ok" }), done({}));
    const s = runReducer(stale, { kind: "begin", mode: "full" });
    expect(s).toEqual({ runId: null, running: true, mode: "full", total: 0, log: [], result: null });
  });

  it("attach only fills a missing run id", () => {
    expect(runReducer(started(), { kind: "attach", runId: 9 }).runId).toBe(1);
    expect(runReducer(EMPTY_RUN, { kind: "attach", runId: 9 }).runId).toBeNull();
  });

  it("adopts the run id when an event beats the invoke promise", () => {
    const s = reduce(EMPTY_RUN, { kind: "begin", mode: "full" }, step({ run_id: 7 }));
    expect(s.runId).toBe(7);
    expect(s.log).toHaveLength(1);
  });

  it("replaces a step's start line with its terminal status", () => {
    const s = reduce(started(), step({}), step({ status: "ok" }));
    expect(s.log).toEqual([{ index: 0, summary: "Wait 500 ms", status: "ok" }]);
    expect(s.total).toBe(3);
  });

  it("keeps one line per step across a multi-step run", () => {
    const s = reduce(
      started(),
      step({ index: 0 }), step({ index: 0, status: "ok" }),
      step({ index: 1, summary: "Press Ctrl+C" }), step({ index: 1, summary: "Press Ctrl+C", status: "error", error: "boom" }),
      step({ index: 2, summary: "Click left" }), step({ index: 2, summary: "Click left", status: "skipped" }),
    );
    expect(s.log.map((e) => e.status)).toEqual(["ok", "error", "skipped"]);
    expect(s.log[1].error).toBe("boom");
  });

  it("ignores events from another run", () => {
    const s = reduce(started(), step({ run_id: 2, index: 5 }), done({ run_id: 2, status: "stopped" }));
    expect(s.log).toEqual([]);
    expect(s.running).toBe(true);
    expect(s.result).toBeNull();
  });

  it("ignores events once the run is over", () => {
    const finished = reduce(started(), done({}));
    expect(runReducer(finished, step({ index: 4 }))).toBe(finished);
  });

  it("done marks in-flight lines skipped and records the result", () => {
    const s = reduce(started(), step({ index: 0 }), step({ index: 0, status: "ok" }), step({ index: 1 }), done({ status: "stopped" }));
    expect(s.running).toBe(false);
    expect(s.log.map((e) => e.status)).toEqual(["ok", "skipped"]);
    expect(s.result).toEqual({ status: "stopped", error: null });
  });

  it("fail records a rejected invoke without losing the log", () => {
    const s = reduce(started(), step({ index: 0, status: "ok" }), { kind: "fail", error: "no backend" });
    expect(s.running).toBe(false);
    expect(s.result).toEqual({ status: "error", error: "no backend" });
    expect(s.log).toHaveLength(1);
  });

  it("clear resets to empty", () => {
    expect(runReducer(reduce(started(), step({}), done({})), { kind: "clear" })).toEqual(EMPTY_RUN);
  });

  it("caps the log", () => {
    let s = started();
    for (let i = 0; i < 260; i++) s = runReducer(s, step({ index: i, status: "ok", summary: `s${i}` }));
    expect(s.log).toHaveLength(200);
    expect(s.log[s.log.length - 1].summary).toBe("s259");
  });
});

describe("runStatusText", () => {
  it("counts finished steps while running", () => {
    const s = reduce(started(), step({ index: 0 }), step({ index: 0, status: "ok" }), step({ index: 1 }));
    expect(runStatusText(s)).toBe("Running… 1/3");
  });
  it("labels a single-step run", () => {
    expect(runStatusText(started("step"))).toBe("Running step…");
  });
  it("is empty before anything runs", () => {
    expect(runStatusText(EMPTY_RUN)).toBe("");
  });
  it("summarises the outcome", () => {
    const ok = reduce(started(), step({ index: 0, status: "ok" }), done({}));
    expect(runStatusText(ok)).toBe("Finished");
    const bad = reduce(started(), step({ index: 0, status: "error", error: "x" }), done({}));
    expect(runStatusText(bad)).toBe("Finished with 1 error");
    expect(runStatusText(reduce(started(), done({ status: "stopped" })))).toBe("Stopped");
    expect(runStatusText(reduce(started(), done({ status: "error", error: "engine died" })))).toBe("Failed: engine died");
  });
});

describe("validateMacro key tokens", () => {
  const macro = (steps: Record<string, unknown>[]) =>
    ({ id: "m1", name: "m", steps } as Parameters<typeof validateMacro>[0]);

  it("accepts a key only the picker can reach", () => {
    expect(validateMacro(macro([{ type: "send_keystroke", keys: "Ctrl+MediaPlayPause" }]))).toEqual([]);
    expect(validateMacro(macro([{ type: "hold_key", key: "AudioVolumeUp" }]))).toEqual([]);
  });
  it("flags a token the engine cannot send", () => {
    const [warn] = validateMacro(macro([{ type: "send_keystroke", keys: "Ctrl+Wibble" }]));
    expect(warn).toContain("Wibble");
  });
  it("leaves fx expressions alone", () => {
    expect(validateMacro(macro([{ type: "send_keystroke", keys: { expr: "k" } }]))).toEqual([]);
  });
  it("still catches an empty key", () => {
    expect(validateMacro(macro([{ type: "hold_key", key: "" }]))[0]).toContain("no key set");
  });
});
