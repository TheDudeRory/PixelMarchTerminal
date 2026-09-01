import { describe, expect, it, beforeEach } from "vitest";
import { NUDGE_MAX, REWAKE_MS, REWAKE_FAST_MS, RUNAWAY_RESTART_MAX, WAKE_MISS_MAX, setTurnBudget } from "../lib/swarm";
import { gaveUp, nextWakeAt, paneKey, paneTelemetry, useSwarmTelemetry, wakeKey, wakeMisses } from "./swarmTelemetry";

// W/W2 are WORKSPACE ids (the store's key), P a swarm project (the budget's key).
const W = "ws-1";
const W2 = "ws-2";
const P = "swarm-tele";

beforeEach(() => useSwarmTelemetry.setState({ panes: {}, budgets: {}, stuck: {} }));

describe("swarmTelemetry", () => {
  it("mirrors a wake and drops it again", () => {
    const s = useSwarmTelemetry.getState();
    s.reportWake(W, "builder-1", "open", { sig: "task-1:open", at: 1000, misses: 0 }, true);
    expect(paneTelemetry(W, "builder-1").wakes.open).toEqual({ at: 1000, misses: 0, urgent: true });
    s.clearWake(W, "builder-1", "open");
    expect(paneTelemetry(W, "builder-1").wakes).toEqual({});
  });

  it("keeps the object identity when a report changes nothing", () => {
    const s = useSwarmTelemetry.getState();
    s.reportWake(W, "scout", "scout-open", { sig: "a", at: 5, misses: 0 }, false);
    const first = useSwarmTelemetry.getState().panes[paneKey(W, "scout")];
    s.reportWake(W, "scout", "scout-open", { sig: "a", at: 5, misses: 0 }, false);
    expect(useSwarmTelemetry.getState().panes[paneKey(W, "scout")]).toBe(first);
  });

  it("counts the next wake down with the same gap rule as wakeDue", () => {
    const s = useSwarmTelemetry.getState();
    s.reportWake(W, "builder-1", "open", { sig: "a", at: 1000, misses: 0 }, true);
    s.reportWake(W, "builder-1", "merge", { sig: "b", at: 1000, misses: 0 }, false);
    const t = paneTelemetry(W, "builder-1");
    // urgent (unclaimed task) is the fast gap, so it comes due first
    expect(nextWakeAt(t)).toBe(1000 + REWAKE_FAST_MS);
    expect(wakeMisses(t)).toBe(0);
    // once the misses cap is hit, even an urgent wake backs off to the slow gap
    s.reportWake(W, "builder-1", "open", { sig: "a", at: 1000, misses: WAKE_MISS_MAX }, true);
    s.clearWake(W, "builder-1", "merge");
    expect(nextWakeAt(paneTelemetry(W, "builder-1"))).toBe(1000 + REWAKE_MS);
    expect(wakeMisses(paneTelemetry(W, "builder-1"))).toBe(WAKE_MISS_MAX);
  });

  it("has no wake deadline for a pane nothing has happened to", () => {
    expect(nextWakeAt(paneTelemetry(W, "reviewer"))).toBeNull();
    expect(paneTelemetry(W, "reviewer").runaway).toEqual({ since: null, restarts: 0 });
  });

  it("mirrors nudge episodes, runaway streaks and pending resets", () => {
    const s = useSwarmTelemetry.getState();
    s.reportNudge(W, "builder-1", { at: 7, count: 2 });
    s.reportRunaway(W, "builder-1", { since: 42, restarts: 1 });
    s.reportReset(W, "builder-1", true);
    expect(paneTelemetry(W, "builder-1").nudge).toEqual({ at: 7, count: 2 });
    expect(paneTelemetry(W, "builder-1").runaway).toEqual({ since: 42, restarts: 1 });
    expect(paneTelemetry(W, "builder-1").resetPending).toBe(true);
    s.reportNudge(W, "builder-1", null); // error scrolled away
    s.reportReset(W, "builder-1", false);
    expect(paneTelemetry(W, "builder-1").nudge).toBeNull();
    expect(paneTelemetry(W, "builder-1").resetPending).toBe(false);
  });

  it("bridges the dispatcher's turn budget into the store", () => {
    setTurnBudget(P, { cap: 2, inFlight: 1, busy: ["builder-1"], starved: [] });
    expect(useSwarmTelemetry.getState().budgets[P]).toEqual({ cap: 2, inFlight: 1, busy: ["builder-1"], starved: [] });
  });

  it("retains only the wake kinds still in the dispatcher's job list", () => {
    const s = useSwarmTelemetry.getState();
    s.reportWake(W, "coordinator", "merge", { sig: "a", at: 1, misses: 0 }, false);
    s.reportWake(W, "coordinator", "scout-done", { sig: "b", at: 1, misses: 0 }, false);
    s.reportWake(W, "builder-1", "open", { sig: "c", at: 1, misses: 0 }, true);
    s.reportWake(W2, "builder-1", "open", { sig: "d", at: 1, misses: 0 }, true);
    s.retainWakes(W, new Set([wakeKey("coordinator", "merge")]));
    expect(Object.keys(paneTelemetry(W, "coordinator").wakes)).toEqual(["merge"]);
    expect(paneTelemetry(W, "builder-1").wakes).toEqual({}); // everything merged — no countdown
    expect(paneTelemetry(W2, "builder-1").wakes.open).toBeDefined(); // other workspace untouched
  });

  it("keeps identity when a retain pass changes nothing", () => {
    const s = useSwarmTelemetry.getState();
    s.reportWake(W, "scout", "scout-open", { sig: "a", at: 5, misses: 0 }, false);
    const before = useSwarmTelemetry.getState().panes;
    s.retainWakes(W, new Set([wakeKey("scout", "scout-open")]));
    expect(useSwarmTelemetry.getState().panes).toBe(before);
  });

  it("drops everything belonging to one workspace, budget only with the last one", () => {
    const s = useSwarmTelemetry.getState();
    s.reportReset(W, "builder-1", true);
    s.reportReset(W2, "builder-1", true);
    setTurnBudget(P, { cap: 1, inFlight: 0, busy: [], starved: [] });
    s.dropWorkspace(W); // a second workspace is still on this swarm — budget stays
    expect(useSwarmTelemetry.getState().panes[paneKey(W, "builder-1")]).toBeUndefined();
    expect(useSwarmTelemetry.getState().panes[paneKey(W2, "builder-1")]).toBeDefined();
    expect(useSwarmTelemetry.getState().budgets[P]).toBeDefined();
    s.dropWorkspace(W2, P); // last one out
    expect(useSwarmTelemetry.getState().budgets[P]).toBeUndefined();
  });
});

