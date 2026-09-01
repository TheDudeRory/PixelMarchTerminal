//! Hotkey registration engine, ported from KeyForge (src/hotkey.rs).
//!
//! KeyForge fired hotkeys through a `TargetMap` keyed by the normalized combo
//! string, because the OS event callback only knew the combo. Our backend is
//! tauri-plugin-global-shortcut, whose event carries the `Shortcut` itself, so
//! the backend binds each action at register time (see mod.rs) and `apply` takes
//! `(combo, Action)` pairs instead of KeyForge's bare `&[String]`. The rest of
//! the engine — normalize, conflict "first binding wins", per-combo errors — is
//! the same. Emergency-stop supersets are DEFERRED (that was macro-engine safety).

use super::bindings::{Action, Profile};
use std::collections::{HashMap, HashSet};

/// Canonical form used to detect conflicts: lowercase, no whitespace.
pub fn normalize(hotkey: &str) -> String {
    hotkey.chars().filter(|c| !c.is_whitespace()).collect::<String>().to_lowercase()
}

/// The emergency stop must fire even while a macro holds extra modifiers — the OS
/// global-shortcut layer matches the exact modifier state, so a held Shift would
/// mask the stop combo precisely when it is needed most. Register every modifier
/// superset of the configured combo instead. Ported from KeyForge hotkey.rs:46.
/// Returns `Ctrl+…`-style combos (parseable by the plugin's `Shortcut`).
pub fn emergency_supersets(hotkey: &str) -> Vec<String> {
    // Keep the key token in its original spelling (the plugin's `Shortcut`
    // parser is picky about key names); derive modifier presence from normalized.
    let orig: Vec<&str> = hotkey.split('+').map(str::trim).filter(|t| !t.is_empty()).collect();
    let key = match orig.last() {
        Some(k) => *k,
        None => return vec![hotkey.trim().to_string()],
    };
    let normalized = normalize(hotkey);
    let mut tokens: Vec<&str> = normalized.split('+').collect();
    tokens.pop(); // drop the key; only modifiers remain
    fn canonical(t: &str) -> &str {
        match t {
            "control" => "ctrl",
            "win" | "cmd" | "command" | "meta" => "super",
            other => other,
        }
    }
    // Present-with-a-key labels the plugin's `Shortcut` parser accepts.
    fn present(m: &str) -> &str {
        match m {
            "ctrl" => "Ctrl",
            "alt" => "Alt",
            "shift" => "Shift",
            "super" => "Super",
            other => other,
        }
    }
    let have: Vec<&str> = tokens.iter().map(|t| canonical(t)).collect();
    const ALL: [&str; 4] = ["ctrl", "alt", "shift", "super"];
    let free: Vec<&str> = ALL.into_iter().filter(|m| !have.contains(m)).collect();
    (0..1u32 << free.len())
        .map(|mask| {
            let mut parts: Vec<&str> = ALL
                .into_iter()
                .filter(|m| {
                    have.contains(m)
                        || free.iter().position(|f| f == m).is_some_and(|i| mask & (1 << i) != 0)
                })
                .map(present)
                .collect();
            parts.push(key);
            parts.join("+")
        })
        .collect()
}

/// OS hotkey registration, replace-all semantics. Each pair that fails to parse
/// or register comes back as (combo, error).
pub trait HotkeyBackend {
    fn apply(&mut self, desired: &[(String, Action)]) -> Vec<(String, String)>;
}

pub struct HotkeyEngine {
    backend: Box<dyn HotkeyBackend + Send>,
    /// normalized hotkey → why it is not active (conflict / parse / registration error)
    errors: HashMap<String, String>,
}

impl HotkeyEngine {
    pub fn new(backend: Box<dyn HotkeyBackend + Send>) -> Self {
        HotkeyEngine { backend, errors: HashMap::new() }
    }

    /// Recompute the full desired set from the enabled bindings and push it to
    /// the OS. Duplicate combos and registration failures land in `errors`.
    pub fn sync(&mut self, profile: &Profile) {
        self.errors.clear();
        let mut desired: Vec<(String, Action)> = Vec::new();
        let mut seen: HashSet<String> = HashSet::new();

        for binding in profile.bindings.iter().filter(|b| b.enabled) {
            let key = normalize(&binding.hotkey);
            if key.is_empty() {
                continue;
            }
            if !seen.insert(key.clone()) {
                // Badge the combo but keep the first registrant active.
                self.errors.insert(key, "conflict: combo already bound (first binding wins)".into());
                continue;
            }
            // Register the user's original spelling; the parser accepts it.
            desired.push((binding.hotkey.trim().to_string(), binding.action.clone()));
        }

        for (combo, error) in self.backend.apply(&desired) {
            self.errors.insert(normalize(&combo), error);
        }
    }

