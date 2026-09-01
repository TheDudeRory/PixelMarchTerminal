// Stateless-worker context resets (swarm). An agent that finishes a cycle posts
// a reset-<role> note (per its brief); this watcher consumes the note, wipes the
// pane's CLI context (/clear, /new — per CLI) and arranges for the role prompt to
// come back, so every cycle starts with a fresh context window. All durable state
// lives in BigBrain notes, never in the terminal's context. Runs for every swarm
// workspace, active or not — panes keep working in the background.
//
// Under host dispatch the re-brief is DEFERRED: the prompt is parked in the pane's
// pendingPrompt and swarmDispatch types it only when work for that role exists.
// Re-briefing straight after the wipe cost a full turn per cycle for an agent whose
// brief just tells it to stop — with one builder that meant two agents thinking at
// once for no reason. Without dispatch (agents poll themselves) the prompt is
// re-sent immediately, since nothing else would ever send it.
//
// Timing is idle-gated, not fixed sleeps: the agent posts the reset note from a
// tool call MID-turn and keeps streaming afterwards, and a busy TUI (opencode,
// codex) discards input injected during a turn or a session switch. So we wait
// for the PTY to go quiet before the wipe AND before the re-brief, and send the
// submitting Enter separately (twice — a second Enter on an already-submitted
// prompt is a no-op, but it rescues a prompt left sitting in the input box).
import { useEffect } from "react";
import { brainChatSend, brainDelete, brainFeedNow, brainReclaimTask, brainTaskStatus, brainUrl, subscribeBrainFeed, ptyWrite } from "./ipc";
import { collectPanes, isTerminal } from "./layout-tree";
import { lastOutputAt, restartTerminal } from "./terminalPool";
import { subscribeAgentEvents, turnActive } from "./agentEvents";
import { isStreamPane, notePromptSent, paneOpen, paneTurnActive, userMessageFrame, waitForStreamPane } from "./agentStream";
import { bootPrompt, clearRolesOf, clearsRole, forceTurnSlot, hasHooks, interruptKey, paneRole, releaseTurnSlot, resetCommand, takeTurnSlot } from "./swarm";
import { useLayout } from "../stores/layout";
import { useSwarmTelemetry } from "../stores/swarmTelemetry";

const POLL_MS = 4000;
const IDLE_QUIET_MS = 3000; // no PTY output for this long = turn/redraw finished
const IDLE_POLL_MS = 400;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The pane's CLI, for the capability lookup — hooks are per CLI, not per pane. */
interface IdleCtx { project: string; role: string; command: string }

/** Resolve when the pane's turn is over. Two signals, in order:
 *   1. the CLI's own turn-end hook (agentEvents), when this CLI has hooks — an
 *      exact boundary, so a busy pane is never mistaken for a finished one and
 *      the /clear is never typed into a live turn;
 *   2. output-quiet for IDLE_QUIET_MS, the only signal a hookless TUI gives
 *      (busy TUIs animate a spinner, so "quiet" tracks turn end).
 *  Returns false if capMs elapsed with the pane still busy — the caller then
 *  falls back to interrupt-then-wait, unchanged. `ctx` omitted = signal 2 only,
 *  i.e. exactly the behaviour every caller had before Phase A. */
async function waitForIdle(paneId: string, capMs: number, ctx?: IdleCtx): Promise<boolean> {
  const hooks = !!ctx && hasHooks(ctx.command);
  const start = Date.now();
  while (Date.now() - start < capMs) {
    // A headless pane's own stream is the strongest signal there is — the CLI
    // emits a result object when the turn ends, so there is no window in which
    // "quiet" has to stand in for "finished". Checked before the hook channel
    // because it is the same fact without the poll latency.
    if (isStreamPane(paneId)) {
      const streaming = paneTurnActive(paneId);
      if (streaming === false) return true;
      if (streaming === true) { await sleep(IDLE_POLL_MS); continue; }
    }
    if (hooks) {
      const active = turnActive(ctx!.project, ctx!.role);
      if (active === false) return true; // the agent said so — no timer needed
      if (active === true) { await sleep(IDLE_POLL_MS); continue; } // mid-turn, and we KNOW it
    }
    const last = lastOutputAt(paneId);
    if (!last || Date.now() - last >= IDLE_QUIET_MS) return true;
    await sleep(IDLE_POLL_MS);
  }
  return false;
}

