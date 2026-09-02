//! Portable persistence: state is saved as `pixelmarch.json` in the source
//! checkout's `data/` folder, NOT the OS app-data dir, so the whole app —
//! code and state — travels in one directory.
//!
//! PixelMarch runs FROM SOURCE (see `update.rs`: updating is `git pull` +
//! rebuild, not an exe swap), so the install *is* the repo. `repo_root()` is
//! the single place that decides where that repo is, and every other path in
//! the app — config, screenshots, logs, brain,
//! host tokens, the webview cache — hangs off
//! `state_dir()` below it.
//!
//! Nothing here reads the runtime environment: the fallback is
//! `CARGO_MANIFEST_DIR`, which the `env!` macro bakes in at COMPILE time.
//! The frontend owns the schema; here we just do atomic file IO.

use std::fs;
use std::path::{Path, PathBuf};

const FILE: &str = "pixelmarch.json";
/// Pre-rename filename (TermMarch). Read as a fallback so an existing install
/// keeps its workspaces; the next save writes the new name.
const LEGACY_FILE: &str = "termmarch.json";

/// Everything the running app writes lives under `<repo>/data` — one gitignored
/// folder, so `git status` stays readable and a wipe is one `rm -rf`.
pub const DATA_DIR: &str = "data";

/// Files that prove a directory is a PixelMarch checkout rather than some
/// parent directory that merely happens to be above the binary.
fn is_repo_root(dir: &Path) -> bool {
    dir.join("src-tauri").join("Cargo.toml").is_file() && dir.join("package.json").is_file()
}

/// The source checkout this process is running out of — the install.
///
/// Two ways to find it, in order:
///
///   1. **Walk up from the binary.** Covers a default `cargo build`, where the
///      binary sits at `<repo>/src-tauri/target/<profile>/pixelmarch`, and any
///      later move of the whole checkout, since the binary moves with it.
///   2. **The compile-time `CARGO_MANIFEST_DIR`** (`<repo>/src-tauri`, so the
///      checkout is its parent). This is what answers on a box that redirects
///      `build.target-dir` OUT of the repo — as this one does, because the
///      volume the source lives on is too small to hold cargo's output.
///
/// Both candidates are checked with `is_repo_root` before being believed. A
/// stale compiled-in path that no longer holds a checkout must fail LOUDLY:
/// returning it anyway would have `state_dir` happily `create_dir_all` a
/// phantom `data/` under a directory the user deleted or renamed, and the app
/// would come up with an empty profile and no explanation.
///
/// Cached — the walk stats the filesystem and this is on the brain's
/// per-request path. Nothing here reads the runtime environment: `env!` bakes
/// its value in at compile time.
pub fn repo_root() -> Result<&'static Path, String> {
    static ROOT: std::sync::OnceLock<Option<PathBuf>> = std::sync::OnceLock::new();
    ROOT.get_or_init(resolve_repo_root).as_deref().ok_or_else(|| {
        format!(
            "cannot locate the PixelMarch checkout (built from {}); \
             move it back or rebuild in place",
            env!("CARGO_MANIFEST_DIR"),
        )
    })
}

fn resolve_repo_root() -> Option<PathBuf> {
    if let Ok(exe) = std::env::current_exe() {
        // The binary can read back as "<path> (deleted)" on Linux once the file
        // behind it is replaced; only the ancestors are used here, and the
        // marker does not affect those.
        let mut cur = exe.parent();
        while let Some(dir) = cur {
            if is_repo_root(dir) {
                return Some(dir.to_path_buf());
            }
            cur = dir.parent();
        }
    }
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    manifest
        .parent()
        .filter(|p| is_repo_root(p))
        .map(|p| p.to_path_buf())
}

/// The profile directory: `<repo>/data`, created on demand.
///
/// Cached after the first success, because the brain resolves its token through
/// here on every authenticated request and this would otherwise be a
/// `create_dir_all` per request. Only success is cached, so a boot with an
/// unwritable checkout can still recover once it becomes writable.
pub fn state_dir() -> Result<PathBuf, String> {
    static READY: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();
    if let Some(dir) = READY.get() {
        return Ok(dir.clone());
    }
    let dir = repo_root()?.join(DATA_DIR);
    fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    let _ = READY.set(dir.clone());
    Ok(dir)
}

fn read_from(dir: &Path) -> std::io::Result<Option<String>> {
    match fs::read_to_string(dir.join(FILE)) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => match fs::read_to_string(dir.join(LEGACY_FILE)) {
            Ok(s) => Ok(Some(s)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e),
        },
        Err(e) => Err(e),
    }
}

fn write_to(dir: &Path, json: &str) -> std::io::Result<()> {
    // Write to a temp file then rename, so a crash mid-write can't corrupt the
    // real file (fs::rename replaces the destination on Windows and Unix).
    let tmp = dir.join(format!("{FILE}.tmp"));
    fs::write(&tmp, json)?;
    fs::rename(&tmp, dir.join(FILE))?;
    Ok(())
}

