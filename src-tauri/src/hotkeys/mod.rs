//! Global Hotkeys — folded in from KeyForge (Z:/SVN/KeyForge, a standalone
//! egui app). The Rust hotkey engine + JSON model are PORTED here; the UI is
//! rebuilt in React (src/components/HotkeyManager.tsx). Registration reuses the
//! app's existing tauri-plugin-global-shortcut rather than KeyForge's raw
//! global-hotkey crate, so there is one OS shortcut owner.
//!
//! This layer is the bridge between the hotkey engine and the KeyForge macro
//! engine (`crate::macros`): a `RunMacro` binding fires a macro through a
//! `macros::Dispatcher`, and an always-registered emergency-stop hotkey (with
//! every modifier superset registered) cancels all running macros and releases
//! held keys/mouse. Input synthesis / window / audio actions live in the macro
//! engine and are reached only through macros, not as bare hotkey actions.

mod bindings;
mod engine;

pub use bindings::{Action, Binding, Profile, DEFAULT_ESTOP, SCHEMA_VERSION};
use engine::{emergency_supersets, HotkeyBackend, HotkeyEngine};

use crate::macros::{self, Dispatcher, Executions, Inputs, Services};
use crate::pty::strip_webview_env;
use serde::Serialize;
use std::collections::HashMap;
use std::process::Command;
use std::str::FromStr;
use std::sync::{Arc, Mutex};
use tauri::{Manager, State};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};

/// Registered combo → action, matched by `Shortcut` identity in the plugin's
/// event handler (see `dispatch`). Shared between the backend (writes it on
/// every sync) and the handler (reads it when a shortcut fires).
type ActiveMap = Arc<Mutex<Vec<(Shortcut, Action)>>>;

/// The tauri-plugin-global-shortcut backend. Binds each action at register time
/// so the fired `Shortcut` maps straight to its action, and only unregisters
/// combos IT registered — never the screenshot/summon shortcuts lib.rs owns.
struct PluginBackend {
    app: tauri::AppHandle,
    registered: Vec<Shortcut>,
    active: ActiveMap,
}

impl HotkeyBackend for PluginBackend {
    fn apply(&mut self, desired: &[(String, Action)]) -> Vec<(String, String)> {
        let gs = self.app.global_shortcut();
        for sc in self.registered.drain(..) {
            let _ = gs.unregister(sc);
        }
        let mut errors = Vec::new();
        let mut active = Vec::new();
        for (combo, action) in desired {
            match Shortcut::from_str(combo) {
                Ok(sc) => match gs.register(sc.clone()) {
                    Ok(()) => {
                        self.registered.push(sc.clone());
                        active.push((sc, action.clone()));
                    }
                    Err(e) => errors.push((combo.clone(), e.to_string())),
                },
                Err(e) => errors.push((combo.clone(), format!("invalid combo: {e}"))),
            }
        }
        *self.active.lock().unwrap() = active;
        errors
    }
}

/// Managed state: the engine, the current profile, the shared active map, and the
/// macro-engine dispatcher plus the reserved emergency-stop registration.
pub struct HotkeyRuntime {
    engine: Mutex<HotkeyEngine>,
    profile: Mutex<Profile>,
    active: ActiveMap,
    path: std::path::PathBuf,
    /// Fires `RunMacro` actions and services the emergency stop. Cloneable; holds
    /// its own tokio runtime handle + `Arc<Services>`.
    dispatcher: Dispatcher,
    /// The tokio runtime the dispatcher spawns macro executions on. Owned here so
    /// it outlives the app; dropping it would abort in-flight macros.
    _runtime: tokio::runtime::Runtime,
    /// The `Shortcut`s currently registered for the emergency stop (the configured
    /// combo plus every modifier superset). Checked first in the fire handler.
    estop: Mutex<Vec<Shortcut>>,
}

/// Build the macro-engine services bundle with the real OS-backed implementations.
fn build_services() -> Services {
    Services {
        inputs: Inputs::new(),
        wm: Box::new(macros::NativeWindowManager),
        audio: Box::new(macros::NativeAudioManager),
        usb: Box::new(macros::NativeUsbEnumerator),
    }
}

/// Register the emergency-stop combo and all its modifier supersets, returning the
/// `Shortcut`s that took. Never fatal — a superset the OS refuses is just skipped.
fn register_estop(app: &tauri::AppHandle, combo: &str) -> Vec<Shortcut> {
    let gs = app.global_shortcut();
    let mut registered = Vec::new();
    for superset in emergency_supersets(combo) {
        match Shortcut::from_str(&superset) {
            Ok(sc) => match gs.register(sc.clone()) {
                Ok(()) => registered.push(sc),
                Err(e) => eprintln!("hotkeys: estop '{superset}' register failed: {e}"),
            },
            Err(e) => eprintln!("hotkeys: estop '{superset}' invalid: {e}"),
        }
    }
    registered
}

