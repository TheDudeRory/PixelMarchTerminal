import { describe, expect, it, vi } from "vitest";
// swarmDispatch pulls in the terminal pool (xterm) transitively, and xterm's
// clipboard addon touches `self` at import time — undefined in the node test
// env. The fan-out under test is pure, so stub the pool away.
vi.mock("./terminalPool", () => ({ lastOutputAt: () => 0, tailText: () => "" }));
import { REWAKE_FAST_MS, REWAKE_MS, SETTLED_STATUSES, STALE_CLAIM_MS, WAKE_DELIVERY_MS, WAKE_MESSAGES, WAKE_MISS_MAX, byWakeAge, cancelledSwarms, consumedScouts, idleBus, inFlightTasks, isInjectable, isSettled, migratePaneRoles, missionDone, paneRole, planGate, reviewedSha, sameCommit, staleChanges, staleClaims, unexpectedHeadMove, wakeDue, wakeKey, wakeMirror, type WakeState } from "./swarm";
import { newGroup, newPane, type LayoutNode, type Pane } from "./layout-tree";
import { approvalText, assignReviews, chatWakeRows, coldStartPane, coordinatorQuiesceDue, onCompletionCommands, stuckReviews, swarmCwd, type CoordQuiesce } from "./swarmDispatch";

const SIG = "task-1:open";
const state = (over: Partial<WakeState> = {}): WakeState => ({ sig: SIG, at: 0, misses: 0, ...over });

describe("host-dispatch wake pacing", () => {
  it("wakes on a pane that has never been woken, and on new work", () => {
    expect(wakeDue(undefined, SIG, 1000, false)).toBe(true);
    expect(wakeDue(state(), "task-2:open", 1000, false)).toBe(true);
  });

  it("stays quiet right after a delivered wake", () => {
    expect(wakeDue(state(), SIG, 5000, false)).toBe(false);
    expect(wakeDue(state(), SIG, 5000, true)).toBe(false);
  });

  it("re-fires an urgent (still-unclaimed) set on the fast gap, others on the slow one", () => {
    expect(wakeDue(state(), SIG, REWAKE_FAST_MS, true)).toBe(true);
    expect(wakeDue(state(), SIG, REWAKE_FAST_MS, false)).toBe(false);
    expect(wakeDue(state(), SIG, REWAKE_MS, false)).toBe(true);
  });

  it("retries immediately while the wake is unconfirmed — this is the builder-idle-with-open-task case", () => {
    expect(wakeDue(state({ misses: 1 }), SIG, 1000, true)).toBe(true);
    expect(wakeDue(state({ misses: 1 }), SIG, 1000, false)).toBe(true);
  });

  it("backs off to the slow gap once a pane has swallowed WAKE_MISS_MAX wakes", () => {
    const dead = state({ misses: WAKE_MISS_MAX });
    expect(wakeDue(dead, SIG, 1000, true)).toBe(false);
    expect(wakeDue(dead, SIG, REWAKE_FAST_MS, true)).toBe(false);
    expect(wakeDue(dead, SIG, REWAKE_MS, true)).toBe(true);
    expect(wakeDue(dead, "task-9:open", 1000, true)).toBe(true); // new work still gets through
  });
});

describe("plan gate", () => {
  const t = (over: Partial<{ key: string; role: string; status: string }> = {}) =>
    ({ key: "task-1", status: "open", ...over });

  it("holds builder tasks while note plan is missing — that claim would be rejected", () => {
    expect(planGate([t()], "").map((x) => x.key)).toEqual(["task-1"]);
    expect(planGate([t({ status: "blocked" })], "").map((x) => x.key)).toEqual(["task-1"]); // the dead-swarm shape
    expect(planGate([t({ role: "builder" })], "  \n ").map((x) => x.key)).toEqual(["task-1"]);
  });

  it("stays out of the way once the plan is up", () => {
    expect(planGate([t()], "task-1 do the thing")).toEqual([]);
  });

  it("ignores scout tasks (exempt server-side) and finished builder work", () => {
    expect(planGate([t({ role: "scout" })], "")).toEqual([]);
    expect(planGate([t({ status: "merged" })], "")).toEqual([]);
    // A cancelled task is as finished as a merged one: nagging the coordinator to
    // write a plan for work a human killed is exactly the treadmill this prevents.
    expect(planGate([t({ status: "cancelled" })], "")).toEqual([]);
  });
});

describe("settled statuses — the two a task never comes back from", () => {
  it("counts merged and cancelled, and nothing else", () => {
    expect(SETTLED_STATUSES).toEqual(["merged", "cancelled"]);
    for (const s of ["merged", "cancelled"]) expect(isSettled(s)).toBe(true);
    for (const s of ["open", "blocked", "claimed", "changes", "done", "approved", "malformed"]) {
      expect(isSettled(s)).toBe(false);
    }
  });

  it("keeps cancelled work out of the in-flight count, so it never holds a mission open", () => {
    expect(inFlightTasks([{ status: "cancelled" }])).toEqual([]);
    expect(missionDone("shipped", [{ status: "merged" }, { status: "cancelled" }])).toBe(true);
  });
});

