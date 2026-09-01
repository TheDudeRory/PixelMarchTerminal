// Shared swarm launch — everything between "the human pressed Launch" and "the
// grid workspace exists": repo prep, the brain notes (mission, role-*, the
// protocol-* sections, on-complete), agent registration, the repo guard, and
// the workspace that spawns the panes. SwarmDialog's launch() is a thin
// wrapper over this (validation, the untracked-files acknowledge, closing the
// dialog), and the headless CLI (task-5) will call it with the same
// SwarmConfig — one launch path, two fronts. The notes written here ARE the
// swarm: the panes and the dispatcher only ever read them back.
import { invoke } from "@tauri-apps/api/core";
import { brainFeedNow, brainSave, brainUrl, detachQuit, ensureGitRepo, onPtyExit, quitApp, subscribeBrainFeed, swarmGuardInstall, swarmGuardProbe, swarmMcpConfig, swarmReclaim, swarmRegisterAgents, swarmUntracked, swarmWorktreeSweep } from "./ipc";
import { DEFAULT_SWARM, gridRoot, missionDone, parentProject, protocolNotes, reviewerCount, swarmLiveInRepo, swarmPanes, swarmProject, swarmRoles, swarmsInRepo, type RoleIdentityFn, type SwarmConfig } from "./swarm";
import { useLayout } from "../stores/layout";

/** The pre-launch warning for untracked files in the repo ROOT.
 *
 *  Builders never see them: `git worktree add` checks out the last COMMIT, so a
 *  file that only exists in the root's working tree is missing from every task
 *  tree. What follows is worse than a missing file — the builder writes its own
 *  version, commits it, and the reviewer reports the files as brand new and
 *  absent from the base commit, because from the branch's side they are.
 *
 *  Naming the files matters more than the count: "3 untracked files" is a
 *  sentence someone dismisses, `src/admin/Users.tsx` is one they recognise. */
export function untrackedWarning(files: string[]): string {
  const one = files.length === 1;
  const shown = files.slice(0, 6).join(", ");
  const rest = files.length > 6 ? `, +${files.length - 6} more` : "";
  return `${files.length} untracked file${one ? "" : "s"} in the repo root (${shown}${rest}) — builders work in worktrees checked out from the last COMMIT, so they will not see ${one ? "it" : "them"} and may write ${one ? "it" : "them"} again from scratch. Commit or stash first, or press Launch again to go ahead anyway.`;
}

/** The stable identity of an untracked-file set — sorted, pipe-joined — so the
 *  SAME string sits on both sides of the acknowledge: the launch throws
 *  UntrackedFilesError while it differs from the caller's ack, the caller
 *  records it, and the re-press ("Launch anyway") carries it back. Commit one
 *  of the files and the signature changes, so the warning comes back for what
 *  is still untracked — the case a one-shot "already warned" flag gets wrong. */
export const untrackedSignature = (files: string[]): string => files.slice().sort().join("|");

/** The launch stopped on untracked root files the caller has not acked. The
 *  message IS the warning (untrackedWarning), so a caller that just surfaces
 *  it can use e.message. The dialog records the signature and shows the line
 *  (the re-press with "Launch anyway" acks it); the headless path can fail
 *  loud instead. */
export class UntrackedFilesError extends Error {
  readonly files: string[];
  constructor(files: string[]) {
    super(untrackedWarning(files));
    this.name = "UntrackedFilesError";
    this.files = files;
  }
}

/** Absolute path of the PixelMarch-owned hook settings file, for the `--settings`
 *  flag swarmPanes() appends to hook-capable CLIs. The Rust command writes (or
 *  refreshes) the file against the RUNNING brain and hands back its path, so it
 *  must be asked at launch time, not cached across restarts: the brain's port and
 *  token change every start and a stale file would point every hook at a dead
 *  address.
 *
 *  Every failure is "" and "" appends nothing, i.e. today's exact command line —
 *  a host with no brain, an older binary without the command, a settings file
 *  that would not write. Launching a swarm without hooks costs the quiet-timer
 *  fallback; failing the launch over it costs the swarm. */
export async function hookSettingsPath(): Promise<string> {
  try {
    const p = await invoke("hook_settings_path");
    return typeof p === "string" ? p : "";
  } catch {
    return "";
  }
}

