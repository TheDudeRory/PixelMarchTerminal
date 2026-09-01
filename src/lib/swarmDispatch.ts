// Host-driven dispatch (swarm). Poll-free workers: with SwarmConfig.hostDispatch
// on, briefs tell every role to END ITS TURN when it has nothing to do, and this
// watcher watches the task bus instead — LLM turns only happen when there is
// work. Each tick it reads the swarm's tasks and types a [host] wake message
// into the pane whose role has actionable state:
//   open builder tasks  → idle builders (one wake per open task)
//   open scout tasks    → scout
//   done builder tasks  → ONE reviewer each, fanned out over reviewer-1..N
//                         (or coordinator when there is no reviewer — merge gate)
//   approved tasks      → coordinator (merge)
//   changes tasks       → the owning builder
//   builder tasks + no "plan" note → coordinator (builders are held: the brain
//     rejects their claims until the plan exists, so waking them just burns turns)
//   done scout tasks    → coordinator (its scout-* notes are ready)
// The coordinator's "result" note ends the mission — but only once no task is in
// flight (missionDone). A premature result puts the swarm in DRAIN mode: no new
// work is handed out, and the review/merge/changes wakes finish what is running.
// Plus inter-agent chat: a message addressed to a role (or "all") wakes that pane
// ONCE — this is how a builder's question reaches an idle coordinator. The rows
// come from the brain (brain_chat) already split and routed; this file no longer
// knows the note naming or the "to:" header convention. Human chat is delivered
// live by SwarmChat's terminal injection, so only agent-authored rows wake here.
// A pane may be DEFERRED when its wake comes due — a lazy worker still sitting at
// a bare shell, or an agent whose context was just wiped by swarmReset and whose
// role prompt is parked in pendingPrompt. Either is brought up first (launchDeferred)
// and woken on the next tick, so no role ever spends a turn on an empty task bus.
// Wake repeats are governed by wakeDue() in swarm.ts: a wake is typed into a TUI
// and a TUI silently drops input that lands mid-redraw, so every wake is checked
// for delivery (the pane must produce output within WAKE_DELIVERY_MS — an agent
// that got the message starts a turn) and an undelivered one retries on the next
// tick instead of waiting out the full REWAKE_MS. A pending set that proves
// nothing happened (a builder task still `open`, i.e. unclaimed) re-fires on the
// fast gap. Panes that are not output-quiet are skipped and retried next tick;
// task claims stay the collision guard, so a duplicate or stale wake is safe,
// just tokens.
// Every injection here is also capped, and the cap is APP-GLOBAL: at most
// turnCap() panes across EVERY swarm workspace may hold a live LLM turn at once
// (one per builder of the largest swarm), so two swarms pointed at the same
// local endpoint no longer ask it for 2N completions in parallel. The budget
// lives in swarm.ts and every injection anywhere goes through injectPrompt().
// Fairness: workspaces are rotated per tick and the job queue is age-ordered
// (byWakeAge), because handing slots out in a fixed order let a coordinator
// that comes due every heartbeat starve the builder wakes behind it at cap=1.
import { useEffect } from "react";
import { brainChat, brainChatSend, brainDelete, brainFeedNow, brainNote, brainReclaims, brainTaskStatus, brainTasks, brainUrl, subscribeBrainFeed, swarmBranchTip, swarmGuardRemove, swarmMergeTask, swarmParkStrays, swarmRepoDirty, swarmRepoHead, swarmUnregisterAgents, swarmWorktreeAdd, swarmWorktreeOwner, type ChatRow, type SwarmTask } from "./ipc";
import { collectPanes, isTerminal, type Pane } from "./layout-tree";
import { lastOutputAt } from "./terminalPool";
import { compacting, lastPromptAcceptedAt, subscribeAgentEvents, turnActive } from "./agentEvents";
import { forceReset, injectPrompt, reclaimScope } from "./swarmReset";
import { REWAKE_FAST_MS, STRAY_PARK_MS, cancelledSwarms, WAKE_DELIVERY_MS, WAKE_MESSAGES, byWakeAge, clearRolesOf, clearsRole, consumedScouts, hasHooks, idleBus, isBuilderRole, isReviewerRole, isRolePane, isSettled, missionDone, paneRole, planGate, reviewedSha, sameCommit, staleChanges, unexpectedHeadMove, wakeMirror, registerSwarm, reportBusy, retainSwarms, staleClaims, takeTurnSlot, trackedSwarms, wakeDue, type WakeState } from "./swarm";
import { useLayout } from "../stores/layout";
import { useSwarmTelemetry, type StuckReview } from "../stores/swarmTelemetry";

const POLL_MS = 5000;
const IDLE_QUIET_MS = 3000; // same signal as swarmReset: no PTY output = turn over
// How long a hook-reported "mid-turn" is believed once the pane has also gone
// PTY-quiet. Generous on purpose — a real agent turn can run minutes — but
// finite, because a turn-end hook that never fires must not wedge the pane.
const HOOK_TURN_MAX_MS = 120_000;
// How long the coordinator must have been quiet before a post-merge wipe fires.
// Deliberately well past IDLE_QUIET_MS: the wake that ends a coordinator cycle is
// delivered ASYNCHRONOUSLY (submitPrompt writes, then the agent takes a second or
// two to start painting), so a 3 s quiet window can catch the gap between "the
// merge chat was typed" and "the coordinator started its turn" and wipe the very
// turn it was woken for. Fifteen seconds of silence means the turn is genuinely
// over — or never started, in which case the wake is re-delivered after the wipe
// from the parked prompt anyway.
const COORD_QUIESCE_MS = 15_000;

const taskRole = (t: SwarmTask) => t.role || "builder"; // untagged tasks are builder work

function isIdle(paneId: string): boolean {
  const last = lastOutputAt(paneId);
  // No output ever = the agent CLI is still booting, not idle — a wake typed
  // now would land in a shell that hasn't started the agent yet.
  if (!last) return false;
  return Date.now() - last >= IDLE_QUIET_MS;
}

/** Holding a live LLM turn right now: the pane produced output within the quiet
 *  window. Deliberately NOT `!isIdle` — isIdle also reports false for a pane
 *  that has never produced any output, and counting those as busy would let a
 *  dead/never-opened pane eat a concurrency slot forever. */
function isBusy(paneId: string): boolean {
  const last = lastOutputAt(paneId);
  return !!last && Date.now() - last < IDLE_QUIET_MS;
}

/** The pane's CLI command line — a lazy worker has not launched yet and carries
 *  its boot command in pendingCommand instead. */
const paneCommand = (pane: Pane) => pane.startupCommand ?? pane.pendingCommand ?? "";

/** Turn state as the AGENT itself reported it (hooks), or undefined when this
 *  pane's CLI has no hooks or has not reported yet. Never guess here: a wrong
 *  "idle" types a wake into a pane mid-turn, which a TUI swallows.
 *
 *  BOUNDED. An "active" turn is trusted only while it is plausible: the Stop
 *  hook is not guaranteed to fire (Esc mid-turn, CLI crash or kill, a hook
 *  command that fails or times out, the brain unreachable exactly then), and an
 *  unbounded `active === true` is permanent — the pane answers "busy" to every
 *  wake, recovery and chat delivery AND holds a turn slot forever, starving the
 *  other roles. Two conditions must BOTH hold before the answer is discarded:
 *  the prompt that started the turn is older than HOOK_TURN_MAX_MS, and the pane
 *  has been PTY-quiet for the usual window. A genuinely long turn keeps painting
 *  its TUI, so it stays trusted; a wedged one falls back to the quiet timer,
 *  which is exactly the self-healing behaviour non-hook panes have today. */
export function hookTurn(project: string, pane: Pane): boolean | undefined {
  if (!hasHooks(paneCommand(pane))) return undefined;
  const role = paneRole(pane);
  // COMPACTING (PreCompact hook): the CLI is summarising its own context. It is
  // not taking a turn, but it is emphatically not ready for one either — a wake
  // typed now is swallowed by a TUI that is not at its input box, and the pane
  // then reads as "woken, did nothing". Busy is the honest answer, and it is
  // bounded in agentEvents (COMPACT_MAX_MS) rather than believed forever.
  if (compacting(project, role)) return true;
  const active = turnActive(project, role);
  if (active !== true) return active;
  const promptAt = lastPromptAcceptedAt(project, role);
  // No prompt stamp behind an active turn should not happen (turnActive is
  // promptAt > turnEndAt), but if it ever does the claim is unverifiable — drop
  // it rather than trust it forever.
  if (!promptAt) return undefined;
  if (Date.now() - promptAt < HOOK_TURN_MAX_MS) return true;
  return isBusy(pane.id) ? true : undefined; // still painting = still working
}

/** Is this pane's turn over? Prefers the CLI's own Stop hook and falls back to
 *  the output-quiet timer for every CLI that has none — which is what keeps
 *  non-hook panes on exactly the path they took before Phase A. */