describe("mission completion gate", () => {
  const t = (status: string) => ({ status });

  it("counts claimed/changes/done/approved as in flight, never open/blocked/merged", () => {
    expect(inFlightTasks([t("open"), t("blocked"), t("merged")])).toEqual([]);
    expect(inFlightTasks([t("claimed"), t("changes"), t("done"), t("approved")]).map((x) => x.status))
      .toEqual(["claimed", "changes", "done", "approved"]);
  });

  it("a result note only completes the mission once nothing is in flight", () => {
    expect(missionDone(undefined, [])).toBe(false); // no result — mission still running
    expect(missionDone("  \n", [t("merged")])).toBe(false); // a blank note is not a result
    // scope cut: tasks deliberately left open/blocked do not hold the mission hostage
    expect(missionDone("shipped", [t("merged"), t("open"), t("blocked")])).toBe(true);
    // the 8740 shape: coordinator declared victory while a changes-rework was mid-flight,
    // and the builder's later `done` landed in a swarm whose dispatcher had stopped
    for (const status of ["claimed", "changes", "done", "approved"]) {
      expect(missionDone("shipped", [t("merged"), t(status)])).toBe(false);
    }
  });
});

describe("on-mission-complete commands", () => {
  const NOTE = "echo mission done\nnotify-send 'swarm finished'";

  it("hands back the note's body on the mission's first done tick", () => {
    expect(onCompletionCommands(new Set(), "swarm-a", NOTE)).toBe(NOTE);
  });

  it("fires exactly once per swarm — the completed set is the gate", () => {
    const completed = new Set<string>();
    // Tick 1: the branch is entered (swarm not yet completed) and answers the hook.
    expect(onCompletionCommands(completed, "swarm-a", NOTE)).toBe(NOTE);
    // The branch adds the swarm to `completed` the moment it runs…
    completed.add("swarm-a");
    // …so every later tick of the same loop answers nothing, forever.
    expect(onCompletionCommands(completed, "swarm-a", NOTE)).toBeUndefined();
    expect(onCompletionCommands(completed, "swarm-a", NOTE)).toBeUndefined();
  });

  it("never fires for a swarm with no hook — a blank or missing note is not an empty run", () => {
    expect(onCompletionCommands(new Set(), "swarm-a", undefined)).toBeUndefined();
    expect(onCompletionCommands(new Set(), "swarm-a", "  \n\t ")).toBeUndefined();
  });

  it("gates per project — one swarm's completion never eats another's hook", () => {
    const completed = new Set<string>(["swarm-a"]);
    expect(onCompletionCommands(completed, "swarm-a", NOTE)).toBeUndefined();
    expect(onCompletionCommands(completed, "swarm-b", NOTE)).toBe(NOTE);
  });
});

describe("scout report retirement — the wake that never stopped", () => {
  const t = (key: string) => ({ key, status: "done", role: "scout" });
  const wake = (over: Partial<WakeState> = {}): WakeState => ({ sig: "task-1:done", at: 0, misses: 0, ...over });
  const later = WAKE_DELIVERY_MS + 1;

  it("retires a scout task once its wake landed and the coordinator went idle", () => {
    expect(consumedScouts([t("task-1")], wake(), later, true).map((x) => x.key)).toEqual(["task-1"]);
  });

  it("holds while the report may not have been read", () => {
    expect(consumedScouts([t("task-1")], undefined, later, true)).toEqual([]); // never woken
    expect(consumedScouts([t("task-1")], wake(), later, false)).toEqual([]); // still mid-turn
    expect(consumedScouts([t("task-1")], wake({ misses: 1 }), later, true)).toEqual([]); // wake never landed
    expect(consumedScouts([t("task-1")], wake(), WAKE_DELIVERY_MS - 1, true)).toEqual([]); // too soon to judge
  });

  it("only retires the tasks the wake actually covered", () => {
    // task-11 is not task-1: the sig is parsed, not substring-matched.
    const out = consumedScouts([t("task-1"), t("task-11"), t("task-2")], wake({ sig: "task-1:done,task-2:done" }), later, true);
    expect(out.map((x) => x.key)).toEqual(["task-1", "task-2"]);
  });

  it("leaves a retired scout task out of every in-flight count", () => {
    // The reason this matters beyond the repeat wake: `done` is in flight, so a
    // scout task nobody can settle holds missionDone and idleBus open forever.
    expect(inFlightTasks([{ status: "done" }])).toHaveLength(1);
    expect(missionDone("shipped", [{ status: "done" }])).toBe(false);
    expect(missionDone("shipped", [{ status: "merged" }])).toBe(true);
  });
});

