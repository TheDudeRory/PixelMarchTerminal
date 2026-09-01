// Single typed wrapper around every Tauri invoke/listen call.
// New calls belong here — it is the norm, not an absolute: a handful of components
// still call `invoke`/`listen` raw. docs/ipc.md names every one of them.
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { ShellInfo } from "./profiles";

export type PtyData = { id: string; data: string }; // data is base64
export type PtyExit = { id: string; code: number | null };

export interface SpawnOpts {
  rows: number;
  cols: number;
  shell?: string;
  args?: string[];
  cwd?: string;
  startupCommand?: string;
  env?: Record<string, string>;
  bigBrainTargets?: string[];
  /** Child mode on the host. Absent = "pty" = a terminal, which is what every
   *  pane was before headless agents existed. "piped" gives the child plain
   *  stdin/stdout instead — same Data/Exit frames come back, the payload is just
   *  the CLI's own JSON stream rather than terminal output. */
  mode?: "pty" | "piped";
}

// Attach to (or spawn) a pane's session on the host, keyed by the pane id so it
// reattaches to the same running shell after a GUI restart / update.
export const ptyOpen = (id: string, opts: SpawnOpts): Promise<void> => invoke("pty_open", { id, opts });

export const detectShells = (): Promise<ShellInfo[]> => invoke("detect_shells");

export const ptyWrite = (id: string, data: string): Promise<void> =>
  invoke("pty_write", { id, data });

export const ptyResize = (id: string, rows: number, cols: number): Promise<void> =>
  invoke("pty_resize", { id, rows, cols });

export const ptyClose = (id: string): Promise<void> => invoke("pty_close", { id });
// Flow control: pause/resume the host's read of a pane's PTY. The GUI pauses
// when a terminal's render queue backs up and resumes once it drains, so the
// child process is throttled to what the terminal can actually paint. A no-op
// against a host that predates flow control (it ignores the unknown frame).
export const ptyPause = (id: string): Promise<void> => invoke("pty_pause", { id });
export const ptyResume = (id: string): Promise<void> => invoke("pty_resume", { id });
// Full quit: host kills every terminal and stops. Detach quit: exit only the
// GUI, leaving the host + terminals running for the next launch.
export const quitApp = (): Promise<void> => invoke("quit_app");
export const detachQuit = (): Promise<void> => invoke("detach_quit");

export const onPtyData = (cb: (p: PtyData) => void): Promise<UnlistenFn> =>
  listen<PtyData>("pty://data", (e) => cb(e.payload));

export const onPtyExit = (cb: (p: PtyExit) => void): Promise<UnlistenFn> =>
  listen<PtyExit>("pty://exit", (e) => cb(e.payload));

// Portable persistence — the backend reads/writes pixelmarch.json in the app's data/ folder.
export const loadState = (): Promise<string | null> => invoke("load_state");
export const saveState = (json: string): Promise<void> => invoke("save_state", { json });
export const statePath = (): Promise<string> => invoke("state_path");

// File helpers for scrollback dump + log-to-file.
export const writeText = (path: string, content: string): Promise<void> => invoke("write_text", { path, content });
export const readText = (path: string): Promise<string> => invoke("read_text", { path });
export const appendText = (path: string, content: string): Promise<void> => invoke("append_text", { path, content });
// Native Markdown picker (used for user-supplied swarm role briefs).
// Resolves to the picked path, or null if the dialog was cancelled.
export const pickMarkdownFile = (title?: string): Promise<string | null> => invoke("pick_markdown_file", { title });
export const pickFolder = (title?: string): Promise<string | null> => invoke("pick_folder", { title });
export const logsDir = (): Promise<string> => invoke("logs_dir");
export const backupCorruptState = (): Promise<string | null> => invoke("backup_corrupt_state");

// Screenshots — capture EACH monitor to its own PNG in the portable
// screenshots/ folder in the app's data/ folder, named with a millisecond timestamp +
// monitor index. The backend broadcasts "screenshot-taken" {path} per file.
export const screenshotStart = (): Promise<void> => invoke("screenshot_start");
export const screenshotList = (): Promise<string[]> => invoke("screenshot_list");
/** REPLACE the set of shots exempt from retention pruning regardless of age.
 *  The caller owns the whole list (one owner, or two callers clobber). Returns
 *  the accepted count. See screenshot.rs prune_dir / PROTECTED. */
export const screenshotProtect = (paths: string[]): Promise<number> => invoke("screenshot_protect", { paths });

// Global Hotkeys (KeyForge fold-in) — the Rust engine owns the profile JSON in
// the portable hotkeys/ dir in the app's data/ folder; these register combos with the OS.
// Actions: launch a program, run a shell command line, or fire a macro from the
// KeyForge macro engine (src-tauri/src/macros, Action::RunMacro in
// hotkeys/bindings.rs:28) by macro id. Input synthesis / window / audio live in
// the macro engine and are reachable only through run_macro, never as bare
// hotkey actions. Macro CRUD IPC lives in MacroEditor.tsx, not here.
export type HotkeyAction =
  | { type: "launch_program"; path: string; args?: string[] }
  | { type: "run_command"; command: string }
  | { type: "run_macro"; id: string };
export interface HotkeyBinding {
  hotkey: string; // combo string, e.g. "Ctrl+Alt+K"
  enabled: boolean;
  action: HotkeyAction;
}
// `errors` maps a NORMALIZED combo (lowercased, no spaces) to why it is inactive
// (conflict with an earlier binding / invalid combo / the OS refused it).
export interface HotkeyView {
  bindings: HotkeyBinding[];
  errors: Record<string, string>;
}
export const hotkeysList = (): Promise<HotkeyView> => invoke("hotkeys_list");
export const hotkeysSave = (bindings: HotkeyBinding[]): Promise<HotkeyView> =>
  invoke("hotkeys_save", { bindings });