export function paneIdle(project: string, pane: Pane): boolean {
  const active = hookTurn(project, pane);
  return active === undefined ? isIdle(pane.id) : !active;
}

/** Same, for the "holding a live turn" half of the question (turn budget). */
export function paneBusy(project: string, pane: Pane): boolean {
  const active = hookTurn(project, pane);
  return active === undefined ? isBusy(pane.id) : active;
}

interface WakeJob { kind: string; pane: Pane | undefined; pending: SwarmTask[]; urgent?: boolean; msg: (keys: string, role: string) => string }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Did the wake actually reach the agent? submitPrompt only proves the bytes
 *  hit the PTY — a TUI mid-redraw drops them, and the pane then just sits there.
 *  An agent that got the message starts a turn, so any output after the
 *  injection echo counts as delivered. No output at all within
 *  WAKE_DELIVERY_MS = it never landed: count the miss so wakeDue re-fires on the
 *  next tick instead of waiting out the heartbeat gap. */
async function confirmDelivery(paneId: string, tag: string, wakes: Map<string, WakeState>, sig: string, mirror: (w: WakeState) => void): Promise<void> {
  const echoedAt = lastOutputAt(paneId); // submitPrompt's own echo, already settled
  await sleep(WAKE_DELIVERY_MS);
  const cur = wakes.get(tag);
  if (!cur || cur.sig !== sig) return; // superseded by newer work — nothing to judge
  const landed = lastOutputAt(paneId) > echoedAt;
  const next = { ...cur, misses: landed ? 0 : cur.misses + 1 };
  wakes.set(tag, next);
  mirror(next);
}

/** Delivery confirmation for a HOOK-capable pane. The miss counter stays out of
 *  the control path (UserPromptSubmit is the real answer, not "some bytes came
 *  back"), but the UI mirror still has to learn that the wake landed or it sits
 *  at the pre-injection state forever. A prompt-accepted stamp at or after the
 *  injection = landed; nothing = leave the mirror alone, since for a hook pane
 *  an unconfirmed wake is not a miss to count, only a wake we cannot vouch for. */
async function confirmHookDelivery(project: string, role: string, sentAt: number, tag: string, wakes: Map<string, WakeState>, sig: string, mirror: (w: WakeState) => void): Promise<void> {
  await sleep(WAKE_DELIVERY_MS);
  const cur = wakes.get(tag);
  if (!cur || cur.sig !== sig) return; // superseded by newer work — nothing to judge
  if (lastPromptAcceptedAt(project, role) < sentAt) return; // not (yet) confirmed
  const next = { ...cur, misses: 0 };
  wakes.set(tag, next);
  mirror(next);
}

/** COLD START: which pane (if any) must be briefed on an EMPTY task bus.
 *  Every wake this file generates is derived from the task bus, so an empty bus
 *  generates nothing — and a headless coordinator carries its brief in
 *  `pendingPrompt` (a piped CLI ignores a positional prompt, see bootCommand),
 *  which is only ever delivered by launchDeferred. Empty bus + parked brief = a
 *  swarm that never starts: panes alive, agents unbriefed, no task ever posted
 *  to wake anyone, forever.
 *  Only the COORDINATOR qualifies. A lazy worker's parked boot command is held
 *  until its role has work on purpose — booting it here would bill for exactly
 *  the idle turn lazyWorkers exists to avoid — and a TUI coordinator carries its
 *  brief on its own command line, so it has nothing parked and is skipped. */
export function coldStartPane<P extends { pendingPrompt?: string; pendingCommand?: string }>(
  tasks: { status: string }[],
  coordinator: P | undefined,
): P | undefined {
  if (tasks.length > 0 || !coordinator) return undefined;
  return coordinator.pendingPrompt || coordinator.pendingCommand ? coordinator : undefined;
}

/** Does the COORDINATOR's context get wiped right now?
 *
 *  The context-reset toggle only ever ARMED a handshake: the reset watcher wipes
 *  a role that asked to be wiped, and nothing else — builders are force-wiped by
 *  the host when their work merges (hostMerge below), but the coordinator asks or
 *  it never happens. Its brief gives it one cycle end (a merge it just unblocked),
 *  so a coordinator that skips that one line accumulates every planning turn,
 *  every scout report and every chat for the whole mission. That is the swarm
 *  that takes minutes to open a task: the wake is cheap, re-reading the context
 *  behind it is not.
 *
 *  So the host takes the same decision it already takes for a merged builder —
 *  but only where the coordinator has demonstrably finished the cycle:
 *   - `selected`: the human picked the coordinator in the clear-context setting.
 *     Nothing here overrides that choice; unselected, the coordinator keeps its
 *     context exactly as before.
 *   - `armed`: a merge landed and the host chatted it the unblock. Without this
 *     the wipe would fire in every idle gap of the mission, including the long
 *     one while builders work, and buy nothing.
 *   - `pendingWakes` / `unseenChat`: nothing is queued FOR the coordinator. A wipe
 *     parks its role prompt (dispatch), so an outstanding wake would be delivered
 *     into a wiped pane a tick later — correct, but a wasted round trip.
 *   - `idle` + `quietMs`: the turn is over. See COORD_QUIESCE_MS.
 *   - `parked`: nothing to wipe — the pane is already sitting on a parked prompt
 *     (previous wipe) or has not launched its CLI yet.
 *  Pure so every one of those clauses is testable without a pane or a brain. */
export interface CoordQuiesce {
  selected: boolean;   // coordinator kind is in this workspace's clearRoles
  armed: boolean;      // a host merge unblock-chat was sent and not yet consumed
  idle: boolean;       // the pane reports its turn is over and nothing is mid-send
  quietMs: number;     // ms since the pane last produced output (0 = never has)
  pendingWakes: number; // coordinator wake jobs with work on this tick
  unseenChat: number;  // chat rows routed to the coordinator, not yet delivered
  parked: boolean;     // pendingPrompt/pendingCommand — already wiped, or not up
}

export function coordinatorQuiesceDue(q: CoordQuiesce): boolean {
  if (!q.selected || !q.armed || q.parked) return false;
  if (q.pendingWakes > 0 || q.unseenChat > 0) return false;
  return q.idle && q.quietMs >= COORD_QUIESCE_MS;
}

/** Bring a deferred pane up before it can be woken, if it has something parked:
 *  a lazy worker's boot COMMAND (bare shell — the CLI is not running yet) or a
 *  post-context-reset role PROMPT (CLI running with a wiped context). Either way
 *  the agent lands on its brief, and the wake itself is left for the next tick so
 *  it arrives at a live, idle pane. Returns true if it fired — caller skips.
 *  Nothing is parked for an idle role, so an idle role costs no model turns. */
function launchDeferred(project: string, pane: Pane, sending: Set<string>, takeSlot: (role: string) => boolean): boolean {
  const cmd = pane.pendingCommand;
  const prompt = pane.pendingPrompt;
  if (!cmd && !prompt) return false;
  if (sending.has(pane.id) || !paneIdle(project, pane)) return true; // busy — retry next tick
  // Booting a CLI on its brief IS a live turn, so it takes a slot like a wake.
  if (!takeSlot(paneRole(pane))) return true; // at the cap — retry next tick
  const patch = useLayout.getState().patchPaneAnywhere;
  sending.add(pane.id);
  // Only a boot command becomes the pane's startupCommand; a re-brief prompt must
  // not, or resetCommand()/interruptKey() would parse the prompt as a CLI name.
  patch(pane.id, cmd ? { pendingCommand: undefined, startupCommand: cmd } : { pendingPrompt: undefined });
  // The slot was already taken above, so this cannot be refused; injectPrompt
  // keeps the accounting in one place (a failed send hands the slot back).
  injectPrompt(project, pane.id, paneRole(pane), cmd ?? prompt!)
    // Send failed — put it back so the next tick tries again.
    .catch(() => patch(pane.id, cmd ? { pendingCommand: cmd } : { pendingPrompt: prompt }))
    .finally(() => sending.delete(pane.id));
  return true;
}

/** The chat rows that should WAKE `role`, out of everything the brain routed.
 *  Pure, and separate from the tick loop, because these three rules are the whole
 *  behavioural difference between reading a swarm's chat and spending a model turn
 *  on it:
 *   1. never wake on your own message;
 *   2. never wake on the HUMAN's — SwarmChat injects those into the addressed pane
 *      live, so a wake would deliver the same message twice;
 *   3. never wake on a headerless one. The brain reports a body with no "to:" line
 *      as targets ["all"], which is right for a READER (a message that reaches
 *      nobody is the worse failure) and wrong for a waker: it would spend one turn
 *      per pane in the swarm on a note nobody addressed. `addressed` exists to keep
 *      exactly this decision available, and the row is still rendered in the
 *      Coordinator tab, so nothing is lost — only the automatic wake is withheld.
 *  Everything else — who the targets are, what the header said — is already parsed
 *  and routed by the brain. */