describe("idle-bus gate — the swarm that is simply over", () => {
  const t = (status: string, key = "task-1") => ({ key, status });
  const PLAN = "task-1 do the thing";

  it("wakes the coordinator when every task is blocked and nothing is in flight", () => {
    // The live shape (6574): plan written, ONE task posted, left `blocked` per
    // the brief, and the coordinator never opened it. No status on the bus wakes
    // anybody, so without this the swarm is dead with a full plan in hand.
    const out = idleBus([t("blocked")], PLAN, undefined);
    expect(out?.kind).toBe("unblock");
    expect(out?.tasks.map((x) => x.key)).toEqual(["task-1"]);
    expect(WAKE_MESSAGES.unblock("task-1", "coordinator")).toContain("task_status open");
  });

  it("asks for the missing result note when everything merged", () => {
    expect(idleBus([t("merged"), t("merged", "task-2")], PLAN, undefined)?.kind).toBe("result");
    expect(idleBus([t("merged")], PLAN, "shipped it")).toBeNull(); // the note is there — missionDone owns it
    // A human cancelling the tail of a mission leaves the same finished bus: ask
    // for the result note rather than polling a swarm that will never move again.
    expect(idleBus([t("merged"), t("cancelled", "task-2")], PLAN, undefined)?.kind).toBe("result");
    expect(idleBus([t("cancelled")], PLAN, undefined)?.kind).toBe("result");
  });

  it("stays out of the way of every other gate", () => {
    expect(idleBus([], PLAN, undefined)).toBeNull(); // empty bus — cold start
    expect(idleBus([t("blocked")], "", undefined)).toBeNull(); // no plan — planGate
    expect(idleBus([t("blocked"), t("open", "task-2")], PLAN, undefined)).toBeNull(); // work is available
    for (const live of ["claimed", "changes", "done", "approved"]) {
      expect(idleBus([t("blocked"), t(live, "task-2")], PLAN, undefined)).toBeNull();
    }
    // Merged + blocked is a real wait (a successor nobody opened), not a finish.
    expect(idleBus([t("merged"), t("blocked", "task-2")], PLAN, undefined)?.kind).toBe("unblock");
  });
});

describe("silent rework — a `changes` task whose branch moved on", () => {
  const t = (over: Partial<{ key: string; status: string; owner: string; updated: number }> = {}) =>
    ({ key: "task-6", status: "changes", owner: "builder-1", updated: 0, ...over });
  const idleOwner = () => true;

  it("picks up handed-back tasks whose owner has gone quiet", () => {
    const now = STALE_CLAIM_MS + 1000;
    expect(staleChanges([t()], now, idleOwner).map((x) => x.key)).toEqual(["task-6"]);
    // Fresh hand-back, mid-turn owner, other statuses, no owner: all left alone.
    expect(staleChanges([t({ updated: now / 1000 })], now, idleOwner)).toEqual([]);
    expect(staleChanges([t()], now, () => false)).toEqual([]);
    expect(staleChanges([t({ status: "claimed" })], now, idleOwner)).toEqual([]);
    expect(staleChanges([t({ owner: "" })], now, idleOwner)).toEqual([]);
  });

  it("reads the reviewed commit out of the verdict line, whatever the verdict", () => {
    expect(reviewedSha("verdict: changes @ df399bb88907a7cb69f79e9dc2f3da7f60187618\n\nmap_screen.gd:36 …"))
      .toBe("df399bb88907a7cb69f79e9dc2f3da7f60187618");
    expect(reviewedSha("verdict: approved @ c15533e7")).toBe("c15533e7");
    // No SHA on the first line: fall back to the body rather than give up.
    expect(reviewedSha("verdict: changes\nthe commit I read was c15533e7")).toBe("c15533e7");
    expect(reviewedSha("verdict: changes — nothing works")).toBeUndefined();
    expect(reviewedSha(undefined)).toBeUndefined();
  });

  it("compares an abbreviated review SHA against a full branch tip", () => {
    expect(sameCommit("df399bb", "df399bb88907a7cb69f79e9dc2f3da7f60187618")).toBe(true);
    expect(sameCommit("DF399BB", "df399bb88907a7cb")).toBe(true);
    // The rescue case: the branch is at a DIFFERENT commit, so the rework exists.
    expect(sameCommit("df399bb", "e64bb98a1c2d3e4f")).toBe(false);
    expect(sameCommit(undefined, "e64bb98")).toBe(false);
    expect(sameCommit("abc", "abc")).toBe(false); // below git's abbreviation floor
  });
});