// Macro editor play button — run the DRAFT being edited without saving it.
// `macro` is the editor's macro JSON (same shape macros_save takes). Both
// starters return a run id; progress arrives as "macro-test-step" events and
// exactly one "macro-test-done" per run. Cancel stops that run only (unlike
// macros_stop_all, which is the emergency stop for every running macro).
// Sub-macros in a `run_macro` step still resolve to their last SAVED version.
export type MacroTestStatus = "start" | "ok" | "skipped" | "error";
export interface MacroTestStep {
  run_id: number;
  index: number;   // top-level step index in macro.steps
  total: number;
  summary: string; // human-readable step label
  status: MacroTestStatus;
  error?: string;  // set when status === "error"
}
export interface MacroTestDone {
  run_id: number;
  status: "completed" | "stopped" | "error";
  error: string | null;
}
export const macrosTestRun = (macro: unknown): Promise<number> =>
  invoke("macros_test_run", { macro });
export const macrosTestStep = (macro: unknown, index: number): Promise<number> =>
  invoke("macros_test_step", { macro, index });
export const macrosTestCancel = (runId: number): Promise<boolean> =>
  invoke("macros_test_cancel", { runId });
export const onMacroTestStep = (cb: (s: MacroTestStep) => void): Promise<UnlistenFn> =>
  listen<MacroTestStep>("macro-test-step", (e) => cb(e.payload));
export const onMacroTestDone = (cb: (d: MacroTestDone) => void): Promise<UnlistenFn> =>
  listen<MacroTestDone>("macro-test-done", (e) => cb(e.payload));

// App-level global shortcuts owned by lib.rs (distinct from the user Global
// Hotkeys above): the summon/hide toggle and the screenshot trigger. Editable
// from the Keybinds settings category; persisted in the app's data/ folder.
export interface AppShortcuts {
  summon: string;     // combo, e.g. "CmdOrCtrl+Alt+Backquote"
  screenshot: string; // combo, e.g. "CmdOrCtrl+Alt+S"
}
export const appShortcutsGet = (): Promise<AppShortcuts> => invoke("app_shortcuts_get");
export const appShortcutsSet = (s: AppShortcuts): Promise<void> =>
  invoke("app_shortcuts_set", { summon: s.summon, screenshot: s.screenshot });

// Voice-To-Text (VoiceMarch fold-in) — offline push-to-talk dictation in its own
// "voice" webview window. The Rust side owns capture/STT (behind the `voice`
// cargo feature) and persists voice-settings.json in the app's data/ folder. A finished
// transcript is broadcast as the "voice-transcript" event; the main window
// writes it into the focused terminal (no OS-level insertion).
export interface VoiceSettings {
  enabled: boolean;      // master switch: off = no hotkey, no capture, no pill
  ptt_hotkey: string;
  mic_device: string | null;
  spacing: "space" | "newline" | "none";
  punctuation: "keep" | "strip" | "spoken";
  whisper_model: string; // tiny.en | base.en | base.en-q8_0
  insertion: string;     // parity field; PixelMarch redirects to the terminal
  always_on_top: boolean;
  mute_on_ptt: boolean;  // deferred: persisted but inert
  chirp: boolean;
  chirp_volume: number;  // 0–100
}
// built=false means the exe was compiled without --features voice (capture inert).
// model_id/model_file name the selected model and the `ggml-<id>.bin` file it needs
// (the filename formula lives in Rust — voice/models.rs — never rebuild it here).
export interface VoiceStatus {
  enabled: boolean;
  built: boolean;
  model_present: boolean;
  model_id: string;
  model_file: string;
  ptt_hotkey: string;
}

// One installable Whisper model. No model ships with the app, so the Voice
// settings panel doubles as the installer: `voice_models_status` reports what is
// on disk, `voice_model_download` fetches it (verified, HTTPS-only), and
// `voice_model_import` copies in a .bin the user downloaded by hand.
export interface VoiceModelInfo {
  id: string;            // e.g. "base.en-q8_0"
  label: string;
  file: string;          // ggml-<id>.bin
  present: boolean;      // a file exists at that name
  size_bytes: number | null;    // bytes on disk (null when absent)
  expected_size: number | null; // bytes upstream publishes (null off-catalog)
  complete: boolean;     // present AND the right size — i.e. actually usable
  selected: boolean;     // is this the model the settings point at?
  url: string;           // "" for a model outside the catalog
}
// Progress for one install, streamed as the "voice-model-progress" event.
export interface VoiceModelProgress {
  id: string;
  downloaded: number;
  total: number | null;
  status: "start" | "progress" | "verifying" | "done" | "error";
  error: string | null;
}

export const voiceGetSettings = (): Promise<VoiceSettings> => invoke("voice_get_settings");
export const voiceSetSettings = (settings: VoiceSettings): Promise<void> =>
  invoke("voice_set_settings", { new: settings });
export const voiceListMics = (): Promise<string[]> => invoke("voice_list_mics");
export const voiceShowWindow = (): Promise<void> => invoke("voice_show_window");
export const voiceHideWindow = (): Promise<void> => invoke("voice_hide_window");
export const voiceStatus = (): Promise<VoiceStatus> => invoke("voice_status");
export const voiceModelsStatus = (): Promise<VoiceModelInfo[]> => invoke("voice_models_status");
// Returns as soon as the background download starts; watch onVoiceModelProgress.
export const voiceModelDownload = (id: string): Promise<void> => invoke("voice_model_download", { id });
// Resolves to the installed filename, or null if the picker was cancelled.
export const voiceModelImport = (id: string): Promise<string | null> => invoke("voice_model_import", { id });

// PTT edge ("down"/"up"), capture stats, model load state, and the formatted
// transcript ready to drop into the terminal.
export const onVoicePtt = (cb: (edge: string) => void): Promise<UnlistenFn> =>
  listen<string>("voice-ptt", (e) => cb(e.payload));
export const onVoiceCapture = (cb: (info: { samples: number; seconds: number }) => void): Promise<UnlistenFn> =>
  listen<{ samples: number; seconds: number }>("voice-capture", (e) => cb(e.payload));
export const onVoiceModel = (cb: (state: string) => void): Promise<UnlistenFn> =>
  listen<string>("voice-model", (e) => cb(e.payload));
export const onVoiceModelProgress = (cb: (p: VoiceModelProgress) => void): Promise<UnlistenFn> =>
  listen<VoiceModelProgress>("voice-model-progress", (e) => cb(e.payload));
// Master switch flipped in the Voice settings panel (which may be a DIFFERENT
// webview than the toolbar), so the main window can add/drop its 🎙 button live.
export const onVoiceEnabled = (cb: (enabled: boolean) => void): Promise<UnlistenFn> =>
  listen<boolean>("voice-enabled", (e) => cb(e.payload));