/** Absolute path of the PixelMarch-owned MCP config file, for the `--mcp-config`
 *  flag swarmPanes() appends to MCP-capable CLIs — and, just as load-bearing, for
 *  the BRIEFS: swarmRoles() only writes tool-call wording when this path exists,
 *  because a brief that names tools the pane was never given is an agent whose
 *  first action fails on an empty context.
 *
 *  Same failure rule as the hook path: every failure is "" and "" appends nothing
 *  and keeps the curl briefs, i.e. today's exact behaviour. */
export async function mcpConfigPath(): Promise<string> {
  try {
    const p = await invoke("mcp_config_path");
    return typeof p === "string" ? p : "";
  } catch {
    return "";
  }
}

/** What the caller has already acknowledged, if anything. */
export interface LaunchSwarmOpts {
  /** Signature of the untracked root files the human has already been shown
   *  and chosen to launch over (see untrackedSignature). Absent or different
   *  from the current set = the launch stops with UntrackedFilesError instead
   *  of starting. */
  ackUntracked?: string;
}

/** Launch a swarm from a config: prepare the repo, write every brain note,
 *  register the per-role agents, arm the guard, and open the grid workspace +
 *  summary. Throws UntrackedFilesError when untracked root files still need an
 *  acknowledge, a plain Error for the hard failures (no mission/cwd, no brain),
 *  and lets a thrown error mean "the launch did not happen" — nothing is
 *  rolled back, so a caller must not assume half a launch on failure (the brain
 *  project is fresh per launch, and the sweep is the only step that touches
 *  anything pre-existing, and it runs before any note is written).
 *  Resolves to the swarm project name the notes were written to — the headless
 *  self-run watches THAT project for completion. */
