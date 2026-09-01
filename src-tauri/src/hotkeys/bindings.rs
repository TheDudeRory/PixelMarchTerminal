//! The Global Hotkeys JSON model, ported from KeyForge (src/bindings.rs).
//! One file, `<repo>/data/hotkeys/default.json`, holds every binding.
//!
//! Actions: LaunchProgram + RunCommand (direct) and RunMacro (fires a macro from
//! the KeyForge engine, `crate::macros`, via the Dispatcher — see mod.rs). The
//! profile also carries the always-registered emergency-stop hotkey.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const SCHEMA_VERSION: u32 = 1;

/// What a hotkey does when it fires. `#[serde(tag = "type")]` keeps the JSON
/// self-describing: `{"type":"launch_program","path":"notepad.exe","args":[]}`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Action {
    /// Spawn an executable directly (no shell), optionally with args.
    LaunchProgram {
        path: String,
        #[serde(default)]
        args: Vec<String>,
    },
    /// Run a command line through the OS shell (cmd /C … on Windows, sh -c … elsewhere).
    RunCommand { command: String },
    /// Fire a macro from the KeyForge engine library (`macros/<id>.json`), by id
    /// or unique name. Executed asynchronously by the `macros::Dispatcher`.
    RunMacro { id: String },
}

impl Action {
    pub fn summary(&self) -> String {
        match self {
            Action::LaunchProgram { path, args } if args.is_empty() => format!("Launch {path}"),
            Action::LaunchProgram { path, args } => format!("Launch {path} {}", args.join(" ")),
            Action::RunCommand { command } => format!("Run: {command}"),
            Action::RunMacro { id } => format!("Run macro: {id}"),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Binding {
    pub hotkey: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    pub action: Action,
}

fn default_true() -> bool {
    true
}

/// Default emergency-stop combo (KeyForge default). Always registered — plus its
/// modifier supersets — so it fires even while a macro holds extra modifiers.
pub const DEFAULT_ESTOP: &str = "Ctrl+Alt+End";

fn default_estop() -> String {
    DEFAULT_ESTOP.to_string()
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Profile {
    pub schema_version: u32,
    pub bindings: Vec<Binding>,
    /// Reserved emergency-stop hotkey: cancels all running macros + releases held
    /// keys/mouse. `#[serde(default)]` so older profiles load unchanged.
    #[serde(default = "default_estop")]
    pub emergency_stop: String,
}

impl Default for Profile {
    fn default() -> Self {
        // Seed one working example so a fresh install demonstrates the loop.
        #[cfg(windows)]
        let action = Action::LaunchProgram { path: "notepad.exe".into(), args: vec![] };
        #[cfg(not(windows))]
        let action = Action::LaunchProgram { path: "xdg-open".into(), args: vec![".".into()] };
        Profile {
            schema_version: SCHEMA_VERSION,
            bindings: vec![Binding { hotkey: "Ctrl+Alt+K".into(), enabled: true, action }],
            emergency_stop: default_estop(),
        }
    }
}

// Identity migration for now; add per-version steps when SCHEMA_VERSION bumps.
fn migrate(mut p: Profile) -> Profile {
    if p.schema_version < SCHEMA_VERSION {
        p.schema_version = SCHEMA_VERSION;
    }
    p
}

impl Profile {
    /// Load the profile, or create a default one if the file is missing.
    /// A corrupt file is moved aside as `<name>.bak` and defaults are returned,
    /// so a hand-edited-into-garbage profile can never crash-loop the app.
    pub fn load_or_create(path: &Path) -> Profile {
        match std::fs::read_to_string(path) {
            Ok(text) => match serde_json::from_str::<Profile>(&text) {
                Ok(p) => migrate(p),
                Err(e) => {
                    eprintln!("hotkeys: corrupt profile ({e}); backing up + resetting");
                    let _ = std::fs::rename(path, path.with_extension("json.bak"));
                    let p = Profile::default();
                    p.save(path);
                    p
                }
            },
            Err(_) => {
                let p = Profile::default();
                p.save(path);
                p
            }
        }
    }

    pub fn save(&self, path: &Path) {
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        match serde_json::to_string_pretty(self) {
            Ok(json) => {
                if let Err(e) = std::fs::write(path, json) {
                    eprintln!("hotkeys: failed to save profile: {e}");
                }
            }
            Err(e) => eprintln!("hotkeys: failed to serialize profile: {e}"),
        }
    }
}

/// The portable profile path: `<repo>/data/hotkeys/default.json` (sibling to the
/// screenshots/ and logs/ dirs — state::state_dir() resolves to <repo>/data).
pub fn profile_path() -> Result<PathBuf, String> {
    Ok(crate::state::state_dir()?.join("hotkeys").join("default.json"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip() {
        let p = Profile::default();
        let json = serde_json::to_string_pretty(&p).unwrap();
        assert_eq!(serde_json::from_str::<Profile>(&json).unwrap(), p);
        assert!(json.contains("\"type\": \"launch_program\""));
    }

    #[test]
    fn run_command_tag() {
        let a = Action::RunCommand { command: "echo hi".into() };
        let json = serde_json::to_string(&a).unwrap();
        assert!(json.contains("\"type\":\"run_command\""));
        assert_eq!(serde_json::from_str::<Action>(&json).unwrap(), a);
    }

    #[test]
    fn run_macro_tag() {
        let a = Action::RunMacro { id: "m-1a2b".into() };
        let json = serde_json::to_string(&a).unwrap();
        assert!(json.contains("\"type\":\"run_macro\""));
        assert_eq!(serde_json::from_str::<Action>(&json).unwrap(), a);
    }

    #[test]
    fn old_profile_without_estop_gets_default() {
        // A pre-estop profile still deserializes, defaulting the new field.
        let json = r#"{"schema_version":1,"bindings":[]}"#;
        let p: Profile = serde_json::from_str(json).unwrap();
        assert_eq!(p.emergency_stop, DEFAULT_ESTOP);
    }
}
