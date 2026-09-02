mod brain;
mod host;
mod hostclient;
mod notify;
mod ocr;
mod pty;
mod screenshot;
mod shells;
mod state;
mod swarm;
mod sysmon;
mod update;
// Wayland screen capture. Linux-only: it talks to KWin and xdg-desktop-portal.
#[cfg(target_os = "linux")]
mod wayland_shot;

/// The running build's version, so Settings can show what the user is actually
/// on. Nothing in the UI knew this before, which made a self-updating app
/// impossible to verify after an update (and impossible to report to support).
/// Same crate as `update`, so this is the exact value `check_update` compares
/// the feed's version against (update.rs:412).
#[tauri::command]
fn app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// The brain's base URL, for the UI to show the "point your agent here" snippet.
/// BigBrain runs in the host process now; read the URL it published.
#[tauri::command]
fn brain_url() -> String {
    host::read_brain_url()
}

use hostclient::HostClient;
use pty::SpawnOpts;
use tauri::State;

/// Swarm launch guard: make sure the working directory exists and is a git repo
/// with at least one commit, so the builders' worktree/branch protocol works
/// from task-1 even in an empty folder (`git worktree add -b` needs a HEAD, and
/// racing agents each running `git init` is chaos). Returns what it did.
#[tauri::command]
fn ensure_git_repo(cwd: String) -> Result<String, String> {
    let dir = std::path::PathBuf::from(&cwd);
    std::fs::create_dir_all(&dir).map_err(|e| format!("cannot create {cwd}: {e}"))?;
    let git = |args: &[&str]| {
        let mut c = std::process::Command::new("git");
        pty::strip_webview_env(&mut c);
        c.args(args).current_dir(&dir);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        c.output().map_err(|e| format!("git not available: {e}"))
    };
    let mut did = Vec::new();
    if !git(&["rev-parse", "--is-inside-work-tree"])?.status.success() {
        let init = git(&["init"])?;
        if !init.status.success() {
            return Err(format!("git init failed: {}", String::from_utf8_lossy(&init.stderr).trim()));
        }
        did.push("git init");
    }
    // Unborn HEAD (no commits yet): seed an empty commit. Retry with an inline
    // identity in case git has no global user.name/email configured.
    if !git(&["rev-parse", "--verify", "HEAD"])?.status.success() {
        let plain = git(&["commit", "--allow-empty", "-m", "swarm: initial commit"])?;
        if !plain.status.success() {
            let forced = git(&["-c", "user.name=swarm", "-c", "user.email=swarm@pixelmarch.local", "commit", "--allow-empty", "-m", "swarm: initial commit"])?;
            if !forced.status.success() {
                return Err(format!("initial commit failed: {}", String::from_utf8_lossy(&forced.stderr).trim()));
            }
        }
        did.push("initial empty commit");
    }
    // Builders put their worktrees in <repo>/.swarm/task-<n> so nothing is ever
    // created outside the project. Ignore it locally (.git/info/exclude, not
    // .gitignore) so the swarm never dirties a tracked file in the user's repo.
    if let Ok(out) = git(&["rev-parse", "--git-common-dir"]) {
        if out.status.success() {
            let gd = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !gd.is_empty() {
                let gitdir = dir.join(&gd); // absolute path stays absolute
                let excl = gitdir.join("info").join("exclude");
                let cur = std::fs::read_to_string(&excl).unwrap_or_default();
                if !cur.lines().any(|l| l.trim() == "/.swarm/") {
                    let _ = std::fs::create_dir_all(gitdir.join("info"));
                    let sep = if cur.is_empty() || cur.ends_with('\n') { "" } else { "\n" };
                    let _ = std::fs::write(&excl, format!("{cur}{sep}/.swarm/\n"));
                    did.push("ignore /.swarm/");
                }
            }
        }
    }
    Ok(did.join(" + "))
}

/// Re-exported for `main.rs`: run as the detached PTY host instead of the GUI.
pub fn run_host() {
    host::run_host();
}