export const onVoiceTranscript = (cb: (text: string) => void): Promise<UnlistenFn> =>
  listen<string>("voice-transcript", (e) => cb(e.payload));
// Fires once per transcription finish on EVERY path (terminal/type/paste/empty/
// error). Carries no text — only signals "back to idle" so the pill resets.
export const onVoiceDone = (cb: () => void): Promise<UnlistenFn> =>
  listen("voice-done", () => cb());

// System-monitor pane: one-shot metrics snapshot, polled on an interval by the UI.
export interface Gpu { name: string; util: number; memUsed: number; memTotal: number; temp: number | null }
export interface Metrics {
  cpu: number; cores: number[];
  memUsed: number; memTotal: number;
  swapUsed: number; swapTotal: number;
  netRx: number; netTx: number; // bytes/sec
  temp: number | null;          // hottest component °C
  gpus: Gpu[];
}
export const sysSnapshot = (): Promise<Metrics> => invoke("sysinfo_snapshot");

// BigBrain — the local memory service. Returns its base
// URL (e.g. http://127.0.0.1:8734), or "" if no local port was free.
//
// MEMOIZED: the brain binds its port once per host process and the URL never
// changes afterwards, but several callers asked for it on every tick of their own
// timer (swarmReset 4 s, swarmRunaway 30 s — neither file is touched here, but both
// stop re-reading the URL because of this cache — plus the panel): ~20 IPC round
// trips a minute for a constant.
//
// ONLY a NON-EMPTY answer is cached. "" is not a fact about the process, it is
// "the URL file is not there yet": run_host writes state_dir()/pixelmarch-brain.url
// (host.rs:651) AFTER bind (:645), and ensure_host returns as soon as the port file
// lets it connect — so a GUI that asks early can legitimately get "". Caching that
// would break brainUrl() for the whole session, and with it the agent briefs
// (SwarmDialog), swarmReset and swarmRunaway. A rejection is not cached either.
let brainUrlOnce: Promise<string> | null = null;
export const brainUrl = (): Promise<string> => {
  if (!brainUrlOnce) {
    const p = (invoke("brain_url") as Promise<string>).then(
      (u) => {
        if (!u) brainUrlOnce = null; // not bound yet — ask again next time
        return u;
      },
      (e) => {
        brainUrlOnce = null;
        throw e;
      },
    );
    brainUrlOnce = p;
  }
  return brainUrlOnce;
};

// BigBrain note manager — a text editor over the on-disk store
// (brain/<project>/<key>.md in the app's data/ folder). Edits the files directly; no HTTP.
export const brainProjects = (): Promise<string[]> => invoke("brain_projects");
export const brainKeys = (project: string): Promise<string[]> => invoke("brain_keys", { project });
export const brainNote = (project: string, key: string): Promise<string | null> => invoke("brain_note", { project, key });
export const brainSave = async (project: string, key: string, value: string): Promise<void> => {
  await invoke("brain_save", { project, key, value });
  feedPoke(project, key, value); // our own write — never wait a poll to see it
};
export const brainDelete = async (project: string, key: string): Promise<void> => {
  await invoke("brain_delete", { project, key });
  feedPoke(project, key, null);
};
export const brainDeleteProject = (project: string): Promise<void> => invoke("brain_delete_project", { project });

// Cross-project note search for the Visualize graph. `elsewhere` marks hits that
// live in a project other than the one searched.
export interface BrainHit { project: string; key: string; value: string; updated: number; elsewhere: boolean }
export const brainSearch = (project: string, q: string): Promise<BrainHit[]> => invoke("brain_search", { project, q });

// ── Editing without resending the body (brain api v5) ────────────────────────
// `brain_patch` / `brain_replace` are the IPC twins of POST /patch and POST
// /replace (src-tauri/src/brain/mod.rs). They exist so an edit costs the SIZE OF
// THE EDIT, not the size of the note: the old flow was read-whole-note →
// re-POST-whole-note, which is what made a store-wide version-string sweep
// enormous.
//
// NEITHER pokes the note feed on its own: a patch answers with the changed
// LINES, not the new body, and a bulk replace answers with rows, so neither call
// knows what the note now says. The CALLER folds its own write in — `brainFeedPoke`
// when it holds the new body (the editor does), `brainFeedStale` when it only
// knows which notes changed (a bulk apply). Skip that and the write converges
// only on the feed's own schedule (BODY_REFRESH_MS / RECONCILE_MS), which is
// right for another agent's write over HTTP but far too slow for our own.

/** One changed line in a patch/replace preview. `before: null` = inserted line,
 *  `after: null` = deleted line. */
export interface BrainEditLine { line: number; before: string | null; after: string | null }

export interface BrainPatchResult {
  ok: boolean; project: string; key: string; op?: string; dry?: boolean;
  hits?: number; changed?: number; lines?: BrainEditLine[];
  bytes?: { before: number; after: number };
  note?: string; error?: string; hint?: string; reason?: string;
}

/** Edit ONE note in place. `op` may be omitted: `find` implies replace, `text`
 *  implies append. `expect` is the optimistic-concurrency guard — the patch is
 *  refused unless that substring is still in the stored body. `dry` previews. */
export const brainPatch = (
  project: string, key: string,
  a: { op?: string; find?: string; replace?: string; text?: string; lines?: string; all?: boolean; regex?: boolean; expect?: string; dry?: boolean },
): Promise<BrainPatchResult> => invoke("brain_patch", { project, key, ...a });

export interface BrainReplaceNote {
  project: string; key: string; hits: number; lines: BrainEditLine[];
  lines_elided?: number; multiline?: boolean;
}
export interface BrainReplaceResult {
  ok: boolean; dry: boolean; scope: string; find: string; notes_matched: number; hits: number;
  notes: BrainReplaceNote[];
  regex?: boolean; replace?: string; include_tasks?: boolean;
  written?: number; limit?: number; reason?: string; hint?: string;
  failed?: { project: string; key: string; error: string }[];
}

/** Search-and-replace across MANY notes — one project, or the whole store with
 *  `allProjects`. DRY RUN UNLESS `apply` IS TRUE: the caller is expected to show
 *  the reported notes/lines and get a human yes before committing, because the
 *  store is the only copy. `task-<n>` notes are skipped unless `includeTasks`. */
