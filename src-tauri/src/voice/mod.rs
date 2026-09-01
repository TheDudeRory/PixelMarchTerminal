//! Voice-To-Text — folded in from VoiceMarch (Z:/SVN/VoiceMarch), an offline
//! push-to-talk dictation app (Tauri v2). Ported into PixelMarch as its own
//! webview window ("voice", declared in tauri.conf.json).
//!
//! BUILD: the STT engine (whisper-rs) needs libclang + CMake at build time and
//! the audio stack (cpal) pulls native libs, so the whole capture/transcribe
//! path sits behind the `voice` cargo feature. That feature is ON by default
//! (Cargo.toml `default = ["voice"]`) because dictation must work out of the box;
//! on a box without LLVM + CMake, build with `--no-default-features` (that is what
//! `scripts/linux-build.sh --no-voice` passes). When the feature is off the
//! commands still exist (so the UI loads) but report `built = false` and do nothing.
//!
//! MODELS: no GGML model ships with the app. `models.rs` owns the catalog, the
//! single `ggml-<id>.bin` path formula, and the download/import commands that the
//! Voice settings panel drives.
//!
//! DEFERRED from VoiceMarch: OS-level text insertion (insert.rs / enigo /
//! arboard) and system-output muting (sysaudio.rs / Windows Core Audio, the
//! `mute_on_ptt` setting persists but is inert). Instead of typing at the OS
//! cursor, a finished transcript is emitted as the `voice-transcript` event; the
//! main window writes it into the focused terminal (see App.tsx) — dictation
//! lands in the host terminal, staying in-app.

mod settings;
pub use settings::VoiceSettings;

// Model catalog + installer. NOT feature-gated: a build without the `voice`
// feature still reports what is on disk, and the path helper is the one place
// the `ggml-<id>.bin` filename is spelled.
pub mod models;

#[cfg(feature = "voice")]
mod audio;
#[cfg(feature = "voice")]
mod dictate;
// OS-cursor insertion + system-output muting: used by the (feature-gated) audio
// thread, so gated too — keeps the default build free of dead-code warnings even
// though their deps (enigo/arboard/windows Core Audio) are unconditional.
#[cfg(feature = "voice")]
mod insert;
#[cfg(feature = "voice")]
mod stt;
#[cfg(feature = "voice")]
mod sysaudio;

use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;
use tauri::{Manager, State};
use tauri_plugin_global_shortcut::Shortcut;

/// Pill (compact) and panel (expanded) window sizes, in logical px. VoiceMarch's
/// 152×72 lozenge grows to a 320×480 settings panel and back via `set_compact`.
const PILL: (f64, f64) = (152.0, 72.0);
const PANEL: (f64, f64) = (320.0, 480.0);

/// Managed state: the live settings, shared with the (feature-gated) audio thread,
/// plus the pill-window bookkeeping (`set_compact` / position persistence).
pub struct VoiceState {
    settings: Arc<Mutex<VoiceSettings>>,
    expanded: AtomicBool,           // true while the settings panel is open
    last_geom_save: Mutex<Instant>, // throttle position writes to the slow Z: share
    /// Tray entry for the pill, greyed out while the master switch is off. Held
    /// here so `voice_set_settings` can flip it live (built in `build_tray`).
    tray_item: Mutex<Option<tauri::menu::MenuItem<tauri::Wry>>>,
}

