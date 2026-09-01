// Swarm M1 — turn one mission into a workspace of coordinated agent panes.
// Coordination runs entirely over BigBrain notes (project `<repo>-swarm-<slug>`); this
// module only builds the role briefs, the panes, and the grid layout tree.
// Full design: swarm.md at the repo root.
import { collectPanes, isTerminal, newGroup, newPane, type LayoutNode, type Pane, type TabGroup } from "./layout-tree";

/** Per-role-kind agent CLI. The boot prompt is appended as one single-quoted arg,
 *  so any client that accepts `cmd '<prompt>'` works (claude, codex, gemini, …). */
export interface AgentCmds {
  coordinator: string;
  builders?: string[]; // one client per builder, indexed by builder number - 1 (empty entry inherits builders[0])
  scout: string;
  reviewer: string; // legacy single-reviewer client; seeds reviewers[] when that is empty
  reviewers?: string[]; // one client per reviewer, indexed like builders[] (empty entry inherits reviewers[0])
}

/** Client used when a role has no command configured at all. */
export const DEFAULT_AGENT_CMD = "claude";

/** A user-written .md that replaces one role's generated brief body.
 *  `path` is kept only so the dialog can show what was picked; `body` is the
 *  text that actually ships (read at pick time, so editing the file afterwards
 *  does not silently change an already-launched swarm). */
export interface RoleBrief {
  path: string;
  body: string;
}

export interface SwarmConfig {
  mission: string;
  cwd: string; // working directory every agent starts in
  builders: number; // 1..4
  scout: boolean;
  reviewers: number; // 0..4 review panes; 0 = the coordinator is the merge gate
  reviewer?: boolean; // LEGACY single-reviewer flag — read by migrateSwarmConfig(), never by new code
  agentCmds: AgentCmds;
  skipPermissions: boolean; // add each CLI's bypass-permissions flag to every pane
  clearRoles: RoleKind[]; // stateless-worker context wipes between cycles, per ROLE KIND —
  // which kinds of agent get /clear'd at a cycle end (e.g. ["builder"] = only builders).
  // Empty = context resets off entirely. Replaces the old single contextResets bool, so a
  // user can wipe just the workers while the coordinator keeps its planning context.
  concurrent: boolean; // let every role hold a live LLM turn at once — lifts the app-global
  // turn cap for this swarm (builders + reviewers run wild). Default off keeps the single
  // local endpoint safe (one completion at a time).
  hostDispatch: boolean; // poll-free workers: agents end their turn when idle and the
  // host watches the task bus, waking the right pane when work appears (off by default)
  lazyWorkers: boolean; // only the coordinator starts its CLI at launch; every other
  // role's pane opens as a bare shell and the host launches its agent on the first
  // wake. Needs hostDispatch (nothing else knows when a role is needed).
  headless?: boolean; // run every headless-capable role as a piped-stdio agent (no PTY,
  // no TUI, JSON in and JSON out) instead of a terminal. ON by default: the transcript
  // renderer landed (HeadlessPane + agentTranscript), stream stdin is guarded against
  // PTY-shaped input, and nudge detection reads the parsed error channel — the reasons
  // this was opt-in are gone. The dialog checkbox is now the opt-OUT. A CLI without the
  // capability keeps its terminal exactly as before, so mixed swarms are unaffected.
  roleBriefs?: Record<string, RoleBrief>; // per-role user .md, keyed by the role name
  // swarmRoles() mints (coordinator | scout | builder-N | reviewer-N, see ROLE_RE).
  // Per launch only — never persisted. A missing/blank entry keeps the generated brief.
}

export const KNOWN_AGENT_CMDS = ["claude", "codex", "gemini", "opencode"];

/** Per-CLI "run without permission prompts" flag, keyed by binary name.
 *  Unknown clients get no flag — the pane just prompts as usual. */
export const SKIP_PERMISSION_FLAGS: Record<string, string> = {
  claude: "--dangerously-skip-permissions",
  codex: "--dangerously-bypass-approvals-and-sandbox",
  gemini: "--yolo",
  aider: "--yes-always",
};

/** Binary name of an agent command line ("opencode --model x" → "opencode"). */
export function agentBin(agentCmd: string): string {
  return agentCmd.trim().split(/\s+/)[0]?.toLowerCase().replace(/\.(exe|cmd|bat)$/, "") ?? "";
}

/** Bypass flag for an agent command line ("claude --model x" → claude's flag). */
export function skipPermissionFlag(agentCmd: string): string {
  const flag = SKIP_PERMISSION_FLAGS[agentBin(agentCmd)] ?? "";
  return flag && !agentCmd.includes(flag) ? flag : "";
}

/** Flag a CLI needs before its startup prompt. claude/codex take the prompt as a
 *  positional arg; opencode's positional arg is the PROJECT DIR (prompt goes via
 *  --prompt); gemini's positional prompt runs one-shot and exits (-i stays interactive). */
export const PROMPT_FLAGS: Record<string, string> = {
  opencode: "--prompt",
  gemini: "-i",
};

/** Per-CLI REPL command that wipes the conversation context (stateless-worker
 *  resets between swarm cycles). Unknown CLIs get "" — re-brief only, no wipe. */
export const RESET_COMMANDS: Record<string, string> = {
  claude: "/clear",
  codex: "/new",
  gemini: "/clear",
  opencode: "/new",
  aider: "/clear",
  pi: "/new", // VERIFIED pi 0.84.2: "/new" runs handleClearCommand(); there is no /clear
};

/** Context-wipe command for a pane, derived from its startup command line. */
export function resetCommand(startupCommand: string): string {
  return RESET_COMMANDS[agentBin(startupCommand)] ?? "";
}

/** Key that aborts a CLI's in-flight turn — ESC for the TUIs, Ctrl+C for plain
 *  REPLs. The reset watcher sends it when a pane refuses to go idle (an agent
 *  looping /wait polls never ends its turn, and a busy TUI just queues anything
 *  injected mid-turn — including the /clear itself). */
export const INTERRUPT_KEYS: Record<string, string> = {
  claude: "\x1b",
  codex: "\x1b",
  gemini: "\x1b",
  opencode: "\x1b",
  aider: "\x03",
  pi: "\x1b",
};

/** Turn-abort key for a pane, derived from its startup command line. */
export function interruptKey(startupCommand: string): string {
  return INTERRUPT_KEYS[agentBin(startupCommand)] ?? "\x1b";
}

/** What a CLI can do beyond "type at it and watch the output".
 *  hooks    — fires lifecycle hooks we can point at the brain (real turn
 *             boundaries instead of the IDLE_QUIET_MS guess, see agentEvents.ts)
 *  mcp      — loads MCP servers from a config we hand it (structured task bus)
 *  headless — runs as a piped stdio process with a JSON event stream */
export interface AgentCaps { hooks: boolean; mcp: boolean; headless: boolean }

/** Capability table, keyed by binary name. EVERY `true` here disables a
 *  fallback, so a wrong one silently wedges the pane: an entry is only allowed
 *  to claim something that was VERIFIED against the installed binary, never
 *  copied out of a plan document. Anything absent, unproven or unknown is all
 *  false and keeps today's exact PTY path.
 *  claude 2.1.218 (verified): --settings / --include-hook-events + the
 *  SessionStart/UserPromptSubmit/Stop/Notification hook names in the binary;
 *  --mcp-config; -p --input-format stream-json --output-format stream-json.
 *  codex / gemini / opencode / aider were NOT installed where this was checked —
 *  that is not evidence of absence, it is absence of evidence, so they get
 *  false and someone re-scouts on a host that has them. */
export const AGENT_CAPS: Record<string, AgentCaps> = {
  claude: { hooks: true, mcp: true, headless: true },
  codex: { hooks: false, mcp: false, headless: false },
  gemini: { hooks: false, mcp: false, headless: false },
  opencode: { hooks: false, mcp: false, headless: false },
  aider: { hooks: false, mcp: false, headless: false },
};

const NO_CAPS: AgentCaps = { hooks: false, mcp: false, headless: false };

/** Capabilities of a pane's command line ("claude --model x" → claude's row).
 *  Unknown binary = nothing claimed. */
export function agentCaps(startupCommand: string): AgentCaps {
  return AGENT_CAPS[agentBin(startupCommand)] ?? NO_CAPS;
}

/** Does this pane's CLI report its own turn boundaries? The one question every
 *  Phase-A consumer asks before preferring an event over the quiet timer. */
export function hasHooks(startupCommand: string): boolean {
  return agentCaps(startupCommand).hooks;
}

/** Can this pane's CLI load the brain's MCP server? Capability alone is not
 *  enough to WRITE an MCP brief — see `speaksMcp`. */
export function hasMcp(startupCommand: string): boolean {
  return agentCaps(startupCommand).mcp;
}

/** Will this pane actually reach the brain over MCP? Capability AND a config file
 *  to point it at. Both halves matter: a brief that tells an agent to call
 *  `note_get` on a pane launched WITHOUT `--mcp-config` describes tools that do
 *  not exist, and the agent's first action fails on an empty context — the exact
 *  silent-no-op shape Phase A already produced twice. No path = curl briefs, i.e.
 *  today's behaviour.
 *  The quote refusal lives HERE, not only in `mcpConfigFlag`: an unquotable path
 *  drops the flag, so if the brief were decided by a laxer predicate a pane
 *  launched WITHOUT `--mcp-config` would still be told to call `note_get`. One
 *  predicate, one answer — brief and command line cannot disagree. */