// FINDING 1.5: the key used to be "<swarm project>/<role>", so two workspaces
// open on the SAME swarm shared one record — each one's dispatcher reconciled
// the other's wakes away and their cooldowns overwrote each other.
describe("workspace scoping (finding 1.5)", () => {
  it("keeps two workspaces on one swarm project apart", () => {
    const s = useSwarmTelemetry.getState();
    s.reportWake(W, "builder-1", "open", { sig: "a", at: 1000, misses: 0 }, true);
    s.reportNudge(W, "builder-1", { at: 1000, count: 1 });
    s.reportWake(W2, "builder-1", "open", { sig: "b", at: 9000, misses: 2 }, false);

    expect(paneTelemetry(W, "builder-1").wakes.open).toEqual({ at: 1000, misses: 0, urgent: true });
    expect(paneTelemetry(W2, "builder-1").wakes.open).toEqual({ at: 9000, misses: 2, urgent: false });
    expect(paneTelemetry(W2, "builder-1").nudge).toBeNull(); // W's episode is W's alone

    // W2's dispatcher reconciling its own tick must not clear W's countdown.
    s.retainWakes(W2, new Set());
    expect(paneTelemetry(W2, "builder-1").wakes).toEqual({});
    expect(paneTelemetry(W, "builder-1").wakes.open).toBeDefined();
  });
});

