import { describe, expect, it, vi } from "vitest";
import { COMPACT_RUNAWAY_MS, RUNAWAY_MS, RUNAWAY_RESTART_MAX, looksCompacting, normalizeTail, scanForRunaways } from "./swarm";

// swarmRunaway (imported lazily below for `keepSet`) pulls React, the terminal
// pool — whose clipboard addon touches `self`, undefined in the node env — and
// the Tauri ipc bindings. None of them is on the path under test.
vi.mock("./terminalPool", () => ({ lastOutputAt: () => 0, tailText: () => "", restartTerminal: () => {} }));
vi.mock("./ipc", () => ({ brainUrl: () => Promise.resolve(""), ptyWrite: () => Promise.resolve() }));

const PANE = { id: "p1", role: "builder-1", project: "proj", command: "opencode" };
const MIN = 60_000;

/** Drive the detector over a scripted timeline: [minutesElapsed, tail] per poll,
 *  with the pane reported busy unless `tail` is null (= turn ended). */
function run(script: [number, string | null][]) {
  const state = new Map();
  const hits: number[] = [];
  for (const [min, tail] of script) {
    const now = min * MIN;
    const got = scanForRunaways([PANE], state, now, {
      lastOutput: () => (tail === null ? now - 60_000 : now - 1000),
      tail: () => tail ?? "",
    });
    if (got.length) hits.push(min);
  }
  return hits;
}

describe("normalizeTail", () => {
  it("ignores spinner glyphs, counters and whitespace", () => {
    expect(normalizeTail("⠹ thinking… 1234 tokens  12s")).toBe(normalizeTail("⠼ thinking… 9876 tokens 340s"));
  });
  it("keeps real new output distinct", () => {
    expect(normalizeTail("⠹ running tests")).not.toBe(normalizeTail("⠹ writing file"));
  });
});

describe("scanForRunaways", () => {
  it("flags a pane busy with a frozen tail past the threshold", () => {
    expect(run([[0, "⠹ thinking 1 tokens"], [5, "⠼ thinking 900 tokens"], [9, "⠧ thinking 20000 tokens"]])).toEqual([9]);
  });

  it("leaves a busy pane alone while it keeps printing new output", () => {
    expect(run([[0, "compiling a.rs"], [5, "compiling b.rs"], [9, "compiling c.rs"], [14, "linking"]])).toEqual([]);
  });

  it("resets the streak when the turn ends", () => {
    expect(run([[0, "⠹ thinking 1"], [5, "⠼ thinking 900"], [7, null], [9, "⠧ thinking 20000"]])).toEqual([]);
  });

  it("gives up after RESTART_MAX recoveries", () => {
    const script: [number, string | null][] = [];
    for (let m = 0; m <= 60; m += 9) script.push([m, "⠹ thinking 1 tokens"]);
    expect(run(script).length).toBe(2);
  });

  it("drops state for panes that disappear", () => {
    const state = new Map();
    scanForRunaways([PANE], state, 0, { lastOutput: () => -1000, tail: () => "x" });
    expect(state.size).toBe(1);
    scanForRunaways([], state, MIN, { lastOutput: () => 0, tail: () => "" });
    expect(state.size).toBe(0);
  });
});

// CONTEXT COMPACTION — the healthy state that wears a runaway's clothes: busy
// pane, frozen screen, no tool call, for minutes. Aborting it costs the agent its
// turn AND its compaction, and spends one of two restarts a human is meant to be
// told about.
describe("compaction is not a runaway", () => {
  const state = () => new Map();

  it("holds the streak at zero while the CLI's own hook says it is compacting", () => {
    const st = state();
    const frozen = () => "⠹ thinking 1 tokens";
    // Busy with a frozen tail for well past the threshold — but paused throughout.
    for (let m = 0; m <= 40; m += 5) {
      const now = m * MIN;
      expect(scanForRunaways([PANE], st, now, { lastOutput: () => now - 1000, tail: frozen }, undefined, new Set(["p1"]))).toEqual([]);
      expect(st.get("p1").since).toBeNull(); // no countdown is accruing
    }
  });

  it("starts the clock again where the compaction ENDED, not where the turn began", () => {
    const st = state();
    const tail = () => "⠹ thinking 1 tokens";
    const read = (now: number) => ({ lastOutput: () => now - 1000, tail });
    scanForRunaways([PANE], st, 0, read(0), undefined, new Set(["p1"])); // compacting
    scanForRunaways([PANE], st, 20 * MIN, read(20 * MIN), undefined, new Set(["p1"])); // still compacting
    // Back from compaction. The streak restarts here, so the pane gets its full
    // RUNAWAY_MS of ordinary rope before anyone aborts it.
    expect(scanForRunaways([PANE], st, 21 * MIN, read(21 * MIN))).toEqual([]);
    expect(st.get("p1").since).toBe(21 * MIN);
    const t1 = 21 * MIN + RUNAWAY_MS - 1;
    expect(scanForRunaways([PANE], st, t1, read(t1))).toEqual([]);
    const t2 = 21 * MIN + RUNAWAY_MS;
    expect(scanForRunaways([PANE], st, t2, read(t2))).toEqual([PANE]);
  });

  it("keeps the restart budget the pane had already spent", () => {
    const st = new Map([["p1", { since: 0, tail: "x", restarts: 1 }]]);
    scanForRunaways([PANE], st, MIN, { lastOutput: () => MIN - 1000, tail: () => "x" }, undefined, new Set(["p1"]));
    expect(st.get("p1")!.restarts).toBe(1); // a pause is not a fresh start
  });

  it("reads the frozen SCREEN for CLIs with no hooks — a longer leash, still bounded", () => {
    expect(looksCompacting("⠹ Compacting conversation… (esc to interrupt · 41k tokens)")).toBe(true);
    expect(looksCompacting("Auto-compact in progress")).toBe(true);
    expect(looksCompacting("⠹ thinking 20000 tokens")).toBe(false);
    const compactScreen: [number, string | null][] = [];
    for (let m = 0; m <= 20; m += 4) compactScreen.push([m, "⠹ Compacting conversation… 41000 tokens"]);
    expect(run(compactScreen)).toEqual([]); // past RUNAWAY_MS, and left alone
    // …but a pane that never leaves that screen IS wedged, just slower to call.
    const forever: [number, string | null][] = [];
    for (let m = 0; m <= COMPACT_RUNAWAY_MS / MIN + 5; m += 5) forever.push([m, "⠹ Compacting conversation… 41000 tokens"]);
    expect(run(forever).length).toBe(1);
    expect(RUNAWAY_RESTART_MAX).toBeGreaterThan(0);
  });
});

// The hook's own `keep` rule, which decides whether RUNAWAY_RESTART_MAX means
// anything at all.
describe("keepSet", () => {
  it("keeps only the panes mid-recovery, so each detector still prunes the other's", async () => {
    const { keepSet } = await import("./swarmRunaway");
    const all = [{ id: "a" }, { id: "b" }, { id: "c" }];
    // `b` is being aborted and re-briefed: its entry (and its spent restarts)
    // must survive the polls that recovery spans.
    expect([...keepSet(all, new Set(["b"]))]).toEqual(["b"]);
    // Nothing recovering = nothing kept. The union of every live id is what made
    // a taken-over pane's stream entry immortal, watchdog silently off.
    expect(keepSet(all, new Set()).size).toBe(0);
  });
});