describe("guard breach — master moved and the host did not do it", () => {
  const at = (sha: string, subject: string) => ({ sha, subject, branch: "master" });

  const was = (sha: string, branch = "master") => ({ sha, branch });

  it("says nothing about a first sample, an unchanged HEAD, or the host's own merge", () => {
    expect(unexpectedHeadMove(undefined, at("aaa1111", "whatever"), false)).toBe(false);
    expect(unexpectedHeadMove(was("aaa1111"), at("aaa1111", "whatever"), false)).toBe(false);
    expect(unexpectedHeadMove(was("aaa1111"), at("bbb2222", "merge: task-6 (swarm)"), false)).toBe(false);
    // A host merge is in flight: HEAD legitimately moves under the sample.
    expect(unexpectedHeadMove(was("aaa1111"), at("bbb2222", "feat: whatever"), true)).toBe(false);
    // A branch switch in the root moves HEAD without anyone committing.
    expect(unexpectedHeadMove(was("aaa1111", "side"), at("bbb2222", "feat: whatever"), false)).toBe(false);
  });

  it("fires on a commit that landed on the root branch with no merge behind it", () => {
    // The live one: a builder committed its rework straight onto master, in the
    // root checkout, and it was found the next morning by reading a reflog.
    expect(unexpectedHeadMove(was("df399bb"), at("e64bb98", "fix task-6: address all 7 reviewer feedback items"), false)).toBe(true);
    // Near-misses that must not be mistaken for the host's own subject line.
    expect(unexpectedHeadMove(was("a"), at("b", "merge: task-6 (swarm) and some extra"), false)).toBe(true);
    // The subject is namespaced by swarm project now (merge_subject, swarm.rs) —
    // both forms are the host's, and nothing dressed up as one is.
    expect(unexpectedHeadMove(was("aaa1111"), at("bbb2222", "merge: task-6 (swarm repo-swarm-auth-1a2b)"), false)).toBe(false);
    expect(unexpectedHeadMove(was("a"), at("b", "merge: task-6 (swarm two words)"), false)).toBe(true);
    expect(unexpectedHeadMove(was("a"), at("b", "merge: task-6 (swarm repo-swarm-auth-1a2b) plus"), false)).toBe(true);
    expect(unexpectedHeadMove(was("a"), at("b", "Merge branch 'swarm/task-6'"), false)).toBe(true);
  });
});

describe("wake fairness (finding 1.7)", () => {
  // The queue is served until the turn budget is spent, so order IS priority.
  // It used to be positional: coordinator jobs were declared first, so at cap=1
  // a coordinator coming due every heartbeat took the only slot forever and the
  // builder wake behind it never fired.
  const jobs = [
    { kind: "merge", role: "coordinator" },
    { kind: "open", role: "builder-1" },
    { kind: "review", role: "reviewer" },
  ];

  it("serves the job that has waited longest, never-woken first", () => {
    const at: Record<string, number> = { merge: 9000, review: 5000 }; // "open" never fired
    expect(byWakeAge(jobs, (j) => at[j.kind]).map((j) => j.kind)).toEqual(["open", "review", "merge"]);
  });

  it("a job that just took the slot sinks behind the ones it was starving", () => {
    const at: Record<string, number> = { merge: 1000, open: 2000, review: 3000 };
    expect(byWakeAge(jobs, (j) => at[j.kind]).map((j) => j.kind)).toEqual(["merge", "open", "review"]);
    at.merge = 4000; // coordinator was just woken
    expect(byWakeAge(jobs, (j) => at[j.kind]).map((j) => j.kind)).toEqual(["open", "review", "merge"]);
  });

  it("keeps declaration order for jobs of the same age", () => {
    expect(byWakeAge(jobs, () => 1000).map((j) => j.kind)).toEqual(["merge", "open", "review"]);
    expect(byWakeAge(jobs, () => undefined).map((j) => j.kind)).toEqual(["merge", "open", "review"]);
  });
});

describe("coordinator cycle wipe — the reset that used to depend on the coordinator asking", () => {
  // Everything true: a merge was reported, the unblock chat was answered, the pane
  // has been quiet well past COORD_QUIESCE_MS and nothing is queued for it.
  const due = (over: Partial<CoordQuiesce> = {}): CoordQuiesce => ({
    selected: true, armed: true, idle: true, quietMs: 60_000,
    pendingWakes: 0, unseenChat: 0, parked: false, ...over,
  });

  it("wipes a selected coordinator once its post-merge cycle is over", () => {
    expect(coordinatorQuiesceDue(due())).toBe(true);
  });

  it("never touches a coordinator the human did not select for clearing", () => {
    expect(coordinatorQuiesceDue(due({ selected: false }))).toBe(false);
  });

  it("only fires on a cycle the host actually ended — never in an ordinary idle gap", () => {
    expect(coordinatorQuiesceDue(due({ armed: false }))).toBe(false);
  });

  it("waits out the turn: mid-turn, or quiet for less than the settle window", () => {
    expect(coordinatorQuiesceDue(due({ idle: false }))).toBe(false);
    expect(coordinatorQuiesceDue(due({ quietMs: 3_000 }))).toBe(false);
    // A pane that has never produced output is booting, not finished.
    expect(coordinatorQuiesceDue(due({ quietMs: 0 }))).toBe(false);
  });

  it("holds while anything is still queued for the coordinator", () => {
    expect(coordinatorQuiesceDue(due({ pendingWakes: 1 }))).toBe(false);
    expect(coordinatorQuiesceDue(due({ unseenChat: 1 }))).toBe(false);
  });

  it("skips a pane that is already wiped or not up — its prompt is parked", () => {
    expect(coordinatorQuiesceDue(due({ parked: true }))).toBe(false);
  });
});