export async function launchSwarm(cfg: SwarmConfig, opts: LaunchSwarmOpts = {}): Promise<string> {
  if (!cfg.mission.trim() || !cfg.cwd.trim()) {
    throw new Error("Mission and working directory are required.");
  }
  const url = await brainUrl();
  if (!url) throw new Error("BigBrain is not running (no free port) — the swarm has no coordination bus.");
  const repo = cfg.cwd.trim();
  // Empty/fresh dir: init git + seed a commit so the worktree protocol works.
  const gitPrep = await ensureGitRepo(repo);
  // Untracked root files reach no builder: task worktrees are checked out
  // from a COMMIT (see untrackedWarning). Checked HERE — before the sweep,
  // the brain project and the guard — because this is the last point where
  // nothing has been written yet and "cancel, commit, relaunch" is free.
  // A warning, never a block: the caller may well know, and a launch this
  // function refuses is a launch someone does around it (the dialog turns the
  // throw into the "Launch anyway" button; a headless caller can fail loud).
  const untracked = await swarmUntracked(repo).catch(() => ({ ok: false, untracked: false, files: [] as string[] }));
  if (untracked.files.length && untrackedSignature(untracked.files) !== opts.ackUntracked) {
    throw new UntrackedFilesError(untracked.files);
  }
  // The LAST run's leftovers, cleared before this one starts. Task ids restart
  // at task-1 every launch (the brain project is fresh) while `.swarm/task-<n>`
  // and `swarm/task-<n>` are REPO-scoped, so a relaunch used to hand its first
  // builder the previous swarm's tree, branch and commits. Nothing is discarded
  // by the sweep: uncommitted work is committed first and an unmerged branch is
  // renamed aside. (The merge commit's subject carries the project id too, so
  // an old run's "merged" answer cannot be read as this run's — but that only
  // stops the release; this is what stops the inheritance.)
  //
  // Skipped ONLY when another swarm is genuinely working in this repo right
  // now — and that question is asked of the PROCESS TABLE, never of anything
  // this app persisted about itself.
  //
  // That distinction is the whole fix for "cancel a swarm, start another one
  // three seconds later". Every trace of a swarm survives a kill: the lock
  // file, both hook blocks, the worktrees, and the workspace itself, which is
  // persisted. The old check read that persisted workspace back and concluded
  // a swarm was still running here, so the sweep was skipped and the new run
  // started on the dead run's trees, branches and commits — silently, because
  // an inherited worktree looks exactly like a fresh one. A killed process is
  // a fact (the lock names its pid AND its start time); a workspace on disk is
  // not evidence that anything is running.
  const probe = await swarmGuardProbe(repo).catch(() => ({ ok: false }) as Awaited<ReturnType<typeof swarmGuardProbe>>);
  // The UI only gets a say when the lock's owner is THIS process, because
  // then the panes are the half Rust cannot see (a swarm the human deleted
  // the workspace of leaves the guard armed by a process that is still very
  // much alive). Another live PixelMarch on this repo is taken at its word.
  const liveHere = swarmLiveInRepo(probe, useLayout.getState().workspaces, repo);
  // Anything else is wreckage, and it is cleared before the sweep rather than
  // worked around: the guard a dead run left armed (which also blocks the
  // HUMAN's commits to master), an index.lock from a git child that was
  // killed mid-call (which fails every git command the sweep is about to
  // run), and a merge the kill interrupted. All no-ops on a healthy repo.
  const reclaimed = liveHere ? null : await swarmReclaim(repo).catch(() => null);
  // Workspaces whose swarm is provably over: the process that armed their
  // guard is gone. Naming them is as far as this goes — a workspace is the
  // human's, and closing one kills terminals — but they must be named,
  // because after an app restart their panes come back and start agents that
  // believe they are still in a swarm, on worktrees the sweep below is about
  // to take away.
  const dead = liveHere ? [] : swarmsInRepo(useLayout.getState().workspaces, repo);
  const sweep = liveHere ? null : await swarmWorktreeSweep(repo, false).catch(() => null);
  const swept = sweep?.ok ? (sweep.swept?.length ?? 0) : 0;
  const stuck = sweep?.ok ? (sweep.kept ?? []) : [];
  const project = swarmProject(cfg.mission, cfg.cwd);
  await brainSave(project, "mission", cfg.mission.trim());
  // Both PixelMarch-owned config files, asked ONCE per launch and threaded into
  // everything downstream. They must be resolved BEFORE the briefs are written:
  // the MCP path decides whether a role's brief is written in tool calls or in
  // curl, and the brief and the command line have to agree.
  const hooks = await hookSettingsPath();
  const mcp = await mcpConfigPath();
  // Per-role AGENT identity: mint one token per role and give each pane its
  // own token-carrying URL + MCP config. This is what makes every task-bus
  // write attributable — a builder cannot post `done` for another, approve
  // its own work, or merge (the brain refuses it, the pre-commit guard blocks
  // the commit). A launch that predates the running brain (no urls) falls back
  // to the session URL, i.e. the old, unenforced behaviour, rather than failing.
  const roleNames = swarmRoles(project, url, cfg, mcp).map((r) => r.name);
  const agentUrls = await swarmRegisterAgents(project, roleNames).catch(() => ({}) as Record<string, string>);
  const roleMcp: Record<string, string> = {};
  for (const name of roleNames) {
    const roleUrl = agentUrls[name];
    if (roleUrl && mcp) roleMcp[name] = await swarmMcpConfig(roleUrl, project, name).catch(() => "");
  }
  const identity: RoleIdentityFn | undefined = Object.keys(agentUrls).length
    ? (name) => (agentUrls[name] ? { url: agentUrls[name], mcpPath: roleMcp[name] ?? mcp } : undefined)
    : undefined;
  // Arm the repo guard: a lock + a pre-commit hook that blocks direct commits
  // to master/main while the swarm runs. Best-effort — a swarm on a repo where
  // we cannot write the hook still runs, just without the seatbelt.
  await swarmGuardInstall(repo).catch(() => {});
  for (const r of swarmRoles(project, url, cfg, mcp, identity)) await brainSave(project, `role-${r.name}`, r.brief);
  // The situational half of the protocol: stored once, fetched by an agent only when it
  // hits the case, so no brief pays for it on turn 0 (the briefs carry the pointers).
  // Any role kind selected = context resets are in play for this swarm (the
  // shared protocol-reset note is written once; the per-role briefs decide who
  // actually gets the handshake).
  const anyReset = (cfg.clearRoles?.length ?? 0) > 0;
  // Same SOLO fact the briefs carry: at one builder nothing ever races for a task, so the
  // shared task-bus note states the claim's real purpose (ownership) instead of collisions.
  for (const p of protocolNotes(project, url, parentProject(cfg.cwd), anyReset, cfg.hostDispatch, Math.max(1, cfg.builders) === 1))
    await brainSave(project, p.key, p.body);
  // The on-mission-complete hook: newline-separated shell commands the host
  // runs exactly ONCE, in the swarm's repo, when the mission hits 100% — the
  // dispatcher's missionDone branch reads it off the feed (a watched key),
  // never from any brief. Written unconditionally: an empty body means "no
  // hook", and a key that always exists is read the same way as every other
  // note.
  await brainSave(project, "on-complete", cfg.onComplete ?? "");
  const s = useLayout.getState();
  // swarmResets stays as the legacy master flag (derived); swarmClearRoles carries
  // the explicit per-kind selection the reset watcher honours; swarmConcurrent lifts
  // the turn cap. All three ride onto the persisted Workspace so the runtime watchers see them.
  // Phase A only fires if the panes are actually LAUNCHED with --settings, and
  // Phase B only if they are launched with --mcp-config: both files are written
  // by the calls above and read by the CLI at spawn.
  s.addWorkspaceWithRoot(project, gridRoot(swarmPanes(project, url, cfg, hooks, mcp, identity)), project, anyReset, cfg.hostDispatch, cfg.clearRoles, cfg.concurrent);
  // A launched swarm opens on the summary grid, not N live terminals: the
  // grid is what you actually watch a swarm with, and it costs one renderer
  // instead of one per agent. Done HERE rather than in the store because
  // swarmSummaryOpen is deliberately session-only and unpersisted (see
  // stores/layout.ts:200-203) — flipping the store default would make a
  // RESTART come up on cards, which reads as "my panes are gone". App.tsx
  // still ANDs the flag with "is this a swarm workspace", so a non-swarm
  // workspace is untouched, and both ways back (the ▣ bar toggle, the ▦
  // pane button) keep working.
  s.openSwarmSummary(true);
  // Worth its own line: these are repairs to the repo the human shares with
  // the swarm, and the guard one of them removes is what would otherwise have
  // gone on refusing their own commits to master.
  if (reclaimed?.cleared?.length) s.addToast(`Recovered from a killed swarm — ${reclaimed.cleared.join("; ")}`);
  if (dead.length)
    s.addToast(`${dead.join(", ")} ${dead.length === 1 ? "is" : "are"} still open but no longer running — close ${dead.length === 1 ? "that workspace" : "those workspaces"}, its agents are working on worktrees this launch just cleared.`);
  // Same count the dialog's swarmTeamSize() shows on its button — duplicated
  // here rather than imported because a lib module must not import a
  // component, and the two must never drift (a toast promising a pane count
  // the launch does not produce is exactly what swarmTeamSize's comment
  // forbids the dialog from doing).
  const teamSize = 1 + Math.max(1, cfg.builders) + (cfg.scout ? 1 : 0) + reviewerCount(cfg);
  s.addToast(`Swarm ${project} launched — ${teamSize} agents${gitPrep ? ` (${gitPrep})` : ""}`);
  // Worth its own line, because it changes what the human will find in `git
  // branch`: a launch DELETES the previous run's task branches, unmerged
  // commits and all. They are PixelMarch's own branches, nothing else is
  // touched, and the commits stay in the reflog — but nobody should learn
  // that from an empty `git branch` afterwards.
  if (swept) s.addToast(`Cleared the last run: ${swept} task worktree${swept === 1 ? "" : "s"} and ${swept === 1 ? "its branch" : "their branches"} deleted, unmerged work included.`);
  // A leftover the sweep could not delete is the one thing that still puts a
  // new run on old commits, so it stays loud.
  if (stuck.length)
    s.addToast(`Could not clear ${stuck.map((t) => t.task).join(", ")}: ${stuck[0].reason ?? "unknown"}. That task number will reuse the old tree.`);
  return project;
}