/// Call once from the tauri `setup` hook (after the global-shortcut plugin is
/// initialized). Loads settings, seeds the file on first run, and — when the
/// `voice` feature is built AND the master switch is on — spawns the capture
/// thread and registers the PTT hotkey.
pub fn init(app: &tauri::AppHandle) {
    let loaded = settings::load();
    if !settings::settings_path().exists() {
        let _ = settings::save(&loaded);
    }
    let settings = Arc::new(Mutex::new(loaded));
    app.manage(VoiceState {
        settings: settings.clone(),
        expanded: AtomicBool::new(false),
        last_geom_save: Mutex::new(Instant::now()),
        tray_item: Mutex::new(None),
    });

    // Apply persisted window prefs to the pill: always-on-top + restore its saved
    // ("home") position, clamped in case that spot is now off-screen.
    let (aot, pos, login, enabled) = {
        let s = settings.lock().unwrap();
        (s.always_on_top, (s.window.x, s.window.y), s.start_on_login, s.enabled)
    };
    // Voice off: the pill window stays as tauri.conf declared it (visible: false)
    // and nothing below needs applying — no hotkey, no capture thread.
    if let Some(w) = app.get_webview_window("voice").filter(|_| enabled) {
        let _ = w.set_always_on_top(aot);
        // The UI always mounts compact (VoiceWindow.tsx), so pin the pill size up
        // front: tauri.conf's declared 152x72 is only a starting hint and GTK will
        // otherwise leave the window at the webview's natural size.
        pin_size(&w, PILL);
        if let (Some(x), Some(y)) = pos {
            let _ = w.set_position(tauri::PhysicalPosition::new(x, y));
            clamp_to_monitor(&w);
        }
    }
    // Re-assert the Run-key entry so a moved/renamed exe stays correct.
    if login {
        set_start_on_login(true);
    }

    #[cfg(feature = "voice")]
    {
        use tauri_plugin_global_shortcut::GlobalShortcutExt;
        // The engine thread is spawned either way (it is idle until a PTT edge
        // arrives, and the whisper model loads lazily) so the master switch can be
        // flipped back on without a restart. What the switch really gates is the
        // global hotkey — an OS-wide grab of e.g. F8 that a user who turned voice
        // off must not keep paying for.
        let engine = audio::AudioEngine::spawn(app.clone(), settings.clone());
        app.manage(engine);
        if enabled {
            let hotkey = settings.lock().unwrap().ptt_hotkey.clone();
            if let Err(e) = app.global_shortcut().register(hotkey.as_str()) {
                eprintln!("voice: failed to register PTT hotkey '{hotkey}': {e}");
            }
        }
    }
    #[cfg(not(feature = "voice"))]
    {
        let _ = &settings; // keep the Arc alive in VoiceState only
    }
}

/// Resize the voice widget between the compact pill and the settings panel,
/// keeping it on-screen and returning the pill to its saved home spot. Invoked as
/// the `set_compact` command by the voice UI (VoiceWindow.tsx).
#[tauri::command]
pub fn set_compact(app: tauri::AppHandle, state: State<VoiceState>, compact: bool) {
    let Some(w) = app.get_webview_window("voice") else { return };
    if compact {
        pin_size(&w, PILL);
        // Return to the saved compact ("home") position.
        let home = {
            let s = state.settings.lock().unwrap();
            (s.window.x, s.window.y)
        };
        if let (Some(x), Some(y)) = home {
            let _ = w.set_position(tauri::PhysicalPosition::new(x, y));
        }
        clamp_to_monitor(&w);
        state.expanded.store(false, Ordering::Relaxed);
    } else {
        // Mark expanded FIRST so the resize/clamp Moved events don't overwrite home.
        state.expanded.store(true, Ordering::Relaxed);
        pin_size(&w, PANEL);
        clamp_to_monitor(&w); // shift up/left if it would spill off the monitor
    }
    // Remember collapsed state for next launch.
    {
        let mut s = state.settings.lock().unwrap();
        s.window.collapsed = compact;
    }
    persist_geometry(&state);
}

/// Resize the widget to exactly `size` (logical px) and hold it there.
///
/// WHY THIS IS NOT JUST `set_size`: the widget must not be user-resizable, but
/// declaring `"resizable": false` in tauri.conf.json makes the window ignore every
/// programmatic resize too — on GTK, `gtk_window_set_resizable(FALSE)` pins the
/// geometry hints to the child's natural size and `gtk_window_resize` (what
/// tao's `set_inner_size` calls, tao 0.35 linux/event_loop.rs) becomes a no-op.
/// That is why the pill sat at the webview's natural size and never grew into the
/// settings panel. So the window is now `resizable: true` and non-resizability is
/// enforced here instead, by clamping min == max == the size we just applied. The
/// old bounds have to be released first, or the pending clamp swallows the resize.
fn pin_size<R: tauri::Runtime>(w: &tauri::WebviewWindow<R>, (width, height): (f64, f64)) {
    let size = tauri::LogicalSize::new(width, height);
    let _ = w.set_min_size(None::<tauri::LogicalSize<f64>>);
    let _ = w.set_max_size(None::<tauri::LogicalSize<f64>>);
    let _ = w.set_size(size);
    let _ = w.set_min_size(Some(size));
    let _ = w.set_max_size(Some(size));
}