// FINDING 1.15: NUDGE_MAX / RUNAWAY_RESTART_MAX exhausted = nothing will ever
// touch that pane again. The strip renders gaveUp() as its own banner.
describe("terminal give-up state (finding 1.15)", () => {
  it("says nothing while a recovery budget is still being spent", () => {
    const s = useSwarmTelemetry.getState();
    expect(gaveUp(paneTelemetry(W, "builder-1"))).toBeNull();
    s.reportNudge(W, "builder-1", { at: 1, count: NUDGE_MAX - 1 });
    s.reportRunaway(W, "builder-1", { since: 1, restarts: RUNAWAY_RESTART_MAX - 1 });
    expect(gaveUp(paneTelemetry(W, "builder-1"))).toBeNull();
  });

  it("reports a spent nudge budget and a spent restart budget", () => {
    const s = useSwarmTelemetry.getState();
    s.reportNudge(W, "builder-1", { at: 1, count: NUDGE_MAX });
    expect(gaveUp(paneTelemetry(W, "builder-1"))).toContain("nudge");
    s.reportNudge(W, "builder-1", null); // error scrolled away — episode over
    expect(gaveUp(paneTelemetry(W, "builder-1"))).toBeNull();
    s.reportRunaway(W, "builder-1", { since: 1, restarts: RUNAWAY_RESTART_MAX });
    expect(gaveUp(paneTelemetry(W, "builder-1"))).toContain("restarts");
  });

  // `restarts` is never reset (scanForRunaways only nulls `since`), so keying the
  // banner off the spent budget alone lit "wedged" for the whole session — on a
  // pane that had recovered and was emitting output. That permanently-lit NEEDS A
  // HUMAN banner is the alarm fatigue 1.15 was meant to remove.
  it("stops reporting a spent restart budget once the pane recovers", () => {
    const s = useSwarmTelemetry.getState();
    s.reportRunaway(W, "builder-1", { since: 1, restarts: RUNAWAY_RESTART_MAX });
    expect(gaveUp(paneTelemetry(W, "builder-1"))).toContain("restarts");
    // Pane went idle: the watcher clears the streak but keeps the spent budget.
    s.reportRunaway(W, "builder-1", { since: null, restarts: RUNAWAY_RESTART_MAX });
    expect(gaveUp(paneTelemetry(W, "builder-1"))).toBeNull();
    // Frozen again with the budget already gone — nothing will abort it now.
    s.reportRunaway(W, "builder-1", { since: 99, restarts: RUNAWAY_RESTART_MAX });
    expect(gaveUp(paneTelemetry(W, "builder-1"))).toContain("restarts");
  });
  // brain-findings 1.1: a done task nobody is reviewing reaches the human through
  // the strip, so the mirror has to appear and CLEAR on the right transitions —
  // a row that outlives the verdict is the alarm fatigue this is meant to avoid.
  it("shows and clears the unreviewed-task row per workspace", () => {
    const s = useSwarmTelemetry.getState();
    const row = { task: "task-3", role: "reviewer-1", since: 1000 };
    s.setStuck(W, [row]);
    expect(useSwarmTelemetry.getState().stuck[W]).toEqual([row]);
    // Another workspace's swarm is untouched by it.
    expect(useSwarmTelemetry.getState().stuck[W2]).toBeUndefined();
    // Reviewer verdicted it: the dispatcher reports an empty list and the row goes.
    s.setStuck(W, []);
    expect(useSwarmTelemetry.getState().stuck[W]).toBeUndefined();
  });

  it("keeps state identity while the same task stays unreviewed", () => {
    const s = useSwarmTelemetry.getState();
    s.setStuck(W, [{ task: "task-3", role: "reviewer-1", since: 1000 }]);
    const first = useSwarmTelemetry.getState().stuck;
    s.setStuck(W, [{ task: "task-3", role: "reviewer-1", since: 1000 }]); // same tick over and over
    expect(useSwarmTelemetry.getState().stuck).toBe(first); // no re-render every 5 s
    s.setStuck(W, [{ task: "task-4", role: "reviewer-1", since: 2000 }]);
    expect(useSwarmTelemetry.getState().stuck[W]).toEqual([{ task: "task-4", role: "reviewer-1", since: 2000 }]);
  });

  it("forgets a closed workspace's unreviewed rows", () => {
    const s = useSwarmTelemetry.getState();
    s.setStuck(W, [{ task: "task-3", role: "reviewer-1", since: 1000 }]);
    s.dropWorkspace(W, P);
    expect(useSwarmTelemetry.getState().stuck[W]).toBeUndefined();
  });

  // A dirty ROOT checkout blocks every host merge, so it goes to the human the
  // same way — and it has to AGE, because "root dirty 20 minutes" is the signal
  // that nobody is coming to fix it.
  it("shows, ages and clears the stray-edit row per workspace", () => {
    const s = useSwarmTelemetry.getState();
    s.setStray(W, ["src/a.ts", "src/b.ts"]);
    const first = useSwarmTelemetry.getState().stray[W];
    expect(first?.files).toEqual(["src/a.ts", "src/b.ts"]);
    expect(useSwarmTelemetry.getState().stray[W2]).toBeUndefined();

    // Same mess reported every 5 s: identity AND `since` are kept, or the row
    // would restart its own clock forever and never look old.
    s.setStray(W, ["src/b.ts", "src/a.ts"]); // order from git is not stable
    expect(useSwarmTelemetry.getState().stray[W]).toBe(first);

    // A different set is a different mess — new files, new clock.
    s.setStray(W, ["src/c.ts"]);
    expect(useSwarmTelemetry.getState().stray[W]?.files).toEqual(["src/c.ts"]);

    s.setStray(W, []); // root clean again
    expect(useSwarmTelemetry.getState().stray[W]).toBeUndefined();
    const clean = useSwarmTelemetry.getState().stray;
    s.setStray(W, []); // …and staying clean is not a re-render
    expect(useSwarmTelemetry.getState().stray).toBe(clean);
  });

  it("forgets a closed workspace's stray-edit row", () => {
    const s = useSwarmTelemetry.getState();
    s.setStray(W, ["src/a.ts"]);
    s.dropWorkspace(W, P);
    expect(useSwarmTelemetry.getState().stray[W]).toBeUndefined();
  });
});