export function chatWakeRows(rows: ChatRow[], role: string): ChatRow[] {
  const me = role.toLowerCase();
  return rows.filter(
    (r) => r.from !== "human" && r.from !== role && r.addressed && (r.targets.includes("all") || r.targets.includes(me)),
  );
}

/** Every chat row of a swarm, or none when the read fails. The dispatcher is a
 *  loop: a brain that is momentarily unreachable must cost this tick's chat
 *  wakes, never the whole tick (the task wakes above it are the load-bearing
 *  half), and the next tick asks again. */
async function chatRows(project: string): Promise<ChatRow[]> {
  try {
    return await brainChat(project);
  } catch {
    return [];
  }
}

/** Which reviewer reviews which "done" builder task — the multi-reviewer fan-out.
 *  Every done task gets EXACTLY ONE owning reviewer, because a task woken into two
 *  reviewer panes is two agents doing the same diff and two verdict notes racing to
 *  overwrite each other (the bus has no per-review claim; the reviewer's own brief
 *  tells it to re-check status, but only after it has already spent a turn).
 *
 *  Assignment is STICKY: `prior` is last tick's map, and a task keeps its reviewer
 *  for as long as it stays done. A re-wake (the first one was typed into a busy TUI
 *  and dropped) must land on the same pane, and the wake signature is per-pane, so
 *  a task hopping between reviewers would re-arm both of them.
 *  New tasks go to the reviewer holding the fewest, preferring one that is `free`
 *  (output-quiet) so a wedged reviewer does not sit on a queue; ties break on role
 *  name, which keeps the whole thing deterministic for a given input. */
export function assignReviews(
  reviewers: string[],
  done: { key: string }[],
  prior: Map<string, string>,
  free: (role: string) => boolean = () => true,
): Map<string, string> {
  const next = new Map<string, string>();
  if (reviewers.length === 0) return next; // reviewers:0 — the coordinator is the gate
  const live = new Set(reviewers);
  const load = new Map(reviewers.map((r) => [r, 0]));
  const bump = (r: string) => load.set(r, (load.get(r) ?? 0) + 1);
  const keys = done.map((t) => t.key);
  // Keep every still-valid assignment first, so the sticky ones shape the load
  // the new tasks are balanced against. A reviewer pane that went away (config
  // lowered, workspace edited) drops its tasks back into the pool below.
  for (const k of keys) {
    const was = prior.get(k);
    if (was && live.has(was)) { next.set(k, was); bump(was); }
  }
  for (const k of keys.filter((k) => !next.has(k)).sort()) {
    const order = [...reviewers].sort((a, b) => (load.get(a)! - load.get(b)!) || a.localeCompare(b));
    const pick = order.find(free) ?? order[0]; // all busy — least-loaded takes it and is woken once idle
    next.set(k, pick);
    bump(pick);
  }
  return next;
}

/** Done tasks whose reviewer has not moved them (brain-findings 1.1). The
 *  dispatcher has already woken that reviewer; if the task is STILL `done` a
 *  fast re-wake gap later and the pane is not mid-turn, nothing is happening to
 *  it. That fact used to reach the human only when the coordinator spent a turn
 *  saying so out loud — this hands it straight to the health strip instead.
 *
 *  REWAKE_FAST_MS is the threshold on purpose: it is the same gap the dispatcher
 *  itself uses for "the last wake achieved nothing, fire again", so the strip
 *  lights up exactly when the dispatcher has started re-waking, never before. */
export function stuckReviews<T extends { key: string; updated: number }>(
  done: T[],
  assigned: Map<string, string>,
  now: number,
  idle: (role: string) => boolean,
): StuckReview[] {
  return done
    .map((t) => ({ task: t.key, role: assigned.get(t.key) ?? "", since: t.updated * 1000 }))
    .filter((s) => s.role && now - s.since >= REWAKE_FAST_MS && idle(s.role))
    .sort((a, b) => a.since - b.since);
}

/** The repo directory a swarm works in — every agent pane was spawned with it
 *  as cwd, so any role pane answers. "" when none carries one (should not
 *  happen for a swarm, but the git actions all no-op safely on ""). */
export function swarmCwd(panes: Pane[]): string {
  return panes.map((p) => p.cwd).find((c): c is string => !!c) ?? "";
}

/** A SHA-shaped token, the shape `resolve_approved` (swarm.rs) will try against
 *  the branch. Nothing here is trusted — git still has to resolve it AND place
 *  it on the branch — this only decides which text is worth handing the gate. */
const HAS_SHA = /\b[0-9a-f]{7,40}\b/i;

/** The approval text the merge gate is given, in priority order:
 *
 *   1. the reviewer's `review-<task>` note, when it names a commit;
 *   2. the LAST reviewer-authored approval line in the task log ("[approved by
 *      reviewer-1] approved @ <sha>") — one line, so it cannot resolve to some
 *      arbitrary older commit the way the whole log could;
 *   3. the note as-is (no SHA anywhere → the gate refuses, as before).
 *
 *  (2) exists because the brief used to ask for a verdict note with no SHA in
 *  it, and every such review deadlocked: the gate found no commit, handed the
 *  task back as `changes`, the reviewer re-approved with the SHA in the STATUS
 *  LOG (the one place the host never read), and the pair ping-ponged forever.
 *  Only `reviewer-*` lines count — a builder's own "[approved by builder-1]" is
 *  not an approval, and honouring it would let a builder merge its own work.
 *  Pure so the precedence is testable without a repo. */
export function approvalText(review: string | null | undefined, desc: string): string | undefined {
  const note = (review ?? "").trim();
  if (HAS_SHA.test(note)) return note;
  const logged = desc
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^\[approved by reviewer/i.test(l) && HAS_SHA.test(l))
    .pop();
  return logged ?? (note || undefined);
}

/** `<project>/<task>@<branch tip>` for every ungateable tip already handed back,
 *  plus a `!` suffix once the coordinator has been told about it. A new commit
 *  on the branch is a new key, so a real re-do is never suppressed. */
const heldTips = new Set<string>();

/** Perform the host merge of one ready task, guard it against re-entry, and
 *  drive the follow-ups: mark it merged (as the host), nudge the coordinator to
 *  unblock, force-reset the owning builder so it stops touching landed work, and
 *  ARM the coordinator's own post-cycle wipe (`owed`) — the unblock it was just
 *  asked for is the end of its cycle, whether or not it says so itself.
 *  A conflict hands the task back to its owner as `changes`; a dirty root is
 *  refused and surfaced. Fire-and-forget from the tick — the `merging` guard
 *  makes a second tick a no-op until this resolves. */
