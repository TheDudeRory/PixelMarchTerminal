use crate::macros::window::WindowSelector;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;

pub const SCHEMA_VERSION: u32 = 1;

/// A step/condition parameter: either a literal or `{ "expr": "..." }`,
/// evaluated with Rhai against the macro's variables at runtime.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Param<T> {
    Expr { expr: String },
    Literal(T),
}

impl<T> From<T> for Param<T> {
    fn from(v: T) -> Self {
        Param::Literal(v)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CmpOp {
    Eq,
    Ne,
    Lt,
    Gt,
    Contains,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Condition {
    All { conditions: Vec<Condition> },
    Any { conditions: Vec<Condition> },
    Not { condition: Box<Condition> },
    /// Escape hatch: arbitrary Rhai boolean expression.
    Expr { expr: String },
    VariableComparison { variable: String, op: CmpOp, value: serde_json::Value },
    WindowExists { window: WindowSelector },
    WindowFocused { window: WindowSelector },
    /// Regex over all visible window titles.
    WindowTitleMatches { pattern: String },
    ProcessRunning { name: String },
    /// "VID:PID" hex or name substring.
    DeviceConnected { device: String },
    AudioDeviceExists { name: String },
    /// True when the named audio device is the current default endpoint.
    AudioDeviceIsDefault { name: String },
    FileExists { path: String },
    DirectoryExists { path: String },
    /// color "#RRGGBB"; per-channel tolerance.
    PixelColorAt { x: i32, y: i32, color: String, #[serde(default)] tolerance: u8 },
    ClipboardContains { pattern: String, #[serde(default)] regex: bool },
    /// "HH:MM"–"HH:MM", wraps overnight.
    TimeIsBetween { start: String, end: String },
    /// ["mon", "tue", ...] — three-letter prefixes, case-insensitive.
    DayOfWeekIs { days: Vec<String> },
}

#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MouseButton {
    #[default]
    Left,
    Right,
    Middle,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ScrollDirection {
    Up,
    Down,
    Left,
    Right,
}

fn default_poll_ms() -> u64 {
    100
}
fn default_wait_timeout_ms() -> u64 {
    10_000
}

/// A step plus its editor placement flags. `disabled` blocks are skipped by
/// the executor and rendered dimmed — invaluable for debugging.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Block {
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub disabled: bool,
    #[serde(flatten)]
    pub step: Step,
}

impl From<Step> for Block {
    fn from(step: Step) -> Block {
        Block { disabled: false, step }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Step {
    If {
        condition: Condition,
        #[serde(default)]
        then: Vec<Block>,
        #[serde(default, rename = "else")]
        else_steps: Vec<Block>,
    },
    Loop {
        times: Param<i64>,
        #[serde(default)]
        steps: Vec<Block>,
    },
    While {
        condition: Condition,
        #[serde(default)]
        steps: Vec<Block>,
    },
    Break,
    Wait {
        ms: Param<i64>,
    },
    WaitUntil {
        condition: Condition,
        #[serde(default = "default_poll_ms")]
        poll_ms: u64,
        #[serde(default = "default_wait_timeout_ms")]
        timeout_ms: u64,
        #[serde(default)]
        on_timeout: Vec<Block>,
    },
    SetVariable {
        name: String,
        value: Param<serde_json::Value>,
    },
    StopMacro,
    RunMacro {
        id: String,
    },
    LaunchProgram {
        path: Param<String>,
        #[serde(default)]
        args: Vec<Param<String>>,
    },
    SendKeystroke {
        keys: Param<String>,
    },
    TypeText {
        text: Param<String>,
        #[serde(default)]
        char_delay_ms: u64,
    },
    HoldKey {
        key: Param<String>,
    },
    ReleaseKey {
        key: Param<String>,
    },
    MouseMove {
        x: Param<i64>,
        y: Param<i64>,
        #[serde(default)]
        relative: bool,
        /// When set, x/y are relative to this window's top-left corner.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        window: Option<WindowSelector>,
    },
    MouseClick {
        #[serde(default)]
        button: MouseButton,
        #[serde(default)]
        double: bool,
    },
    MouseDrag {
        from_x: Param<i64>,
        from_y: Param<i64>,
        to_x: Param<i64>,
        to_y: Param<i64>,
        #[serde(default)]
        button: MouseButton,
    },
    Scroll {
        direction: ScrollDirection,
        amount: Param<i64>,
    },
    FocusWindow {
        window: WindowSelector,
    },
    /// Omitted fields keep their current value; values are pixels or "NN%"
    /// of the window's monitor work area.
    MoveResizeWindow {
        window: WindowSelector,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        x: Option<Param<serde_json::Value>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        y: Option<Param<serde_json::Value>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        w: Option<Param<serde_json::Value>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        h: Option<Param<serde_json::Value>>,
    },
    MinimizeWindow {
        window: WindowSelector,
    },
    MaximizeWindow {
        window: WindowSelector,
    },
    RestoreWindow {
        window: WindowSelector,
    },
    CloseWindow {
        window: WindowSelector,
    },
    ToggleAlwaysOnTop {
        window: WindowSelector,
    },
    /// 1-based monitor index, left-to-right.
    MoveWindowToMonitor {
        window: WindowSelector,
        monitor: Param<i64>,
    },
    /// Opacity percent: 0 = invisible, 100 = opaque. Windows only.
    SetWindowTransparency {
        window: WindowSelector,
        percent: Param<i64>,
    },
    SetClipboard {
        text: Param<String>,
    },
    ClipboardToVariable {
        variable: String,
    },
    ShowNotification {
        #[serde(default)]
        title: String,
        message: Param<String>,
    },
    PlaySound {
        path: Param<String>,
    },
    /// File, folder, or URL via the OS default handler.
    OpenPath {
        path: Param<String>,
    },
    /// Captures into variables: shell_stdout, shell_stderr, shell_exit_code.
    RunShellCommand {
        command: Param<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        timeout_ms: Option<u64>,
    },
    /// Fuzzy name match against live devices (IDs change; names mostly don't).
    SetDefaultAudioDevice {
        name: Param<String>,
        #[serde(default)]
        input: bool,
    },
    /// Master volume by signed percent.
    AdjustVolume {
        delta: Param<i64>,
    },
    /// Master volume to an absolute percent (0-100, clamped by the backend).
    SetVolume {
        level: Param<i64>,
    },
    MuteToggle,
    /// Per-application volume/mute. `target` is a PID or fuzzy app-name match;
    /// omitted `level`/`mute` leave that facet unchanged.
    SetAppVolume {
        target: Param<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        level: Option<Param<i64>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        mute: Option<bool>,
    },
    /// OK continues, Cancel stops the macro — cheap safety valve.
    ConfirmDialog {
        message: Param<String>,
    },
}

impl Step {
    /// (slot label, children) for container steps — the editor and validator
    /// walk nesting through this instead of matching variants themselves.
    pub fn child_lists(&self) -> Vec<(&'static str, &Vec<Block>)> {
        match self {
            Step::If { then, else_steps, .. } => vec![("then", then), ("else", else_steps)],
            Step::Loop { steps, .. } => vec![("do", steps)],
            Step::While { steps, .. } => vec![("do", steps)],
            Step::WaitUntil { on_timeout, .. } => vec![("on timeout", on_timeout)],
            _ => vec![],
        }
    }

    pub fn child_lists_mut(&mut self) -> Vec<(&'static str, &mut Vec<Block>)> {
        match self {
            Step::If { then, else_steps, .. } => vec![("then", then), ("else", else_steps)],
            Step::Loop { steps, .. } => vec![("do", steps)],
            Step::While { steps, .. } => vec![("do", steps)],
            Step::WaitUntil { on_timeout, .. } => vec![("on timeout", on_timeout)],
            _ => vec![],
        }
    }
}

fn param_summary<T: std::fmt::Display>(p: &Param<T>) -> String {
    match p {
        Param::Literal(v) => v.to_string(),
        Param::Expr { expr } => format!("({expr})"),
    }
}

impl Step {
    /// One-line human-readable summary (log lines now, collapsed blocks in M7).
    pub fn summary(&self) -> String {
        match self {
            Step::If { .. } => "If".into(),
            Step::Loop { times, .. } => format!("Loop {} times", param_summary(times)),
            Step::While { .. } => "While".into(),
            Step::Break => "Break".into(),
            Step::Wait { ms } => format!("Wait {} ms", param_summary(ms)),
            Step::WaitUntil { timeout_ms, .. } => format!("Wait until (timeout {timeout_ms} ms)"),
            Step::SetVariable { name, value } => match value {
                Param::Expr { expr } => format!("Set {name} = ({expr})"),
                Param::Literal(v) => format!("Set {name} = {v}"),
            },
            Step::StopMacro => "Stop macro".into(),
            Step::RunMacro { id } => format!("Run macro {id}"),
            Step::LaunchProgram { path, .. } => format!("Launch {}", param_summary(path)),
            Step::SendKeystroke { keys } => format!("Press {}", param_summary(keys)),
            Step::TypeText { text, .. } => {
                let t = param_summary(text);
                let short: String = t.chars().take(24).collect();
                format!("Type {short:?}{}", if t.chars().count() > 24 { "…" } else { "" })
            }
            Step::HoldKey { key } => format!("Hold {}", param_summary(key)),
            Step::ReleaseKey { key } => format!("Release {}", param_summary(key)),
            Step::MouseMove { x, y, relative, window } => {
                let how = match (window, relative) {
                    (Some(sel), _) => format!("in {}", crate::macros::window::describe(sel)),
                    (None, true) => "by".into(),
                    (None, false) => "to".into(),
                };
                format!("Mouse move {how} ({}, {})", param_summary(x), param_summary(y))
            }
            Step::MouseClick { button, double } => {
                format!("{} {button:?}", if *double { "Double-click" } else { "Click" })
            }
            Step::MouseDrag { from_x, from_y, to_x, to_y, button } => format!(
                "Drag {button:?} ({}, {}) → ({}, {})",
                param_summary(from_x),
                param_summary(from_y),
                param_summary(to_x),
                param_summary(to_y)
            ),
            Step::Scroll { direction, amount } => {
                format!("Scroll {direction:?} {}", param_summary(amount))
            }
            Step::FocusWindow { window } => format!("Focus {}", crate::macros::window::describe(window)),
            Step::MoveResizeWindow { window, .. } => {
                format!("Move/resize {}", crate::macros::window::describe(window))
            }
            Step::MinimizeWindow { window } => format!("Minimize {}", crate::macros::window::describe(window)),
            Step::MaximizeWindow { window } => format!("Maximize {}", crate::macros::window::describe(window)),
            Step::RestoreWindow { window } => format!("Restore {}", crate::macros::window::describe(window)),
            Step::CloseWindow { window } => format!("Close {}", crate::macros::window::describe(window)),
            Step::ToggleAlwaysOnTop { window } => {
                format!("Toggle always-on-top {}", crate::macros::window::describe(window))
            }
            Step::MoveWindowToMonitor { window, monitor } => format!(
                "Move {} to monitor {}",
                crate::macros::window::describe(window),
                param_summary(monitor)
            ),
            Step::SetWindowTransparency { window, percent } => format!(
                "Set {} opacity {}%",
                crate::macros::window::describe(window),
                param_summary(percent)
            ),
            Step::SetClipboard { text } => {
                let t = param_summary(text);
                let short: String = t.chars().take(24).collect();
                format!("Set clipboard {short:?}{}", if t.chars().count() > 24 { "…" } else { "" })
            }
            Step::ClipboardToVariable { variable } => format!("Clipboard → {variable}"),
            Step::ShowNotification { title, .. } => format!("Notify {title:?}"),
            Step::PlaySound { path } => format!("Play {}", param_summary(path)),
            Step::OpenPath { path } => format!("Open {}", param_summary(path)),
            Step::RunShellCommand { command, .. } => {
                let c = param_summary(command);
                let short: String = c.chars().take(32).collect();
                format!("Shell: {short}{}", if c.chars().count() > 32 { "…" } else { "" })
            }
            Step::SetDefaultAudioDevice { name, input } => format!(
                "Default audio {} → {}",
                if *input { "input" } else { "output" },
                param_summary(name)
            ),
            Step::AdjustVolume { delta } => format!("Volume {}", param_summary(delta)),
            Step::SetVolume { level } => format!("Volume = {}%", param_summary(level)),
            Step::MuteToggle => "Mute toggle".into(),
            Step::SetAppVolume { target, level, mute } => {
                let mut parts = Vec::new();
                if let Some(l) = level {
                    parts.push(format!("vol {}", param_summary(l)));
                }
                if let Some(m) = mute {
                    parts.push(if *m { "mute".into() } else { "unmute".into() });
                }
                let what = if parts.is_empty() { "(no change)".into() } else { parts.join(", ") };
                format!("App {} → {what}", param_summary(target))
            }
            Step::ConfirmDialog { message } => format!("Confirm: {}", param_summary(message)),
        }
    }
}

fn default_schema_version() -> u32 {
    SCHEMA_VERSION
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Macro {
    #[serde(default = "default_schema_version")]
    pub schema_version: u32,
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub steps: Vec<Block>,
    /// Runaway-guard overrides; defaults in exec.rs apply when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_runtime_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_loop_iterations: Option<u64>,
}

/// All macros from `keyforge_data/macros/`, one JSON file each.
/// ponytail: re-read from disk on every trigger fire — files are tiny and
/// hand-edited in M3; add caching/file-watch only if profiling ever cares.
#[derive(Debug, Default, Clone)]
pub struct MacroLibrary {
    macros: HashMap<String, Macro>,
}

impl MacroLibrary {
    pub fn load(dir: &Path) -> MacroLibrary {
        let mut macros = HashMap::new();
        let entries = match std::fs::read_dir(dir) {
            Ok(rd) => rd,
            Err(e) => {
                tracing::error!(dir = %dir.display(), error = %e, "cannot read macros directory");
                return MacroLibrary::default();
            }
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            let parsed = std::fs::read_to_string(&path)
                .map_err(|e| e.to_string())
                .and_then(|text| serde_json::from_str::<Macro>(&text).map_err(|e| e.to_string()));
            match parsed {
                // A broken macro file is skipped, never replaced with defaults.
                Err(e) => tracing::error!(file = %path.display(), error = %e, "skipping unreadable macro"),
                Ok(m) => {
                    if let Some(old) = macros.insert(m.id.clone(), m) {
                        tracing::warn!(id = %old.id, "duplicate macro id; keeping the later file");
                    }
                }
            }
        }
        MacroLibrary { macros }
    }

    pub fn get(&self, id: &str) -> Option<&Macro> {
        self.macros.get(id)
    }

    /// Lookup by id, falling back to a unique case-insensitive name match —
    /// bindings written by hand often carry the macro's name, not its id.
    pub fn resolve(&self, key: &str) -> Option<&Macro> {
        if let Some(m) = self.macros.get(key) {
            return Some(m);
        }
        let mut by_name = self
            .macros
            .values()
            .filter(|m| m.name.eq_ignore_ascii_case(key.trim()));
        match (by_name.next(), by_name.next()) {
            (Some(m), None) => Some(m),
            (Some(_), Some(_)) => {
                tracing::warn!(key, "several macros share this name; use the id");
                None
            }
            _ => None,
        }
    }

    /// Sorted by name for stable UI listing.
    pub fn iter_sorted(&self) -> Vec<&Macro> {
        let mut v: Vec<&Macro> = self.macros.values().collect();
        v.sort_by(|a, b| a.name.cmp(&b.name));
        v
    }
}

/// First-run template so hand-writing macros starts from a working file.
pub fn seed_example(dir: &Path) {
    let has_any = std::fs::read_dir(dir)
        .map(|rd| rd.flatten().any(|e| e.path().extension().and_then(|x| x.to_str()) == Some("json")))
        .unwrap_or(false);
    if has_any {
        return;
    }
    let example = Macro {
        schema_version: SCHEMA_VERSION,
        id: "example".into(),
        name: "Example: count to three".into(),
        description: "Hand-written example. Copy this file to create your own macro; \
                      the visual editor arrives in a later milestone."
            .into(),
        steps: vec![
            Step::SetVariable { name: "n".into(), value: serde_json::json!(0).into() }.into(),
            Step::Loop {
                times: 3.into(),
                steps: vec![
                    Step::SetVariable { name: "n".into(), value: Param::Expr { expr: "n + 1".into() } }
                        .into(),
                    Step::Wait { ms: 250.into() }.into(),
                ],
            }
            .into(),
            Step::If {
                condition: Condition::VariableComparison {
                    variable: "n".into(),
                    op: CmpOp::Eq,
                    value: serde_json::json!(3),
                },
                then: vec![Step::SetVariable {
                    name: "result".into(),
                    value: serde_json::json!("counted to three!").into(),
                }
                .into()],
                else_steps: vec![Step::StopMacro.into()],
            }
            .into(),
        ],
        max_runtime_ms: None,
        max_loop_iterations: None,
    };
    crate::macros::persist::save(&dir.join("example.json"), &example);
    tracing::info!("seeded macros/example.json");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn param_untagged_forms() {
        let lit: Param<i64> = serde_json::from_str("5").unwrap();
        assert_eq!(lit, Param::Literal(5));
        let expr: Param<i64> = serde_json::from_str(r#"{"expr": "n + 1"}"#).unwrap();
        assert_eq!(expr, Param::Expr { expr: "n + 1".into() });
        // a literal JSON value that isn't an expr object stays literal
        let val: Param<serde_json::Value> = serde_json::from_str(r#"{"a": 1}"#).unwrap();
        assert!(matches!(val, Param::Literal(_)));
    }

    #[test]
    fn macro_roundtrip() {
        let m = Macro {
            schema_version: SCHEMA_VERSION,
            id: "t".into(),
            name: "t".into(),
            description: String::new(),
            steps: vec![
                Step::If {
                    condition: Condition::All {
                        conditions: vec![Condition::Expr { expr: "true".into() }],
                    },
                    then: vec![Block { disabled: true, step: Step::Break }],
                    else_steps: vec![],
                },
                Step::WaitUntil {
                    condition: Condition::VariableComparison {
                        variable: "x".into(),
                        op: CmpOp::Gt,
                        value: serde_json::json!(2),
                    },
                    poll_ms: 50,
                    timeout_ms: 1000,
                    on_timeout: vec![Step::StopMacro.into()],
                },
            ]
            .into_iter()
            .map(Block::from)
            .collect(),
            max_runtime_ms: Some(1000),
            max_loop_iterations: None,
        };
        let json = serde_json::to_string_pretty(&m).unwrap();
        assert_eq!(serde_json::from_str::<Macro>(&json).unwrap(), m);
        assert!(json.contains("\"type\": \"wait_until\""));
        assert!(json.contains("\"else\""));
        // disabled flag flattens next to the step's own fields
        assert!(json.contains("\"disabled\": true"));
        // enabled blocks don't serialize the flag at all (clean diffs)
        assert_eq!(json.matches("disabled").count(), 1);
    }

    #[test]
    fn resolve_by_id_then_unique_name() {
        let dir = std::env::temp_dir().join(format!("keyforge_resolve_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        for (id, name) in [("m-1", "Focus Notepad"), ("m-2", "Other"), ("m-3", "Twin"), ("m-4", "Twin")] {
            let m: Macro = serde_json::from_value(serde_json::json!({"id": id, "name": name})).unwrap();
            crate::macros::persist::save(&dir.join(format!("{id}.json")), &m);
        }
        let lib = MacroLibrary::load(&dir);
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(lib.resolve("m-2").unwrap().id, "m-2");
        assert_eq!(lib.resolve("focus notepad").unwrap().id, "m-1");
        assert!(lib.resolve("Twin").is_none(), "ambiguous names must not resolve");
        assert!(lib.resolve("ghost").is_none());
    }

    #[test]
    fn missing_optional_fields_default() {
        let m: Macro = serde_json::from_str(r#"{"id": "x", "name": "X"}"#).unwrap();
        assert_eq!(m.schema_version, SCHEMA_VERSION);
        assert!(m.steps.is_empty());
        let s: Step = serde_json::from_str(r#"{"type": "wait_until", "condition": {"type": "expr", "expr": "true"}}"#).unwrap();
        assert!(matches!(s, Step::WaitUntil { poll_ms: 100, timeout_ms: 10_000, .. }));
    }
}