/// Nudge the window so it sits fully within its monitor.
fn clamp_to_monitor<R: tauri::Runtime>(w: &tauri::WebviewWindow<R>) {
    let mon = match w.current_monitor() {
        Ok(Some(m)) => m,
        _ => match w.primary_monitor() {
            Ok(Some(m)) => m,
            _ => return,
        },
    };
    let (mpos, msize) = (mon.position(), mon.size());
    let (Ok(wsize), Ok(wpos)) = (w.outer_size(), w.outer_position()) else {
        return;
    };
    let max_x = (mpos.x + msize.width as i32 - wsize.width as i32).max(mpos.x);
    let max_y = (mpos.y + msize.height as i32 - wsize.height as i32).max(mpos.y);
    let x = wpos.x.clamp(mpos.x, max_x);
    let y = wpos.y.clamp(mpos.y, max_y);
    if x != wpos.x || y != wpos.y {
        let _ = w.set_position(tauri::PhysicalPosition::new(x, y));
    }
}

fn persist_geometry(state: &VoiceState) {
    let s = state.settings.lock().unwrap().clone();
    let _ = settings::save(&s);
}

/// Window-event hook for the voice pill (wired from lib.rs's `on_window_event`,
/// scoped to the "voice" label). Closing hides to tray instead of destroying;
/// dragging the collapsed pill persists its home position (throttled).
pub fn on_window_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    if window.label() != "voice" {
        return;
    }
    let app = window.app_handle();
    let Some(state) = app.try_state::<VoiceState>() else { return };
    match event {
        tauri::WindowEvent::CloseRequested { api, .. } => {
            api.prevent_close();
            persist_geometry(&state);
            let _ = window.hide();
        }
        // Remember the pill's position (only while compact); throttle disk writes.
        tauri::WindowEvent::Moved(pos) => {
            if state.expanded.load(Ordering::Relaxed) {
                return;
            }
            {
                let mut s = state.settings.lock().unwrap();
                s.window.x = Some(pos.x);
                s.window.y = Some(pos.y);
            }
            let mut last = state.last_geom_save.lock().unwrap();
            if last.elapsed() >= std::time::Duration::from_millis(1200) {
                *last = Instant::now();
                drop(last);
                persist_geometry(&state);
            }
        }
        _ => {}
    }
}