/** Type text and submit it as its own message. The Enter goes in a separate PTY
 *  write: a CR bundled in the same chunk as text reads as a pasted newline to a
 *  TUI input box (claude, opencode), so the line never submits and the NEXT
 *  injection concatenates onto it. Second Enter is a rescue — no-op if the
 *  first one submitted, submits a prompt left sitting in the input box. */
export async function submitPrompt(paneId: string, text: string): Promise<void> {
  await ptyWrite(paneId, text);
  await sleep(300);
  await ptyWrite(paneId, "\r");
  await sleep(1000);
  await ptyWrite(paneId, "\r");
}

/** Deliver a prompt to a HEADLESS pane: one stream-json message object, one
 *  write, done. None of `submitPrompt`'s choreography applies — the pauses and
 *  the two Enters exist because a TUI input box can eat a line typed mid-redraw,
 *  and a JSON reader on the far end of a pipe cannot.
 *
 *  It also FAILS LOUDLY where the TUI path cannot afford to. The host drops a
 *  write to an id it has no session for, and says nothing — the wake would look
 *  delivered and the pane would sit silent forever. That window is real: a
 *  context reset RESTARTS the pane, and `pty_open` resolves asynchronously.
 *  Throwing hands the turn slot back and puts the failure where a caller can
 *  act on it.
 *
 *  It does NOT wait for the agent to look ready, because it never will: VERIFIED
 *  on claude 2.1.218, the CLI emits its `system/init` object only after reading
 *  a first message, so a readiness gate on the first send deadlocks. Writing
 *  early is how the CLI is meant to be driven — the bytes wait in the pipe. */
async function submitStreamPrompt(paneId: string, text: string): Promise<void> {
  if (!paneOpen(paneId)) throw new Error(`headless pane ${paneId} has no open session on the host`);
  await ptyWrite(paneId, userMessageFrame(text));
  notePromptSent(paneId); // only AFTER the write landed — this is the turn boundary
}

/** THE one place that decides how a prompt reaches a pane. Both injection
 *  funnels below go through it, so a headless pane can never be typed at and a
 *  TUI can never be handed JSON. */
const sendPrompt = (paneId: string, text: string): Promise<void> =>
  isStreamPane(paneId) ? submitStreamPrompt(paneId, text) : submitPrompt(paneId, text);

// ── the FENCE ───────────────────────────────────────────────────────────────
// A role is fenced while the host is taking work away from it: for that window
// no wake, nudge, chat delivery or boot brief may start it on another turn.
// It is what makes `reclaimScope` below ONE operation rather than two — without
// it, the moment between "the bus says the task is someone else's" and "this
// pane's context is wiped" is a window in which the losing builder can be woken
// and keep editing the scope it just lost, which is exactly the duplication
// brain-findings 2.2 is about (a chat "please stop" arrived after the second
// builder had already started; chat is not a lock).
//
// In-process and synchronous ON PURPOSE. Every injection path in the app goes
// through injectPrompt() in this module, so a plain Set consulted there closes
// the window with no round-trip that could itself be the race.
const fenced = new Set<string>(); // "<project>/<role>" — no turns may be injected

const fenceTag = (project: string, role: string) => `${project}/${role}`;
export const fenceRole = (project: string, role: string): void => { fenced.add(fenceTag(project, role)); };
export const unfenceRole = (project: string, role: string): void => { fenced.delete(fenceTag(project, role)); };
export const isFenced = (project: string, role: string): boolean => fenced.has(fenceTag(project, role));
/** Test seam only — the app never clears every fence at once. */
export const clearFences = (): void => fenced.clear();