/// Keep WebKitGTK's cache/storage in the profile instead of
/// ~/.local/share/<identifier>/, so a portable checkout writes nothing to $HOME.
/// Must run before GTK/WebKit initialise. Best-effort: a read-only install logs
/// once and keeps the default (home) location rather than failing to start.
pub fn redirect_webview_state() {
    let dir = match state::state_dir() {
        Ok(d) => d,
        Err(e) => {
            eprintln!("pixelmarch: cannot locate the profile directory ({e}); webview state stays in $HOME");
            return;
        }
    };
    if let Err(e) = pty::redirect_webview_state(&dir) {
        eprintln!("pixelmarch: profile directory is not writable ({e}); webview state stays in $HOME");
    }
}

/// Undo `redirect_webview_state` in a process that inherited it but owns no
/// webview — the detached session host. Every PTY shell copies the host's
/// environment, so the user's shell sees its own XDG paths, not ours.
pub fn restore_inherited_webview_env() {
    pty::restore_env_from_stash();
}

/// Re-exported for `main.rs`: after a self-update relaunch, block until the
/// previous GUI process has exited, so we start clean instead of racing its
/// single-instance lock and host handoff (that left reattached panes blank).
pub fn await_previous_exit(pid: u32) {
    update::wait_for_process_exit(pid);
}

/// Attach to (or spawn) the pane's session on the host, keyed by the pane id so
/// it reconnects to the same running shell after a GUI restart / update.
#[tauri::command]
fn pty_open(client: State<HostClient>, id: String, opts: SpawnOpts) {
    client.open(&id, opts);
}

/// Sync on purpose: keystroke bytes must reach the host in the order the
/// webview sent them, and Tauri v2 runs sync commands on the main event loop in
/// IPC message order — an `async` command is spawned on the multi-threaded
/// runtime, where two writes can land out of order. This stays cheap because
/// `HostClient::write` no longer blocks on the socket (see
/// `hostclient::spawn_write_loop`): it only serialises and pushes to the writer
/// thread's queue, so the main thread is not held by the socket any more.
#[tauri::command]
fn pty_write(client: State<HostClient>, id: String, data: String) {
    client.write(&id, &data);
}

#[tauri::command]
fn pty_resize(client: State<HostClient>, id: String, rows: u16, cols: u16) {
    client.resize(&id, rows, cols);
}

#[tauri::command]
fn pty_close(client: State<HostClient>, id: String) {
    client.close(&id);
}

/// Flow control for a pane's PTY — pause when the GUI's render queue backs up,
/// resume when it drains. See `host::ClientMsg::Pause`.
#[tauri::command]
fn pty_pause(client: State<HostClient>, id: String) {
    client.pause(&id);
}

#[tauri::command]
fn pty_resume(client: State<HostClient>, id: String) {
    client.resume(&id);
}

/// Full quit: tell the host to tree-kill every terminal and stop, then exit the
/// GUI. Called from the "Close all & quit" dialog.
#[tauri::command]
fn quit_app(app: tauri::AppHandle, client: State<HostClient>) {
    client.shutdown();
    app.exit(0);
}

/// Detach quit: exit only the GUI. The host and its terminals keep running, so
/// reopening (e.g. after dropping in an updated exe) reattaches everything.
#[tauri::command]
fn detach_quit(app: tauri::AppHandle) {
    app.exit(0);
}

/// Toggle the main window (for the global summon/hide hotkey).
fn toggle_main_window(app: &tauri::AppHandle) {
    use tauri::Manager;
    if let Some(win) = app.get_webview_window("main") {
        if win.is_visible().unwrap_or(false) {
            let _ = win.hide();
        } else {
            let _ = win.show();
            let _ = win.set_focus();
        }
    }
}

/// Default app-level global shortcuts. Owned by lib.rs and editable from the
/// Keybinds settings category via `app_shortcuts_get`/`app_shortcuts_set`.
const SCREENSHOT_SHORTCUT: &str = "CmdOrCtrl+Alt+S";
const SUMMON_SHORTCUT: &str = "CmdOrCtrl+Alt+Backquote";

/// The two app-level global shortcuts, persisted in the profile so a rebind
/// survives restarts (portable, same dir as `pixelmarch.json`).
#[derive(Clone, serde::Serialize, serde::Deserialize)]
struct AppShortcuts {
    summon: String,
    screenshot: String,
}

impl Default for AppShortcuts {
    fn default() -> Self {
        Self { summon: SUMMON_SHORTCUT.into(), screenshot: SCREENSHOT_SHORTCUT.into() }
    }
}