// ── Headless self-run — `pixelmarch --swarm <profile> <prompt>` ──────────────
//
// main.rs parses the flag and lib.rs resolves the profile (cwd + agent
// command) and runs the app with the main window hidden. This module is always
// imported (App -> SwarmDialog -> here), so at webview boot in a Tauri window
// it asks Rust for the pending request, launches through the SAME launchSwarm
// the dialog uses, and exits the process when the mission is done. The
// existing React hooks in App (useSwarmDispatch et al.) orchestrate the swarm;
// this only waits for completion and then exits. In a plain browser or vitest
// (no window.__TAURI_INTERNALS__) none of it runs.

/** The pending request for a `--swarm` self-run, as lib.rs resolved it. */
export interface HeadlessSwarmRequest {
  mission: string;
  cwd: string;
  /** Agent command for every role (the profile's startup command, else "claude"). */
  agent: string;
  /** True when this process spawned the PTY host — only then may the exit shut
   *  the host down; otherwise a live instance owns it and only the GUI goes. */
  ownsHost: boolean;
}

/** The SwarmConfig a headless self-run launches with: the dialog's default
 *  team (DEFAULT_SWARM), the prompt as the mission, the profile's cwd, and the
 *  profile's agent command for every role. Pure — the CLI-side tests pin it. */