/** THE funnel. Every prompt injected into a swarm pane — a [host] wake, a
 *  nudge, a runaway re-brief, a post-reset role prompt — goes through here so
 *  it is charged against the ONE app-global turn budget (swarm.ts). Before
 *  this existed only the dispatch loop took slots, and swarmNudge /
 *  swarmRunaway / this file called submitPrompt directly: a nudge landing next
 *  to a live wake pushed a cap=1 endpoint to two concurrent completions, which
 *  is the failure the cap exists to prevent.
 *  Returns false when the budget is spent — the caller skips and retries on its
 *  own next tick (task claims stay the collision guard, so a skipped injection
 *  costs nothing but latency). A failed send hands the slot straight back.
 *  A FENCED role is refused here and nowhere else: this is the one place a pane
 *  can be given a new turn, so one check covers wakes, chat, nudges and boot
 *  briefs. The reset path (injectPromptWaiting) is deliberately NOT fenced — it
 *  is how the fenced pane gets wiped. */
export async function injectPrompt(project: string, paneId: string, title: string, text: string): Promise<boolean> {
  if (isFenced(project, title)) return false; // scope is being taken off this role — no new turn
  if (!takeTurnSlot(project, title)) return false;
  try {
    await sendPrompt(paneId, text);
    return true;
  } catch (e) {
    releaseTurnSlot(project, title); // no turn was started
    throw e;
  }
}

/** Same funnel, but for an injection that MUST happen: the context-reset
 *  sequence has already consumed its reset-<role> note, so dropping the
 *  re-brief would strand the agent with a wiped context and nothing to read
 *  (same for a runaway restart, whose turn has just been aborted).
 *  Waits for a slot, and after `waitMs` proceeds anyway — a budget overrun for
 *  one turn is strictly better than a permanently dead pane. The overrun is
 *  FORCE-RECORDED (forceTurnSlot) rather than taken silently: an untracked turn
 *  is invisible to liveTurns(), so the budget would let a further pane in on top
 *  of it, and nothing would ever expire it. */
export async function injectPromptWaiting(project: string, paneId: string, title: string, text: string, waitMs = 60_000): Promise<void> {
  const start = Date.now();
  let took = false;
  while (!(took = takeTurnSlot(project, title)) && Date.now() - start < waitMs) await sleep(IDLE_POLL_MS);
  if (!took) forceTurnSlot(project, title); // over the cap on purpose — but counted and aged out
  await sendPrompt(paneId, text).catch((e) => { releaseTurnSlot(project, title); throw e; });
}

/** Wipe the pane's CLI context. Re-briefing is the CALLER's business: under host
 *  dispatch the role prompt is parked (pendingPrompt) and only typed in when work
 *  for that role actually exists, so a cleared agent burns zero turns while idle. */
/** `hard` = do not wait out the current turn. A reclaim cannot politely wait up
 *  to 60 s for the losing builder to finish what it is doing — that turn is the
 *  work being taken away — so it aborts the turn up front instead. Headless
 *  panes are hard either way: their reset is a process kill. */
export async function rebrief(paneId: string, startupCommand: string, project: string, url: string, role: string, dispatch: boolean, hard = false): Promise<void> {
  // Both injections below go through the funnel: the /clear starts a session
  // switch and the role prompt starts a real turn, so both belong to the budget.
  // The agent may still be streaming the tail of its turn after posting the
  // reset note — wiping mid-turn loses the injected prompt on session switch.
  const ctx: IdleCtx = { project, role, command: startupCommand };
  // HEADLESS PANES take the whole path below in one step. There is no REPL to
  // type `/clear` into and no input box to lose a keystroke in: a fresh context
  // is a fresh SESSION, and a fresh session is a new process — the CLI mints a
  // new session id on every start unless told to `--resume`, which the boot
  // command never says. Restarting also settles the mid-turn case for free: the
  // interrupt key is a TUI concept, and the kill that restarts the pane is a
  // real signal to the process group, which is the only thing a piped child
  // listens to. So no idle wait, no interrupt, no wipe command.
  if (isStreamPane(paneId)) {
    restartTerminal(paneId); // kill_tree on the old process, respawn, new session
    if (!await waitForStreamPane(paneId, 30_000, IDLE_POLL_MS)) {
      // Respawn is still not up. Sending now would throw ("no open session"),
      // and the reset-<role> note has ALREADY been consumed — the throw is
      // swallowed by the watcher, so the agent would come back with a wiped
      // context, no brief, and nothing that would ever brief it again. Park it:
      // the boot-brief effect below (and swarmDispatch under dispatch) delivers
      // a pendingPrompt as soon as the pane's session is open.
      useLayout.getState().patchPaneAnywhere(paneId, { pendingPrompt: bootPrompt(project, url, role) });
      return;
    }
    return deliver(paneId, project, url, role, dispatch);
  }
  if (hard) {
    // Take the turn away NOW. Same two writes as the timeout path below, just
    // without first giving the pane a minute to keep working the scope.
    await ptyWrite(paneId, interruptKey(startupCommand));
    await waitForIdle(paneId, 15_000);
  } else {
    const idle = await waitForIdle(paneId, 60_000, ctx);
    if (!idle) {
      // Turn never ended (agent drifted into a /wait poll loop after posting the
      // reset note; a spinner keeps the PTY noisy forever). A TUI queues anything
      // injected mid-turn — the /clear included — so abort the turn first.
      await ptyWrite(paneId, interruptKey(startupCommand));
      // No ctx on purpose: an ABORTED turn may never fire its end hook, so the
      // event would say "still mid-turn" forever. Quiet timer only, as before.
      await waitForIdle(paneId, 15_000);
    }
  }
  const clear = resetCommand(startupCommand);
  if (clear) {
    await injectPromptWaiting(project, paneId, role, clear);
    // Also no ctx: this waits for a REDRAW, not for a turn — the last turn-end
    // already fired, so an event-driven answer would return before the session
    // switch finished and the re-brief could land in the wipe.
    await waitForIdle(paneId, 15_000); // let the wipe / new-session redraw settle
  }
  return deliver(paneId, project, url, role, dispatch);
}