describe("cancelling a swarm tears it down — the path that used to have no teardown at all", () => {
  const repoOf = (pairs: [string, string][]) => new Map(pairs);

  it("reports a swarm that vanished from the layout, and leaves the running ones alone", () => {
    const gone = cancelledSwarms(repoOf([["swarm-a", "/repo"], ["swarm-b", "/other"]]), new Set(["swarm-b"]));
    expect(gone).toEqual([{ project: "swarm-a", repo: "/repo", disarm: true }]);
  });

  it("keeps the guard armed while a sibling swarm is still running in the same repo", () => {
    // One lock and one pair of hooks per REPO: the first swarm to close must not
    // strip the seatbelt off the second.
    const gone = cancelledSwarms(repoOf([["swarm-a", "/repo"], ["swarm-b", "/repo"]]), new Set(["swarm-b"]));
    expect(gone).toEqual([{ project: "swarm-a", repo: "/repo", disarm: false }]);
  });

  it("disarms once the last swarm in a repo is gone, and reports both", () => {
    const gone = cancelledSwarms(repoOf([["swarm-a", "/repo"], ["swarm-b", "/repo"]]), new Set());
    expect(gone).toEqual([
      { project: "swarm-a", repo: "/repo", disarm: true },
      { project: "swarm-b", repo: "/repo", disarm: true },
    ]);
  });

  it("reports nothing while every swarm is still there", () => {
    expect(cancelledSwarms(repoOf([["swarm-a", "/repo"]]), new Set(["swarm-a"]))).toEqual([]);
    expect(cancelledSwarms(repoOf([]), new Set())).toEqual([]);
  });

  it("never disarms on a swarm whose repo was never sampled", () => {
    // No cwd was ever seen for it (a workspace closed before its first tick), so
    // there is no repo to disarm and nothing may be guessed.
    expect(cancelledSwarms(repoOf([["swarm-a", ""]]), new Set())).toEqual([{ project: "swarm-a", repo: "", disarm: false }]);
  });
});

describe("swarmCwd", () => {
  it("finds the repo directory from whichever agent pane carries it", () => {
    const p = (over: Partial<Pane>) => newPane({ title: "x", ...over });
    // No pane carries a cwd → "" (git actions no-op on it).
    expect(swarmCwd([p({}), p({})])).toBe("");
    // The first pane with a cwd answers, and a blank cwd is skipped.
    expect(swarmCwd([p({ cwd: "" }), p({ cwd: "/repo" }), p({ cwd: "/other" })])).toBe("/repo");
  });
});

describe("wake messages", () => {
  it("covers every kind the dispatcher can raise, as typeable single-line ASCII", () => {
    // "merge" is gone as a wake — the host merges directly instead of waking the
    // coordinator to run git; the coordinator is now nudged over chat.
    // "malformed" is the repair wake: a task note that lost its header is refused
    // to every other role, so nothing but this nag can move it off the bus.
    for (const kind of ["scout-done", "scout-open", "review", "changes", "open", "plan", "claim", "chat", "malformed"]) {
      const msg = WAKE_MESSAGES[kind];
      expect(msg, kind).toBeTypeOf("function");
      const text = msg("task-7", "builder-1");
      expect(text).toContain("task-7");
      expect(text, kind).toContain("builder-1"); // addressed: a scrollback holds other roles' words
      expect(isInjectable(text), text).toBe(true); // one line, printable ASCII — it is typed into a TUI
    }
  });
});

