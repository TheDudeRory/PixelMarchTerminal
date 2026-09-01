//! Screenshot backend: capture EVERY monitor to its OWN PNG in a portable
//! `screenshots/` folder in the profile, each named with a millisecond
//! timestamp + monitor index. No stitching — one file per physical display.
//!
//! Right after the capture, one borderless always-on-top snip overlay window is
//! opened per monitor, covering that monitor and showing its freshly saved shot
//! (`index.html?snip=1`, rendered by SnipWindow.tsx). Drag a region to snip
//! (saves a crop) or press Esc to skip — either way every overlay closes.
//! The main window's thumbnail refreshes off the `screenshot-taken` broadcast.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{Emitter, Manager, PhysicalPosition, PhysicalSize};

/// Snip-overlay window label -> the PNG that window is showing. Filled when the
/// overlays are spawned, read back by the webview via `snip_source`.
static SNIP_SOURCES: Mutex<Option<HashMap<String, String>>> = Mutex::new(None);

fn snip_sources() -> std::sync::MutexGuard<'static, Option<HashMap<String, String>>> {
    let mut g = SNIP_SOURCES.lock().unwrap_or_else(|e| e.into_inner());
    if g.is_none() {
        *g = Some(HashMap::new());
    }
    g
}

fn screenshots_dir() -> Result<PathBuf, String> {
    crate::state::screenshots_dir().map(PathBuf::from)
}

/// Resolve a caller-supplied path and prove it names a regular file that lives
/// DIRECTLY in `dir`.
///
/// Both sides are canonicalised first, on purpose: a bare `p.parent() == dir`
/// comparison is only a string test, so `<dir>/../../secret.png` and a symlink
/// inside `dir` pointing anywhere on disk both pass it. `canonicalize` resolves
/// `..` and follows symlinks/junctions, so the containment check runs on the real
/// target; anything that resolves outside `dir` is rejected. `dir` is canonicalised
/// too because on Windows canonicalisation adds the `\\?\` prefix — comparing a
/// canonical child against a non-canonical parent would never match.
fn contain_in_dir(dir: &Path, path: &str) -> Result<PathBuf, String> {
    let dir = dir
        .canonicalize()
        .map_err(|e| format!("screenshots folder unavailable ({}): {e}", dir.display()))?;
    let p = Path::new(path)
        .canonicalize()
        .map_err(|e| format!("cannot resolve {path}: {e}"))?;
    if p.parent() != Some(dir.as_path()) {
        return Err("path outside screenshots folder".into());
    }
    if !p.is_file() {
        return Err("not a file".into());
    }
    Ok(p)
}

/// `contain_in_dir` against the portable screenshots folder.
fn safe_shot_path(path: &str) -> Result<PathBuf, String> {
    let dir = screenshots_dir()?;
    contain_in_dir(&dir, path)
}

// --- retention -------------------------------------------------------------

/// Retention policy for the portable `screenshots/` folder. Captures land on a
/// global hotkey and NOTHING used to delete, so the folder grew without bound.
/// Both limits are independent and either can be switched off with `0`.
#[derive(Clone, Copy, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Retention {
    /// Keep at most this many PNGs, newest first. `0` = unlimited.
    pub max_count: usize,
    /// Keep at most this many megabytes of PNGs, newest first. `0` = unlimited.
    pub max_mb: u64,
}

impl Default for Retention {
    /// OFF. Retention is opt-in: an install that never saved a policy has files
    /// the user has never consented to lose, and pruning is irreversible, so a
    /// missing (or corrupt) settings file must never delete anything. The
    /// gallery's settings row shows 200 shots / 500 MB as a placeholder hint
    /// instead, which only takes effect once the user saves it.
    fn default() -> Self {
        Self { max_count: 0, max_mb: 0 }
    }
}

/// Portable, in the profile like every other piece of state. Kept in its own
/// file rather than `pixelmarch.json`: that schema is frontend-owned and the
/// backend (hotkey capture, no webview involved) has to read this on its own.
const RETENTION_FILE: &str = "screenshot-retention.json";

fn retention_path() -> Result<PathBuf, String> {
    Ok(crate::state::state_dir()?.join(RETENTION_FILE))
}