/** Where the role prompt goes after a wipe: parked under host dispatch, sent
 *  now without it. Shared by both wipe paths so they cannot drift. */
async function deliver(paneId: string, project: string, url: string, role: string, dispatch: boolean): Promise<void> {
  const prompt = bootPrompt(project, url, role);
  if (dispatch) {
    // Poll-free swarm: an agent re-briefed now would spend a turn reading its
    // brief just to learn it has nothing to do. Park the prompt instead —
    // swarmDispatch types it the moment this role has actionable state, so with
    // one builder exactly one agent is ever mid-turn.
    useLayout.getState().patchPaneAnywhere(paneId, { pendingPrompt: prompt });
    return;
  }
  await injectPromptWaiting(project, paneId, role, prompt);
}

/** Force a pane's context wipe NOW, without waiting for the agent to ask.
 *  The dispatcher calls this the moment a builder's task leaves its hands
 *  (done → the reviewer/host owns it): a wiped-then-parked agent physically
 *  cannot keep editing the task it already finished, which is the failure this
 *  whole rewrite exists to end (finding-builder-continues-after-done). Same
 *  `rebrief` path a self-requested reset takes — headless panes restart, TUI
 *  panes interrupt+/clear — so the agent comes back clean and, under host
 *  dispatch, idle until it is woken for real work. Idempotent per (project,
 *  role) via `inflight`; a no-op for a pane that no longer exists. */
/*  Returns whether the wipe actually happened: `reclaimScope` below has to know,
 *  because a reclaim whose pane was never wiped must NOT drop its fence. Callers
 *  that only quiesce a finished builder can keep ignoring it — the next tick
 *  re-evaluates. A re-entrant call (already resetting this role) reports false:
 *  it did not perform the wipe, the call that owns the tag does. */
const forcedResets = new Set<string>();
export async function forceReset(project: string, paneId: string, startupCommand: string, url: string, role: string, dispatch: boolean, hard = false): Promise<boolean> {
  const tag = `${project}/${role}`;
  if (forcedResets.has(tag)) return false;
  forcedResets.add(tag);
  try {
    await rebrief(paneId, startupCommand, project, url, role, dispatch, hard);
    return true;
  } catch {
    /* pane gone or write failed — the next tick re-evaluates */
    return false;
  } finally {
    forcedResets.delete(tag);
  }
}

/** The pane a reclaim takes the scope AWAY from. Undefined when that builder's
 *  pane is gone (workspace edited, swarm shrunk) — then there is nothing to
 *  fence and the bus flip alone is the whole operation. */
export interface ReclaimLoser { paneId: string; role: string; startupCommand: string; dispatch: boolean }