// FINDING 1.6: the mirror is reconciled from the tick's job list, and the paths
// that generate NO wakes (dispatch off, mission complete, brain down, empty bus)
// used to `continue` straight past the reconcile — so a finished swarm showed
// "wake due" forever. wakeMirror() makes "no dispatch = empty mirror" structural.
describe("wake mirror reconcile (finding 1.6)", () => {
  const jobs = [
    { kind: "merge", role: "coordinator", pending: [{ key: "task-1" }] },
    { kind: "open", role: "builder-1", pending: [{ key: "task-2" }] },
  ];

  it("mirrors exactly the jobs that have pending work on a live tick", () => {
    expect([...wakeMirror(jobs)]).toEqual([wakeKey("coordinator", "merge"), wakeKey("builder-1", "open")]);
  });

  it("drops a job whose work is gone, and one whose pane vanished", () => {
    expect([...wakeMirror([{ kind: "merge", role: "coordinator", pending: [] }])]).toEqual([]);
    expect([...wakeMirror([{ kind: "open", role: "", pending: [{ key: "task-2" }] }])]).toEqual([]);
  });

  it("INVARIANT: a swarm that generates no wakes reports nothing outstanding", () => {
    // mission complete / dispatch off / brain unreachable / empty task bus —
    // every one of those passes dispatching=false, whatever the last job list was.
    expect(wakeMirror(jobs, false).size).toBe(0);
  });
});

describe("typed pane roles (finding 1.4)", () => {
  it("reads the typed field and ignores the title entirely", () => {
    expect(paneRole({ role: "reviewer" })).toBe("reviewer");
    expect(paneRole({ role: "builder-12" })).toBe("builder-12");
    // A pane the human renamed keeps its role; a pane that only LOOKS like one has none.
    expect(paneRole({ role: "reviewer", title: "notes" } as { role: string })).toBe("reviewer");
    expect(paneRole({})).toBe("");
    expect(paneRole({ role: "builder" })).toBe("");
  });

  it("adopts the title as the role once, for layouts saved before the field existed", () => {
    const tree = (): LayoutNode => ({
      type: "split", id: "s", direction: "horizontal", ratio: 0.5,
      a: newGroup(newPane({ id: "a", title: "coordinator" })),
      b: newGroup(newPane({ id: "b", title: "Terminal 4" })),
    });
    const ws = [{ swarm: "swarm-x", root: tree() }, { swarm: undefined, root: tree() }];
    const out = migratePaneRoles(ws);
    const panes = (n: LayoutNode): Pane[] => (n.type === "tabs" ? n.tabs : [...panes(n.a), ...panes(n.b)]);
    expect(panes(out[0].root).map((p) => p.role)).toEqual(["coordinator", undefined]); // human's shell stays role-less
    expect(panes(out[1].root).map((p) => p.role)).toEqual([undefined, undefined]); // not a swarm workspace
    expect(migratePaneRoles(out)).toBe(out); // idempotent — a second pass changes nothing
  });
});

describe("stale claim recovery", () => {
  const NOW = 10_000_000;
  const old = (NOW - STALE_CLAIM_MS - 1000) / 1000; // brain stamps `updated` in epoch SECONDS
  const task = (over: Partial<{ key: string; status: string; owner: string; updated: number }> = {}) =>
    ({ key: "task-1", status: "claimed", owner: "builder-1", updated: old, ...over });
  const idle = () => true;

  it("flags a claim its owner walked away from", () => {
    expect(staleClaims([task()], NOW, idle).map((t) => t.key)).toEqual(["task-1"]);
  });

  it("leaves a fresh claim alone — that builder is just working", () => {
    expect(staleClaims([task({ updated: (NOW - 5000) / 1000 })], NOW, idle)).toEqual([]);
  });

  it("leaves a claim alone while its owner is mid-turn", () => {
    expect(staleClaims([task()], NOW, () => false)).toEqual([]);
  });

  it("ignores every other status, and claims with no owner to wake", () => {
    for (const status of ["open", "done", "approved", "merged", "changes", "blocked"])
      expect(staleClaims([task({ status })], NOW, idle)).toEqual([]);
    expect(staleClaims([task({ owner: "" })], NOW, idle)).toEqual([]);
  });
});