/// Load the persisted profile and register its enabled bindings. Call once from
/// the tauri `setup` hook (after the global-shortcut plugin is initialized).
pub fn init(app: &tauri::AppHandle) {
    let path = match bindings::profile_path() {
        Ok(p) => p,
        Err(e) => {
            eprintln!("hotkeys: cannot resolve profile path: {e}");
            return;
        }
    };
    let profile = Profile::load_or_create(&path);
    let active: ActiveMap = Arc::new(Mutex::new(Vec::new()));
    let backend = PluginBackend { app: app.clone(), registered: Vec::new(), active: Arc::clone(&active) };
    let mut engine = HotkeyEngine::new(Box::new(backend));
    engine.sync(&profile);

    // Macro engine wiring: a dedicated multi-thread tokio runtime (kept alive in
    // state) hosts macro executions off the UI thread, mirroring KeyForge's main.rs.
    let runtime = match tokio::runtime::Runtime::new() {
        Ok(rt) => rt,
        Err(e) => {
            eprintln!("hotkeys: cannot start macro runtime: {e}; macros disabled");
            return;
        }
    };
    let macros_dir = match crate::state::state_dir() {
        Ok(d) => d.join("macros"),
        Err(e) => {
            eprintln!("hotkeys: cannot resolve macros dir: {e}; macros disabled");
            return;
        }
    };
    let _ = std::fs::create_dir_all(&macros_dir);
    macros::model::seed_example(&macros_dir);
    let dispatcher = Dispatcher {
        handle: runtime.handle().clone(),
        executions: Arc::new(Executions::default()),
        services: Arc::new(build_services()),
        macros_dir,
    };

    // Emergency stop: always registered, with modifier supersets, so it fires even
    // while a macro is holding an extra modifier down.
    let estop = register_estop(app, &profile.emergency_stop);

    app.manage(HotkeyRuntime {
        engine: Mutex::new(engine),
        profile: Mutex::new(profile),
        active,
        path,
        dispatcher,
        _runtime: runtime,
        estop: Mutex::new(estop),
    });
}

/// Called FIRST from lib.rs's fire handler: if the shortcut is the emergency stop
/// (or one of its modifier supersets), cancel every running macro and release all
/// held keys/mouse, returning true so nothing else acts on the combo.
pub fn handle_estop(app: &tauri::AppHandle, shortcut: &Shortcut) -> bool {
    let Some(rt) = app.try_state::<HotkeyRuntime>() else { return false };
    let is_estop = rt.estop.lock().unwrap().iter().any(|sc| sc == shortcut);
    if is_estop {
        rt.dispatcher.emergency_stop();
    }
    is_estop
}

/// Called from lib.rs's global-shortcut handler when a shortcut fires. Returns
/// true if the combo was a bound hotkey (and its action was run), so the caller
/// knows not to also treat it as the summon/hide toggle.
pub fn dispatch(app: &tauri::AppHandle, shortcut: &Shortcut) -> bool {
    let Some(rt) = app.try_state::<HotkeyRuntime>() else { return false };
    let action = rt
        .active
        .lock()
        .unwrap()
        .iter()
        .find(|(sc, _)| sc == shortcut)
        .map(|(_, a)| a.clone());
    match action {
        Some(a) => {
            run_action(&a, &rt.dispatcher);
            true
        }
        None => false,
    }
}

/// Execute a hotkey action. Failures are logged, never fatal — a bad path in
/// the profile must not take down the app. `RunMacro` hands off to the macro
/// engine's dispatcher, which runs it on its own runtime.
fn run_action(action: &Action, dispatcher: &Dispatcher) {
    let spawned = match action {
        Action::RunMacro { id } => {
            dispatcher.run_macro_by_id(id);
            return;
        }
        Action::LaunchProgram { path, args } => {
            let mut c = Command::new(path);
            strip_webview_env(&mut c).args(args).spawn()
        }
        Action::RunCommand { command } => {
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                let mut c = Command::new("cmd");
                c.args(["/C", command]).creation_flags(0x0800_0000); // CREATE_NO_WINDOW
                strip_webview_env(&mut c).spawn()
            }
            #[cfg(not(windows))]
            {
                let mut c = Command::new("sh");
                strip_webview_env(&mut c).args(["-c", command]).spawn()
            }
        }
    };
    if let Err(e) = spawned {
        eprintln!("hotkeys: action failed ({}): {e}", action.summary());
    }
}