/// Process-wide current values, read by the global-shortcut handler to know
/// which combo means "screenshot" after a rebind.
fn app_shortcuts_cell() -> &'static std::sync::Mutex<AppShortcuts> {
    static CELL: std::sync::OnceLock<std::sync::Mutex<AppShortcuts>> = std::sync::OnceLock::new();
    CELL.get_or_init(|| std::sync::Mutex::new(AppShortcuts::default()))
}

fn app_shortcuts_file() -> Result<std::path::PathBuf, String> {
    Ok(state::state_dir()?.join("app-shortcuts.json"))
}

fn load_app_shortcuts() -> AppShortcuts {
    app_shortcuts_file()
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

/// Current app-level global shortcuts (summon/hide + screenshot), for the UI.
#[tauri::command]
fn app_shortcuts_get() -> AppShortcuts {
    app_shortcuts_cell().lock().unwrap().clone()
}

/// Rebind the app-level global shortcuts: unregister the old combos, register
/// the new ones with the OS, persist, and update the live value the handler reads.
#[tauri::command]
fn app_shortcuts_set(app: tauri::AppHandle, summon: String, screenshot: String) -> Result<(), String> {
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};
    let gs = app.global_shortcut();
    {
        let cur = app_shortcuts_cell().lock().unwrap();
        if let Ok(sc) = cur.summon.parse::<Shortcut>() {
            let _ = gs.unregister(sc);
        }
        if let Ok(sc) = cur.screenshot.parse::<Shortcut>() {
            let _ = gs.unregister(sc);
        }
    }
    gs.register(summon.as_str()).map_err(|e| format!("summon '{summon}': {e}"))?;
    gs.register(screenshot.as_str()).map_err(|e| format!("screenshot '{screenshot}': {e}"))?;
    let next = AppShortcuts { summon, screenshot };
    if let Ok(p) = app_shortcuts_file() {
        let _ = std::fs::write(p, serde_json::to_string_pretty(&next).unwrap_or_default());
    }
    *app_shortcuts_cell().lock().unwrap() = next;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    run_app(false)
}

