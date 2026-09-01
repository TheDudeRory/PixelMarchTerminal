// Swarm telemetry — a READ-ONLY MIRROR of the cooldown state the four swarm
// watchers keep in hook-local closures (wakes Map in swarmDispatch, episodes Map
// in swarmNudge, RunawayWatch Map in swarmRunaway, busy Set in swarmReset).
// None of it was visible anywhere, so a human watching a quiet swarm could not
// tell "waiting out a 120s nudge cooldown" from "wedged". The hooks stay
// authoritative — they keep deciding, they just report what they decided here,
// and SwarmHealthStrip renders the countdowns.
//
// Keyed by "<workspace id>/<role>". The role alone is the one identifier all
// four watchers share (swarmReset only ever knows the role, never the pane id),
// and the WORKSPACE id — not the swarm project — scopes it: two workspaces open
// on the same swarm project used to clobber each other's cooldowns and reconcile
// each other's wakes (brain-findings 1.5). Entries are pruned by the reporters
// themselves (a pane that disappears stops being reported and its watcher clears
// its own map), plus dropWorkspace() when a workspace is closed.
// The turn budget stays keyed by PROJECT — it is a property of the swarm, not of
// the window looking at it.
import { create } from "zustand";
import { NUDGE_MAX, RUNAWAY_RESTART_MAX, onTurnBudget, wakeGap, wakeKey, type TurnBudget, type WakeState } from "../lib/swarm";

export { wakeKey } from "../lib/swarm"; // the mirror's key builder lives with wakeMirror()

/** One outstanding wake, per dispatch job kind ("open", "merge", "changes", …).
 *  `urgent` decides which re-wake gap applies, so it has to be mirrored too. */
export interface WakeMirror { at: number; misses: number; urgent: boolean }

/** One task that is FINISHED but has had no reviewer attention (brain-findings
 *  1.1). The dispatcher already knows this — it woke that reviewer and the task
 *  is still `done` a re-wake gap later — and the coordinator used to have to
 *  spend a turn narrating it to the human. `since` is when the task went done. */
export interface StuckReview { task: string; role: string; since: number }

/** Tracked files changed in the ROOT checkout while a swarm runs — an agent
 *  working outside its worktree. This is not cosmetic: the host REFUSES to merge
 *  over a dirty root, so every approved task stops landing until it clears, and
 *  the only signal used to be one chat line to the coordinator (which a human
 *  sees only if they open that pane). It blocked two merges for a whole mission
 *  before anyone noticed — note salvage-task-9-root-strays. */
export interface StrayEdits { files: string[]; since: number }

/** The root branch moved and the host did not merge it — someone got past the
 *  repo guard (it runs as the same user as every agent, so it can be sidestepped
 *  by anything determined enough). Unreviewed work is now on master and nothing
 *  else in the system shows it: the repo looks healthy and the stall shows up
 *  somewhere unrelated. The last one was found by a human reading a reflog the
 *  next morning. */
export interface GuardBreach { sha: string; subject: string; branch: string; at: number }

export interface PaneTelemetry {
  wakes: Record<string, WakeMirror>; // job kind → last wake sent
  nudge: { at: number; count: number } | null; // current error episode, null = tail is clean
  /** Busy-streak start + restarts used, plus whether the pane is COMPACTING its
   *  context right now — the state that stops a streak accruing at all, and the
   *  one a human staring at a frozen pane most needs named. */
  runaway: { since: number | null; restarts: number; compacting?: boolean };
  resetPending: boolean; // context wipe in flight (swarmReset)
}

const EMPTY: PaneTelemetry = { wakes: {}, nudge: null, runaway: { since: null, restarts: 0 }, resetPending: false };

/** `ws` is a WORKSPACE id, never a swarm project — see the header. */
export const paneKey = (ws: string, role: string) => `${ws}/${role}`;

interface TelemetryState {
  panes: Record<string, PaneTelemetry>;
  budgets: Record<string, TurnBudget>; // swarm project → concurrency cap (task-8)
  stuck: Record<string, StuckReview[]>; // WORKSPACE id → done tasks nobody is reviewing
  stray: Record<string, StrayEdits>; // WORKSPACE id → dirty root checkout
  breach: Record<string, GuardBreach>; // WORKSPACE id → last unexplained move of the root branch
  /** Reconciling: the list IS the current state, so an empty array clears. */
  setStuck(ws: string, rows: StuckReview[]): void;
  /** Record an unexplained root-branch move. STICKY on purpose — unlike stray
   *  edits there is nothing to "clear": the commit is in history whether or not
   *  the swarm keeps running, and a human has to decide what happens to it. Only
   *  a newer offending commit replaces it. */
  setBreach(ws: string, b: Omit<GuardBreach, "at">): void;
  /** Same contract: an empty list means the root is clean again. `since` is kept
   *  across reports of the SAME file set, so the strip can age it — a stray that
   *  has sat for ten minutes reads very differently from one a second old. */
  setStray(ws: string, files: string[]): void;
  reportWake(ws: string, role: string, kind: string, w: WakeState, urgent: boolean): void;
  clearWake(ws: string, role: string, kind: string): void;
  reportNudge(ws: string, role: string, ep: { at: number; count: number } | null): void;
  reportRunaway(ws: string, role: string, r: { since: number | null; restarts: number; compacting?: boolean }): void;
  reportReset(ws: string, role: string, pending: boolean): void;
  retainWakes(ws: string, live: Set<string>): void;
  setBudget(project: string, b: TurnBudget): void;
  /** Forget one workspace's panes; `project` also drops its budget mirror (pass
   *  it only when no other workspace is still on that swarm). */
  dropWorkspace(ws: string, project?: string): void;
}