/// System tray (VoiceMarch fold-in): Show / Voice-To-Text / Quit menu, tooltip,
/// left-click reveals the main window. PixelMarch had no tray before, so this is a
/// single registration — call once from lib.rs's `setup`.
pub fn build_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

    // Greyed out while the master switch is off; `voice_set_settings` flips it
    // live through the handle parked in VoiceState.
    let voice_on = app
        .try_state::<VoiceState>()
        .map(|s| s.settings.lock().unwrap().enabled)
        .unwrap_or(true);
    let show = MenuItem::with_id(app, "tm_show", "Show", true, None::<&str>)?;
    let voice = MenuItem::with_id(app, "tm_voice", "Voice-To-Text", voice_on, None::<&str>)?;
    let quit = MenuItem::with_id(app, "tm_quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &voice, &quit])?;
    if let Some(state) = app.try_state::<VoiceState>() {
        *state.tray_item.lock().unwrap() = Some(voice.clone());
    }

    let mut builder = TrayIconBuilder::with_id("pixelmarch")
        .tooltip("PixelMarch — hold your PTT hotkey to dictate")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "tm_show" => show_main(app),
            "tm_voice" => show_voice(app),
            "tm_quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

/// Reveal + focus the pill. The ONE place that honours the master switch, so a
/// stale tray entry, an old toolbar button or a direct IPC call cannot resurrect
/// a widget the user turned off.
fn show_voice(app: &tauri::AppHandle) {
    let on = app
        .try_state::<VoiceState>()
        .map(|s| s.settings.lock().unwrap().enabled)
        .unwrap_or(false);
    if !on {
        return;
    }
    if let Some(w) = app.get_webview_window("voice") {
        let _ = w.show();
        let _ = w.set_focus();
    }
}

fn show_main(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// Add/remove the exe from the per-user Run key (VoiceMarch "start on login").
#[cfg(windows)]
fn set_start_on_login(enabled: bool) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
    // Drop the pre-rename "TermMarch" value in both branches: it points at the
    // old exe path and the enable/disable branches below can never touch it.
    let mut legacy = std::process::Command::new("reg");
    let _ = legacy
        .args(["delete", KEY, "/v", "TermMarch", "/f"])
        .creation_flags(CREATE_NO_WINDOW)
        .output();
    let mut cmd = std::process::Command::new("reg");
    if enabled {
        let Ok(exe) = std::env::current_exe() else { return };
        // Same strip as the Linux branch below — Windows does not produce the
        // "(deleted)" marker, but the Run key must never learn a path from a
        // source we do not normalise.
        let exe = crate::update::intended_install_path(&exe);
        cmd.args([
            "add", KEY, "/v", "PixelMarch", "/t", "REG_SZ", "/d",
            &exe.to_string_lossy(), "/f",
        ]);
    } else {
        cmd.args(["delete", KEY, "/v", "PixelMarch", "/f"]);
    }
    let _ = cmd.creation_flags(CREATE_NO_WINDOW).output();
}
/// Freedesktop autostart: write/remove `~/.config/autostart/pixelmarch.desktop`
/// (honours `XDG_CONFIG_HOME`). Compliant desktops launch listed .desktop entries
/// on login. std fs/process only — no new deps.
#[cfg(not(windows))]
fn set_start_on_login(enabled: bool) {
    let base = std::env::var_os("XDG_CONFIG_HOME")
        .map(std::path::PathBuf::from)
        .filter(|p| !p.as_os_str().is_empty())
        .or_else(|| std::env::var_os("HOME").map(|h| std::path::PathBuf::from(h).join(".config")));
    let Some(base) = base else { return };
    let dir = base.join("autostart");
    let desktop = dir.join("pixelmarch.desktop");
    // Pre-rename entry: remove it either way so it cannot autostart the old exe.
    let _ = std::fs::remove_file(dir.join("termmarch.desktop"));
    if enabled {
        let Ok(exe) = std::env::current_exe() else { return };
        // After an update (or any move of the running binary) `current_exe()`
        // reads back as "<path> (deleted)". Writing that into Exec= persists an
        // autostart entry that can never launch, so strip the marker first.
        let exe = crate::update::intended_install_path(&exe);
        if std::fs::create_dir_all(&dir).is_err() {
            return;
        }
        // Freedesktop Exec quoting: wrap in double quotes so paths with spaces
        // work; inside quotes `"`, `\`, `$` and backtick must be backslash-escaped.
        let exe = exe.to_string_lossy();
        let escaped: String = exe
            .chars()
            .flat_map(|c| match c {
                '"' | '\\' | '$' | '`' => vec!['\\', c],
                _ => vec![c],
            })
            .collect();
        let contents = format!(
            "[Desktop Entry]\nType=Application\nName=PixelMarch\nExec=\"{escaped}\"\nX-GNOME-Autostart-enabled=true\n"
        );
        let _ = std::fs::write(&desktop, contents);
    } else {
        let _ = std::fs::remove_file(&desktop);
    }
}

/// Called from lib.rs's global-shortcut handler on BOTH key edges. Returns true
/// if the combo is the configured PTT hotkey (so the caller stops treating it as
/// a press-only shortcut). Push-to-talk: down opens the mic, up transcribes.
#[cfg(feature = "voice")]
pub fn handle_ptt(app: &tauri::AppHandle, shortcut: &Shortcut, pressed: bool) -> bool {
    use std::str::FromStr;
    use tauri::Emitter;
    let Some(state) = app.try_state::<VoiceState>() else { return false };
    let (enabled, hotkey) = {
        let s = state.settings.lock().unwrap();
        (s.enabled, s.ptt_hotkey.clone())
    };
    // Switched off: the combo is not ours, so the caller may treat it as a normal
    // app shortcut. (Belt and braces — it should already be unregistered.)
    if !enabled {
        return false;
    }
    let Ok(want) = Shortcut::from_str(&hotkey) else { return false };
    if &want != shortcut {
        return false;
    }
    if let Some(engine) = app.try_state::<audio::AudioEngine>() {
        if pressed {
            let _ = app.emit("voice-ptt", "down");
            engine.start();
        } else {
            let _ = app.emit("voice-ptt", "up");
            engine.stop();
        }
    }
    true
}

/// Feature-off stub: nothing to push, so the combo is never "ours".
#[cfg(not(feature = "voice"))]
pub fn handle_ptt(_app: &tauri::AppHandle, _shortcut: &Shortcut, _pressed: bool) -> bool {
    false
}

// ── Commands (always registered so the UI loads regardless of the feature) ──

#[tauri::command]
pub fn voice_get_settings(state: State<VoiceState>) -> VoiceSettings {
    state.settings.lock().unwrap().clone()
}

#[tauri::command]
pub fn voice_set_settings(
    app: tauri::AppHandle,
    state: State<VoiceState>,
    new: VoiceSettings,
) -> Result<(), String> {
    let (old_login, old_enabled) = {
        let s = state.settings.lock().unwrap();
        (s.start_on_login, s.enabled)
    };
    #[cfg(feature = "voice")]
    {
        use tauri_plugin_global_shortcut::GlobalShortcutExt;
        let (old_hotkey, old_model) = {
            let s = state.settings.lock().unwrap();
            (s.ptt_hotkey.clone(), s.whisper_model.clone())
        };
        // The PTT grab is held only while voice is enabled, so BOTH the combo and
        // the master switch decide what should be registered right now.
        if new.ptt_hotkey != old_hotkey || new.enabled != old_enabled {
            let gs = app.global_shortcut();
            if old_enabled {
                let _ = gs.unregister(old_hotkey.as_str());
            }
            if new.enabled {
                gs.register(new.ptt_hotkey.as_str())
                    .map_err(|e| format!("could not register hotkey '{}': {e}", new.ptt_hotkey))?;
            }
        }
        if new.whisper_model != old_model {
            if let Some(engine) = app.try_state::<audio::AudioEngine>() {
                engine.reload_model();
            }
        }
    }
    if new.start_on_login != old_login {
        set_start_on_login(new.start_on_login);
    }
    if let Some(w) = app.get_webview_window("voice") {
        let _ = w.set_always_on_top(new.always_on_top);
        // Switching off takes the pill away immediately; it is only ever brought
        // back deliberately (toolbar/tray), so nothing re-shows it on enable.
        if !new.enabled {
            let _ = w.hide();
        }
    }
    if new.enabled != old_enabled {
        if let Some(item) = state.tray_item.lock().unwrap().as_ref() {
            let _ = item.set_enabled(new.enabled);
        }
        // Tell the main window so the toolbar's 🎙 button appears/disappears
        // without a restart (the settings panel lives in a different webview).
        use tauri::Emitter;
        let _ = app.emit("voice-enabled", new.enabled);
    }
    *state.settings.lock().unwrap() = new.clone();
    settings::save(&new).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn voice_list_mics() -> Vec<String> {
    #[cfg(feature = "voice")]
    {
        audio::list_input_devices()
    }
    #[cfg(not(feature = "voice"))]
    {
        Vec::new()
    }
}

/// Reveal + focus the voice window (Toolbar "Voice" button / summon).
#[tauri::command]
pub fn voice_show_window(app: tauri::AppHandle) {
    show_voice(&app);
}

/// Hide the voice window back to the background (its own close button).
#[tauri::command]
pub fn voice_hide_window(app: tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("voice") {
        let _ = w.hide();
    }
}

#[derive(Serialize)]
pub struct VoiceStatus {
    /// Master switch (`enabled` in voice-settings.json). False = dictation off.
    pub enabled: bool,
    /// Was the crate built with the `voice` feature? If false, capture is inert.
    pub built: bool,
    /// Is the selected GGML model file present in the profile?
    pub model_present: bool,
    /// The id the settings select (e.g. `base.en-q8_0`) and the filename it needs
    /// — so the UI can name both without re-deriving the formula.
    pub model_id: String,
    pub model_file: String,
    pub ptt_hotkey: String,
}

#[tauri::command]
pub fn voice_status(state: State<VoiceState>) -> VoiceStatus {
    let s = state.settings.lock().unwrap();
    VoiceStatus {
        enabled: s.enabled,
        built: cfg!(feature = "voice"),
        model_present: models::model_path(&s.whisper_model).exists(),
        model_id: s.whisper_model.clone(),
        model_file: models::model_file_name(&s.whisper_model),
        ptt_hotkey: s.ptt_hotkey.clone(),
    }
}