// Multi-reviewer fan-out: N reviewer panes share the "done" queue, and no task is
// ever handed to two of them (two agents on one diff, two racing verdict notes).
describe("reviewer fan-out", () => {
  const tasks = (...keys: string[]) => keys.map((key) => ({ key }));
  const REVIEWERS = ["reviewer-1", "reviewer-2", "reviewer-3"];
  const idle = () => true;

  it("gives every done task exactly one reviewer, spread evenly", () => {
    const out = assignReviews(REVIEWERS, tasks("task-1", "task-2", "task-3"), new Map(), idle);
    expect([...out.keys()].sort()).toEqual(["task-1", "task-2", "task-3"]);
    expect([...out.values()].sort()).toEqual(REVIEWERS); // one each — nobody doubled up
  });

  it("keeps a task with the reviewer that already has it (a re-wake must not hop panes)", () => {
    const first = assignReviews(REVIEWERS, tasks("task-1", "task-2"), new Map(), idle);
    const again = assignReviews(REVIEWERS, tasks("task-1", "task-2", "task-3"), first, idle);
    expect(again.get("task-1")).toBe(first.get("task-1"));
    expect(again.get("task-2")).toBe(first.get("task-2"));
    expect(again.get("task-3")).not.toBe(first.get("task-1"));
    expect(again.get("task-3")).not.toBe(first.get("task-2"));
  });

  it("balances new work against what each reviewer is already holding", () => {
    const prior = new Map([["task-1", "reviewer-1"], ["task-2", "reviewer-1"]]);
    const out = assignReviews(REVIEWERS, tasks("task-1", "task-2", "task-3", "task-4"), prior, idle);
    expect(out.get("task-3")).not.toBe("reviewer-1");
    expect(out.get("task-4")).not.toBe("reviewer-1");
    expect(out.get("task-3")).not.toBe(out.get("task-4"));
  });

  it("prefers a free reviewer, and still assigns when every one is busy", () => {
    const only2 = (r: string) => r === "reviewer-2";
    expect(assignReviews(REVIEWERS, tasks("task-1"), new Map(), only2).get("task-1")).toBe("reviewer-2");
    const none = assignReviews(REVIEWERS, tasks("task-1"), new Map(), () => false);
    expect(none.get("task-1")).toBe("reviewer-1"); // least-loaded takes it; the wake waits for it to go idle
  });

  it("re-homes a task whose reviewer pane is gone (reviewer count lowered)", () => {
    const prior = new Map([["task-1", "reviewer-3"]]);
    const out = assignReviews(["reviewer-1", "reviewer-2"], tasks("task-1"), prior, idle);
    expect(out.get("task-1")).toBe("reviewer-1");
  });

  it("forgets tasks that left the done queue", () => {
    const prior = new Map([["task-1", "reviewer-1"], ["task-9", "reviewer-2"]]);
    const out = assignReviews(REVIEWERS, tasks("task-1"), prior, idle);
    expect([...out.keys()]).toEqual(["task-1"]);
  });

  it("assigns nothing with reviewers:0 — the coordinator is the merge gate", () => {
    expect(assignReviews([], tasks("task-1"), new Map(), idle).size).toBe(0);
  });

  it("still works for a pre-multi-reviewer workspace carrying the bare role", () => {
    const out = assignReviews(["reviewer"], tasks("task-1", "task-2"), new Map(), idle);
    expect([...out.values()]).toEqual(["reviewer", "reviewer"]);
  });
});

describe("chat wakes read the brain's routed rows (B4)", () => {
  const row = (over: Partial<Parameters<typeof chatWakeRows>[0][number]> = {}) => ({
    key: "chat-coordinator-1", from: "coordinator", n: 1, to: "builder-1",
    targets: ["builder-1"], addressed: true, text: "do the thing", updated: 1, ...over,
  });

  it("wakes the addressed role and nobody else — targets come parsed from the brain", () => {
    const rows = [row({ targets: ["builder-1"] })];
    expect(chatWakeRows(rows, "builder-1")).toHaveLength(1);
    expect(chatWakeRows(rows, "builder-2")).toHaveLength(0);
    // a multi-target header reaches every role it names, and "all" reaches everyone
    const many = [row({ to: "builder-2|reviewer-1", targets: ["builder-2", "reviewer-1"] })];
    expect(chatWakeRows(many, "builder-2")).toHaveLength(1);
    expect(chatWakeRows(many, "reviewer-1")).toHaveLength(1);
    expect(chatWakeRows(many, "scout")).toHaveLength(0);
    expect(chatWakeRows([row({ targets: ["all"] })], "scout")).toHaveLength(1);
  });

  it("never wakes on your own message, and never on the human's (SwarmChat delivers those live)", () => {
    expect(chatWakeRows([row({ from: "scout", targets: ["all"] })], "scout")).toHaveLength(0);
    const human = [row({ key: "chat-human-3", from: "human", targets: ["all"] })];
    expect(chatWakeRows(human, "builder-1")).toHaveLength(0);
  });

  it("a headerless message does NOT wake the whole swarm — the explicit rule-2 decision", () => {
    // The brain reports a body with no "to:" line as targets ["all"] with
    // addressed:false. Waking on that would spend one model turn per pane on a
    // note nobody addressed, so the wake path keeps the old skip; the row is
    // still readable in the Coordinator tab.
    const loose = [row({ addressed: false, to: "all", targets: ["all"] })];
    for (const role of ["builder-1", "reviewer-1", "scout"]) expect(chatWakeRows(loose, role)).toHaveLength(0);
  });
});