/** Patch one pane's record, creating it on first report. Returns the same state
 *  object when nothing actually changed so React skips the re-render. */
function patch(
  state: TelemetryState,
  ws: string,
  role: string,
  fn: (t: PaneTelemetry) => PaneTelemetry,
): Partial<TelemetryState> | null {
  const key = paneKey(ws, role);
  const prev = state.panes[key] ?? EMPTY;
  const next = fn(prev);
  if (next === prev) return null;
  return { panes: { ...state.panes, [key]: next } };
}

export const useSwarmTelemetry = create<TelemetryState>((set) => ({
  panes: {},
  budgets: {},
  stuck: {},
  stray: {},
  breach: {},

  setBreach: (ws, b) =>
    set((s) => {
      const prev = s.breach[ws];
      if (prev && prev.sha === b.sha) return {}; // same commit — keep its age
      return { breach: { ...s.breach, [ws]: { ...b, at: Date.now() } } };
    }),

  setStray: (ws, files) =>
    set((s) => {
      const prev = s.stray[ws];
      if (files.length === 0) {
        if (!prev) return {};
        const stray = { ...s.stray };
        delete stray[ws];
        return { stray };
      }
      const sig = files.slice().sort().join("|");
      if (prev && prev.files.slice().sort().join("|") === sig) return {}; // same mess — keep its age
      return { stray: { ...s.stray, [ws]: { files, since: Date.now() } } };
    }),

  setStuck: (ws, rows) =>
    set((s) => {
      const sig = (x: StuckReview[]) => x.map((r) => `${r.task}@${r.role}@${r.since}`).join();
      const prev = s.stuck[ws];
      if ((prev ?? []).length === 0 && rows.length === 0) return {};
      if (prev && sig(prev) === sig(rows)) return {}; // unchanged — no re-render
      const stuck = { ...s.stuck };
      if (rows.length === 0) delete stuck[ws]; else stuck[ws] = rows;
      return { stuck };
    }),

  reportWake: (ws, role, kind, w, urgent) =>
    set((s) => patch(s, ws, role, (t) => {
      const cur = t.wakes[kind];
      if (cur && cur.at === w.at && cur.misses === w.misses && cur.urgent === urgent) return t;
      return { ...t, wakes: { ...t.wakes, [kind]: { at: w.at, misses: w.misses, urgent } } };
    }) ?? {}),

  clearWake: (ws, role, kind) =>
    set((s) => patch(s, ws, role, (t) => {
      if (!(kind in t.wakes)) return t;
      const wakes = { ...t.wakes };
      delete wakes[kind];
      return { ...t, wakes };
    }) ?? {}),

  reportNudge: (ws, role, ep) =>
    set((s) => patch(s, ws, role, (t) => {
      if (!ep && !t.nudge) return t;
      if (ep && t.nudge && t.nudge.at === ep.at && t.nudge.count === ep.count) return t;
      return { ...t, nudge: ep };
    }) ?? {}),

  reportRunaway: (ws, role, r) =>
    set((s) => patch(s, ws, role, (t) => {
      if (t.runaway.since === r.since && t.runaway.restarts === r.restarts && !!t.runaway.compacting === !!r.compacting) return t;
      return { ...t, runaway: { ...r } };
    }) ?? {}),

  reportReset: (ws, role, pending) =>
    set((s) => patch(s, ws, role, (t) => (t.resetPending === pending ? t : { ...t, resetPending: pending })) ?? {}),

  // Reconcile one tick's worth of wake jobs: any mirrored kind the dispatcher no
  // longer has a job for is gone (its tasks were merged), so drop it. Without
  // this the strip shows "wake due" forever on a finished, fully idle swarm —
  // the dispatcher only ever deletes a wake when the injection FAILED.
  retainWakes: (ws, live) =>
    set((s) => {
      const prefix = `${ws}/`;
      let panes: Record<string, PaneTelemetry> | null = null;
      for (const [k, t] of Object.entries(s.panes)) {
        if (!k.startsWith(prefix)) continue;
        const role = k.slice(prefix.length);
        const keep = Object.keys(t.wakes).filter((kind) => live.has(wakeKey(role, kind)));
        if (keep.length === Object.keys(t.wakes).length) continue;
        const wakes: Record<string, WakeMirror> = {};
        for (const kind of keep) wakes[kind] = t.wakes[kind];
        panes = panes ?? { ...s.panes };
        panes[k] = { ...t, wakes };
      }
      return panes ? { panes } : {};
    }),

  setBudget: (project, b) =>
    set((s) => {
      const prev = s.budgets[project];
      const starvedSig = (x: TurnBudget["starved"]) => x.map((e) => `${e.title}@${e.since}`).join();
      if (prev && prev.cap === b.cap && prev.inFlight === b.inFlight && prev.busy.join() === b.busy.join() && starvedSig(prev.starved) === starvedSig(b.starved)) return {};
      return { budgets: { ...s.budgets, [project]: b } };
    }),

  dropWorkspace: (ws, project) =>
    set((s) => {
      const prefix = `${ws}/`;
      const panes: Record<string, PaneTelemetry> = {};
      for (const [k, v] of Object.entries(s.panes)) if (!k.startsWith(prefix)) panes[k] = v;
      const stuck = { ...s.stuck };
      delete stuck[ws];
      const stray = { ...s.stray };
      delete stray[ws];
      const breach = { ...s.breach };
      delete breach[ws];
      if (!project) return { panes, stuck, stray, breach };
      const budgets = { ...s.budgets };
      delete budgets[project];
      return { panes, budgets, stuck, stray, breach };
    }),
}));

