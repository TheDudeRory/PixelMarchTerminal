// Swarm health strip (brain-findings 1.3) — a read-only status bar for the
// active swarm workspace. One chip per agent pane showing its live state
// {booting|idle|working|stalled}, the task it currently owns, and how long since
// its terminal last produced output. Brain state comes off the app's shared swarm
// feed (subscribeBrainFeed in lib/ipc — the webview is cross-origin to the brain's
// :8734, so no direct fetch), never a timer of this component's own:
//   feed.tasks                     — the task bus (owner/status per task)
//   feed.notes['status-<role>']    — each agent's heartbeat note
//   terminalPool.lastOutputAt(paneId) — Date.now() of last PTY output
// Read-only over swarm state — the one exception is the "concurrent" chip in the
// cooldown row, which flips this workspace's own swarmConcurrent flag (see there).
//
// Second row: the COOLDOWNS. Every swarm watcher paces itself on a timer that
// used to be invisible (nudge cooldown, re-wake gap, runaway window, restart
// budget, the concurrency cap), so a quiet swarm was indistinguishable from a
// wedged one. The watchers mirror their state into stores/swarmTelemetry and
// this strip counts it down — one 1s `now` ticker for the whole component (the
// same `now` the chips already use), never one timer per chip.
import { useEffect, useState, type CSSProperties } from "react";
import { subscribeBrainFeed, type SwarmTask } from "../lib/ipc";
import { collectPanes, isTerminal } from "../lib/layout-tree";
import { lastOutputAt } from "../lib/terminalPool";
import { NUDGE_COOLDOWN_MS, NUDGE_MAX, RUNAWAY_MS, RUNAWAY_RESTART_MAX, SWARM_TIMERS, isRolePane, paneRole } from "../lib/swarm";
import { subscribeAgentEvents } from "../lib/agentEvents";
import { hookTurn } from "../lib/swarmDispatch";
import { useLayout, activeWorkspace } from "../stores/layout";
import { EMPTY_TELEMETRY, gaveUp, nextWakeAt, paneKey, useSwarmTelemetry, wakeMisses, type PaneTelemetry } from "../stores/swarmTelemetry";

// A finished task nobody is reviewing. Amber, not red: unlike NEEDS A HUMAN this
// is not terminal — the dispatcher keeps re-waking the reviewer — but it is the
// one thing a human otherwise learned only when the coordinator spent a turn
// narrating it (brain-findings 1.1). One cell per task, no history: a status
// strip says what is true now.
const stuckRow: CSSProperties = {
  display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap",
  padding: "3px 8px", background: "rgba(224, 168, 108, 0.12)",
  borderBottom: "1px solid var(--border)",
  fontSize: 10, color: "#e0a86c", fontWeight: 600,
};

// Output-age thresholds. < WORKING = actively emitting; a pane holding a claimed
// task but silent past STALL is wedged, not merely idle.
// Exported (with HEALTH_COLOR/ageLabel/healthOf below) because SwarmSummaryGrid
// is this strip expanded into cards — one health rule for both surfaces, so a
// chip and its card can never disagree about whether an agent is stalled.
export const WORKING_MS = 4000;
export const STALL_MS = 60_000;

export type Health = "booting" | "idle" | "working" | "stalled" | "wedged";

export const HEALTH_COLOR: Record<Health, string> = {
  booting: "#9aa0a6", // gray   — CLI still starting, no output yet
  idle: "#4c8bf5",    // blue   — quiet, nothing claimed
  working: "#5fbf6a", // green  — recent output
  stalled: "#e06c6c", // red    — owns a task but gone silent
  wedged: "#ff8a3d",  // orange — recovery budget spent, only a human can move it
};

// An agent's active task = one it owns that isn't finished. claimed/changes mean
// it should be working it now; done/approved are handed off to the merge gate.
const ACTIVE_STATUS = new Set(["claimed", "changes", "open", "blocked"]);