/// Current policy, or OFF when the file is missing/unreadable/garbage — a
/// broken settings file must neither stop a capture nor start deleting shots
/// the user never agreed to lose.
fn load_retention() -> Retention {
    retention_path()
        .ok()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

/// Shots retention must not delete, whatever their age — canonical paths, so a
/// comparison cannot be dodged by `screenshots/../screenshots/x.png`.
///
/// WHY THIS EXISTS. `prune_dir` protected exactly one file: the newest on disk.
/// But the thumbnail does not always show the newest shot — it follows a crop
/// and a gallery pick — so retention happily deleted the picture the user was
/// looking at. The frontend reconciles AFTER the event (`pinnedAfterPrune` in
/// ScreenshotThumb.tsx), which stops it rendering a path that is gone; it cannot
/// stop the deletion, because the prune runs on the CAPTURE path — a global
/// hotkey, with no webview in the loop to ask. So the set has to live here.
///
/// Deliberately in-process and not a file in the profile: a pin is session
/// state (the thumb starts at the newest shot on every launch), so persisting it
/// would resurrect protections for a window nobody has open, and quietly stop
/// retention from ever reclaiming those bytes again.
static PROTECTED: Mutex<Vec<PathBuf>> = Mutex::new(Vec::new());

fn protected_now() -> Vec<PathBuf> {
    PROTECTED.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

/// Declare the shots the UI is holding open, replacing the whole set: the caller
/// owns the list, so a shot it stops pinning stops being protected (otherwise
/// every shot ever displayed would accumulate and retention would never reclaim
/// anything). Unresolvable or out-of-folder paths are dropped rather than failing
/// the call — a stale path in the list is normal (the file may have just been
/// deleted), and it protects nothing anyway. Returns how many were accepted.
#[tauri::command(async)]
pub fn screenshot_protect(paths: Vec<String>) -> Result<usize, String> {
    let keep: Vec<PathBuf> = paths.iter().filter_map(|p| safe_shot_path(p).ok()).collect();
    let n = keep.len();
    *PROTECTED.lock().unwrap_or_else(|e| e.into_inner()) = keep;
    Ok(n)
}

/// PNGs in `dir`, newest first. The filename is the tiebreaker because a batch
/// capture writes every monitor within the same millisecond stamp.
fn shots_by_age(dir: &Path) -> Result<Vec<(std::time::SystemTime, PathBuf, u64)>, String> {
    let mut shots: Vec<(std::time::SystemTime, PathBuf, u64)> = fs::read_dir(dir)
        .map_err(|e| e.to_string())?
        .filter_map(|entry| {
            let entry = entry.ok()?;
            let path = entry.path();
            if !path.extension().is_some_and(|e| e.eq_ignore_ascii_case("png")) {
                return None;
            }
            let meta = entry.metadata().ok()?;
            Some((meta.modified().ok()?, path, meta.len()))
        })
        .collect();
    shots.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| b.1.cmp(&a.1)));
    Ok(shots)
}

/// Delete the oldest PNGs in `dir` until both limits hold. Returns how many
/// files were removed. A file that refuses to delete (locked by a viewer) is
/// skipped rather than failing the whole prune.
///
/// `protected` names shots that are exempt REGARDLESS OF AGE (see `PROTECTED`).
/// They still COUNT toward both limits, and that is the deliberate choice: they
/// occupy real slots and real bytes, so leaving them out of the accounting would
/// make "keep at most 200 shots / 500 MB" quietly untrue. The visible effect is
/// that pinning eats into the budget rather than expanding it — and if every
/// shot is pinned nothing is deleted at all, which is the pin winning, as it
/// should. Everything else is unchanged.
fn prune_dir(dir: &Path, r: Retention, protected: &[PathBuf]) -> Result<usize, String> {
    if r.max_count == 0 && r.max_mb == 0 {
        return Ok(0);
    }
    let max_bytes = r.max_mb.saturating_mul(1024 * 1024);
    let is_protected = |p: &Path| {
        let real = p.canonicalize();
        let real = real.as_deref().unwrap_or(p);
        protected.iter().any(|q| q == real || q == p)
    };
    let mut kept = 0usize;
    let mut bytes = 0u64;
    let mut removed = 0usize;
    for (_, path, len) in shots_by_age(dir)? {
        let over_count = r.max_count > 0 && kept >= r.max_count;
        let over_bytes = r.max_mb > 0 && bytes.saturating_add(len) > max_bytes;
        // The newest shot always survives, even on its own bigger than max_mb:
        // pruning the file we just captured would be indistinguishable from the
        // capture failing. A pinned shot survives for the same reason one step
        // further out — the user is looking at it.
        if (over_count || over_bytes) && kept > 0 && !is_protected(&path) {
            if fs::remove_file(&path).is_ok() {
                removed += 1;
            }
            continue;
        }
        kept += 1;
        bytes = bytes.saturating_add(len);
    }
    Ok(removed)
}