/// The single app runner. `headless` — the `--swarm <profile> <prompt>`
/// self-run — runs the same app with the main window offscreen+hidden and
/// without the desktop furniture: no single-instance lock (a self-run must
/// start while a GUI is already up, not focus the other window and exit), no
/// tray, no global shortcuts (a summon shortcut would unhide the hidden
/// window). The webview runs
/// exactly as normal — that's where the swarm's React hooks live, and they
/// orchestrate the mission; swarmLaunch.ts exits the process when it is done.
fn run_app(headless: bool) {
    // Self-hosting escape hatch: a swarm working on PixelMarch from inside
    // PixelMarch must be able to launch the build it just made. The
    // single-instance lock is keyed on the app identifier, so a second exe
    // normally just focuses the running window. PIXELMARCH_INSTANCE=<tag>
    // suffixes the identifier, giving that launch (and re-launches with the
    // same tag) their own lock instead of colliding with the main app.
    let mut context = tauri::generate_context!();
    if let Ok(tag) = std::env::var("PIXELMARCH_INSTANCE") {
        let tag: String = tag.chars().filter(|c| c.is_ascii_alphanumeric()).collect();
        if !tag.is_empty() {
            let id = format!("{}.{}", context.config().identifier, tag);
            context.config_mut().identifier = id;
        }
    }
    let mut builder = tauri::Builder::default();
    if !headless {
        // Single-instance must be registered first: a second launch focuses the
        // existing window instead of opening another. (Skipped for the headless
        // self-run: it must start alongside a live GUI, not focus it and exit.)
        builder = builder
            .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
                use tauri::Manager;
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.unminimize();
                    let _ = win.show();
                    let _ = win.set_focus();
                }
            }));
    }
    builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    let pressed =
                        event.state == tauri_plugin_global_shortcut::ShortcutState::Pressed;
                    if pressed {
                        // The screenshot shortcut captures every monitor to its
                        // own file; every other shortcut is summon/hide. The
                        // screenshot combo is read live so a rebind takes effect.
                        let screenshot_combo = app_shortcuts_cell().lock().unwrap().screenshot.clone();
                        let snip: Option<tauri_plugin_global_shortcut::Shortcut> =
                            screenshot_combo.parse().ok();
                        if snip.as_ref() == Some(shortcut) {
                            let app = app.clone();
                            std::thread::spawn(move || {
                                if let Err(e) = screenshot::capture_all(&app) {
                                    // The hotkey path has no return value to the
                                    // webview, so a stderr line was the ONLY
                                    // trace a failed capture left — from the
                                    // user's side the hotkey just did nothing.
                                    eprintln!("screenshot failed: {e}");
                                    use tauri::Emitter;
                                    let _ = app.emit("screenshot-error", e);
                                }
                            });
                        } else {
                            // Not the screenshot shortcut: it's the summon/hide toggle.
                            toggle_main_window(app);
                        }
                    }
                })
                .build(),
        )
        .setup(move |app| {
            use tauri::Manager;
            use tauri_plugin_global_shortcut::GlobalShortcutExt;
            // Sweep the leftover exe from a previous self-update, if any.
            // The brain's note index is PER PROCESS and the `brain_*` IPC commands read
            // THIS one, so the GUI needs its own warm-up + rescan thread. Without it the
            // BigBrain panel, SwarmChat, SwarmHealthStrip and SwarmMission would freeze
            // at whatever disk held when the GUI first read: every swarm note is written
            // by agents over HTTP, i.e. in the host process, not here.
            // Safe to call ahead of the host connect below: this only spawns the watch
            // thread — the warm-up walk runs INSIDE that thread, so it adds nothing to
            // the window before `app.manage(client)` that the next comment guards.
            brain::start_index_watch();
            // Connect to (or launch) the detached PTY host and register managed
            // state FIRST, before the slower inits below.
            // The webview can start loading and invoke pty_open the moment the
            // window appears; if manage() runs after those slow inits we race and
            // pty_open fails with "state not managed for field `client`".
            // The host outlives the GUI — it owns both the terminals AND BigBrain
            // — so both survive a GUI restart/update.
            let client = HostClient::connect(app.handle().clone());
            // A GUI with no host has no terminals at all — every pty_* command
            // silently does nothing. That is worth saying out loud, especially
            // right after a self-update (which stops the old host deliberately
            // and relies on this connect to start the new one): a window whose
            // terminals quietly do nothing reads as a broken app, not as a
            // failed sidecar.
            if !client.connected() {
                eprintln!("terminal host failed to start — terminals will not work");
                let _ = notify::notify(
                    "PixelMarch",
                    "The terminal host failed to start, so terminals will not work. \
                     Quitting and reopening PixelMarch usually fixes it.",
                );
            }
            app.manage(client);
            app.manage(sysmon::SysMon::new());
            if !headless {
                // App-level global shortcuts (summon/hide + screenshot), from the
                // persisted app-shortcuts.json if present, else the defaults. Editable
                // at runtime via app_shortcuts_set (Keybinds settings category).
                let app_sc = load_app_shortcuts();
                let _ = app.global_shortcut().register(app_sc.summon.as_str());
                let _ = app.global_shortcut().register(app_sc.screenshot.as_str());
                *app_shortcuts_cell().lock().unwrap() = app_sc;
            }
            // asset: protocol scope. Config ships an EMPTY static scope (was
            // ["**"] — the webview could read ANY file on disk via asset://).
            // The only asset consumers are the portable screenshots + brain
            // dirs, which sit in the profile. Their exact paths are only known
            // at runtime (state::state_dir = <repo>/data); no static
            // scope var works cross-platform ($EXE = dirs::executable_dir(),
            // which is None on Windows/macOS), so allow them here instead.
            if let Ok(dir) = state::screenshots_dir() {
                let _ = app.asset_protocol_scope().allow_directory(&dir, true);
            }
            if let Ok(base) = state::state_dir() {
                let _ = app.asset_protocol_scope().allow_directory(base.join("brain"), true);
            }
            if headless {
                // Offscreen first — a window manager may briefly map a new
                // window before the hide lands — then hidden. The webview must
                // keep running (the swarm's React hooks live in it), but
                // nothing visible may exist.
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.set_position(tauri::PhysicalPosition::new(-10_000, -10_000));
                    let _ = win.hide();
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            pty_open, pty_write, pty_resize, pty_close, pty_pause, pty_resume, quit_app, detach_quit, ensure_git_repo,
            pty::hook_settings_path,
            pty::mcp_config_path,
            state::load_state, state::save_state, state::state_path,
            state::write_text, state::read_text, state::pick_markdown_file, state::pick_folder,
            state::append_text, state::logs_dir, state::backup_corrupt_state,
            state::screenshots_dir,
            screenshot::screenshot_start, screenshot::screenshot_list,
            screenshot::screenshot_save_crop, screenshot::screenshot_read_png, screenshot::screenshot_delete,
            screenshot::snip_source, screenshot::snip_close, screenshot::snip_close_all,
            screenshot::screenshot_ocr,
            screenshot::screenshot_retention_get, screenshot::screenshot_retention_set,
            screenshot::screenshot_protect,
            app_shortcuts_get, app_shortcuts_set,
            shells::detect_shells,
            sysmon::sysinfo_snapshot,
            app_version,
            brain_url,
            brain::brain_projects, brain::brain_keys, brain::brain_note,
            brain::brain_save, brain::brain_delete, brain::brain_delete_project,
            brain::brain_search, brain::brain_tasks, brain::brain_info, brain::brain_set_info,
            brain::brain_create_project, brain::brain_build_stamp,
            brain::brain_patch, brain::brain_replace,
            brain::brain_chat, brain::brain_resets, brain::brain_reclaims,
            brain::brain_task_status, brain::brain_chat_send, brain::brain_reclaim_task,
            brain::swarm_register_agents, brain::swarm_unregister_agents,
            swarm::swarm_worktree_add, swarm::swarm_merge_task, swarm::swarm_repo_dirty,
            swarm::swarm_untracked,
            swarm::swarm_worktree_sweep,
            swarm::swarm_worktree_owner, swarm::swarm_park_strays,
            swarm::swarm_repo_head, swarm::swarm_branch_tip,
            swarm::swarm_guard_install, swarm::swarm_guard_remove,
            swarm::swarm_guard_probe, swarm::swarm_reclaim,
            pty::swarm_mcp_config,
            update::check_update, update::apply_update, update::update_configured,
            swarm_headless_request, headless_fail
        ])
        .run(context)
        .expect("error while running tauri application");
}