export const brainReplace = (
  a: { project?: string; allProjects?: boolean; find: string; replace?: string; regex?: boolean; keys?: string; includeTasks?: boolean; apply?: boolean; limit?: number },
): Promise<BrainReplaceResult> => invoke("brain_replace", a);

// The /info guide page: current text (override or built-in default), and the
// setter — a non-empty value writes brain/info.md, "" resets to the default.
// IPC because the webview is cross-origin to the brain HTTP server.
export const brainInfo = (): Promise<string> => invoke("brain_info");
export const brainSetInfo = (value: string): Promise<void> => invoke("brain_set_info", { value });

// Swarm launch guard: create the working dir if missing, git init if not a repo,
// seed an empty first commit if HEAD is unborn — so the builders' worktree
// protocol works even when the swarm targets an empty folder. Resolves to what
// it did ("git init + initial empty commit"), "" if the repo was already fine.
export const ensureGitRepo = (cwd: string): Promise<string> => invoke("ensure_git_repo", { cwd });

// Licensing (src-tauri/src/license.rs). Ed25519 entitlement tokens are verified
// offline against a baked-in public key; the cache lives in the app's data/ folder.
// `licensed` is the ONLY field that may gate a paid feature — `state` is for
// telling the user what is going on, and must never be rendered raw.
export interface LicenseStatus {
  licensed: boolean;
  /** unlicensed | active | trialing | past_due | canceled | expired | invalid */
  state: string;
  /** Raw subscription status from the token; for diagnostics, not for the UI. */
  status: string | null;
  plan: string | null;
  /** Unix seconds — when access lapses unless renewed. */
  expires_at: number | null;
  license_key: string | null;
  last_check: number | null;
  /** The last refresh attempt did not complete. Access is unaffected. */
  offline: boolean;
  device_id: string | null;
}
// Reads the cache, and refreshes only when the token is near expiry (at most
// hourly) — so this can block on the network for a few seconds.
export const licenseStatus = (): Promise<LicenseStatus> => invoke("license_status");
export const licenseActivate = (key: string): Promise<LicenseStatus> => invoke("license_activate", { key });
export const licenseRefresh = (): Promise<LicenseStatus> => invoke("license_refresh");
export const licenseDeactivate = (): Promise<LicenseStatus> => invoke("license_deactivate");
// Opens Paddle's customer portal in the user's browser and resolves once it is
// launched. Deliberately returns nothing: the session URL has a bearer token
// embedded in it, so it stays in Rust and never reaches this side. Call it on
// click only — each call costs the server a live Paddle API request.
export const licensePortal = (): Promise<void> => invoke("license_portal");

// Updates (src-tauri/src/update.rs). PixelMarch runs from its git checkout, so
// an update is `git pull` + a rebuild — there is no download and no exe swap.
// The version is the running build's, bare ("0.1.37", no leading v).

/** What a `git pull` would bring in, and where it would come from. */
export type UpdAvailable = {
  /** Commits HEAD is behind the upstream. */
  behind: number;
  /** The upstream ref, e.g. "origin/master" — the remote about to put code on this machine. */
  upstream: string;
  /** Version the incoming commits build as; "" when it could not be read. */
  version: string;
  /** Incoming commit subjects, newest first. */
  notes: string[];
  /** Uncommitted changes are present. The pull may still succeed — git refuses
   *  only when the incoming commits touch a file that was modified locally. */
  dirty: boolean;
};
/**
 * "blocked" is a checkout that cannot update itself in place — no git, no
 * upstream configured, a detached HEAD. It is neither "up to date" nor a
 * failure, and collapsing it into either would tell someone they are current
 * when nothing was ever checked.
 */
export type UpdateCheck =
  | { status: "available"; info: UpdAvailable }
  | { status: "upToDate" }
  | { status: "blocked"; reason: string };
/**
 * One line of build output. There is no percentage here on purpose: a build has
 * no knowable total, so `step`/`steps` is the only honest progress there is.
 */
export type UpdateProgressEvent = { step: number; steps: number; command: string; line: string };

// False when this checkout has no upstream to pull from — the UI disables the
// check instead of offering a button that can only fail.
export const updateConfigured = (): Promise<boolean> => invoke("update_configured");
export const appVersion = (): Promise<string> => invoke("app_version");
// Fetches from the upstream remote, then reports what is waiting.
export const checkUpdate = (): Promise<UpdateCheck> => invoke("check_update");
// Pulls, rebuilds and restarts into the result, emitting update-progress
// throughout. Takes no argument: the pull is --ff-only onto the branch's own
// upstream, which Rust reads from the checkout rather than accepting from here.
export const applyUpdate = (): Promise<void> => invoke("apply_update");
// Subscribe BEFORE calling applyUpdate: the first step starts the moment it is
// invoked and emits its first event immediately.
export const onUpdateProgress = (cb: (p: UpdateProgressEvent) => void): Promise<UnlistenFn> =>
  listen<UpdateProgressEvent>("update-progress", (e) => cb(e.payload));

// Swarm task bus — parsed task-<n> notes (same rows as GET /tasks on the HTTP side).
export interface SwarmTask { key: string; status: string; role: string; owner: string; files: string; desc: string; updated: number }
export const brainTasks = (project: string): Promise<SwarmTask[]> => invoke("brain_tasks", { project });

// Swarm chat + reset requests — the SAME notes as ever (chat-<from>-<n>,
// reset-<role>), but split, routed and ordered by the brain, so no caller parses
// the `to:` header convention any more. `targets` is the parsed header, `to` the
// raw one; `addressed` is false when the body carried no header at all (the brain
// then reports it as "all" — see the wake path in swarmDispatch for what that
// means). Rows come back oldest-first, ties broken on (from, n) so ten messages
// inside one mtime second still read back in order.
export interface ChatRow { key: string; from: string; n: number; to: string; targets: string[]; addressed: boolean; text: string; updated: number }
export interface ResetRow { key: string; role: string; state: string; updated: number }
/** `role` given = only what is addressed to that role (or all), minus its own
 *  messages; omitted = every message in the project. `since` is an exclusive
 *  epoch-SECONDS cursor — mtime granularity, so de-dup on `key` as well. */
export const brainChat = (project: string, role?: string, since?: number): Promise<ChatRow[]> =>
  invoke("brain_chat", { project, role, since });