describe("cold start on an empty task bus", () => {
  const coord = (over: Partial<Pane> = {}) => ({ id: "c", role: "coordinator", ...over } as Pane);

  it("briefs a headless coordinator whose brief is parked — the swarm-never-starts bug", () => {
    // Headless + host dispatch: the brief cannot ride the command line, so it is
    // parked. Nothing on the bus means no wake is generated, so before this the
    // coordinator was never briefed and no task was ever posted: deadlock.
    expect(coldStartPane([], coord({ pendingPrompt: "You are COORDINATOR..." }))?.id).toBe("c");
  });

  it("boots a coordinator still sitting on a parked boot command", () => {
    expect(coldStartPane([], coord({ pendingCommand: "claude '...'" }))?.id).toBe("c");
  });

  it("leaves a TUI coordinator alone — its brief was on its own command line", () => {
    expect(coldStartPane([], coord({ startupCommand: "claude '...'" }))).toBeUndefined();
  });

  it("does nothing once the bus has work — the normal wake path owns that", () => {
    expect(coldStartPane([{ status: "open" }], coord({ pendingPrompt: "brief" }))).toBeUndefined();
  });

  it("does nothing when the swarm has no coordinator pane", () => {
    expect(coldStartPane([], undefined)).toBeUndefined();
  });
});

// brain-findings 1.1 (code half): the human learns that a done task is sitting
// unreviewed from the strip, not from a coordinator turn spent narrating it.
describe("stuck-review telemetry", () => {
  const sec = (ms: number) => Math.floor(ms / 1000);
  const done = (key: string, doneAtMs: number) => ({ key, updated: sec(doneAtMs) });
  const assigned = new Map([["task-1", "reviewer-1"], ["task-2", "reviewer-2"]]);
  const idle = () => true;

  it("says nothing until the dispatcher itself would re-wake", () => {
    const now = 1_000_000;
    // Freshly done — the first review wake has only just gone out.
    expect(stuckReviews([done("task-1", now)], assigned, now, idle)).toEqual([]);
    expect(stuckReviews([done("task-1", now - REWAKE_FAST_MS + 1000)], assigned, now, idle)).toEqual([]);
    // At the fast gap the dispatcher starts re-waking, so the strip lights up.
    const at = now - REWAKE_FAST_MS;
    expect(stuckReviews([done("task-1", at)], assigned, now, idle)).toEqual([
      { task: "task-1", role: "reviewer-1", since: at },
    ]);
  });

  it("stays quiet while the assigned reviewer is actually mid-turn", () => {
    const now = 1_000_000;
    const at = now - REWAKE_FAST_MS * 3;
    // Busy = it IS reviewing; only a reviewer doing nothing is worth saying.
    expect(stuckReviews([done("task-1", at)], assigned, now, () => false)).toEqual([]);
  });

  it("reports one row per unreviewed task, oldest first, and skips unassigned ones", () => {
    const now = 1_000_000;
    const older = now - REWAKE_FAST_MS * 4;
    const newer = now - REWAKE_FAST_MS * 2;
    const rows = stuckReviews(
      [done("task-2", newer), done("task-1", older), done("task-9", older)],
      assigned,
      now,
      idle,
    );
    expect(rows).toEqual([
      { task: "task-1", role: "reviewer-1", since: older },
      { task: "task-2", role: "reviewer-2", since: newer },
    ]);
  });

  it("clears the moment the task leaves done — the strip is state, not a log", () => {
    // The caller passes only tasks that are still `done`, so a verdicted task
    // simply stops being reported and the row disappears.
    expect(stuckReviews([], assigned, 1_000_000, idle)).toEqual([]);
  });
});

describe("what the merge gate is handed as the approval", () => {
  const sha = "436beba165c224d67862cfc3ab785734b397fc20";
  const log = [
    "Create project scaffold.",
    "[done by builder-1] branch swarm/task-1: scaffold",
    "[changes by reviewer-1] project.godot: missing config/main_scene",
    "[done by builder-1] fixed review feedback",
    `[approved by reviewer-1] approved @ ${sha}`,
  ].join("\n");

  it("prefers the review note when it names a commit", () => {
    expect(approvalText(`verdict: approved @ c15533e7\nlooks fine`, log)).toContain("c15533e7");
  });

  it("falls back to the reviewer's approval line when the note carries no SHA", () => {
    // The deadlock this fixes: the brief asked for a SHA-less verdict note, so
    // the gate refused forever while the SHA sat in the task log all along.
    expect(approvalText("verdict: approved\nproject.godot: correct autoloads", log)).toBe(
      `[approved by reviewer-1] approved @ ${sha}`,
    );
  });

  it("ignores a builder approving its own work", () => {
    const self = `${log.split("\n").slice(0, 4).join("\n")}\n[approved by builder-1] approved @ ${sha}`;
    expect(approvalText("verdict: approved", self)).toBe("verdict: approved");
  });

  it("stays undefined with nothing to gate on — a no-reviewer swarm merges ungated, as before", () => {
    expect(approvalText(null, "just a description")).toBeUndefined();
    expect(approvalText("", "")).toBeUndefined();
  });
});
