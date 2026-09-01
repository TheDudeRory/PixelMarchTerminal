// Real turn boundaries (swarm Phase A4). Agent CLIs that support lifecycle hooks
// curl the embedded brain on every session start, prompt submit, turn end and
// notification (the hook block is installed per pane by the Rust side); the brain
// keeps those in a bounded per-project ring and serves them at
// `GET /agent-events?project=&since=<seq>`. This module is the frontend end of
// that channel: one poller per swarm project, a cursor that never replays, and
// three questions the watchers used to answer by guessing at PTY silence —
// `turnActive()`, `lastTurnEndAt()`, `lastPromptAcceptedAt()`.
//
// EVERY reader must treat `undefined` as "no signal" and fall back to the old
// output-quiet heuristic. Only `claude` is hook-capable today (AGENT_CAPS in
// swarm.ts); on a host without it this whole module stays empty and every
// consumer takes exactly the path it took before. A wrong "the turn is over"
// wedges a pane, so the unknown answer is never guessed.
import { brainUrl } from "./ipc";

export type AgentEventKind = "session-start" | "prompt-submitted" | "turn-end" | "notification" | "compacting";

/** The kinds POST /agent-event accepts. Anything else is dropped on the floor
 *  here as well as at the brain — a kind we do not model must never move a turn
 *  boundary. */
export const AGENT_EVENT_KINDS: readonly AgentEventKind[] = ["session-start", "prompt-submitted", "turn-end", "notification", "compacting"];

/** How long a compaction is believed once its `PreCompact` hook has fired.
 *  Compaction ends at the NEXT event from that role — the CLI fires SessionStart
 *  (source `compact`) when it comes back, and any prompt/turn boundary proves it
 *  too — but there is no hook that means "compaction failed", and an unbounded
 *  belief would switch the runaway watchdog off for that pane forever. Generous
 *  on purpose: compaction is one huge summarisation completion, and on a local
 *  endpoint it can genuinely run for many minutes. */
export const COMPACT_MAX_MS = 15 * 60_000;

/** One event as the brain serves it. `at` is optional and may be seconds or
 *  milliseconds (the brain stamps with its own clock); missing = "now". */
export interface AgentEvent {
  seq: number;
  role: string;
  event: string;
  session?: string;
  detail?: string;
  at?: number;
}

/** GET /agent-events answer: the events after `since`, plus the ring's current
 *  sequence number (the cursor to send next time). */
export interface AgentEventsPage {
  events?: AgentEvent[];
  seq?: number;
}

/** When each kind was last seen for one role. 0 = never seen. */
export interface RoleEvents {
  sessionStartAt: number;
  promptAt: number;
  turnEndAt: number;
  notifyAt: number;
  /** When this role last STARTED compacting its context (hook `PreCompact`).
   *  Not a turn boundary: the turn it interrupts is still open behind it. */
  compactAt: number;
}

interface ProjectEvents {
  cursor: number;
  /** Consecutive pages whose ring seq came back BELOW our cursor. One is a
   *  duplicate page; RESTART_CONFIRM of them is a restarted ring. */
  low: number;
  roles: Map<string, RoleEvents>;
}

/** How many consecutive below-cursor pages it takes to declare a ring restart. */
const RESTART_CONFIRM = 2;

const store = new Map<string, ProjectEvents>();

const POLL_MS = 1000; // local HTTP on loopback — cheap, and idle detection is latency-bound
const BACKOFF_MS = 30_000; // endpoint missing (older brain) or erroring — stop hammering it
const FAIL_MAX = 3;

const blank = (): RoleEvents => ({ sessionStartAt: 0, promptAt: 0, turnEndAt: 0, notifyAt: 0, compactAt: 0 });

/** Normalize the brain's stamp to a Date.now()-comparable millisecond value.
 *  A stamp below 1e12 is seconds (that threshold is 2001 in ms, 33k AD in s),
 *  which is the same unit rule the task bus uses for `updated`. */
function stampMs(at: number | undefined): number {
  if (typeof at !== "number" || !isFinite(at) || at <= 0) return Date.now();
  return at < 1e12 ? at * 1000 : at;
}

function project(name: string): ProjectEvents {
  let p = store.get(name);
  if (!p) store.set(name, (p = { cursor: 0, low: 0, roles: new Map() }));
  return p;
}

/** Fold one /agent-events page into the store and return the new cursor.
 *  Two guarantees the callers depend on:
 *   - NO REPLAY: an event whose seq is at or below the cursor is ignored, so a
 *     duplicated page (retry, two subscribers) cannot move a turn boundary back.
 *   - MONOTONIC (except on a confirmed ring restart, below): the cursor only
 *     ever grows, taking the page's own `seq` when it
 *     is ahead of the last event (the ring may have dropped events we never saw;
 *     jumping to its seq is what keeps the next request from asking for them
 *     forever). */