export const brainResets = (project: string): Promise<ResetRow[]> => invoke("brain_resets", { project });

/** One outstanding SCOPE RECLAIM (brain-findings 2.2): the coordinator asked for
 *  a task to be taken off `from` and given to `to` (empty = released back to the
 *  pool). The brain only records it — the flip and the losing pane's wipe are one
 *  host operation, see reclaimScope in swarmReset.ts. */
export interface ReclaimRow { key: string; task: string; from: string; to: string; why: string; updated: number }
export const brainReclaims = (project: string): Promise<ReclaimRow[]> => invoke("brain_reclaims", { project });

/** The bus half of a reclaim, as the host. Call it ONLY from reclaimScope: the
 *  losing pane must be fenced before it and wiped after it, or this is just a
 *  reassignment with the old owner still free to take a turn. */
export const brainReclaimTask = (project: string, task: string, to: string): Promise<{ ok: boolean; reason?: string; error?: string; from?: string; to?: string; status?: string }> =>
  invoke("brain_reclaim_task", { project, task, to });

// ── Swarm control plane (host-enforced; see src-tauri/src/swarm.rs + brain) ──
// The host performs the git steps agents used to be told to run, and the brain
// authenticates every pane with its OWN per-role token so the task lifecycle is
// gated by who is asking, not by what the brief said.

/** Transition a task AS THE HOST (attributed "[<status> by host]" in the log). */
export const brainTaskStatus = (project: string, task: string, status: string, log?: string): Promise<Record<string, unknown>> =>
  invoke("brain_task_status", { project, task, status, log });

/** Post a swarm chat row as the host (repo-dirty warnings and the like). */
export const brainChatSend = (project: string, from: string, to: string, text: string): Promise<Record<string, unknown>> =>
  invoke("brain_chat_send", { project, from, to, text });

/** Mint per-role agent tokens for a swarm launch: role → token-carrying base
 *  URL. Panes are spawned with THESE (env + MCP config), never the session URL. */
export const swarmRegisterAgents = async (project: string, roles: string[]): Promise<Record<string, string>> => {
  const out = (await invoke("swarm_register_agents", { project, roles })) as { ok: boolean; urls?: Record<string, string> };
  return out.ok && out.urls ? out.urls : {};
};

/** Revoke a swarm's agent tokens + per-role MCP configs (mission end). */
export const swarmUnregisterAgents = (project: string): Promise<void> => invoke("swarm_unregister_agents", { project });

/** Per-role MCP config file carrying the role's agent-token URL, or "". */
export const swarmMcpConfig = (url: string, project: string, role: string): Promise<string> =>
  invoke("swarm_mcp_config", { url, project, role });

/** Host-created worktree for a claimed task (.swarm/task-<n>, branch swarm/task-<n>). */
export const swarmWorktreeAdd = (cwd: string, task: string): Promise<{ ok: boolean; path?: string; error?: string }> =>
  invoke("swarm_worktree_add", { cwd, task });

export interface SweptTask { task: string; swept: boolean; branch?: string; deleted?: boolean; reason?: string }
export interface SwarmSweepResult { ok: boolean; swept?: SweptTask[]; kept?: SweptTask[]; salvage_branches?: string[]; swarm_dir_removed?: boolean; error?: string }
/** Clear the PREVIOUS run's task worktrees and branches out of a repo, at launch.
 *  Task ids restart at task-1 every swarm but `.swarm/task-<n>` and
 *  `swarm/task-<n>` are repo-scoped, so without this a new task-1 inherits an
 *  old one's tree, branch and commits. Nothing is discarded: uncommitted work is
 *  committed first, and an unmerged branch is RENAMED to
 *  `pixelmarch-salvage/<task>-<sha>`, never deleted. `live` is the destructive
 *  half of the contract, same shape as swarmMergeTask's `ownerStopped`: pass
 *  false only after confirming no swarm is already running on this repo —
 *  anything else sweeps nothing. */
export const swarmWorktreeSweep = (cwd: string, live: boolean): Promise<SwarmSweepResult> =>
  invoke("swarm_worktree_sweep", { cwd, live });

export interface SwarmMergeResult { ok: boolean; merged?: string; already?: boolean; manifests?: string[]; conflict?: boolean; reason?: string; dirty?: string[]; noBranch?: boolean; no_branch?: boolean; error?: string; moved?: boolean; unresolved_approval?: boolean; changes_log?: string; gated?: boolean; branch?: string; approved_sha?: string; head_sha?: string; ahead?: number; worktree?: Record<string, unknown> }
/** Host-performed merge of an approved task branch (+ worktree/branch cleanup).
 *  `approved` is the commit the reviewer READ (a bare SHA or the whole approval
 *  note — a single-SHA note cannot resolve to an older commit); omit it and the
 *  merge is ungated (`gated:false`). `project` namespaces the merge commit's
 *  subject — task ids restart at task-1 every launch, so without it a PREVIOUS
 *  swarm's merge commit answers "is this task merged?" for a task that has
 *  merged nothing. `ownerStopped` is the second half of the worktree rule: the
 *  branch + worktree are released ONLY once the owning pane has been stopped, so
 *  pass true only after the owner is force-reset. */
export const swarmMergeTask = (cwd: string, task: string, project: string, approved?: string, ownerStopped?: boolean): Promise<SwarmMergeResult> =>
  invoke("swarm_merge_task", { cwd, task, project, approved, ownerStopped });

/** Stamp a task worktree with the role the bus says owns it. The guard's
 *  reference-transaction hook refuses a ref write from any other pane — the one
 *  breach a branch rule cannot catch is the RIGHT branch in the RIGHT worktree
 *  moved by the WRONG builder. `ok:false` + `no_worktree` = not created yet. */
export const swarmWorktreeOwner = (cwd: string, task: string, owner: string): Promise<{ ok: boolean; owner?: string; changed?: boolean; no_worktree?: boolean; error?: string }> =>
  invoke("swarm_worktree_owner", { cwd, task, owner });

/** Uncommitted tracked changes in the root checkout — the stray-edit tripwire. */
export const swarmRepoDirty = (cwd: string): Promise<{ ok: boolean; dirty: boolean; files: string[] }> =>
  invoke("swarm_repo_dirty", { cwd });