/** Read one pane's mirror without subscribing to the whole map. */
export function paneTelemetry(ws: string, role: string): PaneTelemetry {
  return useSwarmTelemetry.getState().panes[paneKey(ws, role)] ?? EMPTY;
}

/** The pane's mirror, or a blank one — for render paths that must not care
 *  whether a watcher has reported anything yet. */
export const EMPTY_TELEMETRY: PaneTelemetry = EMPTY;

/** The TERMINAL give-up state (brain-findings 1.15): both recovery watchers have
 *  a hard budget (NUDGE_MAX nudges per API-error episode, RUNAWAY_RESTART_MAX
 *  abort+re-brief cycles) and simply stop when it is spent. Nothing then touches
 *  that pane again — it is wedged until a human looks — so the UI has to say so
 *  out loud instead of leaving a quiet chip. Returns a human sentence, or null.
 *
 *  Both halves must describe the pane RIGHT NOW, not the budget it once spent.
 *  The nudge half self-heals (the episode is cleared when the error scrolls
 *  away), but `restarts` is never reset — scanForRunaways only ever nulls
 *  `since` on the idle path (swarm.ts) and drops the watch entry when the pane
 *  disappears. So a spent runaway budget alone would light the banner for the
 *  rest of the session, including after a re-brief that worked, and "wedged"
 *  outranks every other health state in the strip. A permanently-lit NEEDS A
 *  HUMAN banner is the alarm fatigue 1.15 existed to kill. Gate on `since`:
 *  it is non-null exactly while the frozen busy streak is still running. */
export function gaveUp(t: PaneTelemetry): string | null {
  if (t.nudge && t.nudge.count >= NUDGE_MAX)
    return `${NUDGE_MAX} auto-nudges used on an API error and it is still stalled — the nudge watcher gave up`;
  if (t.runaway.restarts >= RUNAWAY_RESTART_MAX && t.runaway.since !== null)
    return `${RUNAWAY_RESTART_MAX} runaway restarts used — the watchdog will not abort this pane again`;
  return null;
}

/** When the next re-wake for this pane becomes due (soonest across job kinds),
 *  or null when nothing is pending. Mirrors wakeDue()'s gap rule via wakeGap. */
export function nextWakeAt(t: PaneTelemetry): number | null {
  let soonest: number | null = null;
  for (const w of Object.values(t.wakes)) {
    const due = w.at + wakeGap(w.misses, w.urgent);
    if (soonest === null || due < soonest) soonest = due;
  }
  return soonest;
}

/** Highest undelivered-wake count across job kinds — >0 means wakes are being
 *  typed into a TUI that is dropping them. */
export function wakeMisses(t: PaneTelemetry): number {
  return Object.values(t.wakes).reduce((max, w) => Math.max(max, w.misses), 0);
}

// The concurrency cap (task-8) is already published by swarm.ts's own tiny
// pub/sub; bridge it in here so the UI has ONE place to read swarm telemetry.
// Module-level and idempotent — no component owns this subscription.
onTurnBudget((project, b) => useSwarmTelemetry.getState().setBudget(project, b));