/// What the UI reads: the current bindings, the emergency-stop combo, plus a
/// per-combo error map (normalized combo → why it is inactive: conflict / invalid
/// / OS refusal).
#[derive(Serialize)]
pub struct HotkeyView {
    pub bindings: Vec<Binding>,
    pub emergency_stop: String,
    pub errors: HashMap<String, String>,
}

#[tauri::command]
pub fn hotkeys_list(rt: State<HotkeyRuntime>) -> HotkeyView {
    let profile = rt.profile.lock().unwrap();
    let bindings = profile.bindings.clone();
    let emergency_stop = profile.emergency_stop.clone();
    let errors = rt.engine.lock().unwrap().errors().clone();
    HotkeyView { bindings, emergency_stop, errors }
}

/// Replace the whole binding set: persist to hotkeys/default.json, re-register
/// with the OS, and return the fresh view (with any conflict/registration
/// errors). The frontend edits the list locally and saves the whole thing —
/// simpler and race-free versus index-based add/update/delete commands.
#[tauri::command]
pub fn hotkeys_save(rt: State<HotkeyRuntime>, bindings: Vec<Binding>) -> HotkeyView {
    // Preserve the emergency-stop combo (edited via hotkeys_set_estop, not here).
    let emergency_stop = rt.profile.lock().unwrap().emergency_stop.clone();
    let profile = Profile { schema_version: SCHEMA_VERSION, bindings, emergency_stop };
    profile.save(&rt.path);
    let errors = {
        let mut eng = rt.engine.lock().unwrap();
        eng.sync(&profile);
        eng.errors().clone()
    };
    let bindings = profile.bindings.clone();
    let emergency_stop = profile.emergency_stop.clone();
    *rt.profile.lock().unwrap() = profile;
    HotkeyView { bindings, emergency_stop, errors }
}

/// Rebind the emergency-stop hotkey: unregister the old supersets, register the
/// new ones, persist to the profile, and return the refreshed view. An empty or
/// unparseable combo falls back to the KeyForge default rather than leaving the
/// safety stop unregistered.
#[tauri::command]
pub fn hotkeys_set_estop(app: tauri::AppHandle, rt: State<HotkeyRuntime>, combo: String) -> HotkeyView {
    let combo = if combo.trim().is_empty() { DEFAULT_ESTOP.to_string() } else { combo };
    let gs = app.global_shortcut();
    // Drop the previously registered estop supersets before registering the new set.
    for sc in rt.estop.lock().unwrap().drain(..) {
        let _ = gs.unregister(sc);
    }
    let registered = register_estop(&app, &combo);
    *rt.estop.lock().unwrap() = registered;

    let (bindings, emergency_stop, save) = {
        let mut profile = rt.profile.lock().unwrap();
        profile.emergency_stop = combo;
        (profile.bindings.clone(), profile.emergency_stop.clone(), profile.clone())
    };
    save.save(&rt.path);
    let errors = rt.engine.lock().unwrap().errors().clone();
    HotkeyView { bindings, emergency_stop, errors }
}

// ------------------------------------------------------------- macro surface
// Commands the Keybinds/Macros/Devices UI (task-6) consumes. The macro-engine
// device types are UI-agnostic and not `Serialize`, so they are projected onto
// local DTOs here.

/// A macro from the on-disk library, trimmed to what a picker/list needs.
#[derive(Serialize)]
pub struct MacroInfo {
    pub id: String,
    pub name: String,
    pub description: String,
}

/// List the macro library (`<exe>/macros/*.json`), sorted by name.
#[tauri::command]
pub fn macros_list(rt: State<HotkeyRuntime>) -> Vec<MacroInfo> {
    let lib = macros::MacroLibrary::load(&rt.dispatcher.macros_dir);
    lib.iter_sorted()
        .into_iter()
        .map(|m| MacroInfo { id: m.id.clone(), name: m.name.clone(), description: m.description.clone() })
        .collect()
}

/// Run a macro by id (or unique name) — same path a `RunMacro` hotkey takes.
#[tauri::command]
pub fn macros_run(rt: State<HotkeyRuntime>, id: String) {
    rt.dispatcher.run_macro_by_id(&id);
}

/// Emergency "Stop all": cancel every running macro + release held keys/mouse.
/// Returns how many executions were live (best-effort informational count).
#[tauri::command]
pub fn macros_stop_all(rt: State<HotkeyRuntime>) -> usize {
    let n = rt.dispatcher.executions.count();
    rt.dispatcher.emergency_stop();
    n
}