/** Untracked files in the root checkout — what a launch would hide from every
 *  builder, since a task worktree is checked out from a COMMIT. Host excludes
 *  (`.swarm/`, build caches) are applied first, so what comes back is only work
 *  a human might have meant to commit. */
export const swarmUntracked = (cwd: string): Promise<{ ok: boolean; untracked: boolean; files: string[] }> =>
  invoke("swarm_untracked", { cwd });

/** Stash the root's stray edits so host merges can resume. Reversible — the work
 *  stays in `git stash list` under `label`, and nothing is ever discarded. */
export const swarmParkStrays = (cwd: string, label: string): Promise<{ ok: boolean; parked: boolean; files: string[]; stash?: string; left?: string[]; error?: string }> =>
  invoke("swarm_park_strays", { cwd, label });

/** The root checkout's HEAD. Sampled every tick: master moving with no host
 *  merge behind it is someone walking past the guard, and nothing else sees it. */
export const swarmRepoHead = (cwd: string): Promise<{ ok: boolean; sha?: string; subject?: string; branch?: string }> =>
  invoke("swarm_repo_head", { cwd });

/** A task branch's tip — "did its builder commit work nobody announced?" */
export const swarmBranchTip = (cwd: string, task: string): Promise<{ ok: boolean; exists?: boolean; sha?: string; subject?: string; branch?: string }> =>
  invoke("swarm_branch_tip", { cwd, task });

/** Arm / disarm the repo guard (pre-commit + reference-transaction) that keeps
 *  master and every task branch out of agents' hands while a swarm runs. */
export const swarmGuardInstall = (cwd: string): Promise<{ ok: boolean; error?: string }> => invoke("swarm_guard_install", { cwd });
export const swarmGuardRemove = (cwd: string): Promise<{ ok: boolean; error?: string }> => invoke("swarm_guard_remove", { cwd });

/** Is a swarm ACTUALLY running on this repo, read from the process table rather
 *  than from anything this app persisted about itself?
 *
 *  `live` means the process that armed the guard is still running (pid AND start
 *  time, so a recycled pid cannot pass). `ours` narrows that to "and it is this
 *  process", which is the only case where the caller should go on to ask the UI
 *  whether that swarm's panes are still open — see the launch path in
 *  SwarmDialog. Everything else is a leftover, however recent. */
export const swarmGuardProbe = (cwd: string): Promise<{ ok: boolean; locked?: boolean; live?: boolean; ours?: boolean; pid?: number; reason?: string; error?: string }> =>
  invoke("swarm_guard_probe", { cwd });

/** Put a repo back in a launchable state after the last swarm was KILLED rather
 *  than finished: disarm the guard it left armed, remove a stale index.lock, and
 *  abort an operation the kill interrupted. Loses no work — see swarm.rs. */
export const swarmReclaim = (cwd: string): Promise<{ ok: boolean; cleared?: string[]; error?: string }> =>
  invoke("swarm_reclaim", { cwd });

// ── The swarm brain feed ───────────────────────────────────────────────────
// ONE poller per swarm project, shared by every surface that reads it, instead
// of a timer per component.
//
// What it replaces: SwarmChat ran two `brainSearch` full-store scans every 2 s,
// swarmDispatch a third every 5 s plus three note/task reads per swarm,
// SwarmHealthStrip one task read plus one note read PER ROLE every 1.5 s, and
// SwarmMission three more every 2 s — five timers, all asking the same project
// the same questions, several of them the whole-store search.
//
// The rules that make it cheap:
//  - KEYS ARE THE CHANGE FEED. `brain_keys` is one call that returns names only.
//    A note whose key we already hold a body for is not re-read, so a swarm at
//    idle costs two calls a tick (keys + the task bus) no matter how big its
//    transcript is.
//  - BODIES ARE CACHED BY KEY. `prefixes` (e.g. "chat-") mirrors a whole family
//    of write-once notes: a body is fetched the tick its key first appears.
//    `watch` is for the handful of keys that are REWRITTEN under the same name
//    (status-<role> heartbeats, plan, result) — those refresh on a slower gap.
//  - SEED AND RECONCILE WITH ONE SEARCH. `brainSearch` is the expensive call, so
//    it runs twice per prefix per minute at most: once to seed (it is the only
//    read that carries each note's mtime, which is what orders the transcript)
//    and then every RECONCILE_MS, which is what makes a body REWRITTEN under an
//    existing key converge instead of being pinned by the cache forever.
//  - NOBODY WATCHING, NOBODY POLLING. Subscribers name their own cadence and a
//    hidden-window cadence; the feed runs at the fastest one currently asked
//    for. A project with no subscribers has no timer at all, so a workspace that
//    is not a swarm — and a swarm whose mission is over — costs nothing.
//
// It deliberately does NOT try to be live. The brain's long-poll (GET /wait)
// would push instead of poll, but the webview is cross-origin to the brain's
// HTTP port and there is no IPC twin for it yet; when there is, it lands here
// and every caller below gets it for free.

/** One note as the feed holds it. `updated` is epoch SECONDS, like BrainHit. */
export interface BrainNoteEntry { value: string; updated: number }

export interface BrainFeed {
  /** A tick has completed, so `keys`/`tasks` are real answers and not "not asked yet". */
  ready: boolean;
  /** Every note key in the project, from the last tick. */
  keys: string[];
  tasks: SwarmTask[];
  /** Bodies the feed holds, by key. A key absent here was never requested (or its
   *  note is empty); a key absent from `keys` no longer exists. */
  notes: Record<string, BrainNoteEntry>;
  /** Date.now() of the last completed tick, 0 if none. */
  at: number;
}

export interface BrainFeedOpts {
  /** Cadence while the window is visible. Default 2000. */
  intervalMs?: number;
  /** Cadence while the window is hidden — for a surface nobody can be looking at.
   *  Watchers that must keep running in the background leave it equal to
   *  `intervalMs`. Default: `intervalMs`. */
  hiddenMs?: number;
  /** Pull the task bus. Default true. */
  tasks?: boolean;
  /** Keys that are rewritten in place and must stay fresh (status-<role>, plan,
   *  result, mission). Re-read at most every BODY_REFRESH_MS. */
  watch?: string[];
  /** Key prefixes to mirror wholesale ("chat-", "ask-"): each key's body is read
   *  once, the tick its key first shows up. */
  prefixes?: string[];
}