async function hostMerge(
  project: string,
  repo: string,
  task: SwarmTask,
  owner: Pane | undefined,
  merging: Set<string>,
  quiesced: Set<string>,
  owed: Set<string>,
): Promise<void> {
  const tag = `${project}/${task.key}`;
  if (!repo || merging.has(tag)) return;
  merging.add(tag);
  try {
    // THE GATE: an approval authorises merging the commit the reviewer READ, and
    // nothing later (swarm_merge_task refuses a branch that moved past it). The
    // approved SHA lives in the review-<task> note — one SHA, so it cannot resolve
    // to an older commit the way the whole task log could. A no-reviewer swarm
    // merges `done` tasks that have no such note: approval stays undefined and the
    // merge is ungated, exactly as before.
    const review = await brainNote(project, `review-${task.key}`).catch(() => null);
    const approved = approvalText(review, task.desc ?? "");
    // LAST LOOK BEFORE THE MERGE. `task` is this tick's snapshot, and a human can
    // cancel an approved task from the mission board in the seconds this function
    // spends reading the review note — merging then would land the very work the
    // cancel stopped, and stamp `merged` over `cancelled`. One read; merges are rare.
    const now = await brainTasks(project).then((rows) => rows.find((r) => r.key === task.key)).catch(() => undefined);
    if (now && isSettled(now.status)) return;
    const res = await swarmMergeTask(repo, task.key, project, approved);
    if (res.moved || res.unresolved_approval) {
      // The tip advanced past what was approved, or the approval named no
      // resolvable commit. Hand it back for a RE-GATE rather than merge
      // unreviewed work — and log it, so it does not retry forever in silence.
      //
      // ONCE PER TIP, though. The handback is only useful the first time: if the
      // re-gate comes back naming no commit again, re-posting `changes` on the
      // same commit just restarts a loop that neither side can break (it ran 7
      // rounds live). Say it to the coordinator instead, which is where a human
      // is watching, and leave the task alone.
      const held = `${tag}@${res.head_sha ?? ""}`;
      const msg = res.changes_log
        ?? `merge held: swarm/${task.key}'s approval names no commit I can match to its branch — re-review it and write note "review-${task.key}" with first line "verdict: approved @ <sha>" (git rev-parse swarm/${task.key}).`;
      if (!heldTips.has(held)) {
        heldTips.add(held);
        await brainTaskStatus(project, task.key, "changes", msg).catch(() => {});
      } else if (!heldTips.has(`${held}!`)) {
        heldTips.add(`${held}!`);
        await brainChatSend(project, "host", "coordinator", `${task.key} cannot merge: ${msg} It has already been handed back once on this commit and came back the same — it needs a human or a re-scoped task, not another round.`).catch(() => {});
      }
    } else if (res.ok) {
      const note = res.manifests?.length
        ? `host merge — install ${res.manifests.join(", ")} at the repo root`
        : "host merge";
      // The merge already landed and (unless `already`) the branch is deleted, so
      // this write is the ONLY record that it happened. A single lost write used to
      // strand the task at `approved` forever: the branch is gone, so every later
      // tick's merge attempt hit "no branch" and did nothing. Retry it a few times
      // rather than fire-and-forget; swarm_merge_task is now idempotent (it detects
      // the landed merge commit and returns ok), so the next tick self-heals even
      // if all retries here fail.
      let marked = false;
      for (let i = 0; i < 3 && !marked; i++) {
        marked = await brainTaskStatus(project, task.key, "merged", note).then(() => true).catch(() => false);
        if (!marked) await sleep(500);
      }
      // The coordinator owns dependency order (its plan), so it still unblocks —
      // it just no longer runs git. A chat from the host wakes it.
      await brainChatSend(
        project,
        "host",
        "coordinator",
        `${task.key} merged by the host${res.manifests?.length ? ` (root install needed: ${res.manifests.join(", ")})` : ""}. Unblock its successors per the plan; keep note "plan" authoritative.`,
      ).catch(() => {});
      // That chat IS the coordinator's cycle: it unblocks, and it is done until
      // the next merge. Arm the wipe — the tick fires it once the coordinator has
      // actually gone quiet with nothing queued (coordinatorQuiesceDue).
      owed.add(project);
      // Its work landed — wipe the builder so it cannot keep editing the task.
      if (owner) {
        quiesced.add(tag);
        const url = await brainUrl().catch(() => "");
        if (url) await forceReset(project, owner.id, owner.startupCommand ?? owner.pendingCommand ?? "", url, paneRole(owner), true).catch(() => {});
      }
      // Second half of the worktree rule: the merge landed AND the owner is now
      // stopped, so release the branch + worktree. swarm_merge_task is idempotent
      // (it detects the landed merge and just runs the cleanup) — nothing else
      // releases it, so without this the worktrees accumulate for the whole run.
      await swarmMergeTask(repo, task.key, project, undefined, true).catch(() => {});
    } else if (res.conflict) {
      await brainTaskStatus(project, task.key, "changes", `merge conflict — rebase/resolve on swarm/${task.key}: ${res.error ?? ""}`.trim()).catch(() => {});
    } else if (res.dirty?.length) {
      await brainChatSend(project, "host", "coordinator", `cannot merge ${task.key}: the repo root has uncommitted changes (${res.dirty.slice(0, 5).join(", ")}). A builder edited outside its worktree — resolve before the merge can proceed.`).catch(() => {});
    } else if (res.no_branch) {
      // No branch AND no landed merge commit (swarm_merge_task already ruled out
      // the lost-write case). The task is approved but its work is nowhere — a
      // deleted branch, or an approval that never had one. Don't spin silently:
      // surface it so a human/coordinator can rebuild or re-open the task.
      await brainChatSend(project, "host", "coordinator", `cannot merge ${task.key}: branch swarm/${task.key} does not exist and no merge for it is on the current branch. Its work is missing — re-open the task or restore the branch.`).catch(() => {});
    }
  } catch {
    /* IPC failed — next tick retries */
  } finally {
    merging.delete(tag);
  }
}

/** Perform every reclaim the coordinator has requested (brain-findings 2.2).
 *  The brain records who loses a task's scope and who gets it; taking it away is
 *  the host's job, because only the host can stop a pane. `reclaimScope` does
 *  the fence/flip/wipe as one operation — this function is only the queue:
 *   · done      → consume the request, tell the coordinator it landed;
 *   · refused   → consume it too (the brain will refuse it identically forever)
 *                 and say why, so the coordinator stops waiting on it;
 *   · pane wipe failed → LEAVE the request; the loser stays fenced meanwhile, so
 *                 retrying costs nothing but a tick.
 *  Fire-and-forget from the tick, guarded per task by `inflight`. */
async function runReclaims(
  project: string,
  keys: string[],
  byRole: (role: string) => Pane | undefined,
  dispatch: boolean,
  inflight: Set<string>,
): Promise<void> {
  // Cheap gate: the feed already carries every note key, so a swarm with no
  // pending reclaim (the normal case) costs nothing per tick.
  if (!keys.some((k) => k.startsWith("reclaim-"))) return;
  let rows;
  try {
    rows = await brainReclaims(project);
  } catch {
    return; // brain momentarily unreachable — next tick asks again
  }
  for (const r of rows) {
    const tag = `${project}/${r.task}`;
    if (inflight.has(tag)) continue;
    inflight.add(tag);
    try {
      const pane = r.from ? byRole(r.from) : undefined;
      const url = pane ? await brainUrl().catch(() => "") : "";
      if (pane && !url) continue; // cannot wipe without the brain URL — retry next tick
      const out = await reclaimScope(project, r.task, r.to, pane ? {
        paneId: pane.id,
        role: paneRole(pane),
        startupCommand: pane.startupCommand ?? pane.pendingCommand ?? "",
        dispatch,
      } : undefined, url);
      if (out.ok) {
        await brainDelete(project, r.key).catch(() => {});
        await brainChatSend(
          project,
          "host",
          "coordinator",
          `${r.task} reclaimed: ${r.from || "nobody"} was reset and no longer owns it${r.to ? `, it is now claimed by ${r.to}` : ", it is open again"}.`,
        ).catch(() => {});
      } else if (out.refused) {
        await brainDelete(project, r.key).catch(() => {});
        await brainChatSend(project, "host", "coordinator", `cannot reclaim ${r.task}: ${out.reason ?? "refused"}. Nothing was changed.`).catch(() => {});
      }
      // else: transient (IPC) or fencedOpen — the request stays and retries.
    } catch {
      /* ignore — the request stays on the queue */
    } finally {
      inflight.delete(tag);
    }
  }
}

/** Keep every live task worktree stamped with the role the BUS says owns it.
 *  The repo guard's reference-transaction hook reads that stamp and refuses a
 *  ref write from any other pane — which is the only way to catch the breach
 *  that has no wrong branch and no wrong tree in it: `builder-2`, resumed with a
 *  bare "continue", ran `git merge --ff-only master` inside `.swarm/task-12` and
 *  moved `swarm/task-12` under a live `builder-1`.
 *
 *  Driven from the bus rather than from worktree creation on purpose: a reclaim
 *  hands a live tree to a different builder, and the marker has to follow it or
 *  it locks out the new owner. `marked` remembers the last value written per
 *  task so the steady state costs no IPC; a worktree that does not exist yet
 *  simply retries next tick. */
async function syncWorktreeOwners(repo: string, tasks: SwarmTask[], marked: Map<string, string>): Promise<void> {
  for (const t of tasks) {
    // Settled tasks (merged, or cancelled by the human) have no live worktree to
    // keep stamped — re-stamping a cancelled task's tree every tick would also
    // re-create it, which is the one thing a cancel should not do.
    if (!t.owner || isSettled(t.status)) continue;
    const tag = `${repo}/${t.key}`;
    if (marked.get(tag) === t.owner) continue;
    let out = await swarmWorktreeOwner(repo, t.key, t.owner).catch(() => ({ ok: false, no_worktree: false }));
    if (!out.ok && out.no_worktree) {
      // The claim landed before its builder opened the tree. Open it here — the
      // host was always meant to (swarm_worktree_add), and an unstamped worktree
      // is an unguarded one, so the window between claim and stamp is worth
      // closing. Idempotent, and a builder that opens its own finds it already
      // there.
      await swarmWorktreeAdd(repo, t.key).catch(() => {});
      out = await swarmWorktreeOwner(repo, t.key, t.owner).catch(() => ({ ok: false, no_worktree: false }));
    }
    if (out.ok) marked.set(tag, t.owner);
  }
}