#[tauri::command]
pub fn load_state() -> Result<Option<String>, String> {
    read_from(&state_dir()?).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn save_state(json: String) -> Result<(), String> {
    write_to(&state_dir()?, &json).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn state_path() -> Result<String, String> {
    Ok(state_dir()?.join(FILE).to_string_lossy().into_owned())
}

/// Overwrite a file (used to dump a pane's scrollback).
#[tauri::command]
pub fn write_text(path: String, content: String) -> Result<(), String> {
    fs::write(&path, content).map_err(|e| e.to_string())
}

/// Read a file back as text (counterpart of `write_text`; used to load a
/// user-supplied role brief .md picked with `pick_markdown_file`).
#[tauri::command]
pub fn read_text(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| format!("read {path}: {e}"))
}

/// Native picker for a Markdown file (a user-written swarm role brief).
/// Returns the picked path, or None if the user cancelled. rfd is the app's
/// only file dialog.
#[tauri::command]
pub async fn pick_markdown_file(title: Option<String>) -> Result<Option<String>, String> {
    let picked = rfd::AsyncFileDialog::new()
        .set_title(title.unwrap_or_else(|| "Choose a Markdown file".into()))
        .add_filter("Markdown", &["md"])
        .pick_file()
        .await;
    let Some(picked) = picked else { return Ok(None) };
    let path = picked.path().to_path_buf();
    // Canonicalise off the async runtime's thread — it hits the filesystem, and a
    // network share can block for seconds.
    let path = tauri::async_runtime::spawn_blocking(move || {
        fs::canonicalize(&path).unwrap_or(path)
    })
    .await
    .map_err(|e| e.to_string())?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

/// Native picker for a FOLDER (the project a BigBrain drift audit runs against).
/// Same shape as `pick_markdown_file`: the picked path, or None if cancelled.
/// A folder is pickable whether or not the brain has ever heard of it — notes
/// record a project by NAME, never by path, so the brain cannot be the only way
/// to name the directory an audit runs in.
#[tauri::command]
pub async fn pick_folder(title: Option<String>) -> Result<Option<String>, String> {
    let picked = rfd::AsyncFileDialog::new()
        .set_title(title.unwrap_or_else(|| "Choose a folder".into()))
        .pick_folder()
        .await;
    let Some(picked) = picked else { return Ok(None) };
    let path = picked.path().to_path_buf();
    // Canonicalise off the async runtime's thread — same reason as above.
    let path = tauri::async_runtime::spawn_blocking(move || {
        fs::canonicalize(&path).unwrap_or(path)
    })
    .await
    .map_err(|e| e.to_string())?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

/// Append to a file, creating it if needed (used to tee a pane's output to a log).
#[tauri::command]
pub fn append_text(path: String, content: String) -> Result<(), String> {
    use std::io::Write;
    let mut f = fs::OpenOptions::new().create(true).append(true).open(&path).map_err(|e| e.to_string())?;
    f.write_all(content.as_bytes()).map_err(|e| e.to_string())
}

/// Subfolder of the profile that holds the config files PixelMarch GENERATES
/// and owns outright: the hook settings, the shared MCP config, one MCP config
/// per swarm role, and the agent-token registry. They used to sit loose at the
/// top of the profile, and since a swarm writes one file per role, a handful of missions
/// buried the profile folder under dozens of `pixelmarch-mcp-swarm-*.json`.
/// The leading dot hides it on unix. The user's own `pixelmarch.json` stays at
/// the top level: it is state, not generated, and moving it would strand an
/// existing install's workspaces.
pub const CONFIG_DIR: &str = ".json";

/// The generated-config directory, created on demand. Creation belongs HERE
/// because the writer these files go through (`host::write_token_at`, 0600 at
/// open time) does not create parent directories — it would just fail.
/// Cached after the first success, because the brain resolves the agent-token
/// registry through here on EVERY authenticated request: without the cache that
/// is a `create_dir_all` per request. Only success is cached, so a boot with an
/// unwritable profile can still recover once it becomes writable.
pub fn config_dir() -> Result<PathBuf, String> {
    static READY: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();
    if let Some(dir) = READY.get() {
        return Ok(dir.clone());
    }
    let dir = state_dir()?.join(CONFIG_DIR);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    migrate_loose_configs(&dir);
    let _ = READY.set(dir.clone());
    Ok(dir)
}

/// True for the file names PixelMarch generates and replaces wholesale.
/// `pixelmarch.json` is deliberately absent — see `CONFIG_DIR`.
fn is_generated_config(name: &str) -> bool {
    matches!(
        name,
        "pixelmarch-hooks.json" | "pixelmarch-mcp.json" | "pixelmarch-brain-agents.json"
    ) || (name.starts_with("pixelmarch-mcp-swarm-") && name.ends_with(".json"))
}

/// One-shot sweep of an install that predates `CONFIG_DIR`: move the generated
/// configs off the top level. Moved rather than deleted so a registration that
/// is still live (the agent-token registry) survives the upgrade; every one of
/// them is rewritten at the next pane spawn anyway. Called once per process
/// (from `config_dir`'s cold path), from whichever of the GUI or host processes
/// touches configs first.
fn migrate_loose_configs(dir: &Path) {
    let Some(parent) = dir.parent() else { return };
    let Ok(entries) = fs::read_dir(parent) else { return };
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        if !is_generated_config(&name) {
            continue;
        }
        // Unix rename replaces the destination; Windows refuses when it exists,
        // and in that case the copy already in the folder is the current one.
        if fs::rename(e.path(), dir.join(&name)).is_err() {
            let _ = fs::remove_file(e.path());
        }
    }
}

/// The portable logs directory (`<repo>/data/logs`), created on demand.
#[tauri::command]
pub fn logs_dir() -> Result<String, String> {
    let dir = state_dir()?.join("logs");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.to_string_lossy().into_owned())
}

/// The portable screenshots directory (`<repo>/data/screenshots`), created on demand.
#[tauri::command]
pub fn screenshots_dir() -> Result<String, String> {
    let dir = state_dir()?.join("screenshots");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.to_string_lossy().into_owned())
}