    /// Per-combo error map (normalized combo → reason it is inactive), surfaced
    /// to the UI so a conflicting/unregisterable row can be badged.
    pub fn errors(&self) -> &HashMap<String, String> {
        &self.errors
    }
}

#[cfg(test)]
mod tests {
    use super::super::bindings::Binding;
    use super::*;
    use std::sync::{Arc, Mutex};

    #[derive(Default)]
    struct FakeBackend {
        applied: Arc<Mutex<Vec<Vec<String>>>>,
        fail: HashMap<String, String>,
    }

    impl HotkeyBackend for FakeBackend {
        fn apply(&mut self, desired: &[(String, Action)]) -> Vec<(String, String)> {
            self.applied.lock().unwrap().push(desired.iter().map(|(c, _)| c.clone()).collect());
            desired
                .iter()
                .filter_map(|(c, _)| self.fail.get(c).map(|e| (c.clone(), e.clone())))
                .collect()
        }
    }

    fn binding(hotkey: &str, enabled: bool) -> Binding {
        Binding { hotkey: hotkey.into(), enabled, action: Action::RunCommand { command: "x".into() } }
    }

    fn profile(bindings: Vec<Binding>) -> Profile {
        Profile { schema_version: 1, bindings, emergency_stop: "Ctrl+Alt+End".into() }
    }

    #[test]
    fn sync_registers_enabled_only() {
        let backend = FakeBackend::default();
        let applied = Arc::clone(&backend.applied);
        let mut engine = HotkeyEngine::new(Box::new(backend));

        engine.sync(&profile(vec![binding("Ctrl+Alt+K", true), binding("Ctrl+X", false), binding("", true)]));

        assert_eq!(applied.lock().unwrap()[0], vec!["Ctrl+Alt+K"]);
    }

    #[test]
    fn duplicate_combo_is_conflict_first_wins() {
        let backend = FakeBackend::default();
        let applied = Arc::clone(&backend.applied);
        let mut engine = HotkeyEngine::new(Box::new(backend));

        engine.sync(&profile(vec![binding("Ctrl+Alt+K", true), binding("ctrl+alt+k", true)]));

        // second (duplicate) is dropped; only the first is pushed to the OS
        assert_eq!(applied.lock().unwrap()[0], vec!["Ctrl+Alt+K"]);
        assert!(engine.errors().get("ctrl+alt+k").unwrap().contains("conflict"));
    }

    #[test]
    fn estop_supersets_cover_free_modifiers() {
        let sets = emergency_supersets("Ctrl+Alt+End");
        // free modifiers = shift, super → 2^2 = 4 combos, all keeping the key case.
        assert_eq!(sets.len(), 4);
        assert!(sets.contains(&"Ctrl+Alt+End".to_string()));
        assert!(sets.contains(&"Ctrl+Alt+Shift+End".to_string()));
        assert!(sets.contains(&"Ctrl+Alt+Super+End".to_string()));
        assert!(sets.contains(&"Ctrl+Alt+Shift+Super+End".to_string()));
    }

    #[test]
    fn estop_supersets_no_mods_yields_full_grid() {
        // key only → all 4 modifiers free → 16 combos, each ending in the key.
        let sets = emergency_supersets("F13");
        assert_eq!(sets.len(), 16);
        assert!(sets.iter().all(|s| s.ends_with("F13")));
        assert!(sets.contains(&"F13".to_string()));
    }

    #[test]
    fn backend_failure_is_reported() {
        let backend = FakeBackend {
            fail: HashMap::from([("Ctrl+Alt+K".to_string(), "taken by another app".to_string())]),
            ..Default::default()
        };
        let mut engine = HotkeyEngine::new(Box::new(backend));

        engine.sync(&profile(vec![binding("Ctrl+Alt+K", true)]));

        assert_eq!(engine.errors().get("ctrl+alt+k").unwrap(), "taken by another app");
    }
}