export interface ReclaimOutcome {
  ok: boolean;
  /** The brain refused it (task already done/approved/merged, gone, unwritable).
   *  Permanent: the request must be consumed and reported, never retried. */
  refused?: boolean;
  reason?: string;
  /** The bus flip landed but the losing pane could not be wiped. The fence is
   *  HELD (that pane still cannot be given a turn) and the caller retries. */
  fencedOpen?: boolean;
  from?: string;
  to?: string;
}

/** RECLAIM SCOPE — the whole of brain-findings 2.2, as one host operation.
 *
 *  The incident: a coordinator noticed two builders on one task and chatted
 *  "please stop"; it arrived after the second builder had already started, and
 *  the work was done twice. The fix is not a better message — it is that
 *  reassignment stops being a message at all. Here the losing builder is
 *  FENCED first (no injection path can give it another turn), the bus flip
 *  happens second, and its context is wiped third, and the fence spans all
 *  three, so there is no instant at which the task belongs to someone else
 *  while its old owner is still free to take a turn.
 *
 *  Partial failure never leaves the task half-reclaimed:
 *   · flip refused/failed  → fence dropped, nothing changed at all (`refused`);
 *   · flip ok, wipe failed → fence HELD, so the loser is still frozen out; the
 *     caller retries the wipe on its next tick (`fencedOpen`). */