export function ageLabel(ms: number): string {
  if (ms < 1000) return "0s";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h`;
}

/** `turn` is the agent's OWN answer to "am I mid-turn?" (hook lifecycle events,
 *  bounded by swarmDispatch.hookTurn), or undefined for a CLI with no hooks.
 *  Without it this function had only PTY silence to go on, and a thinking agent
 *  paints nothing: an extended-thinking builder read "idle" after 4 s and
 *  "stalled" after 60 s while it was working the whole time. A hook-reported
 *  live turn therefore outranks the age thresholds. The false/undefined paths
 *  are unchanged, so a non-hook CLI keeps exactly the old behaviour. */
export function healthOf(paneId: string, hasActiveTask: boolean, now: number, wedged: boolean, turn?: boolean): { state: Health; age: number } {
  const last = lastOutputAt(paneId);
  // "wedged" outranks everything: both recovery watchers have spent their budget
  // on this pane and will never touch it again (brain-findings 1.15). It reads
  // as plain "idle" otherwise, which is exactly how a dead pane went unnoticed.
  if (wedged) return { state: "wedged", age: last ? now - last : 0 };
  if (turn === true) return { state: "working", age: last ? now - last : 0 };
  if (!last) return { state: "booting", age: 0 };
  const age = now - last;
  if (age < WORKING_MS) return { state: "working", age };
  if (hasActiveTask && age >= STALL_MS) return { state: "stalled", age };
  return { state: "idle", age };
}

/** Countdown to an absolute deadline. Past deadlines read "due" — the watcher
 *  fires on its own poll tick, so "0s" would look stuck. */
function inLabel(at: number, now: number): string {
  const ms = at - now;
  if (ms <= 0) return "due";
  return ageLabel(ms);
}

/** The cooldowns for one pane, as short "name value" cells. Empty = the pane has
 *  no pacing state at all (nothing has happened to it yet), so it renders nothing. */
function cooldownCells(t: PaneTelemetry, now: number): { text: string; title: string; warn?: boolean }[] {
  const cells: { text: string; title: string; warn?: boolean }[] = [];
  const wake = nextWakeAt(t);
  if (wake !== null) {
    const misses = wakeMisses(t);
    cells.push({
      text: `wake ${inLabel(wake, now)}${misses ? ` ×${misses}` : ""}`,
      title: `next host re-wake ${inLabel(wake, now)}` + (misses ? `\n${misses} wake(s) never landed (typed into a busy TUI)` : ""),
      warn: misses > 0,
    });
  }
  if (t.nudge) {
    const until = t.nudge.at + NUDGE_COOLDOWN_MS;
    const spent = t.nudge.count >= NUDGE_MAX;
    cells.push({
      text: `nudge ${t.nudge.count}/${NUDGE_MAX}${spent ? "" : ` ${inLabel(until, now)}`}`,
      title: spent
        ? `API-error episode: ${NUDGE_MAX} nudges used — the watcher gave up, a human has to look`
        : `API-error episode: ${t.nudge.count} nudge(s) sent, next allowed ${inLabel(until, now)}`,
      warn: spent,
    });
  }
  // Compaction: no countdown to show, because none is accruing — but a pane that
  // sits frozen for minutes with nothing in the strip is exactly what makes a
  // human (and, before this, the watchdog) call it stuck.
  if (t.runaway.compacting) {
    cells.push({ text: "compacting", title: "the CLI is summarising its own context (PreCompact) — no wake is typed and the runaway clock is paused until it comes back" });
  }
  if (t.runaway.since !== null) {
    const at = t.runaway.since + RUNAWAY_MS;
    cells.push({ text: `runaway ${inLabel(at, now)}`, title: `busy with a frozen tail since ${ageLabel(now - t.runaway.since)} ago — aborted + re-briefed ${inLabel(at, now)}` });
  }
  if (t.runaway.restarts) {
    const spent = t.runaway.restarts >= RUNAWAY_RESTART_MAX;
    cells.push({
      text: `restarts ${t.runaway.restarts}/${RUNAWAY_RESTART_MAX}`,
      title: spent ? "restart budget spent — the watchdog will not touch this pane again" : "runaway restarts used",
      warn: spent,
    });
  }
  if (t.resetPending) cells.push({ text: "reset…", title: "context wipe in flight (swarmReset): waiting for the pane to go quiet, then /clear + re-brief" });
  return cells;
}

const strip: CSSProperties = {
  display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap",
  padding: "4px 8px", background: "var(--panel)",
  borderBottom: "1px solid var(--border)",
};

const cooldownRow: CSSProperties = {
  display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap",
  padding: "3px 8px", background: "var(--panel-2)",
  borderBottom: "1px solid var(--border)",
  fontSize: 10, color: "var(--muted)",
};

// The terminal give-up state gets its own loud row: a spent nudge/restart budget
// means no watcher will touch that pane again, so it must not read as "quiet".
const wedgedRow: CSSProperties = {
  display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap",
  padding: "3px 8px", background: "rgba(255, 138, 61, 0.14)",
  borderBottom: "1px solid #ff8a3d",
  fontSize: 10, color: "#ff8a3d", fontWeight: 600,
};

// A dirty ROOT checkout: an agent editing outside its worktree. Loud, because it
// is not cosmetic — the host refuses to merge over a dirty root, so from the
// moment this appears NOTHING lands, and the only previous signal was one chat
// line into a coordinator pane (it hid there for a whole mission once).
const strayRow: CSSProperties = {
  display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap",
  padding: "3px 8px", background: "rgba(255, 138, 61, 0.10)",
  borderBottom: "1px solid #ff8a3d",
  fontSize: 10, color: "#ff8a3d", fontWeight: 600,
};

// The root branch moved and the host did not do it: unreviewed work is on master
// and the repo looks fine from every other angle. The loudest row on the strip,
// because it is the only place this is visible at all — the last one was found
// by a human reading a reflog the next morning.
const breachRow: CSSProperties = {
  display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap",
  padding: "3px 8px", background: "rgba(255, 77, 77, 0.16)",
  borderBottom: "1px solid #ff4d4d",
  fontSize: 10, color: "#ff4d4d", fontWeight: 700,
};

const cell: CSSProperties = { padding: "1px 5px", border: "1px solid var(--border)", borderRadius: 4, whiteSpace: "nowrap" };

// The one control on this strip. Same shape as `cell` so the row still reads as
// status, plus the affordances a chip that DOES something needs.
const toggleCell: CSSProperties = {
  ...cell, cursor: "pointer", background: "transparent", font: "inherit", lineHeight: "inherit",
};

export default function SwarmHealthStrip() {
  const workspaces = useLayout((s) => s.workspaces);
  const activeId = useLayout((s) => s.activeId);
  const root = useLayout((s) => activeWorkspace(s).root);
  const ws = workspaces.find((w) => w.id === activeId);
  const project = ws?.swarm;

  const [tasks, setTasks] = useState<SwarmTask[]>([]);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [now, setNow] = useState(() => Date.now());
  const [showTimers, setShowTimers] = useState(false);
  const telemetry = useSwarmTelemetry((s) => s.panes);
  const budget = useSwarmTelemetry((s) => (project ? s.budgets[project] : undefined));
  const setSwarmConcurrent = useLayout((s) => s.setSwarmConcurrent);
  const concurrent = !!ws?.swarmConcurrent;
  // Reported by the dispatcher, which is the only thing that knows WHICH reviewer
  // owns a done task (its sticky fan-out) and that the wake already went out.
  const stuck = useSwarmTelemetry((s) => s.stuck[activeId]) ?? [];
  // Reported by the dispatcher's stray-edit tripwire (swarm_repo_dirty).
  const stray = useSwarmTelemetry((s) => s.stray[activeId]);
  // The root branch moved with no host merge behind it (watchHead). Sticky:
  // the commit is in history, so only a human closes this one out.
  const breach = useSwarmTelemetry((s) => s.breach[activeId]);

  // Agent panes of the active swarm workspace, by TYPED role — a role pane the
  // human renamed used to vanish from the strip entirely (brain-findings 1.4).
  const rolePanes = project ? collectPanes(root).filter(isTerminal).filter(isRolePane) : [];
  const roleKey = rolePanes.map(paneRole).sort().join(",");

  // Task bus + per-role heartbeat notes, off the shared feed (lib/ipc) — this used
  // to be its own 1.5 s timer firing 1 + N sync IPC calls (one per role) at every
  // other surface's cadence. Two things the strip shows are NOT on that path and
  // must not be paced by it: the output age of each pane (terminalPool, in this
  // process) and the cooldown countdowns (the telemetry store). They are driven by
  // `now` below, which ticks once a second and costs nothing — so the chips
  // actually update MORE smoothly than the 1.5 s fetch did.
  // The heartbeat notes themselves are `watch` keys: rewritten under the same key,
  // so the feed refreshes them on its slower body gap. They render only inside a
  // chip's tooltip; the chip's state, task and age never came from them.
  useEffect(() => {
    if (!project || rolePanes.length === 0) return;
    const roles = roleKey.split(",");
    return subscribeBrainFeed(
      project,
      { intervalMs: 2000, hiddenMs: 15_000, watch: roles.map((r) => `status-${r}`) },
      (feed) => {
        setTasks(feed.tasks);
        const map: Record<string, string> = {};
        for (const r of roles) {
          const v = feed.notes[`status-${r}`]?.value;
          if (v) map[r] = v;
        }
        setNotes(map);
      },
    );
  }, [project, roleKey]);

  // Real turn boundaries. Ref-counted with swarmDispatch's own subscription, so
  // this costs a second poller only when host dispatch is off — and without it
  // the chips would fall back to PTY silence and call a thinking agent idle.
  useEffect(() => {
    if (!project) return;
    return subscribeAgentEvents(project);
  }, [project]);

  // Output ages and cooldown countdowns are local state; nothing here touches the
  // brain, so it can tick faster than any poll.
  useEffect(() => {
    const t = setInterval(() => { if (document.visibilityState !== "hidden") setNow(Date.now()); }, 1000);
    return () => clearInterval(t);
  }, []);

  if (!project || rolePanes.length === 0) return null;

  const activeByRole = new Map<string, SwarmTask>();
  for (const t of tasks) {
    if (t.owner && ACTIVE_STATUS.has(t.status) && !activeByRole.has(t.owner)) activeByRole.set(t.owner, t);
  }

  // Telemetry is keyed by WORKSPACE id, not by swarm project: two workspaces on
  // one swarm used to read (and clobber) each other's cooldowns (findings 1.5).
  const teleOf = (role: string): PaneTelemetry => telemetry[paneKey(activeId, role)] ?? EMPTY_TELEMETRY;

  const cooldowns = rolePanes
    .map((p) => ({ role: paneRole(p), cells: cooldownCells(teleOf(paneRole(p)), now) }))
    .filter((r) => r.cells.length > 0);

  // Panes both recovery watchers have given up on. Nothing else will move them,
  // so they get a banner of their own rather than one grey cell in row two.
  const wedged = rolePanes
    .map((p) => ({ role: paneRole(p), why: gaveUp(teleOf(paneRole(p))) }))
    .filter((r): r is { role: string; why: string } => !!r.why);
  const wedgedRoles = new Set(wedged.map((w) => w.role));

  return (
    <>
    <div style={strip}>
      <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.8, color: "var(--muted)", marginRight: 2 }}>
        SWARM
      </span>
      {rolePanes.map((p) => {
        const role = paneRole(p);
        const active = activeByRole.get(role);
        const { state, age } = healthOf(p.id, !!active, now, wedgedRoles.has(role), hookTurn(project, p));
        const color = HEALTH_COLOR[state];
        const note = notes[role];
        const title = [
          `${role}: ${state}`,
          state === "wedged" ? wedged.find((w) => w.role === role)!.why : "",
          active ? `task ${active.key} (${active.status})` : "no active task",
          `last output ${ageLabel(age)} ago`,
          note ? `heartbeat: ${note.split("\n")[0]}` : "",
        ].filter(Boolean).join("\n");
        return (
          <div key={p.id} title={title} style={{
            display: "flex", alignItems: "center", gap: 5,
            border: "1px solid var(--border)", borderRadius: 6, padding: "2px 7px",
          }}>
            <span style={{ width: 7, height: 7, borderRadius: "50%", background: color, flex: "0 0 auto" }} />
            <span style={{ fontSize: 11, fontWeight: 600, color: "var(--text)" }}>{role}</span>
            <span style={{ fontSize: 10, fontWeight: 700, color, textTransform: "uppercase", letterSpacing: 0.4 }}>{state}</span>
            {active && <span style={{ fontSize: 10, color: "var(--muted)" }}>{active.key}</span>}
            <span style={{ fontSize: 10, color: "var(--muted)" }}>{ageLabel(age)}</span>
          </div>
        );
      })}
    </div>
    {wedged.length > 0 && (
      <div style={wedgedRow}>
        <span style={{ fontWeight: 700, letterSpacing: 0.8 }}>NEEDS A HUMAN</span>
        {wedged.map((w) => (
          <span key={w.role} style={{ ...cell, borderColor: "#ff8a3d" }} title={w.why}>
            <b>{w.role}</b> — {w.why}
          </span>
        ))}
      </div>
    )}
    {breach && (
      <div style={breachRow}>
        <span style={{ fontWeight: 700, letterSpacing: 0.8 }}>GUARD BREACH</span>
        <span
          style={{ ...cell, borderColor: "#ff4d4d" }}
          title={`${breach.branch || "the root branch"} moved to ${breach.sha} — "${breach.subject}" — and PixelMarch did not merge it.\n\nSomething committed, merged or reset past the repo guard, so work no reviewer gated is now on the root branch and no task on the bus records it.\nThe guard runs as your user, so it can always be sidestepped; this row is how you find out that it was.\nInspect it: git show ${breach.sha.slice(0, 12)}`}
        >
          {breach.branch || "root branch"} moved to {breach.sha.slice(0, 8)} {ageLabel(now - breach.at)} ago — no host merge: “{breach.subject}”
        </span>
        <span style={{ ...cell, borderColor: "#ff4d4d" }}>unreviewed work is on the root branch</span>
      </div>
    )}
    {stray && (
      <div style={strayRow}>
        <span style={{ fontWeight: 700, letterSpacing: 0.8 }}>STRAY EDITS</span>
        <span
          style={{ ...cell, borderColor: "#ff8a3d" }}
          title={`Uncommitted tracked changes in the repo ROOT, not in any .swarm/ worktree:\n${stray.files.join("\n")}\n\nEvery host merge is REFUSED while this is here, so no approved task can land.\nThe guard blocks the commit; where these files belong is a human's call.`}
        >
          repo root dirty {ageLabel(now - stray.since)} — {stray.files.length} file{stray.files.length === 1 ? "" : "s"}: {stray.files.slice(0, 3).join(", ")}
          {stray.files.length > 3 ? ` +${stray.files.length - 3}` : ""}
        </span>
        <span style={{ ...cell, borderColor: "#ff8a3d" }}>merges are blocked until it is clean</span>
      </div>
    )}
    {stuck.length > 0 && (
      <div style={stuckRow}>
        <span style={{ fontWeight: 700, letterSpacing: 0.8 }}>NO REVIEW</span>
        {stuck.map((s) => (
          <span
            key={s.task}
            style={{ ...cell, borderColor: "#e0a86c" }}
            title={`${s.task} has been done for ${ageLabel(now - s.since)} and ${s.role} has not verdicted it.\nThe host is re-waking that reviewer; if this does not clear, look at its pane.`}
          >
            <b>{s.role}</b> idle {ageLabel(now - s.since)} on {s.task}
          </span>
        ))}
      </div>
    )}
    <div style={cooldownRow}>
      <span style={{ fontWeight: 700, letterSpacing: 0.8 }}>COOLDOWNS</span>
      {budget && budget.cap > 0 && (
        <span
          style={{ ...cell, color: budget.inFlight >= budget.cap ? "#e0a86c" : "var(--muted)" }}
          title={`concurrent LLM turns: ${budget.inFlight} of ${budget.cap} allowed (one per builder — a single local endpoint serves one completion at a time)`
            + (budget.busy.length ? `\nholding a turn: ${budget.busy.join(", ")}` : "")}
        >
          turns {budget.inFlight}/{budget.cap}
        </span>
      )}
      {/* The turn cap is APP-GLOBAL and sized off the LARGEST swarm, not the sum:
          two swarms of two builders share two slots, so a busy swarm can hold
          every slot and the other one gets no turn at all — not even the one it
          needs to deliver a re-briefed pane's parked prompt. "Run concurrent"
          exempts THIS workspace's panes from the cap; it was settable only in the
          launch dialog, which meant the fix for a starved live swarm was to
          recreate it. swarmDispatch re-registers the flag every tick, so the
          flip lands on the next 5 s poll. */}
      <button
        type="button"
        onClick={() => setSwarmConcurrent(activeId, !concurrent)}
        style={{
          ...toggleCell,
          color: concurrent ? "#5fbf6a" : "var(--muted)",
          borderColor: concurrent ? "#5fbf6a" : "var(--border)",
          fontWeight: concurrent ? 600 : 400,
        }}
        title={concurrent
          ? "Run concurrent is ON for this swarm: its roles bypass the app-global turn cap and can all be mid-turn at once.\nTheir turns are still counted, so other swarms see the load.\nClick to put this swarm back under the cap."
          : `Run concurrent is OFF: this swarm's panes queue for the ${budget?.cap ?? 1} app-global turn slot(s), shared with every OTHER swarm workspace.\nClick to exempt this swarm from the cap — every role may hold a turn at once.\nOnly safe when your endpoint serves parallel completions.`}
      >
        concurrent {concurrent ? "on" : "off"}
      </button>
      {budget && budget.starved.length > 0 && (
        <span
          style={{ ...cell, color: "#e06c6c", borderColor: "#e06c6c", fontWeight: 600 }}
          title={"refused a turn slot for 30s+ — the app-global cap is fully held, so this pane cannot launch or wake."
            + "\nCheck what is holding the turns (the cell to the left), including OTHER swarm workspaces: a wedged pane there starves this one."
            + "\n" + budget.starved.map((s) => `${s.title}: starved ${ageLabel(now - s.since)}`).join("\n")}
        >
          starved {budget.starved.map((s) => `${s.title} ${ageLabel(now - s.since)}`).join(", ")}
        </span>
      )}
      {cooldowns.length === 0 && <span style={{ opacity: 0.7 }}>none pending</span>}
      {cooldowns.map((r) => (
        <span key={r.role} style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <span style={{ color: "var(--text)", fontWeight: 600 }}>{r.role}</span>
          {r.cells.map((c) => (
            <span key={c.text} style={{ ...cell, color: c.warn ? "#e06c6c" : "var(--muted)" }} title={c.title}>{c.text}</span>
          ))}
        </span>
      ))}
      <button
        onClick={() => setShowTimers((v) => !v)}
        style={{ marginLeft: "auto", background: "none", border: "1px solid var(--border)", borderRadius: 4, color: "var(--muted)", fontSize: 10, padding: "1px 6px", cursor: "pointer" }}
        title="the fixed timers every swarm watcher runs on"
      >
        timers {showTimers ? "▴" : "▾"}
      </button>
    </div>
    {showTimers && (
      <div style={{ ...cooldownRow, gap: 8 }}>
        {SWARM_TIMERS.map((t) => (
          <span key={t.label} style={cell} title={t.what}>
            {t.label} <span style={{ color: "var(--text)" }}>{t.value}</span>
          </span>
        ))}
      </div>
    )}
    </>
  );
}