/** How often a `watch` key's body is re-read. These are small notes whose text
 *  feeds tooltips and gates (heartbeat lines, the plan gate, the mission-complete
 *  flag) — none of them is a per-second signal, and the health chips' own state
 *  (colour, output age, task) does not come from them at all. */
const BODY_REFRESH_MS = 10_000;
/** How often the seeding search re-runs, which is the ONLY thing that notices a
 *  body rewritten under a key we already cached. */
const RECONCILE_MS = 20_000;
/** Bodies fetched per tick. A swarm's first tick can find hundreds of chat notes;
 *  reading them all at once would be exactly the burst this file exists to kill,
 *  so they come in over several ticks. */
const MAX_BODY_FETCH = 40;

interface FeedSub { opts: BrainFeedOpts; cb: (f: BrainFeed) => void }

interface FeedState {
  subs: Map<number, FeedSub>;
  feed: BrainFeed;
  timer: ReturnType<typeof setTimeout> | null;
  ticking: boolean;
  /** Date.now() of the last body read, per key. */
  read: Map<string, number>;
  /** Prefixes already seeded by a search. */
  seeded: Set<string>;
  reconciledAt: number;
  /** Writes/deletes this app made WHILE a tick was in flight, by key. The tick
   *  read its key list before they happened, so it must not be allowed to
   *  overwrite them — they are re-applied over its snapshot. */
  pending: Map<string, { value: string | null; at: number }>;
}

const feeds = new Map<string, FeedState>();
let feedSubId = 0;

const emptyFeed = (): BrainFeed => ({ ready: false, keys: [], tasks: [], notes: {}, at: 0 });

const hiddenNow = (): boolean =>
  typeof document !== "undefined" && document.visibilityState === "hidden";

/** The fastest cadence any live subscriber is asking for right now. */
function feedPeriod(st: FeedState): number {
  const hidden = hiddenNow();
  let ms = Infinity;
  for (const { opts } of st.subs.values()) {
    const base = opts.intervalMs ?? 2000;
    ms = Math.min(ms, hidden ? (opts.hiddenMs ?? base) : base);
  }
  return Number.isFinite(ms) ? ms : 2000;
}

function feedWants(st: FeedState): { tasks: boolean; watch: Set<string>; prefixes: Set<string> } {
  const watch = new Set<string>();
  const prefixes = new Set<string>();
  let tasks = false;
  for (const { opts } of st.subs.values()) {
    if (opts.tasks !== false) tasks = true;
    for (const k of opts.watch ?? []) watch.add(k);
    for (const p of opts.prefixes ?? []) prefixes.add(p);
  }
  return { tasks, watch, prefixes };
}

/** The search token that finds a prefix's notes: the prefix's leading word, since
 *  the brain tokenizes a key on non-alphanumerics and matches token PREFIXES
 *  ("chat-" -> "chat" finds every chat-<who>-<n>). */
const prefixQuery = (prefix: string): string => prefix.replace(/[^a-zA-Z0-9]+/g, " ").trim();

function feedEmit(project: string) {
  const st = feeds.get(project);
  if (!st) return;
  const snapshot = st.feed;
  for (const { cb } of [...st.subs.values()]) {
    try { cb(snapshot); } catch { /* a subscriber that throws must not kill the feed */ }
  }
}

/** Fold a write/delete this app just made straight into the cache, so the surface
 *  that made it does not wait for a poll to see its own message. */
function feedPoke(project: string, key: string, value: string | null) {
  const st = feeds.get(project);
  if (!st) return;
  // A tick that is already in flight read its key list BEFORE this write, so its
  // snapshot would resurrect a deleted key (swarmReset would re-brief a pane) or
  // drop a just-sent message for a round. Park it and re-apply after the tick.
  if (st.ticking) st.pending.set(key, { value, at: Date.now() });
  const notes = { ...st.feed.notes };
  let keys = st.feed.keys;
  if (value === null) {
    delete notes[key];
    // Drop the key too: swarmReset consumes a reset-<role> note and must not see
    // it again on the next tick, or it would re-run the wipe it just finished.
    keys = keys.filter((k) => k !== key);
    st.read.delete(key);
  } else {
    notes[key] = { value, updated: Date.now() / 1000 };
    if (!keys.includes(key)) keys = [...keys, key].sort();
    st.read.set(key, Date.now());
  }
  st.feed = { ...st.feed, keys, notes };
  feedEmit(project);
}

/** Fold a note this app PATCHED into the feed, same as a `brainSave` does. The
 *  patch call itself cannot: it answers with the changed lines, so only the
 *  caller knows the body the note now holds. */
export function brainFeedPoke(project: string, key: string, value: string) {
  feedPoke(project, key, value);
}

/** Forget the cached BODIES of notes rewritten behind the feed's back (a bulk
 *  apply, which reports which notes changed but not what they now say) and tick
 *  now, so they are re-read on the next pass instead of waiting out RECONCILE_MS.
 *  A key nobody watches or mirrors has no body cached and costs nothing. */
export function brainFeedStale(project: string, keys: string[]) {
  const st = feeds.get(project);
  if (!st) return;
  for (const k of keys) st.read.delete(k);
  feedSchedule(project, true);
}

/** Re-apply the writes/deletes that landed DURING a tick over that tick's own
 *  snapshot, so the poke wins and not the stale read. Mutates `notes` and the
 *  read stamps in place, returns the key list to publish, and drains `pending`. */
function feedApplyPending(
  st: FeedState,
  keys: string[],
  notes: Record<string, BrainNoteEntry>,
): string[] {
  if (st.pending.size === 0) return keys;
  let out = keys;
  let added = false;
  for (const [k, p] of st.pending) {
    if (p.value === null) {
      delete notes[k];
      out = out.filter((x) => x !== k);
      st.read.delete(k);
    } else {
      notes[k] = { value: p.value, updated: p.at / 1000 };
      if (!out.includes(k)) { out = out === keys ? keys.slice() : out; out.push(k); added = true; }
      st.read.set(k, p.at);
    }
  }
  st.pending.clear();
  return added ? out.sort() : out;
}