/// Apply the saved policy to the portable screenshots folder. Called after every
/// capture and crop save; failures are the caller's to ignore — a full folder is
/// not a reason to lose the shot.
fn prune_screenshots() -> Result<usize, String> {
    let dir = screenshots_dir()?;
    prune_dir(&dir, load_retention(), &protected_now())
}

/// Payload of the `screenshot-pruned` event.
#[derive(Clone, serde::Serialize)]
struct ShotsPruned {
    removed: usize,
}

/// Prune on a capture path and tell the UI when it actually deleted something.
/// Silent deletion on a global hotkey is invisible; a toast makes retention
/// observable. Failures stay ignored — a full folder is not a reason to lose
/// the shot we just took.
fn prune_and_announce(app: &tauri::AppHandle) {
    if let Ok(removed) = prune_screenshots() {
        if removed > 0 {
            let _ = app.emit("screenshot-pruned", ShotsPruned { removed });
        }
    }
}

/// Read the retention policy (gallery settings row).
#[tauri::command(async)]
pub fn screenshot_retention_get() -> Result<Retention, String> {
    Ok(load_retention())
}

/// Write the retention policy and apply it immediately. Returns how many files
/// the new policy deleted, so the UI can say so.
#[tauri::command(async)]
pub fn screenshot_retention_set(retention: Retention) -> Result<usize, String> {
    let json = serde_json::to_string(&retention).map_err(|e| e.to_string())?;
    fs::write(retention_path()?, json).map_err(|e| e.to_string())?;
    prune_screenshots()
}

/// Payload of the `screenshot-taken` event — one per saved file, broadcast so
/// the main window's thumbnail refreshes from any window.
#[derive(Clone, serde::Serialize)]
struct ShotSaved {
    path: String,
}

/// One captured monitor: where it lives on the virtual desktop (physical px)
/// and the PNG we just wrote for it.
struct Shot {
    x: i32,
    y: i32,
    w: u32,
    h: u32,
    path: String,
}

/// Capture one image per monitor, in `monitors` order.
///
/// xcap is the backend everywhere except a Linux Wayland session, where its own
/// Wayland path cannot produce an image on KDE at all (see wayland_shot.rs) and
/// would raise one permission dialog per monitor on the desktops where it can.
#[cfg(target_os = "linux")]
fn capture_images(monitors: &[xcap::Monitor]) -> Result<Vec<image::RgbaImage>, String> {
    if crate::wayland_shot::is_wayland_session() {
        let targets: Vec<crate::wayland_shot::Target> = monitors
            .iter()
            .map(|m| crate::wayland_shot::Target {
                name: m.name().unwrap_or_default(),
                x: m.x().unwrap_or(0),
                y: m.y().unwrap_or(0),
                w: m.width().unwrap_or(0),
                h: m.height().unwrap_or(0),
            })
            .collect();
        return crate::wayland_shot::capture_monitors(&targets);
    }
    capture_images_xcap(monitors)
}

#[cfg(not(target_os = "linux"))]
fn capture_images(monitors: &[xcap::Monitor]) -> Result<Vec<image::RgbaImage>, String> {
    capture_images_xcap(monitors)
}

fn capture_images_xcap(monitors: &[xcap::Monitor]) -> Result<Vec<image::RgbaImage>, String> {
    monitors
        .iter()
        .map(|m| m.capture_image().map_err(|e| e.to_string()))
        .collect()
}