export async function reclaimScope(
  project: string,
  task: string,
  to: string,
  loser: ReclaimLoser | undefined,
  url: string,
): Promise<ReclaimOutcome> {
  if (loser) fenceRole(project, loser.role); // BEFORE the flip — this is the lock
  let flip: Awaited<ReturnType<typeof brainReclaimTask>>;
  try {
    flip = await brainReclaimTask(project, task, to);
  } catch (e) {
    if (loser) unfenceRole(project, loser.role); // nothing changed on the bus
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
  if (!flip?.ok) {
    if (loser) unfenceRole(project, loser.role);
    return { ok: false, refused: true, reason: flip?.reason ?? flip?.error ?? "the brain refused the reclaim" };
  }
  if (!loser) return { ok: true, from: flip.from, to: flip.to }; // no pane to wipe
  // `hard`: the turn being aborted is the work we are taking away.
  const wiped = await forceReset(project, loser.paneId, loser.startupCommand, url, loser.role, loser.dispatch, true);
  if (!wiped) return { ok: false, fencedOpen: true, from: flip.from, to: flip.to, reason: "the losing pane could not be wiped — it stays fenced" };
  unfenceRole(project, loser.role);
  return { ok: true, from: flip.from, to: flip.to };
}

/** CANCEL A TASK — the human's stop button, from the mission board.
 *
 *  Same shape as `reclaimScope` and for the same reason: moving the bus is the
 *  easy half. A task marked cancelled while its builder is mid-turn, with nothing
 *  else done, is the "please stop" chat message all over again — the pane keeps
 *  editing scope the human just killed, and posts `done` into a task that no
 *  longer exists. So the owner is FENCED first (no injection path can hand it
 *  another turn), the bus flip happens second, and its context is wiped third.
 *
 *  What this deliberately does NOT do is touch git. The branch `swarm/<task>` and
 *  its worktree are left exactly where they are: cancelling ends an agent's work,
 *  it does not throw away commits — a human who cancels a half-finished task can
 *  still read, keep or delete that branch. (Merge cleanup is the only path that
 *  removes a worktree, and it only does so after the work has landed.)
 *
 *  The COORDINATOR is never wiped, even when it owns the task: its context is the
 *  mission plan, and a cancel is a re-plan, not a restart. It is told in chat
 *  instead — which is also how it learns about any other role's cancelled task.
 *
 *  Partial failure never leaves a task half-cancelled:
 *   · flip refused/failed  → fence dropped, nothing changed at all (`refused`);
 *   · flip ok, wipe failed → fence HELD, the owner is still frozen out, and the
 *     caller may retry (`fencedOpen`). The bus already says cancelled either way. */
export interface CancelOutcome {
  ok: boolean;
  /** The brain refused the write (no such task, unwritable store). Permanent. */
  refused?: boolean;
  reason?: string;
  /** Cancelled on the bus, but the owner's pane could not be wiped — it stays fenced. */
  fencedOpen?: boolean;
}

export async function cancelTask(
  project: string,
  task: string,
  owner: ReclaimLoser | undefined,
  url: string,
  why?: string,
): Promise<CancelOutcome> {
  // The coordinator plans the mission; wiping it to cancel one task would cost
  // the plan. Only a worker pane is fenced and reset.
  const wipe = owner && owner.role !== "coordinator" ? owner : undefined;
  if (wipe) fenceRole(project, wipe.role); // BEFORE the flip — this is the lock
  const reason = why?.trim();
  const log = `host: cancelled by the human from the mission board${reason ? ` — ${reason}` : ""}. `
    + `Nobody works this task again; its branch and worktree (if any) were left in place for the human.`;
  let out: Record<string, unknown> | undefined;
  try {
    out = await brainTaskStatus(project, task, "cancelled", log);
  } catch (e) {
    if (wipe) unfenceRole(project, wipe.role); // nothing changed on the bus
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
  if (out?.ok !== true) {
    if (wipe) unfenceRole(project, wipe.role);
    return { ok: false, refused: true, reason: String(out?.reason ?? out?.error ?? "the brain refused the cancel") };
  }
  // Told AFTER the flip: the coordinator re-plans around a bus that already says
  // cancelled, so it can never read this message and then claim otherwise.
  brainChatSend(
    project,
    "host",
    "coordinator",
    `${task} was CANCELLED by the human at the mission board${reason ? `: ${reason}` : ""}. `
      + `It will not be claimed, re-opened or worked again — the brain refuses all three. `
      + `${wipe ? `${wipe.role} was stopped and its context wiped. ` : ""}`
      + `Re-plan around it: unblock whatever waited on it or drop those tasks, and keep note "plan" authoritative.`,
  ).catch(() => {});
  if (!wipe) return { ok: true };
  // `hard`: the turn being aborted is the work being cancelled.
  const wiped = await forceReset(project, wipe.paneId, wipe.startupCommand, url, wipe.role, wipe.dispatch, true);
  if (!wiped) return { ok: true, fencedOpen: true, reason: `${wipe.role} could not be wiped — it stays fenced` };
  unfenceRole(project, wipe.role);
  return { ok: true };
}

export function useSwarmReset() {
  useEffect(() => {
    const busy = new Set<string>(); // "<project>/<role>" mid-reset — no double-fire
    // Key list off the shared feed (lib/ipc): this watcher only ever needed the
    // NAMES of the reset-<role> notes, and it was calling brainKeys per project on
    // its own 4 s timer next to four other pollers asking the same project the
    // same things. It subscribes for keys only (no task bus, no bodies), and
    // brainDelete below drops the consumed key from the feed at once, so a reset
    // it has already handled can never come back on the next tick.
    // hiddenMs === intervalMs: agents keep resetting while the window is hidden.
    const subs = new Map<string, () => void>();
    const events = new Map<string, () => void>(); // agent-event pollers, one per watched swarm
    const watchFeed = (project: string) => {
      if (subs.has(project)) return;
      subs.set(project, subscribeBrainFeed(project, { intervalMs: POLL_MS, hiddenMs: POLL_MS, tasks: false }, () => {}));
      // Turn boundaries for waitForIdle, when the pane's CLI reports them.
      // Ref-counted in agentEvents.ts — shares swarmDispatch's poller.
      events.set(project, subscribeAgentEvents(project));
    };
    const unwatchFeed = (project: string) => {
      subs.get(project)?.();
      subs.delete(project);
      events.get(project)?.();
      events.delete(project);
    };
    const tick = async () => {
      // Every swarm with at least one role kind selected for clearing. clearRolesOf
      // reads the per-kind swarmClearRoles list, falling back to the legacy
      // swarmResets:true = "all roles" for workspaces saved before that setting.
      const swarms = useLayout.getState().workspaces.filter((w) => w.swarm && clearRolesOf(w).length > 0);
      const live = new Set(swarms.map((w) => w.swarm!));
      for (const project of [...subs.keys()]) if (!live.has(project)) unwatchFeed(project);
      if (swarms.length === 0) return;
      let url = "";
      try { url = await brainUrl(); } catch { return; } // memoized in ipc.ts — one call per app run
      if (!url) return;
      for (const ws of swarms) {
        const project = ws.swarm!;
        watchFeed(project);
        const feed = brainFeedNow(project);
        if (!feed?.ready) continue; // no pass yet — same as a failed read, retry next tick
        const keys = feed.keys;
        const clearKinds = clearRolesOf(ws);
        for (const key of keys.filter((k) => k.startsWith("reset-"))) {
          const role = key.slice("reset-".length);
          const tag = `${project}/${role}`;
          if (busy.has(tag)) continue;
          // Only wipe roles whose KIND the user picked. A stray reset note for a
          // non-selected role (a mis-briefed agent, or a kind toggled off after
          // launch) is consumed but never wiped — otherwise it loops every tick.
          // Consume it OUTSIDE the busy/telemetry path so it never shows a phantom
          // reset or wedges the tag, then move on.
          if (!clearsRole(clearKinds, role)) { brainDelete(project, key).catch(() => {}); continue; }
          busy.add(tag);
          useSwarmTelemetry.getState().reportReset(ws.id, role, true); // mirror for the health strip
          // Fire-and-forget: one slow pane (idle wait) must not stall resets
          // for the other roles; `busy` guards re-entry until it finishes.
          (async () => {
            try {
              await brainDelete(project, key); // consume the request up front
              // By TYPED role — a renamed pane used to make its own reset note
              // unmatchable, so the wipe silently never happened (findings 1.4).
              const pane = collectPanes(ws.root).filter(isTerminal).find((p) => paneRole(p) === role);
              // A lazy worker that has not launched yet keeps its boot command in
              // pendingCommand — either way this is the CLI whose reset syntax we need.
              if (pane) await rebrief(pane.id, pane.startupCommand ?? pane.pendingCommand ?? "", project, url, role, !!ws.swarmDispatch);
            } catch { /* pane gone or pty write failed — request already consumed */ }
            busy.delete(tag);
            useSwarmTelemetry.getState().reportReset(ws.id, role, false);
          })();
        }
      }
    };
    const t = setInterval(tick, POLL_MS);
    return () => {
      clearInterval(t);
      for (const project of [...subs.keys()]) unwatchFeed(project);
    };
  }, []);

  // Boot brief for HEADLESS panes, in swarms that are NOT host-dispatched.
  //
  // A TUI pane carries its brief on its own command line, so it is briefed by
  // the act of launching. A headless pane cannot: verified on claude 2.1.218, a
  // positional prompt is ignored in stream-json input mode, so the brief has to
  // arrive as the first stream message and something has to send it. Under host
  // dispatch that something already exists — swarmDispatch delivers a parked
  // pendingPrompt when the role has work, which is the whole point of parking
  // it — so this only covers the self-polling swarms, where nothing else ever
  // would and the pane would sit forever with a live CLI and no instructions.
  useEffect(() => {
    const sending = new Set<string>();
    const tick = () => {
      for (const ws of useLayout.getState().workspaces) {
        if (!ws.swarm || ws.swarmDispatch) continue;
        for (const pane of collectPanes(ws.root).filter(isTerminal)) {
          const prompt = pane.pendingPrompt;
          const role = paneRole(pane);
          if (!prompt || !role || sending.has(pane.id)) continue;
          // The host must have the session open — a write before `pty_open`
          // resolves is dropped with no error anywhere.
          if (!isStreamPane(pane.id) || !paneOpen(pane.id)) continue;
          sending.add(pane.id);
          // Cleared FIRST so a slow send cannot be started twice by the next
          // tick, and restored if it fails — the same shape the dispatcher uses.
          useLayout.getState().patchPaneAnywhere(pane.id, { pendingPrompt: undefined });
          injectPrompt(ws.swarm!, pane.id, role, prompt)
            .then((sent) => {
              // Budget spent: put it back and try again next tick.
              if (!sent) useLayout.getState().patchPaneAnywhere(pane.id, { pendingPrompt: prompt });
            })
            .catch(() => useLayout.getState().patchPaneAnywhere(pane.id, { pendingPrompt: prompt }))
            .finally(() => sending.delete(pane.id));
        }
      }
    };
    const t = setInterval(tick, POLL_MS);
    return () => clearInterval(t);
  }, []);
}