export function speaksMcp(startupCommand: string, mcpConfigPath: string): boolean {
  return !!mcpConfigPath && !/['"]/.test(mcpConfigPath) && hasMcp(startupCommand);
}

/** The flags that turn a CLI into a headless stream agent: JSON messages in on
 *  stdin, line-delimited JSON events out on stdout, no terminal anywhere.
 *  Keyed by binary name; a CLI with no entry cannot be run headless whatever its
 *  capability row says, so the two can never disagree.
 *
 *  VERIFIED against claude 2.1.218, and every token here is load-bearing:
 *   - `-p` is what enables the stream formats at all;
 *   - `--verbose` is MANDATORY and undocumented — without it the CLI refuses to
 *     start: "When using --print, --output-format=stream-json requires
 *     --verbose". It is absent from `--help`, exactly like the variadic `...` on
 *     --mcp-config that shipped a dead swarm once already;
 *   - `--input-format stream-json` is what keeps stdin OPEN for the next message
 *     instead of running one prompt and exiting, i.e. it is what makes the pane
 *     a conversation rather than a one-shot.
 *  A POSITIONAL prompt is deliberately NOT here: verified on the same binary,
 *  stream-json input mode ignores it (the run sits waiting on stdin and never
 *  starts a turn), which is why a headless pane's brief is delivered as the
 *  first stream message instead of on the command line. */
export const HEADLESS_FLAGS: Record<string, string> = {
  claude: "-p --verbose --input-format stream-json --output-format stream-json",
};

/** The headless flag string for a command line, or "" when this CLI must keep
 *  its terminal. Both halves are required: the capability row (verified) AND a
 *  flag spelling we actually know. */
export function headlessFlags(agentCmd: string): string {
  return agentCaps(agentCmd).headless ? HEADLESS_FLAGS[agentBin(agentCmd)] ?? "" : "";
}

/** Would this CLI run headless if the swarm asked for it? */
export function canRunHeadless(agentCmd: string): boolean {
  return !!headlessFlags(agentCmd);
}

/** How a pane's process must be spawned, DERIVED FROM ITS OWN COMMAND LINE
 *  rather than carried alongside it. The two cannot disagree that way: a piped
 *  child has no terminal, so a pane spawned piped whose command expects a TUI
 *  (or the reverse) is a pane that hangs, and "the flags say so" is the only
 *  source of truth that survives a restart, a profile edit or a persisted
 *  layout written by an older build.
 *  Anything else — every TUI pane, every plain shell — is "pty", i.e. exactly
 *  what every pane has always been. */
export function spawnModeFor(startupCommand: string): "pty" | "piped" {
  if (!canRunHeadless(startupCommand)) return "pty";
  // Whole ARGUMENTS, not substrings: `--print-x` must not be read as `-p`. The
  // pair below is what actually makes the process headless — print mode plus a
  // stdin that stays open for stream-json messages.
  const args = startupCommand.split(/\s+/);
  const has = (...names: string[]) => names.some((n) => args.includes(n));
  return has("-p", "--print") && has("--input-format") && has("stream-json") ? "piped" : "pty";
}

/** Transient-API-failure phrases across the agent CLIs (claude "API Error: 529
 *  Overloaded", codex/opencode rate-limit and stream-error wording) — the
 *  auto-nudge watcher resumes a pane whose tail matches. Phrases only: bare
 *  status codes ("500") would match innocent output like timings. A false
 *  match costs at most a few spurious "continue" messages to an idle agent. */
export const NUDGE_ERROR_RE = /API Error|Overloaded|rate.?limited?|too many requests|stream (?:error|disconnected)|connection (?:error|reset|refused)/i;

/** Nudge pacing (swarmNudge.ts owns the watcher). They live here, next to every
 *  other swarm constant, because the health strip renders them as a legend — a
 *  human watching a stuck pane needs to see WHAT the swarm is waiting on. */
export const NUDGE_IDLE_MS = 15_000; // quiet this long = the turn is definitely over
export const NUDGE_COOLDOWN_MS = 120_000; // min gap between nudges (retries hit the same outage)
export const NUDGE_MAX = 3; // per error episode — then a human has to look

/** Runaway-turn detection (see swarmRunaway.ts for the watcher that uses these).
 *  A local model served over an OpenAI-compatible endpoint has no turn budget:
 *  with reasoning on and a short prompt it can generate until it fills its
 *  context — qwen3.6-35b-a3b was seen burning 20k+ tokens on one boot turn with
 *  zero tool calls. The CLI is streaming the whole time, so the auto-nudge
 *  watcher (quiet pane + error tail) never fires. */
export const RUNAWAY_IDLE_MS = 20_000; // no PTY output this long = turn over; streak resets
export const RUNAWAY_MS = 8 * 60_000; // busy + tail frozen this long = a spiralling turn
export const RUNAWAY_RESTART_MAX = 2; // per pane, then a human has to look

/** CONTEXT COMPACTION is the healthy state that looks most like a runaway: the
 *  pane is busy, the screen sits on one line for minutes and no tool call
 *  happens, because the CLI is summarising its own context rather than taking a
 *  turn. Aborting it is the worst possible answer — the agent loses the turn AND
 *  the compaction, and the watchdog spends a restart it exists to ration.
 *
 *  Two defences, because they cover different panes. A hook-capable CLI says so
 *  itself (`PreCompact` → agentEvents.compacting), and the watcher pauses the
 *  streak while that holds — exact, and it covers headless panes, which have no
 *  screen to read. Every other CLI gets this: the frozen screen SAYS what it is
 *  doing, so a tail that names compaction buys a far longer leash instead of the
 *  ordinary one. Still bounded — a pane genuinely wedged on that screen is a
 *  runaway too, just a slower one to call. */
export const COMPACT_RUNAWAY_MS = 25 * 60_000;
const COMPACTING_RE = /compact(?:ing|ion|ed)?\b/i;

/** Does this pane's screen say it is compacting its context? Read on the RAW
 *  tail, not the normalized one — normalizeTail strips digits and punctuation,
 *  which is fine for "did anything change" and wrong for "what does it say".
 *
 *  ONLY EVER lengthens the watchdog's leash. It must not decide whether a pane is
 *  idle: this is a word match on whatever the agent has on screen, and an agent
 *  reading or writing about compaction (this repo has several) would then read as
 *  "busy" forever and never be woken again. A wrong answer here costs a slower
 *  abort; a wrong answer in paneIdle costs the mission. */
export function looksCompacting(tail: string): boolean {
  return COMPACTING_RE.test(tail);
}

/** Tail with everything a busy-but-progressing TUI churns on its own stripped:
 *  spinner glyphs, digits (token counts, elapsed seconds, percentages) and all
 *  whitespace. Two samples comparing equal mean nothing NEW was printed. */
export function normalizeTail(text: string): string {
  return text
    .replace(/[⠀-⣿─-╿■-◿|/\\\-_*+.·•]/g, "")
    .replace(/\d/g, "")
    .replace(/\s+/g, "");
}

export interface RunawayPane { id: string; role: string; project: string; command: string }
/** `since` = start of the current busy streak, null when the pane is idle (a
 *  0 sentinel would be indistinguishable from a real timestamp of 0). */
export interface RunawayWatch {
  since: number | null;
  tail: string;
  restarts: number;
  /** When this pane was last seen PAUSED (compacting). A turn that spanned a
   *  compaction did not spend that time thinking, so the stream scan — whose
   *  clock is the CLI's own turn start — resumes counting from here instead of
   *  from a turn start that is now minutes of summarisation old. */
  resumedAt?: number;
}

/** One poll pass: returns the panes whose turn looks runaway and should be
 *  aborted + re-briefed. `state` is mutated (streak bookkeeping per pane); the
 *  clock and pane readers are injected so this stays testable without a PTY.
 *
 *  `keep` = ids that still exist but were deliberately left out of `panes` this
 *  pass. Without it the prune below reads "absent from the list" as "pane is
 *  gone" and deletes the entry — including `restarts`, which is the ONLY record
 *  that a pane has already been recovered. The caller drops a pane mid-recovery
 *  from the scan (its busy streak means nothing while its turn is being aborted),
 *  recovery spans several polls, and the pane came back with restarts=0 every
 *  time: RUNAWAY_RESTART_MAX never capped anything and a wedged pane could be
 *  restarted forever. Pass every pane you still know about. */
export function scanForRunaways(
  panes: RunawayPane[],
  state: Map<string, RunawayWatch>,
  now: number,
  read: { lastOutput: (id: string) => number; tail: (id: string) => string },
  keep?: ReadonlySet<string>,
  paused?: ReadonlySet<string>,
): RunawayPane[] {
  const live = new Set<string>();
  const hits: RunawayPane[] = [];
  for (const pane of panes) {
    live.add(pane.id);
    const prev = state.get(pane.id);
    // PAUSED: the CLI's own hook says it is compacting its context. It is busy and
    // its screen is frozen, and neither fact is about the turn — so the streak is
    // held at zero rather than counted, and its spent restarts are carried.
    if (paused?.has(pane.id)) {
      state.set(pane.id, { since: null, tail: "", restarts: prev?.restarts ?? 0, resumedAt: now });
      continue;
    }
    const last = read.lastOutput(pane.id);
    if (!last || now - last >= RUNAWAY_IDLE_MS) { // turn over (or never started) — not a runaway
      if (prev) state.set(pane.id, { since: null, tail: "", restarts: prev.restarts });
      continue;
    }
    const raw = read.tail(pane.id);
    const tail = normalizeTail(raw);
    if (!prev || prev.since === null || prev.tail !== tail) { // new busy streak, or real progress
      state.set(pane.id, { since: now, tail, restarts: prev?.restarts ?? 0 });
      continue;
    }
    // A screen that says it is compacting gets the long leash — this is the whole
    // defence for a CLI with no hooks to tell us the same thing.
    const limit = looksCompacting(raw) ? COMPACT_RUNAWAY_MS : RUNAWAY_MS;
    if (now - prev.since < limit || prev.restarts >= RUNAWAY_RESTART_MAX) continue;
    state.set(pane.id, { since: now, tail, restarts: prev.restarts + 1 });
    hits.push(pane);
  }
  for (const id of [...state.keys()]) if (!live.has(id) && !keep?.has(id)) state.delete(id);
  return hits;
}

/** Runaway detection for HEADLESS panes, which have no tail to compare.
 *  `scanForRunaways` above measures "busy and printing the same thing" because a
 *  TUI gives nothing better. A stream pane gives something exact: the turn began
 *  when we wrote the message and ends when the CLI emits its result object, so a
 *  runaway is simply a turn that has been open too long. No normalization, no
 *  spinner heuristics, nothing to be fooled by a quiet agent that is really
 *  thinking.
 *  Same bookkeeping and the same restart budget as the TUI scan, so the health
 *  strip reads one kind of state for both: `since` is the turn start, `restarts`
 *  is spent recoveries. `turnSince` returns 0 when the pane is not mid-turn.
 *  `keep` is the same escape as on `scanForRunaways` — ids that still exist but
 *  were not scanned this pass, whose `restarts` must survive the prune. */
export function scanForStreamRunaways(
  panes: RunawayPane[],
  state: Map<string, RunawayWatch>,
  now: number,
  read: { turnSince: (id: string) => number },
  keep?: ReadonlySet<string>,
  paused?: ReadonlySet<string>,
): RunawayPane[] {
  const live = new Set<string>();
  const hits: RunawayPane[] = [];
  for (const pane of panes) {
    live.add(pane.id);
    const prev = state.get(pane.id);
    // PAUSED — compacting, per the CLI's own PreCompact hook. This is the case a
    // headless pane cannot express any other way: its turn stays open across the
    // compaction, so the "turn open too long" test would fire on a healthy agent
    // and keep firing the moment it came back. `resumedAt` is what the resume
    // below counts from.
    if (paused?.has(pane.id)) {
      state.set(pane.id, { since: null, tail: "", restarts: prev?.restarts ?? 0, resumedAt: now });
      continue;
    }
    const since = read.turnSince(pane.id);
    if (!since) { // idle between turns — nothing to be runaway about
      if (prev) state.set(pane.id, { since: null, tail: "", restarts: prev.restarts });
      continue;
    }
    const restarts = prev?.restarts ?? 0;
    // Track the CLI's own turn start, not the first tick we noticed it: a watcher
    // that starts late would otherwise grant a wedged pane a fresh window. The one
    // exception is a turn that spanned a compaction — none of that time was the
    // turn, so the clock restarts where the compaction ended and stays there
    // (`resumedAt` is carried forward until this turn finishes).
    const resumedAt = prev?.resumedAt;
    const start = resumedAt && resumedAt > since ? resumedAt : since;
    state.set(pane.id, { since: start, tail: "", restarts, resumedAt });
    if (now - start < RUNAWAY_MS || restarts >= RUNAWAY_RESTART_MAX) continue;
    state.set(pane.id, { since: now, tail: "", restarts: restarts + 1 });
    hits.push(pane);
  }
  for (const id of [...state.keys()]) if (!live.has(id) && !keep?.has(id)) state.delete(id);
  return hits;
}

/** Host-dispatch wake pacing (see swarmDispatch.ts). A wake is a line typed into
 *  a TUI, and a TUI silently drops input that arrives mid-redraw — so wakes DO
 *  get lost, and the old rule (re-send only when the pending task set changes or
 *  REWAKE_MS passes) left a builder sitting next to an open task for two
 *  minutes. Two escapes: a wake whose delivery was never confirmed retries on
 *  the next tick, and an urgent pending set (a builder task still `open` = still
 *  unclaimed, i.e. nobody acted on the last wake) re-fires on the fast gap. */
export const REWAKE_MS = 120_000; // pending set unchanged and being worked — just a heartbeat
export const REWAKE_FAST_MS = 20_000; // pending set unchanged and provably NOT being worked
export const WAKE_MISS_MAX = 3; // undelivered wakes before backing off to the slow gap
export const WAKE_DELIVERY_MS = 12_000; // no pane output this long after a wake = it never landed
export const STALE_CLAIM_MS = 90_000; // claimed + untouched + owner idle = the claim was dropped

/** Claims that nobody is working any more: the task is `claimed`, its note has
 *  not been touched for STALE_CLAIM_MS, and the owning pane's turn is over. That
 *  state is a deadlock, not a slow builder — a builder that finished the work
 *  but ended its turn without posting `done` leaves the task claimed forever, so
 *  no `open` task exists to wake anyone and the mission just stops. (Seen live:
 *  the builder did the work, never marked it done, then reset context and looped
 *  on an empty bus.) `idle` decides whether the owner is mid-turn. */
export function staleClaims<T extends { key: string; status: string; owner: string; updated: number }>(tasks: T[], now: number, idle: (owner: string) => boolean): T[] {
  return tasks.filter(
    (t) => t.status === "claimed" && t.owner && now - t.updated * 1000 >= STALE_CLAIM_MS && idle(t.owner),
  );
}

/** Builder tasks the brain will NOT let anyone claim yet, because note "plan" is
 *  missing (the server's hard guard — see claim_task in brain/mod.rs). Waking a
 *  builder for these is a treadmill: it claims, gets "no plan yet", stops, and the
 *  still-open task marks the wake urgent so the host re-fires 20s later, forever.
 *  The coordinator is the one who can end it, so the host wakes IT instead. Blocked
 *  tasks count too: a plan-less swarm whose only task is blocked wakes nobody at all
 *  and just dies. Empty result = nothing to nag about (no tasks, or the plan is up). */
export function planGate<T extends { role?: string; status: string }>(tasks: T[], plan: string): T[] {
  if (plan.trim()) return [];
  return tasks.filter((t) => (t.role || "builder") === "builder" && !isSettled(t.status));
}

/** Statuses a task never comes back from: its work landed (`merged`) or a human
 *  killed it from the mission board (`cancelled` — see cancelTask in swarmReset).
 *  Nothing wakes on them, no gate waits for them, and no count of "work left"
 *  includes them. Cancelled is terminal on the BRAIN side too: agents cannot post
 *  it and cannot move a task off it (lifecycle_refusal), so the host is the only
 *  thing that can ever put a task back. */
export const SETTLED_STATUSES: readonly string[] = ["merged", "cancelled"];
export const isSettled = (status: string): boolean => SETTLED_STATUSES.includes(status);

/** Tasks with work IN FLIGHT: someone is on it (claimed/changes) or it is
 *  waiting at a gate (done/approved). open and blocked are deliberately NOT in
 *  flight — a coordinator cutting scope leaves those behind on purpose. */
export function inFlightTasks<T extends { status: string }>(tasks: T[]): T[] {
  const inFlight = new Set(["claimed", "changes", "done", "approved"]);
  return tasks.filter((t) => inFlight.has(t.status));
}

/** THE BUS IS IDLE AND NOBODY IS COMING. Nothing in flight, nothing open, and
 *  the mission is not over: no status on the bus wakes any role, so the swarm
 *  sits there forever. Two shapes, and only the coordinator can end either:
 *
 *   · `unblock` — every remaining task is `blocked`. Seen live: a coordinator
 *     posted the first task of its plan (briefs say create them all blocked),
 *     then spent its turn on a chat message and never opened one. One blocked
 *     task, no builder pane ever launched, and the swarm was dead on arrival
 *     with a full plan written down.
 *   · `result`  — everything is merged but note "result" was never written, so
 *     missionDone() cannot fire and the dispatcher polls a finished swarm.
 *
 *  Null whenever some other gate owns the situation: an empty bus (cold start),
 *  a missing plan (planGate), or any task still open/in flight. */
export function idleBus<T extends { status: string }>(tasks: T[], plan: string, result: string | undefined): { kind: "unblock" | "result"; tasks: T[] } | null {
  if (tasks.length === 0 || !plan.trim() || result?.trim()) return null;
  if (inFlightTasks(tasks).length > 0) return null;
  if (tasks.some((t) => t.status === "open")) return null;
  const blocked = tasks.filter((t) => t.status === "blocked");
  if (blocked.length) return { kind: "unblock", tasks: blocked };
  // Settled, not merged: a bus whose last live task was CANCELLED is just as
  // finished as one that merged everything, and it needs the same "result" note —
  // otherwise a human cancelling the tail of a mission leaves the dispatcher
  // polling a swarm that will never move again.
  return tasks.every((t) => isSettled(t.status)) ? { kind: "result", tasks } : null;
}

/** SCOUT TASKS THE COORDINATOR IS DONE WITH. A scout task produces NOTES
 *  (scout-*), not a branch: no reviewer touches it (reviewer briefs review
 *  role=builder only) and no merge can ever settle it, so it stops at `done`
 *  and stays there. Two things go wrong while it does — seen live: the
 *  scout-done wake re-fires at every REWAKE_MS with a report the coordinator
 *  folded into its plan an hour ago, and `done` counts as IN FLIGHT, so
 *  missionDone/idleBus can never fire and the swarm cannot end.
 *
 *  The report is consumed once its wake LANDED and the coordinator's turn is
 *  over; the host then settles the task itself. Conditions, all required:
 *  the wake went out (a state exists for it), it covers this task, delivery
 *  has had its window, no miss is counted against it, and the pane is idle
 *  again. A hook pane never counts a miss, so there `misses === 0` only means
 *  "nothing argues against it" — an unlanded wake retires the task early, and
 *  the idleBus `unblock` path is what wakes the coordinator after that. */
export function consumedScouts<T extends { key: string }>(
  scoutDone: T[],
  wake: { sig: string; at: number; misses: number } | undefined,
  now: number,
  coordinatorIdle: boolean,
): T[] {
  if (!wake || !coordinatorIdle || wake.misses > 0) return [];
  if (now - wake.at < WAKE_DELIVERY_MS) return [];
  const covered = new Set(wake.sig.split(",").map((s) => s.split(":")[0]));
  return scoutDone.filter((t) => covered.has(t.key));
}

/** Handed-back tasks whose branch has moved ON since the hand-back: the builder
 *  did the rework and ended its turn without posting `done`.
 *
 *  Same deadlock as staleClaims, one status over, and it cost a night: task-6
 *  came back as `changes`, its builder fixed all seven findings and committed —
 *  then said nothing. `changes` wakes only its owner, the owner sees work it has
 *  already done and stops, and the reviewer (which wakes on `done`) and the host
 *  merge (which wakes on `approved`) both wait on a status that never comes.
 *
 *  `reviewed` is the SHA out of the review note that sent it back; a tip that no
 *  longer matches it is new work. The caller resolves tips — this only decides
 *  which tasks are worth asking about (untouched for STALE_CLAIM_MS, owner
 *  idle), because resolving a tip costs an IPC call per task. */
export function staleChanges<T extends { key: string; status: string; owner: string; updated: number }>(tasks: T[], now: number, idle: (owner: string) => boolean): T[] {
  return tasks.filter(
    (t) => t.status === "changes" && t.owner && now - t.updated * 1000 >= STALE_CLAIM_MS && idle(t.owner),
  );
}

/** The commit a review note is ABOUT — "verdict: changes @ df399bb…" — whatever
 *  the verdict was. Same permissive shape swarm.rs uses for approvals (git is
 *  what decides whether a token is a commit), and the FIRST one wins: reviewers
 *  put the SHA on the verdict line and quote others further down. */
export function reviewedSha(note: string | undefined): string | undefined {
  if (!note) return undefined;
  const m = /\b[0-9a-f]{7,40}\b/i.exec(note.split("\n")[0]) ?? /\b[0-9a-f]{7,40}\b/i.exec(note);
  return m?.[0].toLowerCase();
}

/** Do two commit ids name the same commit? One side is usually abbreviated (a
 *  reviewer writes 8 hex digits, git reports 40), so compare on the shorter. */
export function sameCommit(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const [x, y] = [a.toLowerCase(), b.toLowerCase()];
  const n = Math.min(x.length, y.length);
  return n >= 7 && x.slice(0, n) === y.slice(0, n);
}

/** Did the root checkout's HEAD move in a way the host did NOT cause?
 *
 *  The host writes every merge itself, with a subject it can recognise — the
 *  namespaced "merge: task-<n> (swarm <project>)" of merge_subject() in
 *  swarm.rs, and the older unnamespaced form for a repo whose history predates
 *  it; a builder committing straight onto master writes anything else. That commit is
 *  invisible after the fact — the repo looks healthy, the task bus looks stalled
 *  somewhere else entirely, and the only reason it was ever found was a human
 *  reading a reflog the next morning. Sampling HEAD each tick makes it a 5 s
 *  alarm instead.
 *
 *  `merging` is true while a host merge is in flight for this swarm, which is
 *  the one time HEAD legitimately moves under us mid-sample. */
export function unexpectedHeadMove(
  prev: { sha: string; branch: string } | undefined,
  next: { sha: string; subject: string; branch: string },
  merging: boolean,
): boolean {
  if (!prev || prev.sha === next.sha) return false;
  if (merging) return false;
  // A different branch under HEAD is a CHECKOUT, not a commit — a human moving
  // around the root checkout must not read as a breach. (It is still a problem
  // for the merges, which target whatever branch the root is on; the dirty-root
  // tripwire and the merge itself are what speak to that.)
  if (prev.branch !== next.branch) return false;
  return !/^merge: task-\d+ \(swarm(?: [A-Za-z0-9._-]+)?\)$/.test(next.subject.trim());
}

/** How long a dirty root is left alone before the host parks it in a stash. A
 *  human mid-edit in the root gets a grace window; after that the merges matter
 *  more, and parking is reversible (git stash) where waiting is not — the
 *  previous behaviour was to wait forever and ask a human, and a mission spent
 *  its coordinator's only turn doing exactly that (chat-human-1: "clean it
 *  yourself are you kidding me?"). */
export const STRAY_PARK_MS = 60_000;

/** Is the mission over? The coordinator's "result" note is the completion
 *  signal, but it is only HONORED once no task is in flight. Seen live
 *  (finding-reviewer-never-starts): the coordinator wrote "result" while a
 *  changes-rework was still running; the builder posted `done` five minutes
 *  later into a swarm whose dispatcher had already stopped, and the task sat
 *  unreviewed until a human merged it by hand. A premature "result" now leaves
 *  the dispatcher running, so the normal review/merge wakes drain the in-flight
 *  work — and the moment the last task leaves the bus, the same note completes
 *  the mission with no further action from anyone. */
export function missionDone(result: string | undefined, tasks: { status: string }[]): boolean {
  return !!result?.trim() && inFlightTasks(tasks).length === 0;
}

/* ── Turn concurrency budget (APP-GLOBAL) ────────────────────────────────────
 *  A swarm pointed at ONE local endpoint (LM Studio, ollama, …) can only serve
 *  one completion at a time; ask for a second and both crawl or the server
 *  errors out. Nothing throttled that before: coordinator + builder + scout +
 *  reviewer could all hold a live turn at once. Rule: N builders configured =
 *  at most N panes mid-turn, so a 1-builder swarm serializes every role.
 *
 *  The cap used to be DERIVED PER WORKSPACE, which reproduced the exact failure
 *  it exists to prevent: two swarm workspaces pointed at the same endpoint each
 *  allowed N live turns, so the endpoint saw 2N. There is now ONE budget for
 *  the whole app — every swarm registers its builder count, the cap is the
 *  largest of them, and EVERY injection anywhere (wake, nudge, runaway restart,
 *  context re-brief) takes a slot out of that single ledger via injectPrompt()
 *  in swarmReset.ts. An injection skipped at the cap is simply retried on the
 *  next watcher tick, and task claims stay the collision guard, so nothing in
 *  the protocol changes. A pane already mid-send is never interrupted. */
/** The role names swarmPanes() hands out. Anything else is not an agent pane.
 *  Bare "reviewer" is no longer minted (reviewers are numbered like builders) but
 *  stays matched: workspaces saved before multi-reviewer carry it, and dropping it
 *  would turn those panes into non-agent panes — uncounted by the turn budget and
 *  invisible to dispatch. */
export const ROLE_RE = /^(coordinator|scout|reviewer|reviewer-\d+|builder-\d+)$/;

/** The role a pane runs, or "" when it is not an agent pane. Reads the TYPED
 *  `pane.role` field only: role identity used to ride on `pane.title`, so
 *  renaming the reviewer pane rerouted the merge gate to the coordinator and
 *  broke health + telemetry at the same time (brain-findings 1.4). Titles are
 *  cosmetic now; pre-role saved panes are migrated once by migratePaneRoles(). */
export function paneRole(p: { role?: string }): string {
  return p.role && ROLE_RE.test(p.role) ? p.role : "";
}

/** An agent pane of a swarm workspace — one of the panes swarmPanes() created.
 *  Everything else in that workspace belongs to the human (a shell tailing a
 *  build, a log) and must NOT count against the turn cap: such a pane produces
 *  output continuously, so it would look busy forever and, at cap=1,
 *  permanently starve the swarm. */
export function isRolePane(p: { role?: string }): boolean {
  return paneRole(p) !== "";
}

/** Key of one outstanding wake job in the telemetry mirror. */
export const wakeKey = (role: string, kind: string) => `${role}::${kind}`;

/** What the wake mirror must contain after ONE dispatch tick. The dispatcher's
 *  `wakes` Map is authoritative and only ever deletes a wake when the injection
 *  FAILED, so the read-only mirror has to be reconciled every tick or a finished
 *  swarm shows "wake due" forever (brain-findings 1.6). `dispatching` is false on
 *  every path that generates no wakes at all — host dispatch off, mission
 *  complete (note "result" written), brain unreachable, empty task bus — and then
 *  the mirror is empty BY CONSTRUCTION, not by whether the caller remembered to
 *  reconcile. That was the bug: those paths `continue`d past the reconcile. */
export function wakeMirror<J extends { kind: string; role: string; pending: unknown[] }>(jobs: J[], dispatching = true): Set<string> {
  if (!dispatching) return new Set();
  return new Set(jobs.filter((j) => j.role && j.pending.length > 0).map((j) => wakeKey(j.role, j.kind)));
}

/** A builder pane, by role — "builder-1", "builder-2", … */
export function isBuilderRole(role: string): boolean {
  return /^builder-\d+$/.test(role);
}

/** A review pane, by role — "reviewer-1", "reviewer-2", … plus the bare "reviewer"
 *  of pre-multi-reviewer workspaces. Dispatch fans "done" tasks out over these. */
export function isReviewerRole(role: string): boolean {
  return /^reviewer(-\d+)?$/.test(role);
}

/** The KIND of a role, collapsing the numbered panes: "builder-2" → "builder",
 *  "reviewer-1" (and legacy bare "reviewer") → "reviewer". Coordinator and scout
 *  are their own kind. This is the granularity the per-role context-clear setting
 *  (SwarmConfig.clearRoles) works at — you pick "builders" once, not each pane. */
export type RoleKind = "coordinator" | "scout" | "builder" | "reviewer";
export const ROLE_KINDS: readonly RoleKind[] = ["coordinator", "scout", "builder", "reviewer"];
export function roleKind(role: string): RoleKind | "" {
  if (role === "coordinator" || role === "scout") return role;
  if (isBuilderRole(role)) return "builder";
  if (isReviewerRole(role)) return "reviewer";
  return "";
}

/** Should a pane of this role be context-wiped, given a clearRoles selection?
 *  Matches by KIND, so "builder-3" is cleared iff "builder" is selected. */
export function clearsRole(clearRoles: readonly string[] | undefined, role: string): boolean {
  const k = roleKind(role);
  return !!k && !!clearRoles?.includes(k);
}

/** The effective clear-role set for a saved workspace. `swarmClearRoles` is the
 *  explicit per-kind list (the new setting); a workspace saved before it exists
 *  carries only the legacy `swarmResets:true`, which meant "wipe everything" — so
 *  migrate that to all role kinds. Absent both = context resets off. */
export function clearRolesOf(w: { swarmResets?: boolean; swarmClearRoles?: readonly string[] }): RoleKind[] {
  if (w.swarmClearRoles) return ROLE_KINDS.filter((k) => w.swarmClearRoles!.includes(k));
  return w.swarmResets ? [...ROLE_KINDS] : [];
}

/** One-time migration for layouts saved before `pane.role` existed: back then
 *  the pane TITLE was the role, so adopt it as the role and leave the title
 *  alone. Runs on hydrate; panes already carrying a role are untouched, and a
 *  human's shell (title "Terminal 3") never matches, so it stays role-less.
 *  Returns the same array when nothing changed, so hydrate does not churn. */
export function migratePaneRoles<W extends { swarm?: string; root: LayoutNode }>(workspaces: W[]): W[] {
  let dirty = false;
  const fixPane = (p: Pane): Pane => {
    if (p.role !== undefined || !ROLE_RE.test(p.title)) return p;
    dirty = true;
    return { ...p, role: p.title };
  };
  const fixNode = (n: LayoutNode): LayoutNode =>
    n.type === "tabs" ? { ...n, tabs: n.tabs.map(fixPane) } : { ...n, a: fixNode(n.a), b: fixNode(n.b) };
  const out = workspaces.map((w) => (w.swarm ? { ...w, root: fixNode(w.root) } : w));
  return dirty ? out : workspaces;
}

/** How long a slot handed to an injection survives without being confirmed by a
 *  measurement. A wake that never landed (TUI dropped it mid-redraw) or a swarm
 *  whose dispatcher is switched off — nothing re-measures those panes, so an
 *  un-expiring hold would wedge the budget for the rest of the session. */
export const TURN_HOLD_MS = 30_000;

/** How long a pane must keep being REFUSED a slot before the mirror calls it
 *  starved. A refusal is normal for a tick or two at the cap; a pane refused
 *  this long is the invisible-starvation shape (finding-reviewer-never-starts):
 *  another swarm's wedged panes hold the app-global budget and the launch that
 *  was supposed to happen silently retries forever. */
export const STARVED_AFTER_MS = 30_000;
/** A refusal older than this means the caller stopped asking (the work drained,
 *  the pane got its slot elsewhere, the swarm closed) — drop the entry. Sized to
 *  a few dispatcher ticks so one missed poll does not reset the streak. */
const STARVE_FRESH_MS = 15_000;

/** Per-swarm slice of the one global ledger. `measured` = panes swarmDispatch
 *  observed mid-turn on its last tick; `holds` = titles handed a slot that have
 *  not been measured yet (title → when it was taken); `starved` = titles being
 *  refused at the cap (title → first and latest refusal). All keyed by pane
 *  title, and a title counts once however many times it appears. */
interface Ledger { measured: string[]; holds: Map<string, number>; starved: Map<string, { since: number; at: number }>; builders: number; concurrent: boolean }
const ledgers = new Map<string, Ledger>();
let capOverride = 0;

function ledgerFor(project: string): Ledger {
  let l = ledgers.get(project);
  if (!l) { l = { measured: [], holds: new Map(), starved: new Map(), builders: 0, concurrent: false }; ledgers.set(project, l); }
  return l;
}

/** Register a swarm and its builder-pane count. The app-global cap is the
 *  largest registered count — the biggest swarm still gets one turn per
 *  builder, and adding a second swarm no longer doubles what the endpoint sees.
 *  `concurrent` = this swarm's "run wild" flag: its own injections bypass the
 *  cap (every role can hold a live turn at once). Refreshed each dispatch tick
 *  from the workspace flag, so toggling it takes effect immediately. */
export function registerSwarm(project: string, builders: number, concurrent = false): void {
  const l = ledgerFor(project);
  l.builders = Math.max(0, Math.floor(builders));
  l.concurrent = concurrent;
}

/** Drop closed swarms from the budget (called with the live project list). */
export function retainSwarms(projects: string[]): void {
  const live = new Set(projects);
  for (const p of [...ledgers.keys()]) if (!live.has(p)) ledgers.delete(p);
}

/** Manual app-global cap (0/undefined = back to "one per builder of the biggest
 *  swarm"). Nothing in the UI calls this yet — see finding 1.16. */
export function setTurnCapOverride(n?: number): void {
  capOverride = n && n > 0 ? Math.floor(n) : 0;
}

/** Concurrent live turns allowed across EVERY swarm in the app. */
export function turnCap(): number {
  if (capOverride) return capOverride;
  let max = 0;
  for (const l of ledgers.values()) max = Math.max(max, l.builders);
  return Math.max(1, max);
}

/** Panes holding a live turn right now, as "<project>/<title>". Expired holds
 *  are dropped here — this is the one place the ledger is garbage-collected. */
export function liveTurns(now = Date.now()): string[] {
  const out = new Set<string>();
  for (const [project, l] of ledgers) {
    for (const t of l.measured) out.add(`${project}/${t}`);
    for (const [t, at] of [...l.holds]) {
      if (now - at >= TURN_HOLD_MS) l.holds.delete(t);
      else out.add(`${project}/${t}`);
    }
  }
  return [...out];
}

/** Titles this swarm currently counts against the budget. */
function busyTitles(project: string, now: number): string[] {
  const l = ledgers.get(project);
  if (!l) return [];
  const held = [...l.holds].filter(([, at]) => now - at < TURN_HOLD_MS).map(([t]) => t);
  return [...new Set([...l.measured, ...held])];
}

/** Titles this swarm is starving: refused a slot for STARVED_AFTER_MS and still
 *  asking. Entries whose refusals went stale are dropped here — the ledger's
 *  second GC point after liveTurns(). */
function starvedTitles(project: string, now: number): { title: string; since: number }[] {
  const l = ledgers.get(project);
  if (!l) return [];
  const out: { title: string; since: number }[] = [];
  for (const [t, s] of [...l.starved]) {
    if (now - s.at >= STARVE_FRESH_MS) l.starved.delete(t);
    else if (now - s.since >= STARVED_AFTER_MS) out.push({ title: t, since: s.since });
  }
  return out.sort((a, b) => a.title.localeCompare(b.title));
}

/** Republish the mirror the UI reads. `inFlight`/`cap` are APP-GLOBAL numbers
 *  (that is the budget being spent); `busy`/`starved` are this swarm's share. */
function publish(project: string, now = Date.now()): void {
  setTurnBudget(project, { cap: turnCap(), inFlight: liveTurns(now).length, busy: busyTitles(project, now), starved: starvedTitles(project, now) });
}

/** swarmDispatch's per-tick measurement: the panes of `project` that are
 *  producing output (or mid-send) right now. Supersedes their holds. */
export function reportBusy(project: string, busy: string[], now = Date.now()): void {
  const l = ledgerFor(project);
  l.measured = [...new Set(busy)];
  for (const t of l.measured) l.holds.delete(t);
  publish(project, now);
}

/** Take one slot out of the single app-global budget for `title` in `project`.
 *  false = at the cap, caller must skip and retry. A pane that already counts
 *  as live keeps its slot rather than taking a second one. */
export function takeTurnSlot(project: string, title = "?", now = Date.now()): boolean {
  const l = ledgerFor(project);
  const hold = l.holds.get(title);
  if (l.measured.includes(title) || (hold !== undefined && now - hold < TURN_HOLD_MS)) {
    if (l.starved.delete(title)) publish(project, now); // it is mid-turn — not starved
    return true;
  }
  // A "run concurrent" swarm lifts the cap for ITS OWN panes — every role can be
  // mid-turn at once. The hold is still recorded (so liveTurns/the UI mirror stay
  // truthful and other swarms see the load), it just is not refused at the cap.
  if (!l.concurrent && liveTurns(now).length >= turnCap()) {
    // Refused at the cap. Track the streak so a pane starved past
    // STARVED_AFTER_MS shows up in the mirror instead of silently retrying
    // forever; a fresh refusal extends the streak, a stale one restarts it.
    const s = l.starved.get(title);
    l.starved.set(title, { since: s && now - s.at < STARVE_FRESH_MS ? s.since : now, at: now });
    publish(project, now);
    return false;
  }
  l.starved.delete(title);
  l.holds.set(title, now);
  publish(project, now);
  return true;
}

/** Workspaces whose turns count against the app-global budget: EVERY swarm
 *  workspace, including those with host dispatch OFF. Nudges and runaway
 *  re-briefs inject into those too, and retainSwarms() deletes the ledger of any
 *  swarm not listed here — so leaving them out silently uncounts live turns.
 *  swarmDispatch gates only whether wakes are GENERATED, never the accounting. */
export function trackedSwarms<T extends { swarm?: string }>(workspaces: T[]): T[] {
  return workspaces.filter((w) => !!w.swarm);
}

/** Repo paths compare as strings here — same shape the pane was spawned with —
 *  so only the cosmetic differences are normalised away (trailing separator,
 *  surrounding space). Anything cleverer would need the filesystem, and this
 *  answer only ever gates a destructive step: a path that does not obviously
 *  match is treated as a DIFFERENT repo, which keeps the sweep from running. */
const sameRepo = (a: string, b: string) => {
  const norm = (s: string) => s.trim().replace(/[\\/]+$/, "");
  return !!a && norm(a) === norm(b);
};

/** Which swarm projects already have agent panes pointed at `cwd`.
 *
 *  Asked at LAUNCH, before the relaunch sweep: `.swarm/task-<n>` and
 *  `swarm/task-<n>` are repo-scoped while a swarm project is not, so a second
 *  swarm on the SAME repo would have its trees swept out from under it by the
 *  third. Non-empty = do not sweep, run alongside whatever is there. Only the
 *  UI can answer this — the panes live in the webview, not in Rust — which is
 *  why swarm_worktree_sweep refuses unless it is told explicitly. */
export function swarmsInRepo<T extends { swarm?: string; root: LayoutNode }>(workspaces: T[], cwd: string): string[] {
  return trackedSwarms(workspaces)
    .filter((w) => collectPanes(w.root).filter(isTerminal).filter(isRolePane).some((p) => sameRepo(p.cwd ?? "", cwd)))
    .map((w) => w.swarm!);
}

/** What `swarm_guard_probe` answers about a repo's lock file — see swarm.rs. */
export interface GuardProbe { locked?: boolean; live?: boolean; ours?: boolean }

/** Is a swarm genuinely RUNNING in `cwd` right now — the one question the
 *  relaunch sweep is gated on, and the one whose wrong answer is silent.
 *
 *  The probe is the authority, because it reads the process table: the lock file
 *  records the pid AND the start time of whatever armed it, so an owner that was
 *  killed cannot pass for one that is running. Everything the app knows about
 *  ITSELF survives a kill — the workspace list is persisted — which is why it
 *  cannot be the evidence: a pkill'd swarm was still "here" on the next launch,
 *  the sweep was skipped, and the new run silently started on the dead run's
 *  worktrees, branches and commits.
 *
 *  The workspace list gets exactly one job, and only when the lock's owner is
 *  THIS process: are that swarm's panes still open? A live PixelMarch that armed
 *  a guard and then had its workspace deleted is a process that is running and a
 *  swarm that is not. Any OTHER live owner (a second PixelMarch on the same repo)
 *  is taken at its word — its panes are not ours to look for. */
export function swarmLiveInRepo<T extends { swarm?: string; root: LayoutNode }>(
  probe: GuardProbe | null | undefined,
  workspaces: T[],
  cwd: string,
): boolean {
  if (!probe?.live) return false;
  if (!probe.ours) return true;
  return swarmsInRepo(workspaces, cwd).length > 0;
}

/** One swarm that disappeared from the layout, and what tearing it down means.
 *  `disarm` is false when another swarm is still running in the same repo. */
export interface CancelledSwarm { project: string; repo: string; disarm: boolean }

/** Which swarms were CANCELLED since the last tick — present in `repoOf` (the
 *  dispatcher's per-swarm repo sample) and absent from `live` (the layout).
 *
 *  This exists because until it did, nothing tore a cancelled swarm down: the
 *  teardown was inside the mission-complete branch, so a swarm the human killed
 *  from the workspace list left its lock and both hook blocks armed — and an
 *  armed guard goes on refusing the HUMAN's own commits to master long after the
 *  swarm that armed it is gone — plus its agent tokens live in the brain.
 *
 *  `disarm` is the one subtlety: the guard is REPO-wide, not swarm-wide. Two
 *  swarms in one repo share one lock and one pair of hooks, so the first to close
 *  must not strip the seatbelt off the second. Only the last one out disarms. */
export function cancelledSwarms(repoOf: Map<string, string>, live: Set<string>): CancelledSwarm[] {
  const stillRunning = new Set([...repoOf].filter(([p]) => live.has(p)).map(([, repo]) => repo));
  return [...repoOf]
    .filter(([project]) => !live.has(project))
    .map(([project, repo]) => ({ project, repo, disarm: !!repo && !stillRunning.has(repo) }));
}

/** Record a hold for a turn that is happening WHETHER OR NOT the budget allowed
 *  it — the must-happen injections (post-reset re-brief, runaway restart) give up
 *  waiting after a timeout and inject anyway. The overrun is real, so it belongs
 *  in the ledger: counted by liveTurns(), visible in the mirror, and aged out at
 *  TURN_HOLD_MS like any other hold. Silently overrunning without a hold was the
 *  bug — the extra turn was invisible and could never expire. */
export function forceTurnSlot(project: string, title = "?", now = Date.now()): void {
  const l = ledgerFor(project);
  l.starved.delete(title); // it got its turn, however rudely
  if (l.measured.includes(title)) return; // already counted as live — no second slot
  l.holds.set(title, now);
  publish(project, now);
}

/** Hand a slot back — the injection failed, so no turn was ever started. */
export function releaseTurnSlot(project: string, title: string): void {
  ledgers.get(project)?.holds.delete(title);
  publish(project);
}

/** What the dispatcher last measured for a swarm — for the UI (a strip showing
 *  "2/2 turns live" and who holds them). Mirrored, not owned, by the store. */
export interface TurnBudget { cap: number; inFlight: number; busy: string[]; starved: { title: string; since: number }[] }
const budgets = new Map<string, TurnBudget>();
const budgetSubs = new Set<(project: string, b: TurnBudget) => void>();

const starvedSig = (s: TurnBudget["starved"]) => s.map((x) => `${x.title}@${x.since}`).join();

export function setTurnBudget(project: string, b: TurnBudget): void {
  const prev = budgets.get(project);
  if (prev && prev.cap === b.cap && prev.inFlight === b.inFlight && prev.busy.join() === b.busy.join() && starvedSig(prev.starved) === starvedSig(b.starved)) return;
  budgets.set(project, b);
  for (const fn of budgetSubs) fn(project, b);
}

export function turnBudget(project: string): TurnBudget {
  return budgets.get(project) ?? { cap: 0, inFlight: 0, busy: [], starved: [] };
}

/** Subscribe to budget changes; returns the unsubscribe. */
export function onTurnBudget(fn: (project: string, b: TurnBudget) => void): () => void {
  budgetSubs.add(fn);
  return () => budgetSubs.delete(fn);
}

export interface WakeState { sig: string; at: number; misses: number }

/** Age-order a wake queue. The dispatcher stops handing out slots the moment
 *  the budget is spent, so whatever sits at the front of the list wins — and
 *  the list used to be built in a fixed order (coordinator jobs first). At
 *  cap=1 a coordinator that comes due every heartbeat therefore starved the
 *  builder wakes behind it indefinitely. Sorting by "longest since this job
 *  last fired" (never fired = first) makes the queue fair: a job that just got
 *  a slot sinks to the back until every other due job has had its turn. */
export function byWakeAge<T>(jobs: T[], lastAt: (j: T) => number | undefined): T[] {
  return jobs
    .map((j, i) => ({ j, i, at: lastAt(j) ?? -1 }))
    .sort((a, b) => a.at - b.at || a.i - b.i) // stable: equal age keeps declaration order
    .map((x) => x.j);
}

/** Every [host] message the dispatcher types into a pane, by wake kind. They
 *  live here, beside bootPrompt, because they are subject to the SAME
 *  invariant: each is typed into a TUI input box, so it must be one line of
 *  printable ASCII (see isInjectable + the test that walks this table).
 *
 *  Each one is ADDRESSED. A pane reads its scrollback, and a scrollback holds
 *  other roles' words: three separate panes in one swarm read the host's half of
 *  the log as their own instructions and started merging (note
 *  decision-no-builder-merges). "[host -> builder-2]" costs nothing and makes
 *  every host line in that scrollback say who it was for. */
export const WAKE_MESSAGES: Record<string, (keys: string, role: string) => string> = {
  merge: (k, r) => `[host -> ${r}] ${k} ready to merge - merge per your brief, post status merged, unblock successors, then stop.`,
  "scout-done": (k, r) => `[host -> ${r}] scout finished ${k} - its scout-* notes are ready; continue per your brief.`,
  "scout-open": (k, r) => `[host -> ${r}] scout task(s) ${k} open - claim and work per your brief, then stop.`,
  review: (k, r) => `[host -> ${r}] ${k} done - review per your brief, post the verdict, then stop.`,
  // "re-claim" used to be the whole instruction, and it sent builders down the
  // /claim path — which REFUSES a handed-back task ("not claimable", it is not
  // open) and hints "pick another open task". A dispatch builder then found an
  // empty bus and stopped, every 120s, until its context was gone and the task
  // had never moved (note swarm-changes-wake-builder-loop). So the wake names
  // the retake call itself, and the notes the findings are in.
  changes: (k, r) => `[host -> ${r}] ${k} came back with changes - review feedback on YOUR OWN work. It is NOT open and /claim refuses it ("not claimable"), so do not go looking for an open task: retake it with task_status {task: "${k}", status: "claimed", owner: "${r}"}, read note review-${k} (and correction-${k}-scope if it exists) for the findings, and fix it in the worktree you already have. The moment the fix is COMMITTED on swarm/${k}, post task_status done: nothing else moves the task, the reviewer only ever wakes on done, and a committed fix nobody posted stalls the whole swarm. Then stop.`,
  open: (k, r) => `[host -> ${r}] ${k} open for builders - claim ONE and work it per your brief; if your claim fails and nothing else is open, update your status and stop.`,
  plan: (k, r) => `[host -> ${r}] builder task(s) ${k} exist but note "plan" is missing - the brain REJECTS every builder claim until it is there ("no plan yet"), so no builder can start. Write note "plan" now (one line per task id + summary), then unblock the first task(s) per your brief, then stop.`,
  claim: (k, r) => `[host -> ${r}] ${k} is still CLAIMED BY YOU and never marked done - the swarm is stalled on it. Recover it before anything else: read note protocol-recover in this swarm's project and follow it for branch swarm/${k}.`,
  chat: (k, r) => `[host -> ${r}] new swarm message(s) addressed to you: ${k} - read each (BigBrain note in this swarm's project), act/reply per your brief, then stop.`,
  unblock: (k, r) => `[host -> ${r}] NOTHING on the bus is open or in flight and the mission is not finished - task(s) ${k} are all still "blocked", so no builder can see any of them and no role will be woken again until you act. Open the first task with no unmerged predecessor (task_status open), post any task from your plan you have not created yet, then stop.`,
  result: (k, r) => `[host -> ${r}] every task is merged or cancelled (${k}) but note "result" is missing, so the mission cannot close. Verify the work landed on the current branch, write note "result" per your brief, then stop.`,
  malformed: (k, r) => `[host -> ${r}] task note(s) ${k} lost their status/role/owner/files header, so the bus cannot tell whose they are or whether the work is done - every other role is refused on them and only you can repair one. Read each note, check branch swarm/<task> for committed work, then post task_status open (work still to do or to re-verify) or blocked (waiting on something), with a log line saying what you found, then stop.`,
};

/** The nudge sent to a pane stalled on a transient API error (swarmNudge).
 *
 *  THIS USED TO BE THE BARE WORD "continue" — and a bare "continue" is the
 *  documented trigger of every host-merge breach a swarm has had. A pane woken
 *  that way has its brief far up the scrollback, sees the host's own log lines
 *  right above the cursor, and concludes it IS the host: four merges into master
 *  and one fast-forward of another builder's live branch came out of exactly
 *  that (notes decision-no-builder-merges, breach-builder-2-unbriefed-git-writes).
 *  The repo guard now refuses those writes, but the cheaper half of the fix is
 *  to stop producing the stimulus: a nudge names the pane it is waking.
 *
 *  A human typing "continue" by hand is still unfixable from here — which is
 *  why the guard exists and this is only the other half. */
export function nudgeText(role: string): string {
  const note = role ? `note role-${role}` : "your own role-<you> note";
  return `[host -> ${role || "you"}] continue as ${role || "your briefed role"} - you are NOT the host; if your brief is not in view, recall ${note} in this swarm's project BEFORE any git command.`;
}

/** Can this string be typed into a pane? Everything that reaches a PTY as
 *  keystrokes — boot prompts, wake messages, nudges, reset commands — must be a
 *  single line of printable ASCII: a newline submits a half-typed prompt to the
 *  TUI (and fires half a command line at PowerShell when it is embedded in one),
 *  and the PTY codepage is not guaranteed to be UTF-8, so an em dash arrives as
 *  mojibake or nothing. */
export function isInjectable(text: string): boolean {
  return text.length > 0 && /^[\x20-\x7e]+$/.test(text);
}

/** Should this pane be woken for `sig` now? `urgent` marks a pending set that
 *  proves the previous wake achieved nothing (task still unclaimed).
 *  `hooks` = this pane's CLI reports UserPromptSubmit to the brain, so delivery
 *  is a fact, not a guess: the WAKE_DELIVERY_MS miss counter is skipped entirely
 *  (the dispatcher never increments it for such a pane either). The miss counter
 *  exists only because a TUI silently drops keystrokes that land mid-redraw and
 *  nothing else could tell us — re-firing on it when the agent HAS the message
 *  is a duplicate wake and a wasted turn. */
export function wakeDue(prev: WakeState | undefined, sig: string, now: number, urgent: boolean, hooks = false): boolean {
  if (!prev || prev.sig !== sig) return true; // new work — always wake
  if (!hooks && prev.misses > 0 && prev.misses < WAKE_MISS_MAX) return true; // never landed — retry at once
  return now - prev.at >= wakeGap(prev.misses, urgent);
}

/** The re-wake gap wakeDue() will apply next — same rule, exposed so the UI can
 *  count a wake down instead of duplicating the branch. */
export function wakeGap(misses: number, urgent: boolean): number {
  return misses >= WAKE_MISS_MAX || !urgent ? REWAKE_MS : REWAKE_FAST_MS;
}

/** Every tunable the watchers run on, for the health strip's legend: none of
 *  these are configurable, so seeing the number is the only way a human can tell
 *  a swarm that is WAITING from one that is wedged. */
export const SWARM_TIMERS: { label: string; value: string; what: string }[] = [
  { label: "REWAKE", value: `${REWAKE_MS / 1000}s`, what: "heartbeat re-wake, same pending set" },
  { label: "REWAKE_FAST", value: `${REWAKE_FAST_MS / 1000}s`, what: "re-wake while the task is still unclaimed" },
  { label: "WAKE_MISS_MAX", value: `${WAKE_MISS_MAX}`, what: "undelivered wakes before backing off" },
  { label: "WAKE_DELIVERY", value: `${WAKE_DELIVERY_MS / 1000}s`, what: "no output after a wake = it never landed" },
  { label: "STALE_CLAIM", value: `${STALE_CLAIM_MS / 1000}s`, what: "claimed (or changes) + untouched + owner idle = the host steps in" },
  { label: "STRAY_PARK", value: `${STRAY_PARK_MS / 1000}s`, what: "same dirty root this long = the host stashes it so merges resume" },
  { label: "NUDGE_COOLDOWN", value: `${NUDGE_COOLDOWN_MS / 1000}s`, what: "min gap between nudges" },
  { label: "NUDGE_MAX", value: `${NUDGE_MAX}`, what: "nudges per error episode" },
  { label: "RUNAWAY", value: `${RUNAWAY_MS / 60_000}m`, what: "busy + frozen tail = spiralling turn" },
  { label: "RUNAWAY_RESTARTS", value: `${RUNAWAY_RESTART_MAX}`, what: "restarts per pane, then a human looks" },
  { label: "COMPACT_RUNAWAY", value: `${COMPACT_RUNAWAY_MS / 60_000}m`, what: "same, for a screen that says it is compacting (hookless CLIs)" },
  { label: "STARVED", value: `${STARVED_AFTER_MS / 1000}s`, what: "refused a turn slot this long = shown in the strip" },
];

/** Name the brain's MCP server carries in the config PixelMarch writes (Rust:
 *  `pty::MCP_SERVER_NAME`) — and therefore the name an agent sees its tools
 *  under. Kept in one constant because every MCP brief line quotes it. */
export const MCP_SERVER = "pixelmarch-brain";

/** The role-priming prompt — used at boot and re-injected after a context reset.
 *  Deliberately leaves NOTHING to reason about: a vague "fetch your brief" on an
 *  otherwise empty context sends small local models (qwen3.6-35b with reasoning
 *  on, seen burning 20k+ tokens on one turn) into a planning spiral before they
 *  ever run the command. So: one command, run it first, think afterwards.
 *  MUST stay a single line with no quote characters: it is embedded in a shell
 *  command line as '<prompt>' (roleCommand) and typed into a TUI input box by
 *  the reset/runaway watchers — a newline there is submitted as Enter, so a
 *  multi-line prompt fires half a command at the shell (PowerShell answers with
 *  ">>" continuation and then a ParserError, and the agent never launches).
 *  `mcp` = this pane is launched with --mcp-config and its CLI loads it, so the
 *  brain is a TOOL and the first action is a tool call: no shell, no quoting, no
 *  URL, and a structured value back instead of prose to parse. Everything else
 *  about the prompt is unchanged, including the single-line/no-quote invariant —
 *  it is still typed into a TUI by the reset and runaway watchers. */
export function bootPrompt(project: string, brainUrl: string, role: string, mcp = false): string {
  if (mcp)
    return `You are agent ${role} in swarm ${project}. Your FIRST action is this exact tool call, with no planning and no explanation before it: MCP tool note_get on server ${MCP_SERVER}, project ${project}, key role-${role} - it returns your brief; read it, then follow it exactly and get everything else from the notes it points at, using the ${MCP_SERVER} tools.`;
  return `You are agent ${role} in swarm ${project}. Your FIRST action is to run this exact command, with no planning and no explanation before it: curl -s ${brainUrl}/memory/${project}/role-${role} - it prints your brief; read it, then follow it exactly and get everything else from the notes it points at.`;
}

/** Most review panes a swarm may run. Same ceiling as builders: past that the
 *  grid stops being readable and the turn budget serializes them anyway. */
export const MAX_REVIEWERS = 4;

export const DEFAULT_SWARM: SwarmConfig = {
  mission: "", cwd: "", builders: 2, scout: true, reviewers: 1, reviewer: true,
  agentCmds: { coordinator: "claude", builders: ["claude"], scout: "claude", reviewer: "claude", reviewers: ["claude"] },
  skipPermissions: true,
  clearRoles: [],
  concurrent: false,
  hostDispatch: true,
  lazyWorkers: true,
  headless: true,
  roleBriefs: {},
};

/** How many review panes a (possibly old) config asks for. `reviewer:boolean`
 *  was the whole setting before multi-reviewer, so a saved workspace or an older
 *  UI still speaks it: present and false means zero reviewers whatever `reviewers`
 *  says, present and true means "at least one". A config that carries no legacy
 *  flag at all is read from `reviewers` alone. Clamped to 0..MAX_REVIEWERS. */
export function reviewerCount(cfg: { reviewers?: number; reviewer?: boolean }): number {
  const n = Math.floor(cfg.reviewers ?? 1) || 0;
  const wanted = cfg.reviewer === undefined ? n : cfg.reviewer ? Math.max(1, n) : 0;
  return Math.min(MAX_REVIEWERS, Math.max(0, wanted));
}

/** Normalize a config read from disk: `reviewers` becomes authoritative and the
 *  legacy `reviewer` flag is dropped, so nothing downstream has to know it existed. */
export function migrateSwarmConfig<C extends { reviewers?: number; reviewer?: boolean }>(raw: C): C & { reviewers: number } {
  const { reviewer: _legacy, ...rest } = raw;
  return { ...(rest as C), reviewers: reviewerCount(raw) };
}

/** One-time config migration. `AgentCmds` used to carry a legacy single
 *  `builder` string beside `builders[]`, and cmdForRole resolved a four-link
 *  fallback chain (builders[N-1] → builders[0] → builder → "claude") on every
 *  lookup. The field is gone; this normalizes anything still shaped the old way
 *  into ONE dense array of length `builders`, so cmdForRole is a single lookup
 *  and the fallbacks are resolved once, where the builder count is known.
 *  `reviewers[]` is densified the same way, seeded from the legacy single
 *  `reviewer` string — but to length `reviewers`, which may legitimately be 0. */
export function migrateAgentCmds(raw: AgentCmds & { builder?: string }, builders: number, reviewers = 1): AgentCmds {
  const { builder, ...cmds } = raw;
  const list = cmds.builders ?? [];
  const first = list[0] || builder || DEFAULT_AGENT_CMD;
  const n = Math.max(1, Math.floor(builders) || 0, list.length);
  const revList = cmds.reviewers ?? [];
  const revFirst = revList[0] || cmds.reviewer || DEFAULT_AGENT_CMD;
  const rn = Math.max(0, Math.floor(reviewers) || 0, revList.length);
  return {
    ...cmds,
    builders: Array.from({ length: n }, (_, i) => list[i] || first),
    reviewers: Array.from({ length: rn }, (_, i) => revList[i] || revFirst),
  };
}

/** The CLI for a concrete role name ("builder-2" → builder #2's command,
 *  "reviewer-2" → reviewer #2's). Expects migrated commands (see
 *  migrateAgentCmds): one dense entry per builder and per reviewer, so there is
 *  nothing left to fall back through. */
export function cmdForRole(cmds: AgentCmds, role: string): string {
  const idx = Math.max(0, Number(role.split("-")[1] || "1") - 1);
  if (role.startsWith("builder")) return cmds.builders?.[idx] || DEFAULT_AGENT_CMD;
  if (isReviewerRole(role)) return cmds.reviewers?.[idx] || cmds.reviewer || DEFAULT_AGENT_CMD;
  return cmds[role as "coordinator" | "scout"] || DEFAULT_AGENT_CMD;
}

export interface SwarmRole {
  name: string; // brain key suffix + pane title, e.g. "coordinator", "builder-1"
  color: string;
  brief: string; // full instructions, stored as note role-<name>
}

const uid = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : Math.random().toString(36).slice(2);

/** BigBrain project of the repo the swarm works in — its folder name (brain convention). */
export function parentProject(cwd: string): string {
  return cwd.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
}

/** <parent>-swarm-<slug> BigBrain project name — parent repo first so swarms of one
 *  repo group together in the brain's project list. */
export function swarmProject(mission: string, cwd = ""): string {
  const slug = mission.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").split("-").slice(0, 4).join("-") || "mission";
  const parent = parentProject(cwd);
  return `${parent ? `${parent}-` : ""}swarm-${slug}-${uid().slice(0, 4)}`;
}

/** One on-demand protocol section: stored as a brain note at swarm launch, fetched
 *  by an agent only when it hits the case. The brief carries the pointer, never the body. */
export interface ProtocolNote { key: string; body: string }

/** The protocol sections that do NOT belong in a turn-0 context: the shared
 *  task-bus contract (protocol-core / protocol-core-mcp, one per wire flavor),
 *  the coordinator's structured-question form (protocol-ask), Windows shell
 *  quoting, the context-reset handshake, parent-memory writes, chat, and
 *  stale-claim recovery. Each is stored once as note protocol-<x> (SwarmDialog
 *  writes these alongside the role-* briefs) and every brief keeps a pointer.
 *  Nothing becomes undiscoverable — the rules are identical, they just arrive
 *  when they are needed. */
export function protocolNotes(project: string, brainUrl: string, parent: string, resets: boolean, dispatch: boolean, solo = false): ProtocolNote[] {
  const u = brainUrl;
  // The task-bus contract every brief used to embed verbatim (~4.2 KB × 5 roles).
  // Stored ONCE per wire flavor; each brief keeps a one-line "read this first"
  // pointer plus only what an agent needs BEFORE its first successful note read
  // (project id, note read/write syntax, the wake/stop or /wait rule).
  const stale = dispatch
    ? "woken for as soon as you act on it, or the host re-wakes you on stale state"
    : "waiting on as soon as you act on it, or your next /wait fires instantly on stale state";
  // SOLO (one builder): no two agents ever race for the same task, so the claim is not a
  // collision guard — it is what makes you the task's OWNER, and the brain refuses a "done"
  // from anyone else ("only the owner posts done", brain/mod.rs). Same rule either way; only
  // the reason changes, and the wrong reason is what makes a solo swarm plan around races.
  const claimWhy = solo
    ? `the claim makes you the task's OWNER, and the
  brain refuses a "done" from anyone else`
    : `claims are the collision guard`;
  const claimFail = solo ? `the task is not open, it is not your role's` : `someone beat you, the task is not your role's`;
  const human = `- The human overseer reads ONLY the "Coordinator" chat tab and CANNOT see your terminal. Route
  anything needing a human via chat (note protocol-chat has the routing rule) — only the
  coordinator addresses the human; never leave something a human must act on printed to a pane.`;
  const onDemandShared = [
    `- protocol-recover — a task of yours is stuck at "claimed"`,
    resets ? `- protocol-reset — the context-reset handshake in full (your brief carries the short form)` : "",
    parent
      ? `- protocol-memory — PARENT MEMORY (BigBrain project "${parent}"): durable codebase learnings
  (gotchas, conventions, build/test quirks) go there; swarm chatter never does`
      : "",
  ];
  const coreCurl = `TASK BUS + COORDINATION (project "${project}", base ${u}) — atomic endpoints, never edit task
notes by hand:
- List: curl -s "${u}/tasks?project=${project}&status=…&role=…&compact=1"
  compact=1 = one task per line (key | status | role | owner | files | desc).
  One task in full: curl -s ${u}/memory/${project}/task-<n>
- Claim:  curl -s -X POST ${u}/claim -d '{"project":"${project}","task":"task-<n>","owner":"<your role>"}'
  ok:false = ${claimFail}, or note "plan" is missing (every
  builder claim is refused with "no plan yet" until the coordinator posts it).
  Claim a task before working it — ${claimWhy}.
- Update: curl -s -X POST ${u}/task-status -d '{"project":"${project}","task":"task-<n>","status":"done|approved|changes|blocked|open","log":"<short note>"}'
  THIS ENDPOINT IS THE ONLY WAY TO MOVE A TASK. The task note IS the task's state (its
  status/role/owner/files header) — writing that note yourself erases it, so the brain refuses a
  note write to any task-<n> key. If the call fails, read the refusal and fix the call; posting
  the payload to ${u}/memory/${project}/task-<n> instead loses the task.
- Tasks are created by the coordinator (its brief carries the recipe) — need one? Message it
  (protocol-chat).
- NEVER touch files owned by another role's claimed task.
- Lifecycle: open → claimed → done → approved|changes → merged. Move a task OFF the status you
  were ${stale}.
- "cancelled" is the human killing a task from PixelMarch's mission board. It is over: never claim
  it, never re-open it, never post work against it (the brain refuses all three), and plan around
  it. If your own task turns cancelled mid-work, stop — that is the point.
- Search notes: curl -s "${u}/recall?project=${project}&q=<topic>"   (keys: curl -s "${u}/keys?project=${project}")
${human}

FETCH ON DEMAND — curl -s ${u}/memory/${project}/<key>. Read one ONLY when its case applies:
${[
    `- protocol-shell — Windows/PowerShell quoting; read it the first time a POST answers
  {"error":"bad json body"}`,
    `- protocol-chat — the human reads ONLY the coordinator chat tab (no terminal); read YOUR
  messages ("chat-human-<n>" included) with curl -s "${u}/chat?project=${project}&role=<your role>",
  never a chat-* key scan; write "chat-<your role>-<n>" with a "to: <one role>" first line`,
    ...onDemandShared,
  ].filter(Boolean).join("\n")}`;
  const coreMcp = `TASK BUS + COORDINATION (project "${project}", MCP server "${MCP_SERVER}") — atomic tools, never
edit task notes by hand. The tool schemas already carry each call's exact arguments — this note
only says WHEN:
- List: tasks_list — status takes a comma-separated list; omit a filter to widen. One task in
  full: note_get on key task-<n>.
- Claim: task_claim BEFORE working a task — ${claimWhy}. claimed:false comes
  with a reason: ${claimFail}, or "no plan yet" (every builder
  claim is refused until the coordinator posts note "plan").
- Update: task_status — status one of done|approved|changes|blocked|open, plus a short log.
  IT IS THE ONLY WAY TO MOVE A TASK. The task note IS the task's state (its status/role/owner/files
  header), so note_set on a task-<n> key erases it and is refused. A task_status that comes back
  ok:false is telling you which call to fix — never answer it with note_set.
- Tasks are created by the coordinator — need one? Message it (protocol-chat).
- NEVER touch files owned by another role's claimed task.
- Lifecycle: open → claimed → done → approved|changes → merged. Move a task OFF the status you
  were ${stale}.
- "cancelled" is the human killing a task from PixelMarch's mission board. It is over: never claim
  it, never re-open it, never post work against it (the brain refuses all three), and plan around
  it. If your own task turns cancelled mid-work, stop — that is the point.
- Search notes with recall; chat with chat_send / chat_inbox.
${human}

FETCH ON DEMAND — note_get on the key. Read one ONLY when its case applies:
${[
    `- protocol-chat — the human reads ONLY the coordinator chat tab (no terminal); chat_inbox
  {project, role: <you>} in (never a chat-* key scan), chat_send out, addressed to ONE role`,
    ...onDemandShared,
  ].filter(Boolean).join("\n")}`;
  const notes: ProtocolNote[] = [
    { key: "protocol-core", body: coreCurl },
    { key: "protocol-core-mcp", body: coreMcp },
    {
      key: "protocol-ask",
      body: `STRUCTURED QUESTIONS (coordinator only — make the human CHOOSE or CONFIRM): do not free-type a
question and hope for prose back. Post a note "ask-<n>" (your own increasing n) whose body is a
first line "ask: <the question>", then one "option: <choice>" line per choice, and "free: 1" to
also offer a typed answer. The human's Coordinator tab renders it as a form; the reply lands as
note "ask-answer-<n>" with an "option: <chosen>" and/or "text: <typed>" line. Poll note
ask-answer-<n> (note_get or the /memory read in your brief) — until it exists the human has not
answered. This survives a /clear and needs no terminal, so prefer it for any decision you need.`,
    },
    {
      key: "protocol-shell",
      body: `SHELL (Windows): PowerShell's \`curl\` is an alias for Invoke-WebRequest — use \`curl.exe\`.
It also mangles the double quotes inside -d '{"a":"b"}' before curl.exe sees them, which comes
back as {"error":"bad json body"}. Do NOT fight the quoting, and do NOT reach for HttpWebRequest
or python: EVERY endpoint — POST included — takes its fields as QUERY PARAMS, which need no
quoting at all. Use this form:
  curl.exe -s -X POST "${u}/task?project=${project}&desc=<what>&files=<paths>&status=blocked&role=builder"
  curl.exe -s -X POST "${u}/claim?project=${project}&task=task-<n>&owner=<your role>"
  curl.exe -s -X POST "${u}/task-status?project=${project}&task=task-<n>&status=done&log=<short>"
  curl.exe -s -X POST "${u}/memory/${project}/<key>?value=<text>"
URL-encode spaces as %20 and & as %26. If a value is too long or awkward for a URL, write it to
a temp file and send that: curl.exe -s -X POST <url> --data-binary "@C:\\path\\body.json".
ALWAYS pass project=${project} explicitly — never rely on a default, and note that your shell's
working directory has NOTHING to do with which project a note lands in.`,
    },
    {
      key: "protocol-chat",
      body: `HUMAN CHANNEL — ASSUME NO TERMINAL IS VISIBLE TO THE HUMAN. The overseer reads and writes ONLY
the "Coordinator" chat tab, never your terminal output. Anything you print to a pane is invisible
to them, so NOTHING that needs a human decision may be left sitting on a terminal — it must go
through chat or it is never seen.
- READING IS THE COST. Read ONLY your own inbox — MCP: chat_inbox {project: "${project}",
  role: "<your role>"}; curl: curl -s "${u}/chat?project=${project}&role=<your role>". Both hand back
  just the messages addressed to you (plus a broadcast), already parsed and routed. NEVER list or
  scan chat-* keys: that pulls every pane's traffic into YOUR context, and the token price of a
  chat is paid once per reader, not once per writer.
- The human's messages arrive that way too, as notes "chat-human-<n>" whose body starts with a
  line "to: <role>" then the message (and are also injected into the addressed pane). Human
  instructions override the current plan — act at once.
- ADDRESS EXACTLY ONE ROLE. Every message you write names one recipient: "to: <role>" (or
  "to: human", coordinator only). "to: all" is read into EVERY pane's next turn — one line, N
  turns — so it is opt-in and rare, for something every role must act on. It is never a default.
- ONLY THE COORDINATOR TALKS TO THE HUMAN. If you are NOT the coordinator and need the human
  (a question, a blocker, a heads-up), send it to the COORDINATOR — write "chat-<your role>-<n>"
  whose first line is "to: coordinator" — and let the coordinator relay it. Never address the
  human directly; a message the human never sees is worse than none.
- COORDINATOR: post anything meant for the human as "chat-coordinator-<n>" whose FIRST LINE is
  exactly "to: human". Only those land in the human's durable Coordinator tab (backed by brain
  notes, they survive a /clear); a coordinator note without that line is treated as agent chatter
  and lands in the Agents tab. TASK ASSIGNMENT IS NOT CHAT: work is handed out by the task bus —
  create the task, open it, and the addressee is woken for it. Chat carries only what the bus
  cannot (a scope correction, a binding decision, a human answer).
TEAMMATE MESSAGES: reach one other role the SAME way — write "chat-<your role>-<n>" whose first
line is "to: <that role>", then STOP; the host wakes the addressee. Send cross-role
questions/heads-ups this way, not into the void. Keep each a few short lines.`,
    },
    {
      key: "protocol-recover",
      body: `STALE CLAIM RECOVERY — a task is still claimed by you and was never marked done, so the swarm
is stalled on it (nothing is open, nobody gets woken). Check your branch swarm/task-<n> with
git log / git status, then, before anything else:
- work committed there  -> post status done, log "branch swarm/task-<n>: ...", now
- work unfinished       -> finish it, commit, then post done
- never started         -> post status open to release it for another builder
Use the Update call from your protocol note for every one of those — the task NOTE is the task's
state and a hand-written note body erases it (the brain refuses that write).
Never end a turn still holding a claim.`,
    },
  ];
  if (resets)
    notes.push({
      key: "protocol-reset",
      body: `CONTEXT RESET (stay fresh — your context is disposable, the brain is not):
Work in cycles; your role's brief says where a cycle ends. EVERYTHING durable must be in brain
notes BY THEN — task logs, status-<your role>, findings, plan updates — because at a cycle end
your context gets wiped and you must be able to continue from your brief + the notes alone.
When your cycle ends, request the wipe:
  curl -s -X POST ${u}/memory/${project}/reset-<your role> --data-raw ready
Then STOP — end your turn immediately. No polling, no further commands after posting the reset
note: the wipe can only land while you sit idle, and anything you run instead blocks it. The
host then clears your terminal's context${dispatch ? ` and re-sends your role prompt ONLY when work for
your role appears — so after the wipe you may sit with an empty context for a long time; that
is correct, do nothing` : ` and re-sends your role prompt`}. After a reset: fetch your brief, read your
status-<your role> note and the task bus, resume. NEVER re-do work the notes say is finished.`,
    });
  if (parent)
    notes.push({
      key: "protocol-memory",
      body: `PARENT MEMORY (BigBrain project "${parent}" — the repo's own long-term memory, outlives this swarm):
- When you learn something durable about the codebase — a gotcha, convention, build/test quirk,
  architecture fact a future agent would otherwise re-derive — remember it there too:
    curl -s -X POST ${u}/memory/${parent}/<short-topic-key> --data-raw "<what & where, file:line>"
- Swarm-internal chatter (tasks, status, chat, plan) stays in "${project}" — do NOT copy it.`,
    });
  return notes;
}

/** The same contract as `protocol()` below, for a pane whose CLI has the brain
 *  loaded as an MCP server: every curl becomes a tool call. Not a cosmetic swap —
 *  it removes the three failure modes the curl briefs spend most of their words
 *  defending against: shell quoting (PowerShell mangling a JSON body), a session
 *  token pasted somewhere stale, and prose that has to be parsed to find out
 *  whether a claim succeeded. A refused claim comes back as `claimed:false` with a
 *  reason instead of a line of text.
 *
 *  `protocol-shell` is deliberately absent from the on-demand index here: it is
 *  entirely about quoting a curl body, and this pane never writes one.
 *  The one thing MCP has no tool for is the long-poll `/wait`, so a swarm running
 *  WITHOUT host dispatch keeps that single curl line — with the brain URL it needs
 *  to authenticate — and nothing else.
 *
 *  SHORT ON PURPOSE: the full task-bus contract lives in note protocol-core-mcp
 *  (written once per swarm by protocolNotes), and the MCP tool schemas already
 *  document every call's arguments — re-stating either here would bill every
 *  pane's turn 0 for text it can fetch (or already has). The brief keeps only
 *  what an agent needs BEFORE its first successful note_get: the project id,
 *  how to read a note, and the wake/stop (or /wait) rule. */
function mcpProtocol(project: string, brainUrl: string, _parent: string, resets: boolean, dispatch: boolean, creates: boolean): string {
  const p = project;
  const wait = dispatch
    ? `- THE HOST WAKES YOU — never poll. PixelMarch watches the bus and types a [host] wake into
  your terminal when work for your role appears. No sleep/watch loops, no periodic re-checks:
  when nothing is actionable, update your status note, STOP and end your turn — sitting idle
  is correct. A wake names task keys; verify with tasks_list before acting.`
    : `- WAIT for work — the ONE thing with no tool (MCP has no long poll), so it stays a single
  blocking command, no loops:
    curl -s --max-time 70 "${brainUrl}/wait?project=${p}&status=<yours>&role=<yours>&timeout=55&compact=1"
  Returns the matching tasks the moment one exists; EMPTY output after ~55s = nothing yet,
  just run the exact same command again — it doubles as your idle sleep. NEVER build your own
  polling loop.`;
  return `
COORDINATION (BigBrain project "${p}", MCP server "${MCP_SERVER}"):
- The brain is a TOOL SERVER on this session, not an HTTP address you shell out to: every call
  is an already-authenticated MCP tool whose answer is a VALUE you can branch on, and the tool
  schemas document each call's arguments. Always pass project: ${p} explicitly —
  there is no default and your working directory means nothing here.
- Read a note with note_get {project: ${p}, key: <key>}; write with note_set.
  Mission = note "mission". Plan = plan_get. Keep a heartbeat note "status-<your role>"
  (what you are doing now), updated whenever you start or finish something.
- READ NOTE protocol-core-mcp BEFORE your first task-bus call — the full contract (task
  list/claim/update rules, lifecycle, chat, the on-demand protocol index) lives there, not here:
    note_get {project: ${p}, key: protocol-core-mcp}
${wait}${creates
  ? `
- Create tasks with task_create (role omitted = builder work; status omitted = blocked for
  builder tasks, open for scout).`
  : ""}${resets
  ? `
- CONTEXT RESET (CYCLE end): call reset_request {project: ${p}, role: <your role>},
  then STOP immediately — details in note protocol-reset.`
  : ""}`;
}

/** Shared protocol block — every brief carries the same coordination contract.
 *  SHORT ON PURPOSE: the full task-bus contract (list/claim/update endpoints,
 *  claim rules, lifecycle, chat, the on-demand protocol index) is written ONCE
 *  per swarm as note protocol-core (protocolNotes above) — embedding it verbatim
 *  in all 5 role briefs cost ~21 KB of brain storage and 4+ KB of every pane's
 *  turn 0. The brief keeps only what an agent needs BEFORE its first successful
 *  note read: the token-carrying base URL, note read/write syntax, and the
 *  wake/stop (or /wait) rule — plus the imperative pointer to protocol-core.
 *  `mcp` swaps the block for its tool-call twin (`mcpProtocol`) — same contract,
 *  same rules, no shell. */
function protocol(project: string, brainUrl: string, parent: string, resets: boolean, dispatch: boolean, creates = false, mcp = false): string {
  if (mcp) return mcpProtocol(project, brainUrl, parent, resets, dispatch, creates);
  const u = brainUrl;
  const wait = dispatch
    ? `- THE HOST WAKES YOU — never poll. PixelMarch watches the bus and types a [host] wake into
  your terminal when work for your role appears. No sleep/watch loops, no periodic re-checks:
  when nothing is actionable, update your status note, STOP and end your turn — sitting idle
  is correct. A wake names task keys; verify with the List endpoint (protocol-core) before acting.`
    : `- WAIT for work (the ONLY way you poll — one blocking curl, no loops):
    curl -s --max-time 70 "${u}/wait?project=${project}&status=<yours>&role=<yours>&timeout=55&compact=1"
  Returns the matching tasks the moment one exists; EMPTY output after ~55s = nothing yet,
  just run the exact same command again — it doubles as your idle sleep. NEVER build your own
  polling loop (for/seq/watch/sleep/grep pipelines) — they die silently in shell timeouts and
  you miss events.`;
  return `
COORDINATION (BigBrain project "${project}", base ${u}):
- That base URL carries the brain's session token in its "/t/<token>/" segment. Use it EXACTLY
  as written; strip it and every command below answers 401 unauthorized. Do not paste it
  anywhere durable — it is minted fresh on each PixelMarch start. ALWAYS pass
  project=${project} explicitly.
- Read a note:  curl -s ${u}/memory/${project}/<key>
- Write a note: curl -s -X POST ${u}/memory/${project}/<key> --data-raw "<body>"
- Mission = note "mission". Plan = note "plan". Keep a heartbeat note "status-<your role>"
  (what you are doing now), updated whenever you start or finish something.
- READ NOTE protocol-core BEFORE your first task-bus call — the full contract (task
  list/claim/update endpoints, claim rules, lifecycle, chat, the on-demand protocol index)
  lives there, not here: curl -s ${u}/memory/${project}/protocol-core
${wait}${creates
  ? `
- Create tasks: curl -s -X POST ${u}/task -d '{"project":"${project}","desc":"<what>","files":"<paths it owns>","status":"open|blocked","role":"builder|scout"}'
  (role omitted = builder work; status omitted = blocked for builder tasks, open for scout.)`
  : ""}${resets
  ? `
- CONTEXT RESET (CYCLE end): curl -s -X POST ${u}/memory/${project}/reset-<your role> --data-raw ready,
  then STOP immediately — details in note protocol-reset.`
  : ""}`;
}

/** Chat discipline — the single largest token sink a real-run audit found: 57 chat
 *  notes across 11 tasks, 37 of them coordinator-authored wakes for transitions the
 *  host dispatcher already watches (swarmDispatch.ts types the [host] wake itself:
 *  open→builder/scout, done→reviewer, approved→coordinator, changes→owner, and the
 *  host messages the coordinator on merge). Every chat note is a full LLM turn to
 *  write AND is fanned out to every pane, so its price is paid N times.
 *
 *  SHORT ON PURPOSE: this block exists to REMOVE token cost, so it must not cost
 *  more than it saves — three lines for a worker, six for the coordinator (which
 *  also owns the decision-note rule, being the only role that writes decisions).
 *  Wire-neutral: no curl, no tool names, so it reads the same in both flavors. */
function chatDiscipline(dispatch: boolean, coordinator: boolean): string {
  const wake = dispatch ? "wakes its role by itself (the host watches the bus)" : "wakes its role by itself (each role's own /wait returns on it)";
  const never = `NEVER chat to prompt an action the bus already triggers: open/done/changes/approved/merged each
${wake}.`;
  // The other half of the same bill: WHO reads it. "to: all" multiplies one
  // message by the pane count, and read paths that scan every chat-* key do it
  // again on the reader's side (brain-findings 1.3/1.4).
  const narrow = `Address ONE role ("to: <role>"); "to: all" spends a turn in every pane, so it is opt-in and rare.
Read only your own inbox (chat_inbox / GET /chat?role=<you>), never a chat-* key scan.`;
  return coordinator
    ? `
CHAT IS EXPENSIVE — a chat note costs a turn to write and is read into EVERY pane:
- ${never} There is no legitimate coordinator-authored wake ("task-4 is at
  done, please pick it up" is pure duplicate cost). Chat carries only what the bus cannot: a scope
  correction, a binding decision, a human answer.
- ${narrow}
- A binding decision lives in exactly ONE note "decision-<slug>". The chat is a single pointer line
  ("to: reviewer-1 — decision-wire-evidence is binding for the rest of the mission"). Never inline a
  note body into chat; writing the note AND restating it doubles a cost already paid per pane.
- A chat is a line or two. Anything longer is a note — post the note, point at it.`
    : `
CHAT IS EXPENSIVE — a chat note costs a turn to write and is read into EVERY pane. ${never}
${narrow}
Chat only what the bus cannot carry, in a line or two; anything longer is a note — post it and
point at it.`;
}

function coordinatorBrief(project: string, brainUrl: string, parent: string, cfg: SwarmConfig, mcp = false): string {
  const open = mcp
    ? `task_status {project: ${project}, task: task-<n>, status: "open"}`
    : `curl -s -X POST "${brainUrl}/task-status?project=${project}&task=task-<n>&status=open"`;
  const createCall = mcp ? `task_create {..., role: "scout"}` : `a task with\n   "role":"scout"`;
  const readSettings = mcp
    ? `note_get {project: ${parent}, key: project_settings}`
    : `curl -s ${brainUrl}/memory/${parent}/project_settings`;
  // Whether the COORDINATOR itself gets context-wiped between cycles — only when
  // its kind is in clearRoles. A builders-only clear leaves this false, so the
  // coordinator keeps its planning context and its brief drops the reset handshake.
  const resets = clearsRole(cfg.clearRoles, "coordinator");
  const reviewers = reviewerCount(cfg);
  // SOLO: one builder means no two tasks are EVER in flight together, so every
  // collision rule below is dead weight — and worse than dead: a coordinator told
  // to plan around parallel builders that it does not have splits scope to dodge a
  // conflict that cannot happen. At 1 builder the brief says so outright and the
  // splitting rules keep only the reasons that still hold (review gate, working
  // artifact per merge, dependency order).
  const solo = Math.max(1, cfg.builders) === 1;
  const team = [solo ? "1 builder (SOLO — tasks run strictly one at a time)" : `${cfg.builders} builders`, cfg.scout ? "1 scout" : null, reviewers ? `${reviewers} reviewer(s)` : null].filter(Boolean).join(", ");
  // A solo builder with no reviewer gets NOTHING from a split: no parallelism to
  // win, no review gate to pass through. The 2-8 floor and the "one-file
  // deliverables still get split" mandate below only earn their cost when one of
  // those two exists — otherwise the coordinator spends turns carving a mission
  // that a single builder will do end to end anyway.
  const soloLoose = solo && !reviewers;
  const range = solo ? (reviewers ? "2-5" : "1-3") : "2-8";
  const shape = solo
    ? `SEQUENTIAL tasks. You have ONE
   builder, so tasks never run at the same time: file overlap BETWEEN tasks is fine and is not
   worth splitting scope over — order them by what must land first.`
    : `tasks with NON-OVERLAPPING file
   ownership, so builders run in parallel.`;
  const gate = reviewers ? "approved" : "done";
  return `You are COORDINATOR of an agent swarm. Team: ${team}.
Mission (also note "mission"):
${cfg.mission}

You plan, integrate, and steer. Do NOT write product code yourself.
ALREADY RUNNING? READ NOTE "plan" BEFORE ANYTHING ELSE. If it exists, steps 1-5 below are ALREADY
DONE and this is a RESUME, not a fresh start: do NOT explore, do NOT read repo files, do NOT run
git, do NOT re-plan, do NOT re-create tasks. Read note "plan", note "status-coordinator" and the
task bus, do EXACTLY what the [host] wake in front of you asks (unblock a task, handle a merge,
answer a message, repair a stalled bus, write "result"), then STOP. Exploring on a resume is how a
swarm stalls with a full plan already written down: nothing on the bus moves while you read.
SCOPE NEVER SPLITS: to change a task's scope, patch that task's desc and/or append a note
"correction-task-<n>-scope" — the task that owns the files keeps owning them. NEVER create a new
task for scope an existing open/claimed/changes task already covers: ${solo
    ? `the second task re-does work the
first already owns, and the builder ships both.`
    : `two tasks over one file set is
how a full competing implementation got built in parallel and thrown away.`}
HUMAN CHANNEL: the human overseer reads ONLY the "Coordinator" chat tab and cannot see any
terminal. Post everything meant for them — questions, status, blockers, and the final result —
as note "chat-coordinator-<n>" whose FIRST LINE is exactly "to: human"; only those reach the
human tab and they survive a /clear. Relay worker messages the human should see. Everything else
goes to ONE role ("to: <role>") — work itself is handed out by the BUS, never by chat, and
"to: all" is read into every pane, so it is opt-in and rare. Full routing rule:
note protocol-chat. To make the human CHOOSE or CONFIRM a decision, read note protocol-ask and
post its structured "ask-<n>" form instead of free-typing a question — the reply lands as note
"ask-answer-<n>".
1. ${cfg.scout ? `SCOUT FIRST — you do NOT read the codebase yourself. You have a scout whose whole job
   is the map you need to plan, and it sits idle until you task it. Your FIRST act is ${createCall}
   with desc "scout: map <what you need to plan this mission>" — then STOP and end your turn${resets
    ? ` (posting
   the request does NOT end a cycle: keep your context, you are woken when its notes land)`
    : ""}.
   Tag EVERY scout request "role":"scout" — untagged tasks are builder work. Skip the scout ONLY
   when the mission needs no knowledge of this codebase at all (you can already name the change).
   When its scout-* notes land, plan FROM THEM — no repo reading, no git, no exploring of your
   own — and decompose the mission into ${range} ${shape}` : `Explore just enough to decompose the mission into ${range} ${shape}`}
2. ${soloLoose ? `DO NOT OVER-SPLIT: one builder, no reviewer. A split buys you no parallelism and no
   review gate here, so it is not worth a single planning turn on its own. Split ONLY where a real
   dependency order forces it, or where a merge boundary leaves a working artifact you want. ONE
   task is a perfectly good plan for a mission one builder can carry end to end — do not carve a
   mission into subsystems to look thorough.` : `ONE-FILE DELIVERABLES STILL GET SPLIT: never collapse the mission into one giant task.
   Split by SUBSYSTEM into SEQUENTIAL tasks that all own that file (e.g. "physics + input",
   "world generation", "gameplay + HUD", "polish"), each saying what it adds on top of the
   previous one. ${solo ? "Splitting is for the REVIEW GATE and a working artifact at every merge, not\n   for isolation" : "Only one is ever open, so there is no collision — and you get a review gate\n   and a working artifact at every merge"}. Single-task plans are for genuinely small missions.`}
3. Write note "plan" FIRST (one line per task id + summary), BEFORE any /task call — the brain
   rejects every builder claim while "plan" is missing ("no plan yet").
4. Create EVERY task with "status":"blocked", no exceptions — blocked tasks are invisible to
   builders, so nobody starts while you are still posting the batch.
5. Only AFTER the whole batch is posted, ${open} for the first
   task plus any with no unmerged predecessor. Tasks that share files stay blocked until
   their predecessor merges (step 8).${resets ? ` THAT ENDS YOUR FIRST CYCLE — planning is the single
   largest thing you will ever hold, and none of it is needed again: "plan" and the task descs
   carry it. Request the context reset and STOP.` : ""}
6. ${cfg.hostDispatch ? `STOP and end your turn — the host tells you (a chat message from "host") when a
   task has been merged and its successors need unblocking.` : `Wait for merge-ready tasks with ONE blocking call (empty = run it again):
     curl -s --max-time 70 "${brainUrl}/wait?project=${project}&status=merged&timeout=55&compact=1"`}
   Builders work each task on branch swarm/task-<n> in a worktree and commit there.${reviewers ? `
   ${reviewers > 1 ? `The ${reviewers} reviewers gate` : "The reviewer gates"}: done becomes approved or changes (the builder redoes it).${reviewers > 1 ? ` Any free reviewer takes any done task; do not assign them yourself.` : ""}` : ""}
7. YOU DO NOT MERGE — PixelMarch performs every merge itself: it merges the ${gate} branch, cleans up
   the worktree, marks the task "merged", and messages you. The brain REFUSES a "merged" status from
   you, and a direct commit to master/main is blocked while the swarm runs, so do not run git merge,
   git worktree, git commit, or git push at all. If a merge hits a conflict the host sets the task back
   to "changes" and its builder resolves it on the branch.
8. When the host tells you a task merged: if it says a dependency manifest changed (package.json,
   Cargo.toml, requirements.txt, …), install at the repo ROOT now (npm install / cargo fetch / pip
   install …). Then unblock successor tasks (${open} on each whose predecessor is now merged) and keep
   note "plan" authoritative.${resets ? ` Unblocking ends a CYCLE: request a context reset and STOP —
   plan, tasks, and status notes carry everything forward.` : cfg.hostDispatch ? ` Then STOP and end your
   turn — the host wakes you for the next merged task.` : ""}
9. When every task is merged, write note "result" (what shipped).${parent ? ` Then save the mission's
   durable learnings to parent project "${parent}", and REFRESH its canonical overview note
   "project_settings": read it (${readSettings}), rewrite it in
   place merging what the mission ADDED or CHANGED (modules, endpoints, commands, conventions,
   build/test steps) and dropping what it made false. Terse and current, no changelog. Missing?
   Create it as a concise project overview.` : ""} Then set "status-coordinator" to "MISSION COMPLETE"
   and post a "chat-coordinator-<n>" with first line "to: human" telling the overseer the mission
   is complete and what shipped — the human never watches a terminal, so this is how they find out.${resets ? `
CYCLE ENDS ARE NOT ONLY MERGES. Every one of these ends a cycle: the batch is posted and the
first tasks opened (5); a scout report is folded into the plan (posting the request does not); a merge
is handled and its successors unblocked (8); a worker chat or a human "ask-answer-<n>" is
answered; a stalled bus is repaired. At each one, make sure "plan" and "status-coordinator" say
everything the next you needs, request the context reset, then STOP — ${cfg.hostDispatch
    ? "you are woken again the moment anything needs you"
    : "your /wait returns the moment anything needs you"}.
NEVER hold a cycle open "to keep the thread". Your context is the ONE thing here that is not
durable, and a coordinator carrying every turn of the mission ends it too full and too slow to
plan — the host also wipes you on its own after a merge, so a note you have not written yet is a
note that is gone. The notes are the thread.` : ""}
AFTER ANY RESUME OR "continue": you are the COORDINATOR, not the host and not a builder. The
scrollback above your cursor contains other roles' words, including the host's. Re-read this brief
(note "role-coordinator") and note "plan", then act ONLY on what the wake asks for.
${chatDiscipline(cfg.hostDispatch, true)}
${protocol(project, brainUrl, parent, resets, cfg.hostDispatch, true, mcp)}`;
}

/** One template for every builder — briefs differ only where the role string is
 *  interpolated. They still land as per-role notes (role-builder-<n>): a single
 *  shared role-builder note is off the table because bootPrompt is regenerated
 *  on reset/runaway (swarmReset.ts, swarmRunaway.ts) from just (project, role),
 *  with no access to per-builder CLI flavor or user-brief overrides — a shared
 *  key would 404 exactly when those make builder briefs diverge. */
function builderBrief(project: string, brainUrl: string, parent: string, n: number, resets: boolean, dispatch: boolean, mcp = false, solo = false): string {
  const snapshot = mcp
    ? `tasks_list {project: ${project}, status: "open", role: "builder"}`
    : `curl -s "${brainUrl}/tasks?project=${project}&status=open&role=builder&compact=1"`;
  const feedback = mcp
    ? `tasks_list {project: ${project}, status: "changes", owner: "builder-${n}"}`
    : `curl -s "${brainUrl}/tasks?project=${project}&status=changes&owner=builder-${n}&compact=1"`;
  const claim = mcp ? `task_claim {project: ${project}, task: task-<n>, owner: builder-${n}}` : "POST /claim";
  const done = mcp
    ? `task_status {project: ${project}, task: task-<n>, status: "done", log: "branch swarm/task-<n>: <what you changed + how verified>"}`
    // Spelled out as the whole call, not as a bare JSON payload: a shorthand that
    // names no URL reads as "write this object somewhere", and an agent that could
    // not get the call through once answered that by writing the payload into the
    // task NOTE — which erased the header the bus reads (the brain now refuses it).
    : `curl -s -X POST "${brainUrl}/task-status?project=${project}&task=task-<n>&status=done&log=branch%20swarm/task-<n>:%20<what you changed + how verified>"`;
  const retake = mcp
    ? `task_status {project: ${project}, task: task-<n>, status: "claimed", owner: "builder-${n}"}`
    : `curl -s -X POST "${brainUrl}/task-status?project=${project}&task=task-<n>&status=claimed&owner=builder-${n}"`;
  return `You are BUILDER-${n} in an agent swarm. You implement tasks.
${dispatch ? `HOLD UNTIL TASKED: until you have successfully claimed a task, do NOTHING — no reading repo
files, no git commands, no plan.md, no exploring, no setup, and NO polling. Set
"status-builder-${n}" to "idle — waiting for tasks" once, then STOP and end your turn. The host
wakes you when an open task exists.` : `HOLD UNTIL TASKED: until you have successfully claimed a task, do NOTHING but poll the brain —
no reading repo files, no git commands, no plan.md, no exploring, no setup. The coordinator
plans; you idle. Wait with ONE blocking call (empty output = run it again):
  curl -s --max-time 70 "${brainUrl}/wait?project=${project}&status=open,changes&role=builder&mine=builder-${n}&timeout=55&compact=1"
(${solo ? "you are the only builder" : "mine= hides other builders' rework"}; a "changes" task in the output is YOURS to redo.)
Set "status-builder-${n}" to "idle — waiting for tasks" once, then stay quiet.`}
Scout tasks are NOT yours — role=builder hides them and the server rejects your claim anyway.
NEVER END A TURN HOLDING A CLAIM: a claimed task is invisible to everyone else, so a claim you
walk away from stalls the whole swarm — nothing is open, nobody is woken, the mission stops.
Before you stop${resets ? " or request a context reset" : ""}, every task you claimed must be "done" (work committed),
"changes" (handed back), or "open" again (released, if you never started it). Committing the
work is NOT finishing the task; the POST that marks it done is.
NEVER MERGE and never commit to master/main — PixelMarch performs every merge itself (worktree
cleanup included). While the swarm runs, git hooks REFUSE any ref write you make to master/main, to
a branch that is not yours, or inside a worktree you do not own — merges, fast-forwards and resets
included, not just commits. They also refuse ANY commit you make in the repo ROOT, on any branch:
the root checkout is the host's. You only ever commit on your own swarm/task-<n> branch, in your own
worktree. A merge conflict comes back to you as a "changes" task; resolve it on your branch. Do not
run git merge, git worktree remove, or git push.
IF A GIT COMMAND IS REFUSED BY THE GUARD, STOP AND SAY SO. The branch did not move, but git had
already written your index and working tree before the refusal, so that checkout may now be dirty.
Do not try to tidy it and do not retry the command — chat the coordinator and let the host resolve it.
AFTER ANY RESUME OR "continue": you are BUILDER-${n}, not the host. The scrollback above your cursor
contains other roles' words, including the host's. Re-read this brief (note "role-builder-${n}")
before any git command.
1. ${dispatch ? `On a [host] wake for a task that came back with CHANGES, that task is YOURS to redo and
   it is NOT open - a snapshot of open tasks is empty by definition, and /claim refuses it
   ("not claimable"). Do NOT stop on that: check for it and retake it,
     ${feedback}
     ${retake}
   then read note review-task-<n> (and correction-task-<n>-scope if one exists), fix it in the
   SAME worktree, commit, and mark it done again - step 5.
   Otherwise snapshot what is open:
     ${snapshot}
   Empty = ${solo ? "nothing is open yet" : "another builder beat you"}: update your status, STOP, wait for the next wake.
   Otherwise read notes "mission" and "plan".` : `When your wait returns an open task, read notes "mission" and "plan". (A "changes" task
   instead = review feedback on YOUR work: ${retake},
   fix it in its worktree, mark done again — see step 5.)`}
2. Claim it via ${claim}. ${mcp ? "claimed:false" : "ok:false"} = pick another, EXCEPT reason "no plan yet": no builder
   claim can succeed until the coordinator posts note "plan". Do not retry, do not loop, do not
   start work — update your status and STOP; the host nags the coordinator and wakes you when
   the plan lands. Only AFTER a successful claim may you touch the repo.
3. Work in an ISOLATED WORKTREE${solo
    ? ` — you are the only builder, but the repo ROOT is the HOST's and
   every commit of yours belongs on your own branch — inside the repo under .swarm/`
    : ` so builders never collide — inside the repo under .swarm/`}
   (git-ignored via .git/info/exclude), NEVER outside the project directory. The host opens it for
   you shortly after your claim lands and stamps it with your name; open it yourself only if it is
   still missing:
     git worktree add .swarm/task-<n> -b swarm/task-<n>
   cd into it, touch ONLY the files the task owns, verify (build/tests as the repo dictates),
   then COMMIT on that branch with a clear message. Never write in another task's worktree — the
   guard refuses it, and the pane that owns it is live.
4. ${done}.
   Update "status-builder-${n}". cd back to the repo root.
5. Check for review feedback:
     ${feedback}
   A task of YOURS there: ${retake} FIRST (takes
   it off the bus), fix it in the same worktree, commit, mark done again.
6. ${resets ? `Otherwise your CYCLE ENDS: request a context reset, then STOP and end your turn — you are
   re-briefed fresh and only then wait for the next open task.` : dispatch ? `Otherwise update your status, then STOP and end your turn — the host wakes you for the
   next open task.` : `Otherwise go back to waiting for the next open task (your /wait command above).`}
${chatDiscipline(dispatch, false)}
${protocol(project, brainUrl, parent, resets, dispatch, false, mcp)}`;
}

function scoutBrief(project: string, brainUrl: string, parent: string, resets: boolean, dispatch: boolean, mcp = false, solo = false): string {
  const claim = mcp ? `task_claim {project: ${project}, task: task-<n>, owner: scout}` : "POST /claim";
  const done = mcp
    ? `task_status {project: ${project}, task: task-<n>, status: "done", log: "<what you mapped + which scout-* notes>"}`
    : `curl -s -X POST\n   "${brainUrl}/task-status?project=${project}&task=task-<n>&status=done&log=<what you mapped + which scout-* notes>"`;
  return `You are SCOUT in an agent swarm. You explore; you never edit files.
${dispatch ? `HOLD UNTIL TASKED: do NOTHING until the coordinator posts a scout task — no reading the
mission, no mapping the codebase, no reading repo files, no notes, and NO polling. Set
"status-scout" to "idle — waiting for scout tasks" once, then STOP and end your turn. The
host wakes you when a task with role scout appears.` : `HOLD UNTIL TASKED: do NOTHING until the coordinator posts a scout task — no reading the
mission, no mapping the codebase, no reading repo files, no notes. The coordinator decides
what to scout and when. Wait with ONE blocking call (empty output = run it again):
  curl -s --max-time 70 "${brainUrl}/wait?project=${project}&status=open&role=scout&timeout=55&compact=1"
Set "status-scout" to "idle — waiting for scout tasks" once, then stay quiet.`}
1. When a scout task appears${dispatch ? " (a [host] wake)" : " (your /wait returns one)"}, claim it via ${claim} — read-only work,
   but the claim is what makes you its OWNER, and the brain refuses a "done" from anyone else.
   Only AFTER a successful claim do you read note "mission" and start exploring.
2. Map what the task asks for: entry points, key modules, conventions, build/test commands,
   gotchas. Write findings as notes "scout-<topic>" (short, file:line specific), then ${done}.${solo
    ? `
   ONE BUILDER works everything you map, strictly in sequence — so report the ORDER things must
   land in, and do NOT carve the codebase into parallel-safe slices: nothing runs in parallel.`
    : ""}
3. Update "status-scout" as you go.${parent ? ` Findings that hold beyond this mission (conventions,
   build/test commands, gotchas) go to PARENT MEMORY too.` : ""}
4. ${resets ? `A finished scout task ends your CYCLE: request a context reset — findings live in the
   scout-* notes, not your head — then STOP and end your turn. You wait for scout tasks again
   only AFTER the host re-briefs you.` : dispatch ? `Then update your status, STOP and end your turn — the host wakes you for the next
   scout task.` : `Then go back to waiting for the next scout task (your /wait command above).`}
${chatDiscipline(dispatch, false)}
${protocol(project, brainUrl, parent, resets, dispatch, false, mcp)}`;
}

function reviewerBrief(project: string, brainUrl: string, parent: string, n: number, total: number, resets: boolean, dispatch: boolean, mcp = false, solo = false): string {
  const me = `reviewer-${n}`;
  const owning = solo ? "the builder" : "the owning builder";
  const verdict = mcp
    ? `task_status {project: ${project}, task: task-<n>, status: "approved"} — or
   {..., status: "changes", log: "<the findings>"} so ${owning} redoes it.`
    : `curl -s -X POST "${brainUrl}/task-status?project=${project}&task=task-<n>&status=approved" — or
   the same call with status=changes&log=<the findings> so ${owning} redoes it.`;
  // With several review panes the same `done` task is visible to all of them, so the
  // brief has to say who owns it: the wake names the task, and the verdict POST is what
  // takes it off "done". A reviewer that grabs a task it was not woken for duplicates
  // another reviewer's work and can overwrite its verdict note.
  const shared = total > 1
    ? `\nYou are one of ${total} reviewers. Review ONLY the task(s) named in your wake, and re-check
the bus first: a task no longer at status "done" was already taken by another reviewer —
skip it, never re-verdict it. Write your findings to note "review-task-<n>" only for the
tasks you actually reviewed.`
    : "";
  // SOLO: with one builder there is never a second task in flight to absorb the wait, so a
  // "changes" verdict stops the whole mission until that one builder redoes it. Findings
  // dribbled out over two rounds cost two full stalls.
  const stall = solo
    ? `\nThe swarm has ONE builder: a "changes" verdict stalls the ENTIRE mission until it redoes
that task — nothing else is in flight. So review the diff ONCE, completely, and put EVERY
finding in the same note; do not hand back twice for things one pass would have caught.`
    : "";
  return `You are REVIEWER-${n} in an agent swarm. You gate quality; you never edit files.${shared}${stall}
${dispatch ? `HOLD UNTIL TASKED: until a task hits status done, do NOTHING — no reading repo files,
no git commands, no plan.md, no exploring, and NO polling. Set "status-${me}" to
"idle — waiting for done tasks" once, then STOP and end your turn. The host wakes you
when a builder task goes done (scout tasks produce notes, not branches — you only
review builder work).` : `HOLD UNTIL TASKED: until a task hits status done, do NOTHING but poll the brain — no
reading repo files, no git commands, no plan.md, no exploring. Wait with ONE blocking
call (empty output = run it again):
  curl -s --max-time 70 "${brainUrl}/wait?project=${project}&status=done&role=builder&timeout=55&compact=1"
(role=builder — scout tasks produce notes, not branches; you only review builder work.)
Set "status-${me}" to "idle — waiting for done tasks" once, then stay quiet.`}
1. When a task goes done, read notes "mission" and "plan". Your verdict (approved/changes)
   moves it off "done"${dispatch ? "." : " — then go back to the same /wait."}
2. Review each done task-<n> against its description:
     git diff $(git merge-base HEAD swarm/task-<n>)..swarm/task-<n>
   Write note "review-task-<n>": first line "verdict: approved @ <sha>" or "verdict: changes",
   then one line per finding (file:line, problem, fix). <sha> is the commit you actually read:
     git rev-parse swarm/task-<n>
   THE HOST MERGES THAT COMMIT AND NOTHING ELSE. An approval note with no SHA in it cannot be
   merged — the host hands the task straight back as "changes", however good the review was.
3. Post the verdict: ${verdict}
4. Update "status-${me}". ${resets ? `Each posted verdict ends your CYCLE: request a context reset,
   then STOP and end your turn — you re-brief fresh and only then wait for the next done task.` : dispatch ? `After each verdict, STOP and end your turn — the host wakes you for the next
   done task.` : `After each verdict go back to the same /wait.`}
   Keep going until the coordinator writes "result".
${chatDiscipline(dispatch, false)}
${protocol(project, brainUrl, parent, resets, dispatch, false, mcp)}`;
}

/** Fold a user-supplied .md into a role's brief. The md REPLACES the generated
 *  role-specific body, but `protocolBlock` is ALWAYS still appended: it carries
 *  the task bus, the claim rules and the merge gate, so a brief without it has
 *  no way to take work or hand it back. A blank/whitespace-only md (or none at
 *  all) leaves the generated brief exactly as it was.
 *  Pure — the whole reason it lives here and not in the dialog. */
export function composeBrief(generated: string, userMd: string | undefined, protocolBlock: string): string {
  const md = (userMd ?? "").trim();
  return md ? `${md}\n${protocolBlock}` : generated;
}

/** The user .md for a role, or undefined. Keys that are not role names
 *  swarmRoles() mints simply never match, so a stale entry is ignored. */
function roleBriefBody(cfg: SwarmConfig, role: string): string | undefined {
  return cfg.roleBriefs?.[role]?.body;
}

/** Per-role launch identity: the token-carrying base URL the role's pane
 *  authenticates with (its AGENT token, minted by swarm_register_agents) and the
 *  MCP config file that carries the same token. A resolver returning undefined —
 *  or no resolver at all — means "use the shared values", i.e. exactly the
 *  pre-identity behaviour (session URL + shared MCP config); this keeps every
 *  existing caller and every test working unchanged. */
export interface RoleIdentity { url: string; mcpPath: string }
export type RoleIdentityFn = (role: string) => RoleIdentity | undefined;

/** All roles for a config, in spawn order (coordinator first). Single fan-out
 *  point: this is also where a user .md overrides a generated brief. `identity`
 *  bakes each role's own agent-token URL / MCP config into its brief so a
 *  curl-brief pane authenticates AS ITS ROLE and the brain's lifecycle guard
 *  knows who is asking. */
export function swarmRoles(project: string, brainUrl: string, cfg: SwarmConfig, mcpConfigPath = "", identity?: RoleIdentityFn): SwarmRole[] {
  const parent = parentProject(cfg.cwd);
  const dispatch = cfg.hostDispatch;
  // A brief is written PER ROLE, and a swarm may mix CLIs — so the tool-call
  // wording is decided per role, from the command that role's pane will run and
  // from whether this host could actually write the MCP config. No path (an older
  // binary, a host that cannot write it, any test that does not ask for one) means
  // every brief keeps its curl wording, i.e. exactly today's text.
  const cmds = migrateAgentCmds(cfg.agentCmds, cfg.builders, reviewerCount(cfg));
  const urlFor = (name: string) => identity?.(name)?.url || brainUrl;
  const mcpPathFor = (name: string) => identity?.(name)?.mcpPath ?? mcpConfigPath;
  const mcpFor = (name: string) => speaksMcp(cmdForRole(cmds, name), mcpPathFor(name));
  // Context resets are now PER ROLE KIND: a role only carries the reset handshake
  // when its kind is in clearRoles, so a builders-only clear leaves the coordinator,
  // scout and reviewers polling/idle as normal.
  const resets = (name: string) => clearsRole(cfg.clearRoles, name);
  // Same protocol block the generated briefs end with; re-used verbatim when a
  // user .md replaces the body around it. Its reset text tracks the role too.
  const proto = (name: string, creates = false) => protocol(project, urlFor(name), parent, resets(name), dispatch, creates, mcpFor(name));
  const role = (name: string, color: string, generated: string, creates = false): SwarmRole => ({
    name, color, brief: composeBrief(generated, roleBriefBody(cfg, name), proto(name, creates)),
  });
  const roles: SwarmRole[] = [role("coordinator", "#e0a44c", coordinatorBrief(project, urlFor("coordinator"), parent, cfg, mcpFor("coordinator")), true)];
  // Same SOLO fact the coordinator's brief carries: one builder = nothing ever runs
  // beside you, so its brief drops the collision framing too.
  const solo = Math.max(1, cfg.builders) === 1;
  for (let i = 1; i <= Math.max(1, cfg.builders); i++)
    roles.push(role(`builder-${i}`, "#4c8bf5", builderBrief(project, urlFor(`builder-${i}`), parent, i, resets(`builder-${i}`), dispatch, mcpFor(`builder-${i}`), solo)));
  if (cfg.scout) roles.push(role("scout", "#5fbf6a", scoutBrief(project, urlFor("scout"), parent, resets("scout"), dispatch, mcpFor("scout"), solo)));
  const reviewers = reviewerCount(cfg);
  for (let i = 1; i <= reviewers; i++)
    roles.push(role(`reviewer-${i}`, "#c576d6", reviewerBrief(project, urlFor(`reviewer-${i}`), parent, i, reviewers, resets(`reviewer-${i}`), dispatch, mcpFor(`reviewer-${i}`), solo)));
  return roles;
}

/** Boot command: fetch your brief from BigBrain and follow it. Single-quoted for
 *  PowerShell (`startup_args` wraps it in -Command) — briefs stay out of the command line. */
function bootCommand(agentCmd: string, project: string, brainUrl: string, role: string, skipPermissions: boolean, hookSettingsPath = "", mcpConfigPath = "", headless = false): string {
  const flag = skipPermissions ? skipPermissionFlag(agentCmd) : "";
  const promptFlag = PROMPT_FLAGS[agentBin(agentCmd)];
  const hooks = hookSettingsFlag(agentCmd, hookSettingsPath);
  const mcp = mcpConfigFlag(agentCmd, mcpConfigPath);
  // HEADLESS: no prompt on the command line at all. Verified on claude 2.1.218 —
  // in stream-json input mode a positional prompt is ignored and the process
  // sits on stdin without ever starting a turn, so a pane launched that way
  // would look alive and be permanently unbriefed. The brief goes in as the
  // first stream message instead (swarmPanes parks it in `pendingPrompt`).
  const stream = headless ? headlessFlags(agentCmd) : "";
  if (stream) return `${agentCmd}${flag ? ` ${flag}` : ""}${hooks ? ` ${hooks}` : ""}${mcp ? ` ${mcp}` : ""} ${stream}`;
  // The prompt must agree with the flags: MCP wording only when the flag that
  // makes those tools exist is actually on this command line.
  const prompt = bootPrompt(project, brainUrl, role, !!mcp);
  // `--mcp-config` is VARIADIC in claude (2.1.218): it keeps eating following
  // args, so a POSITIONAL prompt is read as a second config path and the pane
  // dies at launch ("MCP config file not found: You are agent ..."). `--` ends
  // the option list. Only needed when the prompt is positional and the variadic
  // flag is on the line — `--settings` takes exactly one value, so a pane with
  // hooks alone keeps its command line byte-for-byte.
  const endOpts = mcp && !promptFlag ? " --" : "";
  return `${agentCmd}${flag ? ` ${flag}` : ""}${hooks ? ` ${hooks}` : ""}${mcp ? ` ${mcp}` : ""}${promptFlag ? ` ${promptFlag}` : ""}${endOpts} '${prompt}'`;
}

/** `--settings <path>` for a hook-capable CLI, or "" for everything else.
 *  The hook config is a PixelMarch-owned file in the app's data/ folder (written by the
 *  Rust side, path from the `hook_settings_path` command), never a file in the
 *  user's repo: nothing to merge, no marker line inside JSON, no way for two
 *  swarms sharing a directory to clobber each other, and the brain token stays
 *  out of anything committable. An empty path — this host cannot install hooks,
 *  or the command is missing — appends NOTHING, i.e. today's exact command line.
 *  The path is single-quoted because it can contain spaces (Windows AppData);
 *  a path containing a quote is refused rather than allowed to split the command. */
export function hookSettingsFlag(agentCmd: string, hookSettingsPath: string): string {
  if (!hookSettingsPath || !hasHooks(agentCmd)) return "";
  if (/['"]/.test(hookSettingsPath)) return ""; // unquotable — fall back to no hooks
  return `--settings '${hookSettingsPath}'`;
}

/** `--mcp-config <path>` for an MCP-capable CLI, or "" for everything else.
 *  The config is a PixelMarch-owned file in the app's data/ folder (written by the Rust
 *  side, path from the `mcp_config_path` command) — never `.mcp.json` in the
 *  user's repo, which is JSON (no marker line can live in it) and tracked in git
 *  (no credential may land in it). An empty path appends NOTHING, i.e. today's
 *  exact command line, and the pane keeps the curl brief.
 *  `--strict-mcp-config` is deliberately NOT added: it would switch OFF every MCP
 *  server the user configured for their own repo (this one ships a playwright
 *  entry), which breaks their tooling to gain us nothing — our server is loaded
 *  either way. Same quoting rule as the hook flag: single-quoted for spaces, and
 *  a path containing a quote is refused rather than allowed to split the line. */
export function mcpConfigFlag(agentCmd: string, mcpConfigPath: string): string {
  if (!speaksMcp(agentCmd, mcpConfigPath)) return ""; // includes the unquotable-path refusal
  return `--mcp-config '${mcpConfigPath}'`;
}

/** One pane per role, all sharing cwd.
 *  With lazyWorkers on, only the coordinator boots its CLI: every other role's
 *  boot command is parked in `pendingCommand` and the host types it in the first
 *  time that role has work. Otherwise all four agents start (and bill) at once
 *  just to read a brief that tells them to sit still. */
export function swarmPanes(project: string, brainUrl: string, cfg: SwarmConfig, hookSettingsPath = "", mcpConfigPath = "", identity?: RoleIdentityFn): Pane[] {
  const lazy = cfg.lazyWorkers && cfg.hostDispatch;
  const cmds = migrateAgentCmds(cfg.agentCmds, cfg.builders, reviewerCount(cfg));
  const urlFor = (name: string) => identity?.(name)?.url || brainUrl;
  const mcpPathFor = (name: string) => identity?.(name)?.mcpPath ?? mcpConfigPath;
  return swarmRoles(project, brainUrl, cfg, mcpConfigPath, identity).map((r) => {
    const cmd = cmdForRole(cmds, r.name);
    const roleUrl = urlFor(r.name);
    const roleMcp = mcpPathFor(r.name);
    const headless = !!cfg.headless && canRunHeadless(cmd);
    const boot = bootCommand(cmd, project, roleUrl, r.name, cfg.skipPermissions, hookSettingsPath, roleMcp, headless);
    // Lazy start exists to stop an idle CLI from billing for a turn it did not
    // need. A headless CLI idles for FREE — it blocks reading stdin and spends
    // nothing until a message arrives — so deferring it buys nothing and costs a
    // lot: `pendingCommand` is typed into a bare shell, and a piped pane's
    // "shell" would then own the CLI's stdin instead of us.
    const deferred = lazy && r.name !== "coordinator" && !headless;
    return newPane({
      title: r.name,
      role: r.name, // typed identity — the title is only what the tab shows

      cwd: cfg.cwd || undefined,
      startupCommand: deferred ? undefined : boot,
      pendingCommand: deferred ? boot : undefined,
      // The role's AGENT-token URL, baked into the pane's environment. The host's
      // pane_env honours a caller-set BIGBRAIN_URL over the session one (host.rs),
      // so every hook POST and every curl brief this pane runs authenticates AS
      // ITS ROLE — which is what makes the brain's task-lifecycle guard able to
      // tell one pane from another. With no identity resolver this is the session
      // URL, i.e. exactly today's behaviour.
      env: identity ? { BIGBRAIN_URL: roleUrl } : undefined,
      // The brief a headless pane cannot take on its command line. Parked, not
      // sent: under host dispatch the dispatcher already delivers a parked
      // prompt when the role has work (and only then); without dispatch the
      // reset watcher delivers it as soon as the CLI reports itself ready.
      pendingPrompt: headless ? bootPrompt(project, roleUrl, r.name, !!mcpConfigFlag(cmd, roleMcp)) : undefined,
      color: r.color,
      restartPolicy: "never",
    });
  });
}

/** Balanced grid: split the pane list in half recursively, alternating direction. */
export function gridRoot(panes: Pane[]): LayoutNode {
  const build = (list: Pane[], horizontal: boolean): LayoutNode => {
    if (list.length === 1) return newGroup(list[0]);
    const mid = Math.ceil(list.length / 2);
    return {
      type: "split",
      id: uid(),
      direction: horizontal ? "horizontal" : "vertical",
      ratio: mid / list.length,
      a: build(list.slice(0, mid), !horizontal),
      b: build(list.slice(mid), !horizontal),
    };
  };
  return build(panes, true);
}

/** First tab group in the tree — the coordinator's, given spawn order. */
export function firstGroup(root: LayoutNode): TabGroup {
  return root.type === "tabs" ? root : firstGroup(root.a);
}