// ── Headless self-run — `pixelmarch --swarm <profile> <prompt>` ──────────────
//
// Run one swarm with no human in front of the screen: the CLI resolves the
// profile to a cwd + agent command (failing on the terminal when it cannot),
// runs the app with the window hidden, and the webview's swarmLaunch.ts picks
// the request up via `swarm_headless_request`, launches through the SAME
// shared path as the dialog, and exits the process when the mission completes.

/// The `--swarm` request, resolved CLI-side and handed to the webview.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HeadlessSwarmRequest {
    /// The prompt: the swarm's mission, verbatim.
    pub mission: String,
    /// The profile's working directory: every agent's cwd, and the repo the
    /// swarm's worktrees and guard live in.
    pub cwd: String,
    /// Agent command for every role — the profile's startup command, or
    /// "claude" (swarm.ts's DEFAULT_AGENT_CMD) when the profile has none.
    pub agent: String,
    /// True when THIS process spawned the PTY host (no host was running):
    /// exiting may shut the host down. False = a live instance owns the host
    /// (and BigBrain), so only this GUI may go — never its terminals.
    pub owns_host: bool,
}

static HEADLESS_REQUEST: std::sync::OnceLock<std::sync::Mutex<Option<HeadlessSwarmRequest>>> =
    std::sync::OnceLock::new();

fn headless_slot() -> &'static std::sync::Mutex<Option<HeadlessSwarmRequest>> {
    HEADLESS_REQUEST.get_or_init(|| std::sync::Mutex::new(None))
}

/// Pull `--swarm <profile> <prompt>` out of the argv, wherever it sits.
/// `Ok(None)` = flag absent; `Err` = present but incomplete. Thin pure helper
/// so main.rs (a binary crate, untestable from the suite) gets its parsing
/// covered here.
pub fn parse_swarm_args(args: &[String]) -> Result<Option<(String, String)>, String> {
    for (i, arg) in args.iter().enumerate() {
        if arg != "--swarm" {
            continue;
        }
        let profile = args
            .get(i + 1)
            .ok_or("--swarm needs a profile name: --swarm <profile> <prompt>")?;
        let prompt = args
            .get(i + 2)
            .ok_or("--swarm needs a prompt: --swarm <profile> <prompt>")?;
        return Ok(Some((profile.clone(), prompt.clone())));
    }
    Ok(None)
}