/// Capture every monitor, saving each to its own
/// `screenshots/shot-<utc-ms>-mon<idx>.png`, then raise a snip overlay on each
/// monitor. Emits `screenshot-taken` per file.
/// Called from the palette/IPC command and the global shortcut (its own thread).
pub fn capture_all(app: &tauri::AppHandle) -> Result<(), String> {
    // Let whatever triggered us (palette, menus) dismiss and repaint first so
    // the capture doesn't immortalize that chrome mid-fade.
    std::thread::sleep(std::time::Duration::from_millis(150));

    // A leftover overlay from a previous capture would otherwise be baked into
    // this one.
    close_all_snips(app);

    let monitors = xcap::Monitor::all().map_err(|e| e.to_string())?;
    if monitors.is_empty() {
        return Err("no monitor found".into());
    }
    let images = capture_images(&monitors)?;
    let dir = screenshots_dir()?;
    // Shared stamp across the batch; the monitor index disambiguates same-ms
    // saves within the loop.
    let stamp = chrono::Utc::now().format("%Y%m%d-%H%M%S%.3f");
    let mut shots: Vec<Shot> = Vec::new();
    for (idx, (m, img)) in monitors.iter().zip(images).enumerate() {
        let path = dir.join(format!("shot-{stamp}-mon{idx}.png"));
        img.save(&path).map_err(|e| e.to_string())?;
        let path = path.to_string_lossy().into_owned();
        let _ = app.emit("screenshot-taken", ShotSaved { path: path.clone() });
        shots.push(Shot {
            x: m.x().unwrap_or(0),
            y: m.y().unwrap_or(0),
            w: m.width().unwrap_or(img.width()),
            h: m.height().unwrap_or(img.height()),
            path,
        });
    }
    // Retention runs AFTER the batch is on disk and broadcast, so the shot the
    // user just took is never the one that gets pruned.
    prune_and_announce(app);
    open_snip_overlays(app, shots);
    Ok(())
}