/** One pass: keys + tasks, then only the bodies that are actually missing or due. */
async function feedTick(project: string) {
  const st = feeds.get(project);
  if (!st || st.ticking || st.subs.size === 0) return;
  st.ticking = true;
  try {
    const want = feedWants(st);
    const [keys, tasks] = await Promise.all([
      brainKeys(project),
      want.tasks ? brainTasks(project) : Promise.resolve(st.feed.tasks),
    ]);
    if (!feeds.has(project)) return; // unsubscribed while in flight
    const now = Date.now();
    const live = new Set(keys);
    const notes: Record<string, BrainNoteEntry> = {};
    for (const [k, e] of Object.entries(st.feed.notes)) if (live.has(k)) notes[k] = e;
    for (const k of [...st.read.keys()]) if (!live.has(k)) st.read.delete(k);

    // Seed a new prefix, and re-run the search every RECONCILE_MS. This is the
    // only read that carries mtimes, so it both orders the transcript and lets a
    // body rewritten under an existing key win over the cached one.
    const unseeded = [...want.prefixes].filter((p) => !st.seeded.has(p));
    const dueReconcile = want.prefixes.size > 0 && now - st.reconciledAt >= RECONCILE_MS;
    const searching = dueReconcile ? [...want.prefixes] : unseeded;
    if (searching.length > 0) {
      const results = await Promise.all(
        searching.map((p) => brainSearch(project, prefixQuery(p)).catch(() => [] as BrainHit[])),
      );
      searching.forEach((p, i) => {
        for (const h of results[i]) {
          if (h.elsewhere || !h.key.startsWith(p)) continue;
          // Only touch the entry when the BODY actually differs. A key we already
          // mirror carries a provisional mtime (the moment we first read it), and
          // rewriting that with the file's real mtime would look like a changed
          // note to everything keyed on (key, updated) — swarmDispatch would wake
          // a pane a second time for a message it has already delivered.
          const cur = notes[h.key];
          if (cur && cur.value === h.value) continue;
          notes[h.key] = { value: h.value, updated: h.updated };
          st.read.set(h.key, now);
        }
        st.seeded.add(p);
      });
      if (dueReconcile) st.reconciledAt = now;
    }

    // Bodies still missing: a prefix key we have never read, or a watched key
    // whose body is past its refresh gap.
    // Watched keys go first: they are a handful, they are what the gates read,
    // and the cap below must never starve them behind a big transcript.
    const need: string[] = [];
    for (const k of keys) {
      const seenAt = st.read.get(k);
      if (want.watch.has(k) && (seenAt === undefined || now - seenAt >= BODY_REFRESH_MS)) need.push(k);
    }
    for (const k of keys) {
      if (need.length >= MAX_BODY_FETCH) break;
      if (st.read.get(k) !== undefined || want.watch.has(k)) continue;
      if ([...want.prefixes].some((p) => k.startsWith(p))) need.push(k);
    }
    if (need.length > 0) {
      const bodies = await Promise.all(need.map((k) => brainNote(project, k).catch(() => null)));
      need.forEach((k, i) => {
        st.read.set(k, now);
        const v = bodies[i];
        if (v === null) delete notes[k];
        // A body we just read is current; keep whatever mtime the seed gave it so
        // the transcript's order does not jump, and stamp a fresh note with now.
        // NOTE: `now` is the READ time, not the file's mtime — brain_note does not
        // return one. Two notes from different senders first seen on the SAME tick
        // therefore tie on `updated` and fall back to the sequence number, until
        // the RECONCILE_MS search (the only read carrying real mtimes) corrects
        // them. Steady state is 1-2 new notes a tick, so ties are rare.
        else notes[k] = { value: v, updated: notes[k]?.updated ?? now / 1000 };
      });
    }

    st.feed = { ready: true, keys: feedApplyPending(st, keys, notes), tasks, notes, at: now };
    feedEmit(project);
  } catch {
    // Brain unavailable — keep the last snapshot and try again next tick, which
    // is what every one of these pollers did on its own before.
  } finally {
    st.ticking = false;
    feedSchedule(project);
  }
}

function feedSchedule(project: string, immediate = false) {
  const st = feeds.get(project);
  if (!st) return;
  if (st.timer) { clearTimeout(st.timer); st.timer = null; }
  if (st.subs.size === 0) return;
  st.timer = setTimeout(() => { void feedTick(project); }, immediate ? 0 : feedPeriod(st));
}

/** Subscribe to a swarm project's brain state. Returns the unsubscribe. */
export function subscribeBrainFeed(
  project: string,
  opts: BrainFeedOpts,
  cb: (f: BrainFeed) => void,
): () => void {
  let st = feeds.get(project);
  if (!st) {
    st = { subs: new Map(), feed: emptyFeed(), timer: null, ticking: false, read: new Map(), seeded: new Set(), reconciledAt: 0, pending: new Map() };
    feeds.set(project, st);
  }
  const id = ++feedSubId;
  st.subs.set(id, { opts, cb });
  // Hand the new subscriber what we already have, then tick now: a component
  // mounting mid-swarm must not wait a whole period to render anything, and a
  // new `watch`/`prefixes` set needs a pass to fill in.
  if (st.feed.ready) { try { cb(st.feed); } catch { /* ignore */ } }
  feedSchedule(project, true);
  return () => {
    const cur = feeds.get(project);
    if (!cur) return;
    cur.subs.delete(id);
    if (cur.subs.size > 0) { feedSchedule(project); return; }
    if (cur.timer) clearTimeout(cur.timer);
    // Keep nothing: a swarm nobody is watching should not hold its transcript in
    // memory, and the next subscriber re-seeds in one search.
    feeds.delete(project);
  };
}

/** The latest snapshot for a project, for the watchers that run on their own
 *  timer (swarmDispatch, swarmReset) rather than reacting to the callback. */
export function brainFeedNow(project: string): BrainFeed | undefined {
  return feeds.get(project)?.feed;
}

/** Bodies the feed holds under `prefix`, as search-shaped rows. */
export function feedNotesByPrefix(feed: BrainFeed, prefix: string): { key: string; value: string; updated: number }[] {
  return Object.entries(feed.notes)
    .filter(([k]) => k.startsWith(prefix))
    .map(([key, e]) => ({ key, value: e.value, updated: e.updated }));
}

// Coming back to a hidden window must not show a stale swarm: tick every feed at
// once instead of waiting out the slow hidden cadence.
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    for (const project of feeds.keys()) feedSchedule(project, !hiddenNow());
  });
}