export function headlessSwarmConfig(req: HeadlessSwarmRequest): SwarmConfig {
  return {
    ...DEFAULT_SWARM,
    mission: req.mission,
    cwd: req.cwd,
    agentCmds: {
      coordinator: req.agent,
      // cfg.builders = 2 panes, both running the profile's command.
      builders: [req.agent, req.agent],
      scout: req.agent,
      reviewer: req.agent,
      reviewers: [req.agent],
    },
  };
}

/** Wait for the layout store to hydrate so the launch's workspace is not
 *  clobbered by the restore that lands a moment after boot. */
export function waitForHydrated(timeoutMs: number): Promise<void> {
  if (useLayout.getState().hydrated) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let unsub: (() => void) | undefined;
    const timer = setTimeout(() => {
      unsub?.();
      reject(new Error("the layout never hydrated"));
    }, timeoutMs);
    unsub = useLayout.subscribe((s) => {
      if (s.hydrated) {
        clearTimeout(timer);
        unsub?.();
        resolve();
      }
    });
  });
}

/** The completion tick — the dispatcher's own cadence, and it must keep
 *  running while the window is hidden (nobody is looking at it). */
const HEADLESS_TICK_MS = 5000;

/** Resolve when the mission is done — a non-empty result note AND no tasks
 *  still in flight, the exact gate the dispatcher's completion branch uses.
 *  The dispatcher (App) may already be subscribed to the same feed, in which
 *  case the callback can fire inside the subscribe call, before unsub is
 *  assigned — harmless: we are exiting right after. */
export function watchMissionDone(project: string): Promise<void> {
  return new Promise((resolve) => {
    let finished = false;
    let unsub: (() => void) | undefined;
    const finish = () => {
      if (finished) return;
      finished = true;
      unsub?.();
      resolve();
    };
    const check = () => {
      const feed = brainFeedNow(project);
      if (!feed?.ready) return;
      const result = feed.keys.includes("result") ? feed.notes["result"]?.value : undefined;
      if (missionDone(result, feed.tasks)) finish();
    };
    unsub = subscribeBrainFeed(
      project,
      { intervalMs: HEADLESS_TICK_MS, hiddenMs: HEADLESS_TICK_MS, watch: ["result"] },
      check,
    );
    check();
  });
}

/** Cap on the wait for an on-complete hook to finish — a hanging hook must
 *  not hang the process. */
const ONCOMPLETE_EXIT_TIMEOUT_MS = 30 * 60_000;

/** Resolve when the host reports the named session exited (the on-complete
 *  hook's piped session, id `swarm-oncomplete-<project>` — swarmDispatch.ts),
 *  or after the cap. */
export function waitForPtyExit(id: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    let unlisten: (() => void) | undefined;
    const timer = setTimeout(() => {
      unlisten?.();
      resolve();
    }, timeoutMs);
    void onPtyExit((p) => {
      if (p.id === id) {
        clearTimeout(timer);
        unlisten?.();
        resolve();
      }
    }).then((un) => {
      unlisten = un;
    });
  });
}

async function headlessBoot(): Promise<void> {
  let req: HeadlessSwarmRequest | null;
  try {
    req = (await invoke<HeadlessSwarmRequest | null>("swarm_headless_request")) ?? null;
  } catch {
    return; // no Tauri internals after all — nothing to do
  }
  if (!req) return; // a normal GUI launch
  const cfg = headlessSwarmConfig(req);
  try {
    await waitForHydrated(30_000);
    const project = await launchSwarm(cfg);
    // The React hooks in App drive the swarm; all that is left is to wait for
    // completion and exit.
    await watchMissionDone(project);
    // When a hook IS configured, let it finish on the host before the exit
    // tears the host down (the dispatcher fires it in the very missionDone
    // branch this watcher resolves on).
    if (cfg.onComplete?.trim()) await waitForPtyExit(`swarm-oncomplete-${project}`, ONCOMPLETE_EXIT_TIMEOUT_MS);
    if (req.ownsHost) await quitApp();
    else await detachQuit();
  } catch (e) {
    // The window is hidden — the terminal is the only surface left. Rust
    // prints, notifies, and exits non-zero.
    const msg = e instanceof Error ? e.message : String(e);
    try {
      await invoke("headless_fail", { msg });
    } catch {
      /* fall through */
    }
    try {
      await detachQuit();
    } catch {
      /* headless_fail already took the process down */
    }
  }
}

// Boot once per webview — modules run once, so a flag is not even needed.
// The __TAURI_INTERNALS__ check keeps plain-browser dev and vitest out.
if (
  typeof window !== "undefined" &&
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
) {
  void headlessBoot();
}