// ------------------------------------------------------ macro editor test run
// The play button in MacroEditor runs the DRAFT the user is editing — the macro
// never has to be saved first. Progress is broadcast per top-level step so the
// editor can render a live run log; `macros_test_cancel` stops that one run
// without touching other macros (unlike the emergency `macros_stop_all`).

/// Per-step progress. Payload = `macros::exec::StepProgress`
/// {run_id, index, total, summary, status: start|ok|skipped|error, error?}.
pub const TEST_STEP_EVENT: &str = "macro-test-step";
/// One per test run, after the last step. Payload = `TestRunDone`.
pub const TEST_DONE_EVENT: &str = "macro-test-done";

/// End of a test run: `completed` (ran off the end), `stopped` (a Stop Macro
/// step or a cancel), or `error` with the engine's message.
#[derive(Serialize, Clone)]
pub struct TestRunDone {
    pub run_id: u64,
    pub status: &'static str,
    pub error: Option<String>,
}

/// Start a test run of an unsaved draft. `only` (when set) runs just that
/// top-level step. Returns the run id to pass to `macros_test_cancel`; the run
/// itself reports through the `macro-test-step` / `macro-test-done` events.
fn start_test_run(
    app: &tauri::AppHandle,
    rt: &State<HotkeyRuntime>,
    draft: serde_json::Value,
    only: Option<usize>,
) -> Result<u64, String> {
    use tauri::Emitter;
    let mac: macros::Macro =
        serde_json::from_value(draft).map_err(|e| format!("invalid macro: {e}"))?;
    let step_app = app.clone();
    let sink: macros::exec::StepSink = Arc::new(move |p: macros::exec::StepProgress| {
        let _ = step_app.emit(TEST_STEP_EVENT, p);
    });
    let done_app = app.clone();
    Ok(rt.dispatcher.spawn_test_macro(mac, only, sink, move |run_id, result| {
        let done = match result {
            Ok(macros::Outcome::Completed) => TestRunDone { run_id, status: "completed", error: None },
            Ok(macros::Outcome::Stopped) => TestRunDone { run_id, status: "stopped", error: None },
            Err(macros::ExecError::Cancelled) => TestRunDone { run_id, status: "stopped", error: None },
            Err(e) => TestRunDone { run_id, status: "error", error: Some(e.to_string()) },
        };
        let _ = done_app.emit(TEST_DONE_EVENT, done);
    }))
}