export function ingestAgentEvents(name: string, page: AgentEventsPage | null | undefined): number {
  const p = project(name);
  if (!page) return p.cursor;
  // RING RESTART. The ring's own seq going BACKWARDS means the brain recreated
  // this project's ring (brain restarted, rebound in-process, project dropped and
  // re-created): every seq we hold is from a dead numbering, so the no-replay
  // rule below would drop every new event forever and freeze each role on its
  // last state — and a role frozen at "mid-turn" wedges its pane.
  // A single low page is NOT enough to conclude that: a re-delivered older page
  // (retry, two subscribers folding the same response) looks exactly the same and
  // must stay a no-op. Only a SECOND consecutive low reading — i.e. the ring is
  // really sitting below our cursor, not one duplicate in flight — rewinds.
  if (typeof page.seq === "number" && page.seq < p.cursor) {
    if (++p.low < RESTART_CONFIRM) return p.cursor; // one duplicate page — ignore it
    // Back to zero, not to page.seq: the page's own events carry seqs at or below
    // its head, and rewinding only to the head would drop the very page that
    // proved the restart.
    p.cursor = 0;
    p.roles.clear();
    p.low = 0;
  } else {
    p.low = 0;
  }
  for (const e of page.events ?? []) {
    if (!e || typeof e.seq !== "number" || e.seq <= p.cursor) continue; // stale or replayed
    if (!e.role || !AGENT_EVENT_KINDS.includes(e.event as AgentEventKind)) continue; // unknown kind — never guess
    let r = p.roles.get(e.role);
    if (!r) p.roles.set(e.role, (r = blank()));
    const at = stampMs(e.at);
    if (e.event === "session-start") r.sessionStartAt = at;
    else if (e.event === "prompt-submitted") r.promptAt = at;
    else if (e.event === "turn-end") r.turnEndAt = at;
    else if (e.event === "compacting") r.compactAt = at;
    else r.notifyAt = at;
    p.cursor = Math.max(p.cursor, e.seq);
  }
  if (typeof page.seq === "number" && page.seq > p.cursor) p.cursor = page.seq;
  return p.cursor;
}

/** Fold ONE locally-observed event into a role's state, with no ring sequence
 *  behind it. The hook channel above is not the only source of a real turn
 *  boundary: a headless pane's CLI reports its own lifecycle in the JSON stream
 *  it writes to stdout (agentStream.ts), and that is the same fact arriving by a
 *  different road. Recording it here — rather than teaching every watcher about
 *  a second store — is what lets `turnActive` / `lastTurnEndAt` /
 *  `lastPromptAcceptedAt` answer for headless panes with their consumers
 *  UNMODIFIED.
 *
 *  MONOTONIC PER FIELD, which the seq-ordered path gets for free and this one
 *  does not: a project can have both channels live (a headless pane still fires
 *  its lifecycle hooks), and the brain poller runs on a 1 s timer, so a hook
 *  event can be INGESTED after a stream event that happened later. Taking the
 *  later stamp keeps a stale arrival from moving a boundary backwards — the one
 *  mistake that wedges a pane, because a turn-end older than the prompt reads as
 *  "still mid-turn" forever. */
export function recordAgentEvent(name: string, role: string, kind: AgentEventKind, at = Date.now()): void {
  if (!name || !role || !AGENT_EVENT_KINDS.includes(kind)) return;
  const p = project(name);
  let r = p.roles.get(role);
  if (!r) p.roles.set(role, (r = blank()));
  const stamp = at > 0 ? at : Date.now();
  if (kind === "session-start") r.sessionStartAt = Math.max(r.sessionStartAt, stamp);
  else if (kind === "prompt-submitted") r.promptAt = Math.max(r.promptAt, stamp);
  else if (kind === "turn-end") r.turnEndAt = Math.max(r.turnEndAt, stamp);
  else if (kind === "compacting") r.compactAt = Math.max(r.compactAt, stamp);
  else r.notifyAt = Math.max(r.notifyAt, stamp);
}

/** The `since` value the next request must carry. 0 = nothing seen yet. */
export function agentEventsCursor(name: string): number {
  return store.get(name)?.cursor ?? 0;
}

/** Everything known about one role, or undefined when this project/role has
 *  produced no events at all (no hooks installed, or the CLI has none). */
export function roleEvents(name: string, role: string): RoleEvents | undefined {
  return store.get(name)?.roles.get(role);
}