/// Move an unparseable state file aside as `pixelmarch.json.corrupt-<ts>` so the
/// app can start from defaults instead of crash-looping. Returns the backup path.
#[tauri::command]
pub fn backup_corrupt_state() -> Result<Option<String>, String> {
    let dir = state_dir()?;
    let file = dir.join(FILE);
    if !file.exists() {
        return Ok(None);
    }
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let backup = dir.join(format!("{FILE}.corrupt-{ts}"));
    fs::rename(&file, &backup).map_err(|e| e.to_string())?;
    Ok(Some(backup.to_string_lossy().into_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The app runs from its checkout, so the profile must land INSIDE that
    /// checkout — not in `$HOME`, not next to the binary in `target/`. This is
    /// the one assertion that fails loudly if `repo_root`'s walk ever starts
    /// stopping at `src-tauri/target/` instead of the repo.
    #[test]
    fn the_profile_is_the_checkouts_data_folder() {
        let root = repo_root().expect("the test binary is built from a checkout");
        assert!(is_repo_root(root), "{} is not a checkout", root.display());
        assert_eq!(state_dir().unwrap(), root.join(DATA_DIR));
        // `target/` sits under the root, so a walk that stopped early would
        // still be "inside" it — pin the exact depth instead.
        assert!(!root.ends_with("target"), "walked up too few levels");
        assert!(root.join("src").is_dir(), "the frontend source is missing");
    }

    #[test]
    fn round_trip() {
        let dir = std::env::temp_dir().join(format!("pixelmarch_test_{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        assert!(read_from(&dir).unwrap().is_none(), "missing file reads as None");
        let json = r#"{"schemaVersion":1,"activeId":"a","workspaces":[]}"#;
        write_to(&dir, json).unwrap();
        assert_eq!(read_from(&dir).unwrap().as_deref(), Some(json));
        // overwrite works (rename replaces)
        let json2 = r#"{"schemaVersion":1,"activeId":"b","workspaces":[]}"#;
        write_to(&dir, json2).unwrap();
        assert_eq!(read_from(&dir).unwrap().as_deref(), Some(json2));
        fs::remove_dir_all(&dir).ok();
    }

    /// The line that matters: generated configs move, the user's state file and
    /// anything else in the profile stay exactly where they are.
    #[test]
    fn generated_configs_are_classified_apart_from_state() {
        for name in [
            "pixelmarch-hooks.json",
            "pixelmarch-mcp.json",
            "pixelmarch-brain-agents.json",
            "pixelmarch-mcp-swarm-flight_game-builder-1.json",
        ] {
            assert!(is_generated_config(name), "{name} is generated");
        }
        for name in [
            FILE,
            LEGACY_FILE,
            "pixelmarch.json.win.bak",
            "pixelmarch-brain.token",
            "app-shortcuts.json",
            "pixelmarch-mcp-swarm-notes.txt",
        ] {
            assert!(!is_generated_config(name), "{name} must not be moved");
        }
    }

    #[test]
    fn migration_empties_the_profile_of_generated_configs() {
        let base = std::env::temp_dir().join(format!("pixelmarch_cfg_{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let dir = base.join(CONFIG_DIR);
        fs::create_dir_all(&dir).unwrap();
        for name in [FILE, "pixelmarch-hooks.json", "pixelmarch-mcp-swarm-p-builder-1.json"] {
            fs::write(base.join(name), "x").unwrap();
        }
        // A file already in the folder must not block the move of its namesake.
        fs::write(dir.join("pixelmarch-hooks.json"), "old").unwrap();

        migrate_loose_configs(&dir);

        assert!(base.join(FILE).exists(), "user state stays put");
        assert!(!base.join("pixelmarch-hooks.json").exists());
        assert!(!base.join("pixelmarch-mcp-swarm-p-builder-1.json").exists());
        assert!(dir.join("pixelmarch-mcp-swarm-p-builder-1.json").exists());
        assert!(dir.join("pixelmarch-hooks.json").exists());
        fs::remove_dir_all(&base).ok();
    }
}