/** Surface a dirty root checkout — to the HUMAN first (telemetry, same reasoning
 *  as stuck reviews, brain-findings 1.1) — and then FIX IT.
 *
 *  A dirty root is not a style problem: swarm_merge_task REFUSES to merge over
 *  it, so from the moment it appears every approved task stops landing. Telling
 *  someone was the whole response, and it does not work: the message went into a
 *  coordinator pane nobody was looking at (it held two merges for a mission that
 *  way — salvage-task-9-root-strays), and when the coordinator did relay it, the
 *  human's answer was "clean it yourself are you kidding me?" — while the swarm
 *  sat with its only task blocked.
 *
 *  So after STRAY_PARK_MS of the SAME dirty file set, the host parks the changes
 *  in a git stash and says where they went. Reversible by construction: nothing
 *  is discarded, `git stash pop` restores it, and merges resume meanwhile. The
 *  grace window is what keeps a human mid-edit from having the rug pulled.
 *
 *  Note what the message no longer claims. It used to open "A builder is working
 *  outside .swarm/" — in the incident that prompted this, the edits came from a
 *  plain non-swarm agent someone had left running in the repo root, and the
 *  coordinator dutifully hunted a builder that was innocent. */
async function reportStrayEdits(
  project: string,
  wsId: string,
  repo: string,
  reported: Map<string, { sig: string; since: number; parked: boolean }>,
): Promise<void> {
  try {
    const out = await swarmRepoDirty(repo);
    useSwarmTelemetry.getState().setStray(wsId, out.dirty ? out.files : []);
    if (!out.dirty || out.files.length === 0) { reported.delete(project); return; }
    const sig = out.files.slice().sort().join("|");
    const prev = reported.get(project);
    const seen = prev?.sig === sig ? prev : { sig, since: Date.now(), parked: false };
    if (!prev || prev.sig !== sig) {
      reported.set(project, seen);
      await brainChatSend(project, "host", "coordinator", `stray edits in the repo ROOT (not a worktree): ${out.files.slice(0, 8).join(", ")}. Someone is editing the root checkout — it need not be a builder; any agent or tool left running in the repo root does this. The guard blocks the commit, this work is on no task branch, and it blocks every host merge until the root is clean. Do NOT go and tidy the root yourself: if it is still there in ${Math.round(STRAY_PARK_MS / 1000)}s the host parks it in a stash and tells you.`).catch(() => {});
      return;
    }
    if (seen.parked || Date.now() - seen.since < STRAY_PARK_MS) return;
    const label = `pixelmarch swarm ${project}: root strays`;
    const res = await swarmParkStrays(repo, label);
    reported.set(project, { ...seen, parked: true }); // one attempt per file set either way
    await brainChatSend(
      project,
      "host",
      "coordinator",
      res.ok && res.parked
        ? `the root strays (${res.files.slice(0, 8).join(", ")}) are parked in a git stash ("${label}") and the root is clean — merges can proceed. NOTHING WAS DISCARDED: whoever owns that work restores it with "git stash list" then "git stash pop". Carry on with the plan.`
        : `could not park the root strays: ${res.error ?? "unknown error"}. Merges stay blocked until the root is clean; this one needs a human.`,
    ).catch(() => {});
  } catch {
    /* ignore */
  }
}

/** Sample the root checkout's HEAD and shout if it moved with no host merge
 *  behind it — the guard breach nothing else can see.
 *
 *  The guard makes this hard, not impossible (it runs as the same user as every
 *  agent, so a hook can always be sidestepped), and when it happens the evidence
 *  is a repo that looks perfectly healthy: unreviewed work sitting on master,
 *  the task bus stalled somewhere unrelated. It took a human reading a reflog
 *  the next morning to find the last one. Telemetry goes to the strip (the human
 *  reads that), and the coordinator is told once per offending commit so it
 *  stops planning around a tree that no longer matches its plan. */
async function watchHead(
  project: string,
  wsId: string,
  repo: string,
  heads: Map<string, { sha: string; branch: string }>,
  merging: Set<string>,
): Promise<void> {
  try {
    const out = await swarmRepoHead(repo);
    if (!out.ok || !out.sha) return;
    const next = { sha: out.sha, subject: out.subject ?? "", branch: out.branch ?? "" };
    const mergingHere = [...merging].some((tag) => tag.startsWith(`${project}/`));
    const breached = unexpectedHeadMove(heads.get(project), next, mergingHere);
    heads.set(project, { sha: next.sha, branch: next.branch });
    if (!breached) return;
    useSwarmTelemetry.getState().setBreach(wsId, { sha: next.sha, subject: next.subject, branch: next.branch });
    await brainChatSend(project, "host", "coordinator", `BREACH: ${next.branch || "the root branch"} moved to ${next.sha.slice(0, 8)} ("${next.subject}") and the host did not merge it. Someone committed or merged past the guard, so master now holds work no reviewer gated and no task records. Do not build on it: report this to the human (chat "to: human") and stop.`).catch(() => {});
  } catch {
    /* ignore — next tick samples again */
  }
}

/** Rescue a `changes` task whose branch has moved on: the builder did the rework
 *  and never posted `done`.
 *
 *  This is the stall that cost a whole night. task-6 came back as `changes`, its
 *  builder fixed every finding and committed — and said nothing. `changes` wakes
 *  only its owner; the owner sees work it has already done and ends its turn; the
 *  reviewer waits on `done` and the merge waits on `approved`, both forever.
 *
 *  The branch is the evidence, so the host reads it: a tip that is no longer the
 *  commit the review note sent back IS the rework, and the host posts the `done`
 *  its builder owed. Anything else (no branch, no new commits, no review note to
 *  compare against) is left alone — the ordinary `changes` wake covers it. */
async function resolveStaleChanges(
  project: string,
  repo: string,
  tasks: SwarmTask[],
  idle: (owner: string) => boolean,
  resolved: Set<string>,
): Promise<void> {
  for (const t of staleChanges(tasks, Date.now(), idle)) {
    try {
      const tip = await swarmBranchTip(repo, t.key);
      if (!tip.ok || !tip.exists || !tip.sha) continue;
      // Keyed by TIP, not by task: one rescue per commit. A task that goes round
      // again (reviewed → changes → a NEW commit nobody posted) is rescued again,
      // while a rescue the reviewer bounced straight back is not re-posted on the
      // same commit — that is the handback loop this must not start.
      const tag = `${project}/${t.key}@${tip.sha}`;
      if (resolved.has(tag)) continue;
      const reviewed = reviewedSha((await brainNote(project, `review-${t.key}`).catch(() => null)) ?? undefined);
      // No review note to compare against — the hand-back came from the host
      // (a conflict, a re-gate) and the tip proves nothing on its own.
      if (!reviewed || sameCommit(reviewed, tip.sha)) continue;
      resolved.add(tag); // one rescue per task; if it bounces back it is real
      await brainTaskStatus(project, t.key, "done", `host: swarm/${t.key} is at ${tip.sha.slice(0, 8)} ("${tip.subject ?? ""}"), past the reviewed ${reviewed.slice(0, 8)} — the rework is committed but was never posted done. Marking it done for review.`).catch(() => { resolved.delete(tag); });
    } catch {
      /* ignore — next tick tries again */
    }
  }
}

/** Settle scout tasks the coordinator has already been woken on — see
 *  consumedScouts for WHY the host has to be the one to close them. `merged`
 *  and not `cancelled`: the work happened and its output landed (as notes), so
 *  the mission board should read it as done, not killed. One POST per task
 *  ever; a failed post drops the mark so the next tick retries. */
async function retireScouts(project: string, tasks: SwarmTask[], retired: Set<string>): Promise<void> {
  for (const t of tasks) {
    const tag = `${project}/${t.key}`;
    if (retired.has(tag)) continue;
    retired.add(tag);
    await brainTaskStatus(
      project,
      t.key,
      "merged",
      "host: scout report delivered to the coordinator — a scout task produces notes (scout-*), not a branch, so there is nothing to review or merge.",
    ).catch(() => { retired.delete(tag); });
  }
}