/// Agent command when the profile has no startup command — mirrors
/// DEFAULT_AGENT_CMD in lib/swarm.ts, which the launch builds the panes from.
const DEFAULT_AGENT_CMD: &str = "claude";

/// Resolve a profile name against the persisted state JSON (data/pixelmarch.json,
/// written by the frontend — the frontend owns the schema) to the swarm's
/// working directory and agent command. The error strings are user-facing:
/// on the CLI path they are printed before any window exists.
fn profile_name(p: &serde_json::Value) -> &str {
    p.get("name").and_then(|n| n.as_str()).unwrap_or("")
}

pub fn headless_request_from_state(
    state_json: Option<&str>,
    profile: &str,
) -> Result<(String, String), String> {
    let v: serde_json::Value = state_json
        .and_then(|s| serde_json::from_str(s).ok())
        .ok_or_else(|| {
            "no saved state (data/pixelmarch.json) — launch the app once and save a profile"
                .to_string()
        })?;
    let profiles = v
        .get("profiles")
        .and_then(|p| p.as_array())
        .filter(|p| !p.is_empty())
        .ok_or_else(|| {
            "no profiles in the saved state — save a terminal profile from the app first"
                .to_string()
        })?;
    let wanted = profile.trim();
    let prof = profiles
        .iter()
        .find(|p| profile_name(p) == wanted)
        .or_else(|| {
            let lower = wanted.to_lowercase();
            profiles.iter().find(|p| profile_name(p).to_lowercase() == lower)
        })
        .ok_or_else(|| {
            let known = profiles
                .iter()
                .map(profile_name)
                .filter(|n| !n.is_empty())
                .collect::<Vec<_>>()
                .join(", ");
            format!("no profile named {wanted:?} (known profiles: {known})")
        })?;
    let cwd = prof
        .get("cwd")
        .and_then(|c| c.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| format!("profile {wanted:?} has no working directory set"))?
        .to_string();
    let agent = prof
        .get("startupCommand")
        .and_then(|c| c.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(DEFAULT_AGENT_CMD)
        .to_string();
    Ok((cwd, agent))
}

/// True when a PTY host is already answering on its published port — i.e. a
/// live PixelMarch instance owns the host (and BigBrain) this process would
/// otherwise spawn. A headless run that borrows a host must exit GUI-only.
fn host_is_running() -> bool {
    let port = match std::fs::read_to_string(host::port_file())
        .ok()
        .and_then(|s| s.trim().parse::<u16>().ok())
    {
        Some(p) => p,
        None => return false,
    };
    std::net::TcpStream::connect(("127.0.0.1", port)).is_ok()
}

/// `--swarm <profile> <prompt>`: run one swarm in a hidden window and exit
/// when the mission completes. Resolves the profile first, so a bad profile
/// fails on the terminal BEFORE any window exists. Never returns.
pub fn run_swarm_headless(profile: &str, prompt: &str) -> ! {
    let state = state::load_state().ok().flatten();
    let (cwd, agent) = match headless_request_from_state(state.as_deref(), profile) {
        Ok(x) => x,
        Err(e) => {
            eprintln!("pixelmarch --swarm: {e}");
            let _ = notify::notify("PixelMarch", &e);
            std::process::exit(2);
        }
    };
    *headless_slot().lock().unwrap() = Some(HeadlessSwarmRequest {
        mission: prompt.to_string(),
        cwd,
        agent,
        owns_host: !host_is_running(),
    });
    run_app(true);
    // run_app blocks until the app exits (the webview's quit/detach-quit on
    // mission completion). If it ever returns anyway, exit cleanly — a
    // fallthrough would start a second, fully visible app from the CLI.
    std::process::exit(0);
}

/// The pending `--swarm` request for this process, or None for a normal GUI
/// launch. swarmLaunch.ts asks once at webview boot; a plain GUI launch gets
/// None and never sees this.
#[tauri::command]
fn swarm_headless_request() -> Option<HeadlessSwarmRequest> {
    headless_slot().lock().unwrap().clone()
}

/// A headless launch failed in the webview (untracked root files, no brain,
/// …). The window is hidden, so the terminal is the only surface: print,
/// notify, and exit non-zero so the caller's script sees the failure.
#[tauri::command]
fn headless_fail(msg: String) {
    eprintln!("pixelmarch --swarm: {msg}");
    let _ = notify::notify("PixelMarch", &msg);
    // Let stderr drain before the process dies.
    std::thread::sleep(std::time::Duration::from_millis(300));
    std::process::exit(1);
}

#[cfg(test)]
mod headless_tests {
    use super::*;

    const STATE: &str = r#"{
      "activeId": "ws1",
      "workspaces": [],
      "profiles": [
        { "id": "p1", "name": "repo", "cwd": "/home/u/proj", "startupCommand": "claude --dangerously-skip-permissions" },
        { "id": "p2", "name": "Bare", "cwd": "/home/u/bare" },
        { "id": "p3", "name": "NoCwd", "startupCommand": "codex" },
        { "id": "p4", "name": "Blank", "cwd": "   ", "startupCommand": "  " }
      ]
    }"#;

    fn args(xs: &[&str]) -> Vec<String> {
        xs.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn parse_swarm_args_absent() {
        assert_eq!(parse_swarm_args(&args(&[])), Ok(None));
        assert_eq!(parse_swarm_args(&args(&["pixelmarch"])), Ok(None));
        assert_eq!(
            parse_swarm_args(&args(&["pixelmarch", "--await-exit", "4242"])),
            Ok(None)
        );
    }

    #[test]
    fn parse_swarm_args_present_anywhere() {
        let got = parse_swarm_args(&args(&["pixelmarch", "--swarm", "repo", "ship it"]))
            .unwrap()
            .unwrap();
        assert_eq!(got, ("repo".to_string(), "ship it".to_string()));
        // With other flags around it; the prompt is ONE argv entry, spaces and all.
        let got = parse_swarm_args(&args(&[
            "pixelmarch",
            "--await-exit",
            "1",
            "--swarm",
            "repo",
            "fix the thing",
        ]))
        .unwrap()
        .unwrap();
        assert_eq!(got, ("repo".to_string(), "fix the thing".to_string()));
    }

    #[test]
    fn parse_swarm_args_incomplete() {
        let e = parse_swarm_args(&args(&["pixelmarch", "--swarm", "repo"]))
            .unwrap_err();
        assert!(e.contains("prompt"), "{e}");
        let e = parse_swarm_args(&args(&["pixelmarch", "--swarm"])).unwrap_err();
        assert!(e.contains("profile"), "{e}");
    }

    #[test]
    fn resolve_profile_cwd_and_agent() {
        let (cwd, agent) = headless_request_from_state(Some(STATE), "repo").unwrap();
        assert_eq!(cwd, "/home/u/proj");
        assert_eq!(agent, "claude --dangerously-skip-permissions");
    }

    #[test]
    fn resolve_profile_case_insensitive() {
        let (cwd, _) = headless_request_from_state(Some(STATE), "REPO").unwrap();
        assert_eq!(cwd, "/home/u/proj");
    }

    #[test]
    fn resolve_profile_defaults_agent_to_claude() {
        let (_, agent) = headless_request_from_state(Some(STATE), "Bare").unwrap();
        assert_eq!(agent, "claude");
    }

    #[test]
    fn resolve_profile_errors() {
        assert!(headless_request_from_state(None, "repo").is_err());
        assert!(headless_request_from_state(Some("{ not json"), "repo").is_err());
        assert!(headless_request_from_state(Some(r#"{"profiles": []}"#), "repo").is_err());
        let e = headless_request_from_state(Some(STATE), "nope").unwrap_err();
        assert!(e.contains("nope"), "{e}");
        assert!(e.contains("repo") && e.contains("Bare"), "known names listed: {e}");
        assert!(headless_request_from_state(Some(STATE), "NoCwd")
            .unwrap_err()
            .contains("working directory"));
        // Whitespace-only cwd/startupCommand count as unset (cwd is checked first).
        assert!(headless_request_from_state(Some(STATE), "Blank")
            .unwrap_err()
            .contains("working directory"));
    }
}