/// Run the whole draft currently in the editor.
#[tauri::command]
pub fn macros_test_run(
    app: tauri::AppHandle,
    rt: State<HotkeyRuntime>,
    r#macro: serde_json::Value,
) -> Result<u64, String> {
    start_test_run(&app, &rt, r#macro, None)
}

/// Run ONE top-level step of the draft (0-based index into `macro.steps`).
#[tauri::command]
pub fn macros_test_step(
    app: tauri::AppHandle,
    rt: State<HotkeyRuntime>,
    r#macro: serde_json::Value,
    index: usize,
) -> Result<u64, String> {
    start_test_run(&app, &rt, r#macro, Some(index))
}

/// Stop one test run by id. `false` = it had already finished.
#[tauri::command]
pub fn macros_test_cancel(rt: State<HotkeyRuntime>, run_id: u64) -> bool {
    rt.dispatcher.executions.cancel(run_id)
}

/// Path to a macro's JSON file, guarding against ids that would escape the
/// macros dir (they come from the library, but never trust a path built from a
/// caller-supplied string).
fn macro_file(dir: &std::path::Path, id: &str) -> Result<std::path::PathBuf, String> {
    let id = id.trim();
    if id.is_empty() || id.contains(['/', '\\']) || id.contains("..") {
        return Err(format!("invalid macro id: {id:?}"));
    }
    Ok(dir.join(format!("{id}.json")))
}

/// Generate a KeyForge-style macro id: `m-<hex nanos since epoch>` (app.rs:250).
fn new_macro_id() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("m-{nanos:x}")
}

/// Read one macro's full JSON from `<macros dir>/<id>.json` for the editor.
/// `None` if the file is absent or unreadable — the editor treats that as "new".
#[tauri::command]
pub fn macros_get(rt: State<HotkeyRuntime>, id: String) -> Option<serde_json::Value> {
    let path = macro_file(&rt.dispatcher.macros_dir, &id).ok()?;
    let text = std::fs::read_to_string(&path).ok()?;
    serde_json::from_str(&text).ok()
}

/// Create or overwrite a macro. An empty `id` mints a fresh one; the macro is
/// validated by round-tripping through `Macro`, written as pretty JSON to
/// `<id>.json`, and the on-disk library is what `macros_list` re-reads, so the
/// save is immediately visible. Returns the saved macro's list projection.
#[tauri::command]
pub fn macros_save(rt: State<HotkeyRuntime>, r#macro: serde_json::Value) -> Result<MacroInfo, String> {
    let mut mac: macros::Macro =
        serde_json::from_value(r#macro).map_err(|e| format!("invalid macro: {e}"))?;
    if mac.id.trim().is_empty() {
        mac.id = new_macro_id();
    }
    let path = macro_file(&rt.dispatcher.macros_dir, &mac.id)?;
    macros::persist::save(&path, &mac);
    Ok(MacroInfo { id: mac.id, name: mac.name, description: mac.description })
}

/// Soft-delete a macro: rename `<id>.json` to `<id>.json.deleted` so
/// `macros_list` (which only picks up `.json`) drops it, without destroying the
/// file. Missing file is a no-op success.
#[tauri::command]
pub fn macros_delete(rt: State<HotkeyRuntime>, id: String) -> Result<(), String> {
    let path = macro_file(&rt.dispatcher.macros_dir, &id)?;
    if !path.exists() {
        return Ok(());
    }
    let deleted = path.with_extension("json.deleted");
    std::fs::rename(&path, &deleted).map_err(|e| format!("delete failed: {e}"))
}

#[derive(Serialize)]
pub struct AudioDeviceDto {
    pub id: String,
    pub name: String,
    pub output: bool,
    pub default: bool,
}

#[derive(Serialize)]
pub struct UsbDeviceDto {
    pub vid: String,
    pub pid: String,
    pub name: String,
    pub instance_id: String,
}

/// Live audio endpoints (render + capture) for the Devices tab. Enumerated on a
/// scratch thread: the native impl does COM init, which must not run on the main
/// thread (winit owns an OLE STA apartment there — KeyForge main.rs:107).
#[tauri::command]
pub fn devices_audio(rt: State<HotkeyRuntime>) -> Result<Vec<AudioDeviceDto>, String> {
    let services = Arc::clone(&rt.dispatcher.services);
    let list = std::thread::scope(|s| s.spawn(|| services.audio.list()).join())
        .map_err(|_| "audio enumeration thread panicked".to_string())??;
    Ok(list
        .into_iter()
        .map(|d| AudioDeviceDto { id: d.id, name: d.name, output: d.output, default: d.default })
        .collect())
}

#[derive(Serialize)]
pub struct AudioSessionDto {
    pub pid: u32,
    pub name: String,
    pub volume: i32,
    pub muted: bool,
}

/// Per-application audio streams on the default output (populates the App-volume
/// step's datalist). Scratch-threaded for the same COM-apartment reason as
/// `devices_audio`.
#[tauri::command]
pub fn devices_audio_sessions(rt: State<HotkeyRuntime>) -> Result<Vec<AudioSessionDto>, String> {
    let services = Arc::clone(&rt.dispatcher.services);
    let list = std::thread::scope(|s| s.spawn(|| services.audio.list_sessions()).join())
        .map_err(|_| "audio session thread panicked".to_string())??;
    Ok(list
        .into_iter()
        .map(|s| AudioSessionDto { pid: s.pid, name: s.name, volume: s.volume, muted: s.muted })
        .collect())
}

/// Set one application's volume (0-100) and/or mute. `target` is a PID or fuzzy
/// app-name; null level/mute leave that facet unchanged.
#[tauri::command]
pub fn set_app_volume(
    rt: State<HotkeyRuntime>,
    target: String,
    level: Option<i32>,
    mute: Option<bool>,
) -> Result<(), String> {
    let services = Arc::clone(&rt.dispatcher.services);
    std::thread::scope(|s| s.spawn(|| services.audio.set_app_volume(&target, level, mute)).join())
        .map_err(|_| "set app volume thread panicked".to_string())?
}

/// Connected USB devices for the Devices tab. VID/PID as 4-digit hex. Enumerated
/// on a scratch thread for the same COM-apartment reason as `devices_audio`.
#[tauri::command]
pub fn devices_usb(rt: State<HotkeyRuntime>) -> Result<Vec<UsbDeviceDto>, String> {
    let services = Arc::clone(&rt.dispatcher.services);
    let list = std::thread::scope(|s| s.spawn(|| services.usb.list()).join())
        .map_err(|_| "usb enumeration thread panicked".to_string())??;
    Ok(list
        .into_iter()
        .map(|d| UsbDeviceDto {
            vid: format!("{:04X}", d.vid),
            pid: format!("{:04X}", d.pid),
            name: d.name,
            instance_id: d.instance_id,
        })
        .collect())
}