export function useSwarmDispatch() {
  useEffect(() => {
    const wakes = new Map<string, WakeState>(); // paneId/kind → last wake sent
    const seenChat = new Set<string>(); // paneId::chatKey::updated already woken for — chat wakes exactly once
    const sending = new Set<string>(); // paneId mid-submitPrompt (it sleeps ~1.3s)
    const completed = new Set<string>(); // swarm projects whose "result" note is set — mission done, stop looping
    const cleaned = new Set<string>(); // swarm projects whose guard/tokens were already torn down
    const reviewedBy = new Map<string, Map<string, string>>(); // swarm → taskKey → owning reviewer role (sticky fan-out)
    const merging = new Set<string>(); // "<swarm>/<task>" mid host-merge — never merge one branch twice
    const quiesced = new Set<string>(); // "<swarm>/<task>" whose owner was already force-reset after done
    const owedReset = new Set<string>(); // swarms whose coordinator owes a post-merge context wipe
    const reclaiming = new Set<string>(); // "<swarm>/<task>" mid scope-reclaim — one at a time per task
    const strayReported = new Map<string, { sig: string; since: number; parked: boolean }>(); // swarm → dirty-file set, when it appeared, whether it was parked
    const ownerMarked = new Map<string, string>(); // "<repo>/<task>" → owner already stamped in its worktree
    const heads = new Map<string, { sha: string; branch: string }>(); // swarm → root checkout HEAD as of the last sample
    const repoOf = new Map<string, string>(); // swarm → its repo, remembered so a swarm that VANISHES can still be torn down (its panes are gone by then)
    const changesResolved = new Set<string>(); // "<swarm>/<task>" already rescued from a silent rework
    const scoutRetired = new Set<string>(); // "<swarm>/<task>" scout task already settled after its report was delivered
    let round = 0; // rotates which swarm is served first — see below
    // Brain state comes off the shared feed (lib/ipc) rather than four reads of
    // this loop's own per swarm per tick (result, tasks, plan and a full-store
    // chat search). A subscription is what makes the feed poll at all, so a swarm
    // this watcher has stopped serving — dispatch off, or mission complete — is
    // dropped and stops costing anything. hiddenMs === intervalMs on purpose:
    // this is a watcher, and a swarm must keep being dispatched while the window
    // is hidden.
    const subs = new Map<string, () => void>();
    const events = new Map<string, () => void>(); // agent-event pollers, one per served swarm
    const watchFeed = (project: string) => {
      if (subs.has(project)) return;
      subs.set(project, subscribeBrainFeed(
        project,
        // No "chat-" prefix any more: chat is read through brain_chat (which routes
        // and parses it), so the feed carries only what this loop still reads itself.
        { intervalMs: POLL_MS, hiddenMs: POLL_MS, watch: ["plan", "result"] },
        () => { /* read imperatively in tick() — this loop paces itself */ },
      ));
      // Lifecycle hooks (Phase A): the swarm's hook-capable panes report their own
      // turn boundaries, which paneIdle/paneBusy prefer over the quiet timer. The
      // subscription is ref-counted in agentEvents.ts, so swarmReset asking for the
      // same project shares this poller instead of opening a second one.
      events.set(project, subscribeAgentEvents(project));
    };
    const unwatchFeed = (project: string) => {
      subs.get(project)?.();
      subs.delete(project);
      events.get(project)?.();
      events.delete(project);
    };
    const tick = async () => {
      // EVERY swarm workspace, not just the host-dispatched ones. swarmNudge and
      // swarmRunaway inject into any `w.swarm` workspace regardless of
      // swarmDispatch, so a dispatch-off swarm still spends the app-global budget.
      // Filtering it out here would have retainSwarms() delete its ledger every
      // tick, dropping its holds and measured turns — exactly the over-subscription
      // the cap exists to prevent. Registration and measurement therefore cover all
      // of them; only the wake-generating body below is gated on swarmDispatch.
      const all = trackedSwarms(useLayout.getState().workspaces);
      // The budget is app-global, so whichever swarm is processed first spends
      // it first. Rotate the order every tick: with two swarms at cap=1 they
      // alternate instead of one starving forever.
      const swarms = all.length > 1 ? [...all.slice(round % all.length), ...all.slice(0, round % all.length)] : all;
      round++;
      // Register live swarms (cap = one turn per builder of the largest) and
      // drop closed ones so a stale workspace cannot hold the cap up.
      retainSwarms(all.map((w) => w.swarm!));
      // Drop feeds for swarms that are gone from the layout entirely.
      const live = new Set(all.map((w) => w.swarm!));
      for (const project of [...subs.keys()]) if (!live.has(project)) unwatchFeed(project);
      // A swarm that vanished from the layout was CANCELLED — the human deleted
      // its workspace. Tear it down exactly as a finished one, because until this
      // existed NOTHING did: the teardown below is inside the missionDone branch,
      // so a cancelled swarm left its lock and both hook blocks armed on the repo
      // (which then went on refusing the HUMAN's own commits to master) and its
      // agent tokens live in the brain. `cleaned` gates it to once per swarm, so
      // a swarm that finished and was then closed is not torn down twice.
      //
      // The repo is read from last tick's sample: by the time a workspace is gone
      // its panes are gone with it, and the panes are where the cwd lived.
      for (const { project, repo, disarm } of cancelledSwarms(repoOf, live)) {
        repoOf.delete(project);
        owedReset.delete(project);
        if (cleaned.has(project)) continue; // finished, then closed — not torn down twice
        cleaned.add(project);
        swarmUnregisterAgents(project).catch(() => {});
        if (disarm) swarmGuardRemove(repo).catch(() => {});
      }
      for (const ws of swarms) {
        // Ledger upkeep FIRST, for every swarm: cap contribution + which of its
        // panes are actually live. A dispatch-off swarm gets no wakes but its
        // nudge/runaway turns must still be counted and its holds preserved.
        const panes = collectPanes(ws.root).filter(isTerminal);
        // ONLY agent panes count: a human split into this workspace tailing a
        // build produces output forever, and counting it would permanently eat a
        // slot — at cap=1 that stalls the swarm with nothing able to recover it.
        const agentPanes = panes.filter(isRolePane);
        // `concurrent` lifts this swarm's turn cap in the ledger (takeTurnSlot),
        // so every role can hold a live LLM turn at once. Refreshed each tick so
        // toggling "run concurrent" on a live workspace takes effect at once.
        registerSwarm(ws.swarm!, agentPanes.filter((p) => isBuilderRole(paneRole(p))).length, !!ws.swarmConcurrent);
        // Sampled for every swarm, dispatch on or off: the teardown above runs on
        // the tick AFTER the workspace disappears, and this is the last chance to
        // learn which repo to disarm.
        const wsRepo = swarmCwd(agentPanes);
        if (wsRepo) repoOf.set(ws.swarm!, wsRepo);
        reportBusy(ws.swarm!, agentPanes.filter((p) => paneBusy(ws.swarm!, p) || sending.has(p.id)).map(paneRole));
        // Wake mirror upkeep. The store is a MIRROR of `wakes` below, and the
        // dispatcher only ever deletes a wake when the injection FAILED — so
        // every path that generates no wakes this tick must reconcile the mirror
        // to "nothing outstanding", or a finished/idle swarm shows "wake due"
        // forever (brain-findings 1.6). Every `continue` below goes through this.
        // (It also clears the stuck-review row: same reconcile, same reason — a
        // swarm this tick generated nothing for has nothing outstanding.)
        const noWakes = () => {
          useSwarmTelemetry.getState().retainWakes(ws.id, wakeMirror([], false));
          useSwarmTelemetry.getState().setStuck(ws.id, []);
          useSwarmTelemetry.getState().setStray(ws.id, []); // tripwire does not run on this path
        };
        if (!ws.swarmDispatch) { unwatchFeed(ws.swarm!); noWakes(); continue; } // host dispatch off — budget tracked, no wakes generated
        // Mission-complete gate: the coordinator writes note "result" at mission
        // end. Once seen, stop generating any wakes for this swarm and drop its
        // feed, so a finished swarm stops polling the brain altogether.
        if (completed.has(ws.swarm!)) { noWakes(); continue; }
        watchFeed(ws.swarm!);
        const feed = brainFeedNow(ws.swarm!);
        // No pass has landed yet (the feed was just subscribed, or the brain is
        // unavailable) — same answer as a failed read: skip, retry next tick.
        if (!feed?.ready) { noWakes(); continue; }
        // "result" is a WATCHED key, so its body arrives on the tick after its key
        // first appears: mission end is seen one 5 s round later than the old
        // direct read saw it. Harmless — it costs one extra wake round at the very
        // end of a mission, and never a missed completion.
        const result = feed.keys.includes("result") ? feed.notes["result"]?.value : undefined;
        const tasks: SwarmTask[] = feed.tasks;
        // A "result" note only completes the mission once no task is IN FLIGHT.
        // Seen live (finding-reviewer-never-starts): the coordinator declared
        // victory while a changes-rework was still running, the builder posted
        // `done` into a stopped swarm, and the task sat unreviewed until a human
        // merged it by hand. A premature "result" keeps the dispatcher running so
        // the ordinary review/merge wakes drain the leftovers; the same note then
        // completes the mission on the first tick the bus is clear.
        if (missionDone(result, tasks)) {
          completed.add(ws.swarm!);
          // Tear the enforcement scaffolding down: revoke the swarm's agent
          // tokens + per-role MCP configs, and remove the pre-commit guard from
          // the repo so ordinary commits work again. Once per swarm.
          if (!cleaned.has(ws.swarm!)) {
            cleaned.add(ws.swarm!);
            const repo = swarmCwd(agentPanes);
            swarmUnregisterAgents(ws.swarm!).catch(() => {});
            // Only the last swarm out of a repo disarms it — a sibling still
            // running there keeps its seatbelt. Same rule as the cancel teardown.
            const shared = all.some((w) => w.swarm !== ws.swarm && repoOf.get(w.swarm!) === repo);
            if (repo && !shared) swarmGuardRemove(repo).catch(() => {});

          }
          unwatchFeed(ws.swarm!); noWakes(); continue;
        }
        // Slots come out of the ONE app-global ledger; a pane woken this tick
        // has produced no output yet, so its slot is held there until the next
        // measurement confirms it (or the hold expires).
        const takeSlot = (role: string) => takeTurnSlot(ws.swarm!, role);
        // Panes are found by their TYPED role, never by title: a renamed or
        // re-titled reviewer pane used to disappear from this lookup and hand
        // the merge gate straight to the coordinator (brain-findings 1.4).
        const byRole = (name: string) => agentPanes.find((p) => paneRole(p) === name);
        // COLD START on an empty bus — see coldStartPane(). Without this a
        // headless swarm never starts at all.
        if (tasks.length === 0) {
          const cold = coldStartPane(tasks, byRole("coordinator"));
          if (cold) launchDeferred(ws.swarm!, cold, sending, takeSlot);
          noWakes();
          continue;
        }
        // No "plan" KEY means no plan, and the gate holds the builders. A key that
        // exists but whose body has not landed yet is a brain hiccup, not a
        // missing plan: assume a plan and don't nag, exactly as the old read did.
        const plan = feed.keys.includes("plan") ? (feed.notes["plan"]?.value ?? "?") : "";
        // Every review pane: "reviewer-1".."reviewer-N", plus the bare "reviewer"
        // of a workspace saved before multi-reviewer. None = reviewers:0, and the
        // merge gate falls back to the coordinator (it merges "done" directly).
        const reviewerPanes = agentPanes.filter((p) => isReviewerRole(paneRole(p)));
        const hasReviewer = reviewerPanes.length > 0;
        const of = (status: string, role: string) => tasks.filter((t) => t.status === status && taskRole(t) === role);
        // A premature "result" (in-flight work kept missionDone false above) puts
        // the swarm in DRAIN mode: the coordinator has declared no new work, so
        // open tasks stop waking anyone — only the review/merge/changes/stale
        // paths run, until the last in-flight task clears and the note completes.
        const draining = !!result?.trim();
        const repo = swarmCwd(agentPanes);

        // THE MERGE IS THE HOST'S, not an agent's. A task ready to merge
        // (approved, or done when the swarm runs no reviewer) is merged by
        // PixelMarch itself — worktree cleanup and all — and the branch never
        // reaches an agent's git. This is half of what stops the runaway seen
        // live (finding-builder-continues-after-done): the other half is the
        // brain refusing an agent-posted `merged` and the pre-commit guard
        // blocking a direct master commit. On success the owning builder is
        // force-reset (its work landed, it must not keep touching it) and the
        // coordinator is nudged to unblock successors per its plan; on conflict
        // the task goes back to its owner as `changes`.
        for (const t of of(hasReviewer ? "approved" : "done", "builder")) {
          void hostMerge(ws.swarm!, repo, t, byRole(t.owner), merging, quiesced, owedReset);
        }
        // SCOPE RECLAIMS are the host's too, and for the same reason the merge is:
        // only PixelMarch can stop a pane, so only PixelMarch can take a live task
        // off a builder without leaving it free to keep working (brain-findings
        // 2.2). The coordinator asks; this performs it, fence and all.
        void runReclaims(ws.swarm!, feed.keys, byRole, true, reclaiming);
        // Stray-edit tripwire: a builder editing the root checkout instead of its
        // worktree (the other shape of the incident) shows up as a dirty root.
        // Tell the coordinator once so a human hears about it; the guard already
        // blocks the commit, this just surfaces the attempt.
        if (repo) void reportStrayEdits(ws.swarm!, ws.id, repo, strayReported);
        // Identity, stamped where the guard can read it: which pane owns which
        // worktree. Cheap after the first write per claim — see syncWorktreeOwners.
        if (repo) void syncWorktreeOwners(repo, tasks, ownerMarked);
        // Did master move without us? The guard breach that leaves no trace on
        // the bus — see watchHead.
        if (repo) void watchHead(ws.swarm!, ws.id, repo, heads, merging);
        // A `changes` task whose branch already carries the rework: post the
        // `done` its builder owed, rather than re-waking it forever.
        if (repo) {
          void resolveStaleChanges(ws.swarm!, repo, tasks, (owner) => {
            const p = byRole(owner);
            return !!p && paneIdle(ws.swarm!, p);
          }, changesResolved);
        }

        // SCOUT REPORTS ARE RETIRED BY THE HOST. Nothing else can: reviewers skip
        // role=scout and there is no branch to merge, so a delivered report sat at
        // `done` forever — re-waking the coordinator every REWAKE_MS about a map it
        // had already planned from, and holding the mission open (a `done` task is
        // in flight, so missionDone and idleBus could never fire). Retired tasks
        // also leave this tick's wake set, so the tick that settles one does not
        // wake the coordinator about it on the way out.
        const coordinator = byRole("coordinator");
        const scoutDone = of("done", "scout");
        const retiring = consumedScouts(
          scoutDone,
          coordinator ? wakes.get(`${coordinator.id}/scout-done`) : undefined,
          Date.now(),
          !!coordinator && paneIdle(ws.swarm!, coordinator),
        );
        if (retiring.length) void retireScouts(ws.swarm!, retiring, scoutRetired);

        let stuck: StuckReview[] = []; // done tasks nobody is reviewing — filled below
        const jobs: WakeJob[] = [
          { kind: "scout-done", pane: coordinator, pending: scoutDone.filter((t) => !retiring.includes(t)), msg: WAKE_MESSAGES["scout-done"] },
          { kind: "scout-open", pane: byRole("scout"), pending: draining ? [] : of("open", "scout"), msg: WAKE_MESSAGES["scout-open"] },
        ];
        if (hasReviewer) {
          // Fan the done tasks out: one owning reviewer per task, so two panes are
          // never woken for the same diff. Assignments are remembered per swarm so
          // a re-wake goes back to the pane that already has the task.
          const doneTasks = of("done", "builder");
          const assigned = assignReviews(
            reviewerPanes.map(paneRole),
            doneTasks,
            reviewedBy.get(ws.swarm!) ?? new Map(),
            (role) => { const p = byRole(role); return !!p && paneIdle(ws.swarm!, p) && !sending.has(p.id); },
          );
          reviewedBy.set(ws.swarm!, assigned);
          for (const pane of reviewerPanes) {
            const role = paneRole(pane);
            const mine = doneTasks.filter((t) => assigned.get(t.key) === role);
            if (mine.length) jobs.push({ kind: "review", pane, pending: mine, msg: WAKE_MESSAGES.review });
          }
          stuck = stuckReviews(doneTasks, assigned, Date.now(), (role) => {
            const p = byRole(role);
            return !!p && paneIdle(ws.swarm!, p);
          });
        }
        // Straight to the human, not through a coordinator turn (brain-findings 1.1).
        useSwarmTelemetry.getState().setStuck(ws.id, stuck);

        // Builders: changes tasks wake their owner; open tasks wake idle builders,
        // one per open task — the atomic claim resolves any race.
        const builders = agentPanes.filter((p) => isBuilderRole(paneRole(p)));
        const changes = tasks.filter((t) => t.status === "changes");
        for (const b of builders) {
          const back = changes.filter((t) => t.owner === paneRole(b));
          if (back.length) jobs.push({ kind: "changes", pane: b, pending: back, msg: WAKE_MESSAGES.changes });
        }
        // Stale claims: the deadlock case. A builder that did the work but ended
        // its turn without posting `done` leaves the task claimed forever — no
        // open task exists, so nothing wakes anyone and the mission stalls.
        // Wake the owner; it may have lost its context, so the message points at
        // note protocol-recover, which carries the full recovery steps.
        for (const t of staleClaims(tasks, Date.now(), (owner) => { const p = byRole(owner); return !!p && paneIdle(ws.swarm!, p); })) {
          jobs.push({ kind: `claim-${t.key}`, pane: byRole(t.owner), pending: [t], urgent: true, msg: WAKE_MESSAGES.claim });
        }

        // Plan gate. No "plan" note = the brain rejects every builder claim, so
        // builder wakes are wasted turns; nag the coordinator instead and hold the
        // builders. Covers the dead-swarm shape too (tasks posted, plan never
        // written, everything blocked — nothing open, so nobody was ever woken).
        const ungated = draining ? [] : planGate(tasks, plan);
        if (ungated.length) jobs.push({ kind: "plan", pane: byRole("coordinator"), pending: ungated, urgent: true, msg: WAKE_MESSAGES.plan });

        // MALFORMED tasks: a task note whose status/role/owner/files header is gone
        // (the brain reports them as such rather than reading them as fresh open
        // work — see note_write_refusal). Nothing else wakes on them: they are not
        // open, not claimable, and have no owner to nag, so without this a task
        // whose header was clobbered sits on the bus forever and the mission stalls
        // on work everyone believes is finished. Only the coordinator can repair one.
        const malformed = tasks.filter((t) => t.status === "malformed");
        if (malformed.length) jobs.push({ kind: "malformed", pane: byRole("coordinator"), pending: malformed, urgent: true, msg: WAKE_MESSAGES.malformed });

        // THE BUS IS IDLE AND NOBODY IS COMING (idleBus). Nothing open, nothing
        // in flight, mission not declared: no status on the bus wakes any role,
        // so without this the swarm is simply over — with its plan written and
        // its tasks still `blocked`, which is how briefs tell coordinators to
        // create them. Seen live twice in one day. Only the coordinator can end
        // it, and it is urgent because nothing else will ever fire.
        const idle = idleBus(tasks, plan, result);
        if (idle) jobs.push({ kind: idle.kind, pane: byRole("coordinator"), pending: idle.tasks, urgent: true, msg: WAKE_MESSAGES[idle.kind] });

        const open = draining || ungated.length ? [] : of("open", "builder");
        if (open.length) {
          const free = builders.filter((b) => paneIdle(ws.swarm!, b) && !changes.some((t) => t.owner === paneRole(b)));
          // urgent: these tasks are still unclaimed, so whatever wake went out
          // last time achieved nothing — don't sit on the slow heartbeat gap.
          for (const b of free.slice(0, open.length)) jobs.push({ kind: "open", pane: b, pending: open, urgent: true, msg: WAKE_MESSAGES.open });
        }

        // Mirror reconcile: this tick's job list IS the set of outstanding wakes.
        // A kind that no longer has pending work (everything merged) must stop
        // showing a countdown, or an idle finished swarm reads as "wake due".
        useSwarmTelemetry.getState().retainWakes(
          ws.id,
          wakeMirror(jobs.map((j) => ({ kind: j.kind, role: j.pane ? paneRole(j.pane) : "", pending: j.pending }))),
        );

        // Age-order before spending any of the budget. The queue used to be
        // positional (coordinator jobs declared first), so at cap=1 a
        // coordinator coming due every heartbeat took the only slot every tick
        // and the builder wake behind it never fired. Longest-since-last-wake
        // goes first; a never-woken job goes before all of them.
        for (const { kind, pane, pending, urgent, msg } of byWakeAge(jobs, (j) => (j.pane ? wakes.get(`${j.pane.id}/${j.kind}`)?.at : undefined))) {
          if (!pane || pending.length === 0) continue;
          // Deferred pane (lazy worker not launched yet, or context-reset agent
          // waiting to be re-briefed): bring it up now, wake it next tick.
          if (launchDeferred(ws.swarm!, pane, sending, takeSlot)) continue;
          const sig = pending.map((t) => `${t.key}:${t.status}`).sort().join(",");
          const tag = `${pane.id}/${kind}`;
          const prev = wakes.get(tag);
          // Hook-capable pane: UserPromptSubmit proves delivery, so the miss
          // counter (a workaround for a TUI silently eating keystrokes) is out of
          // the picture entirely — no retry-at-once branch, and the output-echo
          // confirmation below is replaced by the prompt-accepted stamp, which
          // only ever mirrors a landed wake for the UI.
          const hooks = hasHooks(paneCommand(pane));
          if (!wakeDue(prev, sig, Date.now(), !!urgent, hooks)) continue;
          if (sending.has(pane.id) || !paneIdle(ws.swarm!, pane)) continue; // busy — retry next tick
          const role = paneRole(pane);
          if (!takeSlot(role)) break; // at the cap — every remaining job retries next tick
          sending.add(pane.id);
          const misses = prev && prev.sig === sig ? prev.misses : 0;
          const state = { sig, at: Date.now(), misses };
          wakes.set(tag, state);
          // Mirror the wake for the UI countdown (the hook stays authoritative).
          const tele = useSwarmTelemetry.getState();
          tele.reportWake(ws.id, role, kind, state, !!urgent);
          const paneId = pane.id;
          injectPrompt(ws.swarm!, paneId, role, msg(pending.map((t) => t.key).join(", "), role))
            .then(() => (hooks
              ? confirmHookDelivery(ws.swarm!, role, state.at, tag, wakes, sig, (w) => tele.reportWake(ws.id, role, kind, w, !!urgent))
              : confirmDelivery(paneId, tag, wakes, sig, (w) => tele.reportWake(ws.id, role, kind, w, !!urgent))))
            // A failed injection never happened — forget it so the next tick
            // retries instead of sitting out the full REWAKE_MS window.
            .catch(() => { wakes.delete(tag); tele.clearWake(ws.id, role, kind); })
            .finally(() => sending.delete(pane.id));
        }

        // Inter-agent chat wakes. The rows come from the BRAIN now (brain_chat,
        // the read side of the same storage the chat_send/chat_inbox MCP tools
        // write): `from` and `targets` arrive already split and routed, so the
        // "chat-(.+)-\d+" key regex and the "to:" header regex that used to live
        // here are GONE, not bypassed — there is one parser for this convention
        // and it is in the brain. The storage did not change (still chat-<from>-<n>
        // notes), so a curl-only pane hand-writing one is read back identically.
        const hits = await chatRows(ws.swarm!);
        for (const pane of agentPanes) {
          if (sending.has(pane.id) || !paneIdle(ws.swarm!, pane)) continue; // busy — retry next tick
          const role = paneRole(pane);
          const fresh: { key: string; seenKey: string }[] = [];
          for (const h of chatWakeRows(hits, role)) {
            const seenKey = `${pane.id}::${h.key}::${h.updated}`;
            if (seenChat.has(seenKey)) continue;
            fresh.push({ key: h.key, seenKey });
          }
          if (fresh.length === 0) continue;
          // Same deferred rule as the task wakes: bring the pane up, leave the
          // messages unseen so the next tick delivers them to a live pane.
          if (launchDeferred(ws.swarm!, pane, sending, takeSlot)) continue;
          if (!takeSlot(role)) break; // at the cap — the messages stay unseen and retry next tick
          sending.add(pane.id);
          const keys = fresh.map((f) => f.key).join(", ");
          injectPrompt(ws.swarm!, pane.id, role, WAKE_MESSAGES.chat(keys, role))
            // Only mark seen once the wake actually landed, so a failed inject retries.
            .then(() => fresh.forEach((f) => seenChat.add(f.seenKey)))
            .catch(() => {})
            .finally(() => sending.delete(pane.id));
        }

        // COORDINATOR CYCLE WIPE — the same call the merge above already makes for
        // the builder whose work landed, for the role that plans it. Armed by
        // hostMerge (a merge was reported and the unblock asked for), fired here
        // once the coordinator has gone quiet with nothing queued for it. Without
        // it the wipe depended entirely on the coordinator obeying one line of its
        // brief, which is exactly the instruction a full context stops following.
        const coord = byRole("coordinator");
        if (coord && owedReset.has(ws.swarm!)) {
          const selected = clearsRole(clearRolesOf(ws), "coordinator");
          // Not the human's choice: consume the flag rather than re-test it on
          // every tick for the rest of the mission.
          if (!selected) owedReset.delete(ws.swarm!);
          else {
            const lastOut = lastOutputAt(coord.id);
            const due = coordinatorQuiesceDue({
              selected,
              armed: true,
              idle: paneIdle(ws.swarm!, coord) && !sending.has(coord.id),
              quietMs: lastOut ? Date.now() - lastOut : 0,
              pendingWakes: jobs.filter((j) => j.pane?.id === coord.id && j.pending.length > 0).length,
              unseenChat: chatWakeRows(hits, "coordinator").filter((h) => !seenChat.has(`${coord.id}::${h.key}::${h.updated}`)).length,
              parked: !!(coord.pendingPrompt || coord.pendingCommand),
            });
            if (due) {
              owedReset.delete(ws.swarm!);
              const paneId = coord.id;
              const cmd = paneCommand(coord);
              const tele = useSwarmTelemetry.getState();
              tele.reportReset(ws.id, "coordinator", true); // health strip, same as a self-requested reset
              void brainUrl()
                .then((url) => (url ? forceReset(ws.swarm!, paneId, cmd, url, "coordinator", true) : false))
                .catch(() => false)
                // A wipe that did not happen (no brain URL, pane gone mid-flight,
                // a reset already in flight for this role) re-arms: the cycle is
                // still over, so the next tick tries again rather than leaving the
                // coordinator to grow for the rest of the mission.
                .then((ok) => { if (!ok) owedReset.add(ws.swarm!); })
                .finally(() => useSwarmTelemetry.getState().reportReset(ws.id, "coordinator", false));
            }
          }
        }
      }
    };
    const t = setInterval(tick, POLL_MS);
    return () => {
      clearInterval(t);
      for (const project of [...subs.keys()]) unwatchFeed(project);
    };
  }, []);
}