/** When this role's last turn ENDED (hook `Stop`), or 0 if never seen. */
export function lastTurnEndAt(name: string, role: string): number {
  return roleEvents(name, role)?.turnEndAt ?? 0;
}

/** When this role last ACCEPTED a prompt (hook `UserPromptSubmit`) — the real
 *  answer to "did the wake land?", which the dispatcher used to infer from any
 *  PTY output inside WAKE_DELIVERY_MS. 0 = never seen. */
export function lastPromptAcceptedAt(name: string, role: string): number {
  return roleEvents(name, role)?.promptAt ?? 0;
}

/** When this role's CLI last STARTED a session (hook `SessionStart`), or 0. */
export function lastSessionStartAt(name: string, role: string): number {
  return roleEvents(name, role)?.sessionStartAt ?? 0;
}

/** Is this role mid-turn right now? true/false only when the hooks have actually
 *  told us something; UNDEFINED means "no signal — use the quiet timer". A
 *  session-start alone is deliberately not enough: it says the CLI came up, not
 *  whether it is thinking. */
export function turnActive(name: string, role: string): boolean | undefined {
  const r = roleEvents(name, role);
  if (!r || (!r.promptAt && !r.turnEndAt)) return undefined;
  return r.promptAt > r.turnEndAt;
}

/** Is this role COMPACTING its context right now?
 *
 *  Compaction is the state that looks most like a wedged agent and is the least
 *  like one: the pane is busy, the screen is frozen on one line, no tool call
 *  happens for minutes, and none of it is the agent's turn — the CLI is
 *  summarising its own context so the turn can continue. The runaway watchdog
 *  read that as a spiralling turn and spent its restart budget aborting healthy
 *  agents mid-compaction, and the dispatcher read the same pane as idle and typed
 *  wakes into a TUI that was not listening.
 *
 *  The window opens on `PreCompact` and closes on the NEXT event from the role —
 *  the CLI fires SessionStart (source `compact`) on the way back, and a prompt or
 *  turn boundary proves it just as well — or after COMPACT_MAX_MS, because no
 *  hook says "compaction failed" and a belief with no end would leave the pane
 *  unwatched forever. */
export function compacting(name: string, role: string, now = Date.now()): boolean {
  const r = roleEvents(name, role);
  if (!r?.compactAt) return false;
  // Any later boundary means the CLI is back — including the session-start the
  // compaction itself produces.
  if (Math.max(r.sessionStartAt, r.promptAt, r.turnEndAt, r.notifyAt) > r.compactAt) return false;
  return now - r.compactAt < COMPACT_MAX_MS;
}

/** Drop everything for one project (or all of them) — swarm closed, or a test. */
export function resetAgentEvents(name?: string): void {
  if (name === undefined) store.clear();
  else store.delete(name);
}

/** One HTTP round trip. Returns false when the channel is not usable (brain not
 *  bound yet, endpoint missing on an older brain, transport error) so the poller
 *  can back off instead of hammering a 404 every second. */
export async function pollAgentEvents(name: string): Promise<boolean> {
  let base = "";
  try { base = await brainUrl(); } catch { return false; }
  if (!base) return false;
  try {
    const res = await fetch(`${base}/agent-events?project=${encodeURIComponent(name)}&since=${agentEventsCursor(name)}`);
    if (!res.ok) return false;
    ingestAgentEvents(name, (await res.json()) as AgentEventsPage);
    return true;
  } catch {
    return false;
  }
}

interface Sub { n: number; stop: () => void }
const subs = new Map<string, Sub>();

/** Subscribe to one project's agent events. Ref-counted: swarmDispatch and
 *  swarmReset both want the same stream and must not open two pollers for it.
 *  Returns the unsubscribe; the poller stops when the last subscriber leaves,
 *  and the project's state is dropped with it (a re-subscribe re-reads from
 *  cursor 0, which the brain answers with the whole ring it still holds). */
export function subscribeAgentEvents(name: string): () => void {
  const cur = subs.get(name);
  if (cur) {
    cur.n++;
    return () => release(name);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let fails = 0;
  const loop = async () => {
    if (stopped) return;
    const ok = await pollAgentEvents(name);
    fails = ok ? 0 : fails + 1;
    if (stopped) return;
    timer = setTimeout(loop, fails >= FAIL_MAX ? BACKOFF_MS : POLL_MS);
  };
  void loop();
  subs.set(name, { n: 1, stop: () => { stopped = true; if (timer) clearTimeout(timer); } });
  return () => release(name);
}

function release(name: string): void {
  const s = subs.get(name);
  if (!s) return;
  if (--s.n > 0) return;
  s.stop();
  subs.delete(name);
  resetAgentEvents(name);
}