/// Raise one borderless, always-on-top overlay per monitor, each sized/placed to
/// cover its monitor and told which PNG to show. Windows must be built on the
/// main thread — the hotkey path calls us from a worker thread.
fn open_snip_overlays(app: &tauri::AppHandle, shots: Vec<Shot>) {
    let app = app.clone();
    let _ = app.clone().run_on_main_thread(move || {
        for (idx, s) in shots.iter().enumerate() {
            let label = format!("snip-{idx}");
            snip_sources()
                .as_mut()
                .unwrap()
                .insert(label.clone(), s.path.clone());
            let built = tauri::WebviewWindowBuilder::new(
                &app,
                &label,
                tauri::WebviewUrl::App("index.html?snip=1".into()),
            )
            .title("Snip")
            .decorations(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .resizable(false)
            .shadow(false)
            .visible(false)
            .build();
            match built {
                Ok(w) => {
                    // Physical px: monitor geometry from xcap is unscaled, so
                    // set it directly instead of going through logical points.
                    let _ = w.set_position(PhysicalPosition::new(s.x, s.y));
                    let _ = w.set_size(PhysicalSize::new(s.w, s.h));
                    let _ = w.show();
                    let _ = w.set_focus();
                }
                Err(e) => eprintln!("snip overlay {label} failed: {e}"),
            }
        }
    });
}

/// Close every snip overlay and forget their sources.
fn close_all_snips(app: &tauri::AppHandle) {
    let labels: Vec<String> = snip_sources().as_ref().unwrap().keys().cloned().collect();
    for label in labels {
        if let Some(w) = app.get_webview_window(&label) {
            let _ = w.close();
        }
    }
    snip_sources().as_mut().unwrap().clear();
}

/// PNG this snip overlay window should display (called by SnipWindow.tsx).
#[tauri::command(async)]
pub fn snip_source(window: tauri::Window) -> Result<String, String> {
    snip_sources()
        .as_ref()
        .unwrap()
        .get(window.label())
        .cloned()
        .ok_or_else(|| format!("no snip source for {}", window.label()))
}

/// Close just this overlay, leaving the other monitors' up. Esc/snip use
/// `snip_close_all` instead; this stays for closing a single stuck overlay.
#[tauri::command(async)]
pub fn snip_close(window: tauri::Window) -> Result<(), String> {
    snip_sources().as_mut().unwrap().remove(window.label());
    window.close().map_err(|e| e.to_string())
}

/// Close every overlay (a snip was taken, or the user bailed out of all of them).
#[tauri::command(async)]
pub fn snip_close_all(app: tauri::AppHandle) -> Result<(), String> {
    close_all_snips(&app);
    Ok(())
}

/// Capture all monitors to separate files (palette / IPC entry point).
#[tauri::command(async)]
pub fn screenshot_start(app: tauri::AppHandle) -> Result<(), String> {
    capture_all(&app)
}

/// Save a cropped/snipped PNG (bytes produced by the frontend canvas) as a new
/// file in the portable screenshots folder, then broadcast `screenshot-taken`
/// so the thumbnail refreshes to it. Returns the written path.
#[tauri::command(async)]
pub fn screenshot_save_crop(app: tauri::AppHandle, png: Vec<u8>) -> Result<String, String> {
    let dir = screenshots_dir()?;
    let stamp = chrono::Utc::now().format("%Y%m%d-%H%M%S%.3f");
    let path = dir.join(format!("shot-{stamp}-crop.png"));
    fs::write(&path, &png).map_err(|e| e.to_string())?;
    let path_str = path.to_string_lossy().into_owned();
    let _ = app.emit("screenshot-taken", ShotSaved { path: path_str.clone() });
    prune_and_announce(&app);
    Ok(path_str)
}

/// Read a screenshot PNG back as raw bytes so the frontend can push it to the
/// clipboard as an image. Restricted to files inside the screenshots folder.
#[tauri::command(async)]
pub fn screenshot_read_png(path: String) -> Result<Vec<u8>, String> {
    let p = safe_shot_path(&path)?;
    fs::read(&p).map_err(|e| e.to_string())
}

/// Delete a screenshot PNG from the portable folder. Restricted to files inside
/// the screenshots folder.
#[tauri::command(async)]
pub fn screenshot_delete(path: String) -> Result<(), String> {
    let p = safe_shot_path(&path)?;
    fs::remove_file(&p).map_err(|e| e.to_string())
}

/// OCR a saved screenshot and return its text, so an error on screen can be
/// pasted as text instead of burning image tokens. Restricted to the
/// screenshots folder like the other file commands.
#[tauri::command(async)]
pub fn screenshot_ocr(path: String) -> Result<String, String> {
    let p = safe_shot_path(&path)?;
    crate::ocr::ocr_file(&p)
}

/// All PNGs in the screenshots folder, newest first.
#[tauri::command(async)]
pub fn screenshot_list() -> Result<Vec<String>, String> {
    let dir = screenshots_dir()?;
    Ok(shots_by_age(&dir)?
        .into_iter()
        .map(|(_, p, _)| p.to_string_lossy().into_owned())
        .collect())
}

#[cfg(test)]
mod tests {
    use super::{contain_in_dir, prune_dir, Retention};
    use std::fs;
    use std::path::{Path, PathBuf};

    /// Isolated scratch dir under the OS temp dir; `unique` keeps parallel test
    /// threads from colliding without pulling in a tempdir dependency.
    fn scratch(unique: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("pixelmarch-shot-test-{unique}"));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(d.join("shots")).unwrap();
        d
    }

    #[test]
    fn accepts_file_directly_in_dir() {
        let root = scratch("ok");
        let dir = root.join("shots");
        let f = dir.join("shot-1.png");
        fs::write(&f, b"x").unwrap();
        let got = contain_in_dir(&dir, &f.to_string_lossy()).unwrap();
        assert_eq!(got, f.canonicalize().unwrap());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn rejects_dot_dot_escape() {
        // The old `parent()` check passed this: the literal parent component IS
        // the screenshots dir, even though the path resolves outside it.
        let root = scratch("dotdot");
        let dir = root.join("shots");
        let outside = root.join("secret.png");
        fs::write(&outside, b"x").unwrap();
        let escape = format!("{}/../secret.png", dir.to_string_lossy());
        assert!(contain_in_dir(&dir, &escape).is_err());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn rejects_file_in_sibling_dir() {
        let root = scratch("sibling");
        let dir = root.join("shots");
        let other = root.join("other");
        fs::create_dir_all(&other).unwrap();
        let f = other.join("shot-1.png");
        fs::write(&f, b"x").unwrap();
        assert!(contain_in_dir(&dir, &f.to_string_lossy()).is_err());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn rejects_nested_subdirectory() {
        // Only files DIRECTLY in the folder are addressable.
        let root = scratch("nested");
        let dir = root.join("shots");
        let sub = dir.join("sub");
        fs::create_dir_all(&sub).unwrap();
        let f = sub.join("shot-1.png");
        fs::write(&f, b"x").unwrap();
        assert!(contain_in_dir(&dir, &f.to_string_lossy()).is_err());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn rejects_directory_and_missing_file() {
        let root = scratch("missing");
        let dir = root.join("shots");
        let sub = dir.join("sub");
        fs::create_dir_all(&sub).unwrap();
        assert!(contain_in_dir(&dir, &sub.to_string_lossy()).is_err()); // a dir, not a file
        assert!(contain_in_dir(&dir, &dir.join("nope.png").to_string_lossy()).is_err());
        let _ = fs::remove_dir_all(&root);
    }

    // --- retention ---------------------------------------------------------

    /// `n` PNGs of `size` bytes each, named so the highest index is the newest
    /// (the sort's filename tiebreaker orders same-millisecond writes).
    fn fill(dir: &Path, n: usize, size: usize) {
        for i in 0..n {
            fs::write(dir.join(format!("shot-{i:03}.png")), vec![0u8; size]).unwrap();
        }
    }

    fn names(dir: &Path) -> Vec<String> {
        let mut v: Vec<String> = fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        v.sort();
        v
    }

    /// Retention is opt-in: no settings file (so `Default`) must delete nothing,
    /// or the first capture after an update eats an existing user's history.
    #[test]
    fn default_policy_is_off_and_deletes_nothing() {
        let r = Retention::default();
        assert_eq!((r.max_count, r.max_mb), (0, 0));
        let root = scratch("default-off");
        let dir = root.join("shots");
        fill(&dir, 5, 8);
        assert_eq!(prune_dir(&dir, r, &[]).unwrap(), 0);
        assert_eq!(names(&dir).len(), 5);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn prunes_down_to_max_count_keeping_newest() {
        let root = scratch("keep-count");
        let dir = root.join("shots");
        fill(&dir, 5, 8);
        let removed = prune_dir(&dir, Retention { max_count: 2, max_mb: 0 }, &[]).unwrap();
        assert_eq!(removed, 3);
        assert_eq!(names(&dir), vec!["shot-003.png", "shot-004.png"]);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn prunes_by_total_size() {
        let root = scratch("keep-size");
        let dir = root.join("shots");
        // 3 files of ~0.75 MB; a 2 MB cap fits two of them.
        fill(&dir, 3, 768 * 1024);
        let removed = prune_dir(&dir, Retention { max_count: 0, max_mb: 2 }, &[]).unwrap();
        assert_eq!(removed, 1);
        assert_eq!(names(&dir), vec!["shot-001.png", "shot-002.png"]);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn zero_limits_mean_off() {
        let root = scratch("off");
        let dir = root.join("shots");
        fill(&dir, 4, 8);
        assert_eq!(prune_dir(&dir, Retention { max_count: 0, max_mb: 0 }, &[]).unwrap(), 0);
        assert_eq!(names(&dir).len(), 4);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn newest_shot_survives_a_limit_it_alone_exceeds() {
        // Losing the shot the user just took would look like a failed capture.
        let root = scratch("newest");
        let dir = root.join("shots");
        fill(&dir, 2, 3 * 1024 * 1024);
        let removed = prune_dir(&dir, Retention { max_count: 0, max_mb: 1 }, &[]).unwrap();
        assert_eq!(removed, 1);
        assert_eq!(names(&dir), vec!["shot-001.png"]);
        let _ = fs::remove_dir_all(&root);
    }

    /// 3.5 / review-task-4 bug 4: the thumbnail follows crops and gallery picks,
    /// so the shot on screen is routinely NOT the newest file — and retention
    /// deleted it. Age must stop deciding for a pinned shot.
    #[test]
    fn a_pinned_older_shot_survives_a_prune_that_takes_newer_ones() {
        let root = scratch("pin-older");
        let dir = root.join("shots");
        fill(&dir, 5, 8);
        let pinned = dir.join("shot-000.png").canonicalize().unwrap(); // the OLDEST
        let removed = prune_dir(&dir, Retention { max_count: 2, max_mb: 0 }, &[pinned]).unwrap();
        // Without the pin this prune removes shots 000..002; the pin costs one of
        // the two slots, so only 001 and 002 go.
        assert_eq!(removed, 2);
        assert_eq!(names(&dir), vec!["shot-000.png", "shot-003.png", "shot-004.png"]);
        let _ = fs::remove_dir_all(&root);
    }

    /// A pinned shot is exempt from deletion but still COUNTS: "keep at most N"
    /// would otherwise be quietly untrue, and pinning would expand the budget
    /// instead of spending it.
    #[test]
    fn a_pinned_shot_spends_a_slot_rather_than_expanding_the_budget() {
        let root = scratch("pin-counts");
        let dir = root.join("shots");
        fill(&dir, 4, 768 * 1024);
        let pinned = dir.join("shot-000.png").canonicalize().unwrap();
        // 2 MB fits two 0.75 MB files. The pin is one of them (counted first is
        // the newest, so the pin is reached last) — the folder must not end up
        // holding three.
        prune_dir(&dir, Retention { max_count: 0, max_mb: 2 }, &[pinned]).unwrap();
        let left = names(&dir);
        assert!(left.contains(&"shot-000.png".to_string()), "the pinned shot was deleted: {left:?}");
        assert_eq!(left.len(), 3, "pinned files must still count toward the cap: {left:?}");
        assert_eq!(left, vec!["shot-000.png", "shot-002.png", "shot-003.png"]);
        let _ = fs::remove_dir_all(&root);
    }

    /// Pinning nothing changes nothing, and the newest-shot protection is
    /// independent of it — regression cover for the two rules interacting.
    #[test]
    fn the_newest_shot_stays_protected_with_and_without_pins() {
        let root = scratch("pin-newest");
        let dir = root.join("shots");
        fill(&dir, 3, 3 * 1024 * 1024);
        let newest = dir.join("shot-002.png").canonicalize().unwrap();
        // Pinning the newest shot is a no-op: it was already protected.
        let removed = prune_dir(&dir, Retention { max_count: 0, max_mb: 1 }, &[newest]).unwrap();
        assert_eq!(removed, 2);
        assert_eq!(names(&dir), vec!["shot-002.png"]);
        let _ = fs::remove_dir_all(&root);
    }

    /// A pin the prune cannot match protects nothing, and must not blow up the
    /// prune: a stale path (the file was just deleted elsewhere) and a path from
    /// another folder are both normal inputs.
    #[test]
    fn stale_or_foreign_pins_are_ignored_not_fatal() {
        let root = scratch("pin-stale");
        let dir = root.join("shots");
        fill(&dir, 4, 8);
        let stale = dir.join("shot-999.png"); // never existed
        let foreign = root.join("elsewhere.png");
        fs::write(&foreign, b"x").unwrap();
        let removed = prune_dir(&dir, Retention { max_count: 1, max_mb: 0 }, &[stale, foreign.canonicalize().unwrap()]).unwrap();
        assert_eq!(removed, 3);
        assert_eq!(names(&dir), vec!["shot-003.png"]);
        let _ = fs::remove_dir_all(&root);
    }

    /// The registry is a REPLACE, not an append: a shot the UI stops pinning has
    /// to stop being protected, or every shot ever displayed accumulates and
    /// retention never reclaims anything again.
    #[test]
    fn declaring_pins_replaces_the_whole_set() {
        let root = scratch("pin-replace");
        let dir = root.join("shots");
        fill(&dir, 3, 8);
        let a = dir.join("shot-000.png").canonicalize().unwrap();
        let b = dir.join("shot-001.png").canonicalize().unwrap();

        *super::PROTECTED.lock().unwrap() = vec![a.clone(), b.clone()];
        assert_eq!(super::protected_now(), vec![a, b.clone()]);
        *super::PROTECTED.lock().unwrap() = vec![b.clone()];
        assert_eq!(super::protected_now(), vec![b], "the earlier pin must be gone, not merged");
        *super::PROTECTED.lock().unwrap() = Vec::new();
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn leaves_non_png_files_alone() {
        let root = scratch("non-png");
        let dir = root.join("shots");
        fill(&dir, 3, 8);
        fs::write(dir.join("notes.txt"), b"keep me").unwrap();
        prune_dir(&dir, Retention { max_count: 1, max_mb: 0 }, &[]).unwrap();
        assert_eq!(names(&dir), vec!["notes.txt", "shot-002.png"]);
        let _ = fs::remove_dir_all(&root);
    }

    /// A symlink INSIDE the folder pointing outside must not be readable/deletable.
    /// Windows symlink creation needs Developer Mode or admin, so the test is
    /// unix-only rather than flaky.
    #[cfg(unix)]
    #[test]
    fn rejects_symlink_escape() {
        let root = scratch("symlink");
        let dir = root.join("shots");
        let outside = root.join("secret.png");
        fs::write(&outside, b"x").unwrap();
        let link = dir.join("link.png");
        std::os::unix::fs::symlink(&outside, &link).unwrap();
        assert!(contain_in_dir(&dir, &link.to_string_lossy()).is_err());
        let _ = fs::remove_dir_all(&root);
    }
}
