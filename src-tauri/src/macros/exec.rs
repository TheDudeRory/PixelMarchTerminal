use crate::macros::audio::AudioDeviceManager;
use crate::macros::input::Inputs;
use crate::macros::model::{Block, CmpOp, Condition, Macro, MacroLibrary, Param, Step};
use crate::macros::usb::UsbEnumerator;
use crate::macros::window::{self, WindowInfo, WindowManager, WindowSelector};

/// The OS capabilities macros run against — one bundle instead of a parameter
/// per subsystem. Real impls in main, fakes in tests.
pub struct Services {
    pub inputs: Inputs,
    pub wm: Box<dyn WindowManager>,
    pub audio: Box<dyn AudioDeviceManager>,
    pub usb: Box<dyn UsbEnumerator>,
}
use serde_json::Value;
use std::collections::HashMap;
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
// tokio's Instant == std's in production, but respects the paused test clock.
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

pub const DEFAULT_MAX_RUNTIME_MS: u64 = 60_000;
pub const DEFAULT_MAX_LOOP_ITERATIONS: u64 = 10_000;
pub const MAX_CALL_DEPTH: usize = 16;

#[derive(Debug, Clone, PartialEq)]
pub enum ExecError {
    Cancelled,
    RuntimeLimit,
    LoopLimit,
    Eval(String),
    Input(String),
    Window(String),
    MacroNotFound(String),
    Recursion(String),
}

impl std::fmt::Display for ExecError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ExecError::Cancelled => write!(f, "cancelled"),
            ExecError::RuntimeLimit => write!(f, "max runtime exceeded (runaway guard)"),
            ExecError::LoopLimit => write!(f, "max loop iterations exceeded (runaway guard)"),
            ExecError::Eval(e) => write!(f, "evaluation error: {e}"),
            ExecError::Input(e) => write!(f, "input error: {e}"),
            ExecError::Window(e) => write!(f, "window error: {e}"),
            ExecError::MacroNotFound(id) => write!(f, "macro not found: {id}"),
            ExecError::Recursion(id) => write!(f, "recursion guard tripped at: {id}"),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Outcome {
    Completed,
    Stopped,
}

#[derive(Debug, PartialEq)]
enum Flow {
    Next,
    Break,
    Stop,
}

// ---------------------------------------------------------------- expressions

/// Evaluate a Rhai expression against the macro variables.
/// ponytail: fresh Engine per eval — evals happen at human timescale; cache
/// an Engine only if profiling ever cares.
pub fn eval_expr(expr: &str, vars: &HashMap<String, Value>) -> Result<Value, String> {
    let engine = rhai::Engine::new();
    let mut scope = rhai::Scope::new();
    for (name, value) in vars {
        let dynamic = rhai::serde::to_dynamic(value).map_err(|e| e.to_string())?;
        scope.push_dynamic(name.clone(), dynamic);
    }
    let result = engine
        .eval_expression_with_scope::<rhai::Dynamic>(&mut scope, expr)
        .map_err(|e| e.to_string())?;
    if result.is_unit() {
        return Ok(Value::Null);
    }
    rhai::serde::from_dynamic(&result).map_err(|e| e.to_string())
}

fn eval_value(p: &Param<Value>, vars: &HashMap<String, Value>) -> Result<Value, ExecError> {
    match p {
        Param::Literal(v) => Ok(v.clone()),
        Param::Expr { expr } => eval_expr(expr, vars).map_err(ExecError::Eval),
    }
}

fn eval_i64(p: &Param<i64>, vars: &HashMap<String, Value>) -> Result<i64, ExecError> {
    match p {
        Param::Literal(v) => Ok(*v),
        Param::Expr { expr } => eval_expr(expr, vars)
            .map_err(ExecError::Eval)?
            .as_i64()
            .ok_or_else(|| ExecError::Eval(format!("expected integer from: {expr}"))),
    }
}

fn eval_string(p: &Param<String>, vars: &HashMap<String, Value>) -> Result<String, ExecError> {
    match p {
        Param::Literal(v) => Ok(v.clone()),
        Param::Expr { expr } => match eval_expr(expr, vars).map_err(ExecError::Eval)? {
            Value::String(s) => Ok(s),
            other => Ok(other.to_string()),
        },
    }
}

// ----------------------------------------------------------------- conditions

/// Numeric-aware equality: 3 == 3.0.
fn json_eq(a: &Value, b: &Value) -> bool {
    match (a.as_f64(), b.as_f64()) {
        (Some(x), Some(y)) => x == y,
        _ => a == b,
    }
}

fn compare(op: CmpOp, left: &Value, right: &Value) -> Result<bool, String> {
    match op {
        CmpOp::Eq => Ok(json_eq(left, right)),
        CmpOp::Ne => Ok(!json_eq(left, right)),
        CmpOp::Lt | CmpOp::Gt => {
            let ord = match (left, right) {
                (Value::String(a), Value::String(b)) => a.cmp(b),
                _ => match (left.as_f64(), right.as_f64()) {
                    (Some(a), Some(b)) => a.partial_cmp(&b).ok_or("NaN comparison")?,
                    _ => return Err(format!("cannot order {left} and {right}")),
                },
            };
            Ok(if op == CmpOp::Lt { ord.is_lt() } else { ord.is_gt() })
        }
        CmpOp::Contains => match left {
            Value::String(s) => Ok(match right {
                Value::String(needle) => s.contains(needle.as_str()),
                other => s.contains(&other.to_string()),
            }),
            Value::Array(items) => Ok(items.iter().any(|v| json_eq(v, right))),
            other => Err(format!("contains needs a string or array, got {other}")),
        },
    }
}

pub fn eval_condition(
    cond: &Condition,
    vars: &HashMap<String, Value>,
    services: &Services,
) -> Result<bool, ExecError> {
    let list = || services.wm.list_windows().map_err(ExecError::Window);
    match cond {
        Condition::All { conditions } => {
            for c in conditions {
                if !eval_condition(c, vars, services)? {
                    return Ok(false);
                }
            }
            Ok(true)
        }
        Condition::Any { conditions } => {
            for c in conditions {
                if eval_condition(c, vars, services)? {
                    return Ok(true);
                }
            }
            Ok(false)
        }
        Condition::Not { condition } => Ok(!eval_condition(condition, vars, services)?),
        Condition::Expr { expr } => match eval_expr(expr, vars).map_err(ExecError::Eval)? {
            Value::Bool(b) => Ok(b),
            other => Err(ExecError::Eval(format!("condition must be boolean, got {other}: {expr}"))),
        },
        Condition::VariableComparison { variable, op, value } => {
            let left = vars.get(variable).cloned().unwrap_or(Value::Null);
            compare(*op, &left, value).map_err(ExecError::Eval)
        }
        Condition::WindowExists { window } => Ok(window::find_first(window, &list()?).is_some()),
        Condition::WindowFocused { window } => {
            Ok(window::find_first(window, &list()?).is_some_and(|w| w.focused))
        }
        Condition::WindowTitleMatches { pattern } => {
            let re = regex::Regex::new(pattern)
                .map_err(|e| ExecError::Eval(format!("bad title regex: {e}")))?;
            Ok(list()?.iter().any(|w| re.is_match(&w.title)))
        }
        Condition::ProcessRunning { name } => Ok(window::process_running(name)),
        Condition::DeviceConnected { device } => {
            let devices = services.usb.list().map_err(ExecError::Window)?;
            Ok(crate::macros::usb::any_connected(&devices, device))
        }
        Condition::AudioDeviceExists { name } => {
            let devices = services.audio.list().map_err(ExecError::Window)?;
            Ok(crate::macros::audio::device_exists(name, &devices))
        }
        Condition::AudioDeviceIsDefault { name } => {
            let devices = services.audio.list().map_err(ExecError::Window)?;
            Ok(crate::macros::audio::device_is_default(name, &devices))
        }
        Condition::FileExists { path } => Ok(std::path::Path::new(path).is_file()),
        Condition::DirectoryExists { path } => Ok(std::path::Path::new(path).is_dir()),
        Condition::PixelColorAt { x, y, color, tolerance } => {
            let want = crate::macros::sys::parse_color(color).map_err(ExecError::Eval)?;
            let got = crate::macros::sys::pixel_at(*x, *y).map_err(ExecError::Eval)?;
            Ok(crate::macros::sys::color_close(got, want, *tolerance))
        }
        Condition::ClipboardContains { pattern, regex } => {
            let text = crate::macros::sys::clipboard_get().unwrap_or_default();
            if *regex {
                let re = regex::Regex::new(pattern)
                    .map_err(|e| ExecError::Eval(format!("bad clipboard regex: {e}")))?;
                Ok(re.is_match(&text))
            } else {
                Ok(text.to_lowercase().contains(&pattern.to_lowercase()))
            }
        }
        Condition::TimeIsBetween { start, end } => {
            crate::macros::sys::time_between(chrono::Local::now().time(), start, end)
                .map_err(ExecError::Eval)
        }
        Condition::DayOfWeekIs { days } => {
            use chrono::Datelike;
            Ok(crate::macros::sys::day_matches(chrono::Local::now().weekday(), days))
        }
    }
}

// ------------------------------------------------------------------- executor

struct ExecState<'a> {
    lib: &'a MacroLibrary,
    services: &'a Services,
    vars: HashMap<String, Value>,
    cancel: CancellationToken,
    deadline: Instant,
    loop_cap: u64,
    loops: u64,
    stack: Vec<String>,
}

impl ExecState<'_> {
    fn wm(&self) -> &dyn WindowManager {
        self.services.wm.as_ref()
    }

    /// Topmost window matching the selector, or a clear error.
    fn resolve_window(&self, sel: &WindowSelector) -> Result<WindowInfo, ExecError> {
        let windows = self.wm().list_windows().map_err(ExecError::Window)?;
        window::find_first(sel, &windows)
            .cloned()
            .ok_or_else(|| ExecError::Window(format!("no window matches {}", window::describe(sel))))
    }

    fn check(&self) -> Result<(), ExecError> {
        if self.cancel.is_cancelled() {
            return Err(ExecError::Cancelled);
        }
        if Instant::now() >= self.deadline {
            return Err(ExecError::RuntimeLimit);
        }
        Ok(())
    }

    fn count_loop(&mut self) -> Result<(), ExecError> {
        self.loops += 1;
        if self.loops > self.loop_cap {
            return Err(ExecError::LoopLimit);
        }
        Ok(())
    }

    /// Sleep, capped at the runtime deadline and interruptible by cancellation.
    async fn sleep(&self, wanted: Duration) -> Result<(), ExecError> {
        let capped = wanted.min(self.deadline.saturating_duration_since(Instant::now()));
        tokio::select! {
            _ = self.cancel.cancelled() => Err(ExecError::Cancelled),
            _ = tokio::time::sleep(capped) => self.check(),
        }
    }
}

type StepFuture<'a> = Pin<Box<dyn Future<Output = Result<Flow, ExecError>> + Send + 'a>>;

fn run_steps<'a, 'b: 'a>(steps: &'a [Block], st: &'a mut ExecState<'b>) -> StepFuture<'a> {
    Box::pin(async move {
        for block in steps {
            st.check()?;
            if block.disabled {
                tracing::debug!(step = %block.step.summary(), "step disabled, skipped");
                continue;
            }
            let step = &block.step;
            tracing::debug!(step = %step.summary(), depth = st.stack.len(), "step");
            match step {
                Step::If { condition, then, else_steps } => {
                    let branch =
                        if eval_condition(condition, &st.vars, st.services)? { then } else { else_steps };
                    match run_steps(branch, st).await? {
                        Flow::Next => {}
                        other => return Ok(other),
                    }
                }
                Step::Loop { times, steps } => {
                    let times = eval_i64(times, &st.vars)?;
                    'l: for _ in 0..times {
                        st.count_loop()?;
                        match run_steps(steps, st).await? {
                            Flow::Next => {}
                            Flow::Break => break 'l,
                            Flow::Stop => return Ok(Flow::Stop),
                        }
                    }
                }
                Step::While { condition, steps } => {
                    while eval_condition(condition, &st.vars, st.services)? {
                        st.check()?;
                        st.count_loop()?;
                        match run_steps(steps, st).await? {
                            Flow::Next => {}
                            Flow::Break => break,
                            Flow::Stop => return Ok(Flow::Stop),
                        }
                    }
                }
                Step::Break => return Ok(Flow::Break),
                Step::Wait { ms } => {
                    let ms = eval_i64(ms, &st.vars)?.max(0) as u64;
                    st.sleep(Duration::from_millis(ms)).await?;
                }
                Step::WaitUntil { condition, poll_ms, timeout_ms, on_timeout } => {
                    let until = Instant::now() + Duration::from_millis(*timeout_ms);
                    loop {
                        st.check()?;
                        if eval_condition(condition, &st.vars, st.services)? {
                            break;
                        }
                        if Instant::now() >= until {
                            tracing::debug!("wait_until timed out, running on_timeout branch");
                            match run_steps(on_timeout, st).await? {
                                Flow::Next => {}
                                other => return Ok(other),
                            }
                            break;
                        }
                        st.sleep(Duration::from_millis((*poll_ms).max(10))).await?;
                    }
                }
                Step::SetVariable { name, value } => {
                    let v = eval_value(value, &st.vars)?;
                    tracing::debug!(name, value = %v, "set variable");
                    st.vars.insert(name.clone(), v);
                }
                Step::StopMacro => return Ok(Flow::Stop),
                Step::RunMacro { id } => {
                    let sub = st.lib.get(id).ok_or_else(|| ExecError::MacroNotFound(id.clone()))?;
                    if st.stack.iter().any(|s| s == id) || st.stack.len() >= MAX_CALL_DEPTH {
                        return Err(ExecError::Recursion(id.clone()));
                    }
                    st.stack.push(id.clone());
                    let flow = run_steps(&sub.steps, st).await;
                    st.stack.pop();
                    match flow? {
                        Flow::Stop => return Ok(Flow::Stop),
                        // Break never escapes a macro boundary into a caller's loop.
                        _ => {}
                    }
                }
                Step::LaunchProgram { path, args } => {
                    let path = eval_string(path, &st.vars)?;
                    let args = args
                        .iter()
                        .map(|a| eval_string(a, &st.vars))
                        .collect::<Result<Vec<_>, _>>()?;
                    launch_program(&path, &args);
                }
                Step::SendKeystroke { keys } => {
                    let combo = eval_string(keys, &st.vars)?;
                    st.services.inputs.send_combo(&combo).map_err(ExecError::Input)?;
                }
                Step::TypeText { text, char_delay_ms } => {
                    let text = eval_string(text, &st.vars)?;
                    if *char_delay_ms == 0 {
                        st.services.inputs.type_text(&text).map_err(ExecError::Input)?;
                    } else {
                        // Per-char typing stays cancellable between characters.
                        for c in text.chars() {
                            st.services.inputs.type_text(&c.to_string()).map_err(ExecError::Input)?;
                            st.sleep(Duration::from_millis(*char_delay_ms)).await?;
                        }
                    }
                }
                Step::HoldKey { key } => {
                    let key = eval_string(key, &st.vars)?;
                    st.services.inputs.hold_key(&key).map_err(ExecError::Input)?;
                }
                Step::ReleaseKey { key } => {
                    let key = eval_string(key, &st.vars)?;
                    st.services.inputs.release_key(&key).map_err(ExecError::Input)?;
                }
                Step::MouseMove { x, y, relative, window } => {
                    let (mut x, mut y) = (eval_i64(x, &st.vars)? as i32, eval_i64(y, &st.vars)? as i32);
                    let mut relative = *relative;
                    if let Some(sel) = window {
                        let win = st.resolve_window(sel)?;
                        x += win.rect.0;
                        y += win.rect.1;
                        relative = false;
                    }
                    st.services.inputs.mouse_move(x, y, relative).map_err(ExecError::Input)?;
                }
                Step::MouseClick { button, double } => {
                    st.services.inputs.click(*button, *double).map_err(ExecError::Input)?;
                }
                Step::MouseDrag { from_x, from_y, to_x, to_y, button } => {
                    let from = (eval_i64(from_x, &st.vars)? as i32, eval_i64(from_y, &st.vars)? as i32);
                    let to = (eval_i64(to_x, &st.vars)? as i32, eval_i64(to_y, &st.vars)? as i32);
                    st.services.inputs.drag(from, to, *button).map_err(ExecError::Input)?;
                }
                Step::Scroll { direction, amount } => {
                    let amount = eval_i64(amount, &st.vars)?;
                    st.services.inputs.scroll(*direction, amount as i32).map_err(ExecError::Input)?;
                }
                Step::FocusWindow { window } => {
                    let win = st.resolve_window(window)?;
                    st.wm().focus(win.id).map_err(ExecError::Window)?;
                }
                Step::MoveResizeWindow { window, x, y, w, h } => {
                    let win = st.resolve_window(window)?;
                    let dim = |p: &Option<Param<Value>>| -> Result<Option<window::Dim>, ExecError> {
                        match p {
                            None => Ok(None),
                            Some(p) => window::parse_dim(&eval_value(p, &st.vars)?)
                                .map(Some)
                                .map_err(ExecError::Eval),
                        }
                    };
                    let monitors = st.wm().monitors().map_err(ExecError::Window)?;
                    let mon = window::monitor_for(win.rect, &monitors)
                        .ok_or_else(|| ExecError::Window("no monitors".into()))?;
                    let (x, y, w, h) =
                        window::resolve_rect(win.rect, &mon, dim(x)?, dim(y)?, dim(w)?, dim(h)?);
                    st.wm().move_resize(win.id, x, y, w, h).map_err(ExecError::Window)?;
                }
                Step::MinimizeWindow { window } => {
                    let win = st.resolve_window(window)?;
                    st.wm().minimize(win.id).map_err(ExecError::Window)?;
                }
                Step::MaximizeWindow { window } => {
                    let win = st.resolve_window(window)?;
                    st.wm().maximize(win.id).map_err(ExecError::Window)?;
                }
                Step::RestoreWindow { window } => {
                    let win = st.resolve_window(window)?;
                    st.wm().restore(win.id).map_err(ExecError::Window)?;
                }
                Step::CloseWindow { window } => {
                    let win = st.resolve_window(window)?;
                    st.wm().close(win.id).map_err(ExecError::Window)?;
                }
                Step::ToggleAlwaysOnTop { window } => {
                    let win = st.resolve_window(window)?;
                    let on = st.wm().always_on_top(win.id).map_err(ExecError::Window)?;
                    st.wm().set_always_on_top(win.id, !on).map_err(ExecError::Window)?;
                }
                Step::MoveWindowToMonitor { window, monitor } => {
                    let win = st.resolve_window(window)?;
                    let n = eval_i64(monitor, &st.vars)?;
                    let monitors = st.wm().monitors().map_err(ExecError::Window)?;
                    let target = monitors.get((n - 1).max(0) as usize).ok_or_else(|| {
                        ExecError::Window(format!("monitor {n} of {} does not exist", monitors.len()))
                    })?;
                    let current = window::monitor_for(win.rect, &monitors)
                        .ok_or_else(|| ExecError::Window("no monitors".into()))?;
                    // keep size, translate by monitor-origin delta
                    let (x, y) = (
                        win.rect.0 - current.x + target.x,
                        win.rect.1 - current.y + target.y,
                    );
                    st.wm().move_resize(win.id, x, y, win.rect.2, win.rect.3)
                        .map_err(ExecError::Window)?;
                }
                Step::SetWindowTransparency { window, percent } => {
                    let win = st.resolve_window(window)?;
                    let pct = eval_i64(percent, &st.vars)?.clamp(0, 100);
                    let alpha = (pct * 255 / 100) as u8;
                    st.wm().set_transparency(win.id, alpha).map_err(ExecError::Window)?;
                }
                Step::SetClipboard { text } => {
                    let text = eval_string(text, &st.vars)?;
                    crate::macros::sys::clipboard_set(&text).map_err(ExecError::Input)?;
                }
                Step::ClipboardToVariable { variable } => {
                    let text = crate::macros::sys::clipboard_get().map_err(ExecError::Input)?;
                    st.vars.insert(variable.clone(), Value::String(text));
                }
                Step::ShowNotification { title, message } => {
                    let message = eval_string(message, &st.vars)?;
                    crate::macros::sys::notify(title, &message).map_err(ExecError::Input)?;
                }
                Step::PlaySound { path } => {
                    let path = eval_string(path, &st.vars)?;
                    crate::macros::sys::play_sound(&path).map_err(ExecError::Input)?;
                }
                Step::OpenPath { path } => {
                    let path = eval_string(path, &st.vars)?;
                    crate::macros::sys::open_path(&path).map_err(ExecError::Input)?;
                }
                Step::RunShellCommand { command, timeout_ms } => {
                    let command = eval_string(command, &st.vars)?;
                    let timeout = timeout_ms.unwrap_or(crate::macros::sys::DEFAULT_SHELL_TIMEOUT_MS);
                    let out = crate::macros::sys::run_shell(&command, timeout, &st.cancel)
                        .await
                        .map_err(ExecError::Input)?;
                    tracing::debug!(exit_code = out.exit_code, "shell command finished");
                    st.vars.insert("shell_stdout".into(), Value::String(out.stdout));
                    st.vars.insert("shell_stderr".into(), Value::String(out.stderr));
                    st.vars.insert("shell_exit_code".into(), out.exit_code.into());
                }
                Step::SetDefaultAudioDevice { name, input } => {
                    let name = eval_string(name, &st.vars)?;
                    let devices = st.services.audio.list().map_err(ExecError::Input)?;
                    let device = crate::macros::audio::match_device(&name, &devices, !input)
                        .ok_or_else(|| ExecError::Input(format!("no audio device matches {name:?}")))?;
                    tracing::info!(matched = %device.name, "setting default audio device");
                    st.services.audio.set_default(&device.id).map_err(ExecError::Input)?;
                }
                Step::AdjustVolume { delta } => {
                    let delta = eval_i64(delta, &st.vars)? as i32;
                    let now = st.services.audio.adjust_master_volume(delta).map_err(ExecError::Input)?;
                    tracing::debug!(volume = now, "master volume adjusted");
                }
                Step::SetVolume { level } => {
                    let level = eval_i64(level, &st.vars)? as i32;
                    let now = st.services.audio.set_master_volume(level).map_err(ExecError::Input)?;
                    tracing::debug!(volume = now, "master volume set");
                }
                Step::MuteToggle => {
                    let muted = st.services.audio.toggle_mute().map_err(ExecError::Input)?;
                    tracing::debug!(muted, "mute toggled");
                }
                Step::SetAppVolume { target, level, mute } => {
                    let target = eval_string(target, &st.vars)?;
                    let level = match level {
                        Some(p) => Some(eval_i64(p, &st.vars)? as i32),
                        None => None,
                    };
                    st.services
                        .audio
                        .set_app_volume(&target, level, *mute)
                        .map_err(ExecError::Input)?;
                    tracing::debug!(target, ?level, ?mute, "app volume set");
                }
                Step::ConfirmDialog { message } => {
                    let message = eval_string(message, &st.vars)?;
                    let confirmed = tokio::select! {
                        result = rfd::AsyncMessageDialog::new()
                            .set_title("KeyForge")
                            .set_description(&message)
                            .set_buttons(rfd::MessageButtons::OkCancel)
                            .show() => matches!(result, rfd::MessageDialogResult::Ok),
                        _ = st.cancel.cancelled() => return Err(ExecError::Cancelled),
                    };
                    if !confirmed {
                        tracing::info!("confirm dialog cancelled — stopping macro");
                        return Ok(Flow::Stop);
                    }
                }
            }
        }
        Ok(Flow::Next)
    })
}

/// Runs a macro to completion. Sub-macros (Run Macro) share the caller's
/// variables, runtime deadline, and loop budget — guards cover the whole run.
pub async fn execute_macro(
    mac: &Macro,
    lib: &MacroLibrary,
    services: &Services,
    cancel: CancellationToken,
) -> Result<Outcome, ExecError> {
    let mut st = ExecState {
        lib,
        services,
        vars: HashMap::new(),
        cancel,
        deadline: Instant::now()
            + Duration::from_millis(mac.max_runtime_ms.unwrap_or(DEFAULT_MAX_RUNTIME_MS)),
        loop_cap: mac.max_loop_iterations.unwrap_or(DEFAULT_MAX_LOOP_ITERATIONS),
        loops: 0,
        stack: vec![mac.id.clone()],
    };
    match run_steps(&mac.steps, &mut st).await? {
        Flow::Stop => Ok(Outcome::Stopped),
        _ => Ok(Outcome::Completed),
    }
}

// ------------------------------------------------------- observed (test) runs

/// One line of a test run's log, emitted per TOP-LEVEL step of the macro being
/// edited so the editor can show progress while a draft runs.
///
/// `status`: `start` (step entered) → `ok` (returned) | `error` (aborted the
/// run) | `skipped` (step is disabled, never entered). Nested steps inside an
/// If/Loop/While report as part of their enclosing top-level step — the log
/// mirrors the editor's step list, one row per visible step.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct StepProgress {
    pub run_id: u64,
    pub index: usize,
    pub total: usize,
    pub summary: String,
    pub status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl StepProgress {
    fn new(run_id: u64, index: usize, total: usize, summary: String, status: &'static str) -> Self {
        StepProgress { run_id, index, total, summary, status, error: None }
    }
}

/// Where per-step progress goes. The engine stays UI-agnostic: the wiring layer
/// passes a sink that emits a Tauri event, tests pass one that collects.
pub type StepSink = Arc<dyn Fn(StepProgress) + Send + Sync>;

/// Like [`execute_macro`], but runs the top-level steps one at a time and
/// reports each through `sink` — the play button in the macro editor.
///
/// `only` runs a SINGLE top-level step (index into `mac.steps`) instead of the
/// whole macro; variables it sets are discarded with the run, as each test run
/// starts from an empty variable scope. The macro need not exist on disk (it is
/// a draft), but `lib` is still consulted for `Run Macro` steps, so a sub-macro
/// resolves to its last SAVED version.
pub async fn execute_macro_observed(
    mac: &Macro,
    lib: &MacroLibrary,
    services: &Services,
    cancel: CancellationToken,
    run_id: u64,
    only: Option<usize>,
    sink: &StepSink,
) -> Result<Outcome, ExecError> {
    let total = mac.steps.len();
    let indices: Vec<usize> = match only {
        Some(i) if i < total => vec![i],
        Some(i) => {
            return Err(ExecError::Eval(format!("step {i} out of range (macro has {total} steps)")))
        }
        None => (0..total).collect(),
    };
    let mut st = ExecState {
        lib,
        services,
        vars: HashMap::new(),
        cancel,
        deadline: Instant::now()
            + Duration::from_millis(mac.max_runtime_ms.unwrap_or(DEFAULT_MAX_RUNTIME_MS)),
        loop_cap: mac.max_loop_iterations.unwrap_or(DEFAULT_MAX_LOOP_ITERATIONS),
        loops: 0,
        stack: vec![mac.id.clone()],
    };
    for index in indices {
        let block = &mac.steps[index];
        let summary = block.step.summary();
        let event = |status| StepProgress::new(run_id, index, total, summary.clone(), status);
        if block.disabled {
            sink(event("skipped"));
            continue;
        }
        sink(event("start"));
        // One block at a time: the shared `st` carries variables, the runtime
        // deadline and the loop budget across the whole run, exactly as a
        // single `run_steps` call over all of them would.
        match run_steps(std::slice::from_ref(block), &mut st).await {
            Ok(flow) => {
                sink(event("ok"));
                match flow {
                    Flow::Next => {}
                    // Stop/Break at the top level end the run (`Break` outside a
                    // loop is what plain `execute_macro` also treats as an end).
                    Flow::Stop => return Ok(Outcome::Stopped),
                    Flow::Break => break,
                }
            }
            Err(e) => {
                let mut ev = event("error");
                ev.error = Some(e.to_string());
                sink(ev);
                return Err(e);
            }
        }
    }
    Ok(Outcome::Completed)
}

pub fn launch_program(path: &str, args: &[String]) {
    let mut cmd = std::process::Command::new(path);
    match crate::pty::strip_webview_env(&mut cmd).args(args).spawn() {
        Ok(child) => tracing::info!(path, pid = child.id(), "launched program"),
        Err(e) => tracing::error!(path, error = %e, "failed to launch program"),
    }
}

// ------------------------------------------------------------------ dispatch

/// Live macro executions, cancellable as a group by the emergency stop.
#[derive(Default)]
pub struct Executions {
    next: AtomicU64,
    running: Mutex<HashMap<u64, (String, CancellationToken)>>,
}

impl Executions {
    pub fn register(&self, name: &str) -> (u64, CancellationToken) {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let token = CancellationToken::new();
        self.running.lock().unwrap().insert(id, (name.to_owned(), token.clone()));
        (id, token)
    }

    pub fn finish(&self, id: u64) {
        self.running.lock().unwrap().remove(&id);
    }

    pub fn cancel_all(&self) -> usize {
        let running = self.running.lock().unwrap();
        for (name, token) in running.values() {
            tracing::warn!(name, "cancelling running macro");
            token.cancel();
        }
        running.len()
    }

    /// Cancel ONE execution by run id (the macro editor's stop button).
    /// `false` if it already finished.
    pub fn cancel(&self, id: u64) -> bool {
        match self.running.lock().unwrap().get(&id) {
            Some((name, token)) => {
                tracing::info!(name, run_id = id, "cancelling macro run");
                token.cancel();
                true
            }
            None => false,
        }
    }

    pub fn count(&self) -> usize {
        self.running.lock().unwrap().len()
    }
}

/// Everything a fired trigger needs to start work off the UI thread.
#[derive(Clone)]
pub struct Dispatcher {
    pub handle: tokio::runtime::Handle,
    pub executions: Arc<Executions>,
    pub services: Arc<Services>,
    pub macros_dir: PathBuf,
}

impl Dispatcher {
    // Note: the `bindings::Action` dispatch bridge lives in the hotkeys wiring
    // layer (swarm task-5), not in this UI-agnostic engine core.

    pub fn run_macro_by_id(&self, id: &str) {
        let lib = MacroLibrary::load(&self.macros_dir);
        let Some(mac) = lib.resolve(id).cloned() else {
            tracing::error!(id, "macro not found in library (by id or name)");
            return;
        };
        self.spawn_macro(mac, lib);
    }

    pub fn spawn_macro(&self, mac: Macro, lib: MacroLibrary) {
        let (run_id, token) = self.executions.register(&mac.name);
        let executions = Arc::clone(&self.executions);
        let services = Arc::clone(&self.services);
        self.handle.spawn(async move {
            let started = Instant::now();
            tracing::info!(id = %mac.id, name = %mac.name, run_id, "macro started");
            let elapsed = move || started.elapsed().as_millis() as u64;
            match execute_macro(&mac, &lib, &services, token).await {
                Ok(outcome) => {
                    // A completed macro keeps deliberate holds; abnormal ends release.
                    tracing::info!(name = %mac.name, run_id, ?outcome, elapsed_ms = elapsed(), "macro finished")
                }
                Err(ExecError::Cancelled) => {
                    services.inputs.release_all();
                    tracing::warn!(name = %mac.name, run_id, elapsed_ms = elapsed(), "macro cancelled")
                }
                Err(e) => {
                    services.inputs.release_all();
                    tracing::error!(name = %mac.name, run_id, error = %e, elapsed_ms = elapsed(), "macro failed")
                }
            }
            executions.finish(run_id);
        });
    }

    /// Run an UNSAVED draft with per-step reporting (macro-editor play button).
    /// Returns the run id immediately — pass it to `executions.cancel` to stop
    /// just this run. `only` runs a single top-level step. `on_finish(run_id,
    /// result)` fires on the macro runtime once the run ends, however it ended.
    pub fn spawn_test_macro<F>(
        &self,
        mac: Macro,
        only: Option<usize>,
        sink: StepSink,
        on_finish: F,
    ) -> u64
    where
        F: FnOnce(u64, Result<Outcome, ExecError>) + Send + 'static,
    {
        let lib = MacroLibrary::load(&self.macros_dir);
        let (run_id, token) = self.executions.register(&format!("test: {}", mac.name));
        let executions = Arc::clone(&self.executions);
        let services = Arc::clone(&self.services);
        self.handle.spawn(async move {
            tracing::info!(id = %mac.id, name = %mac.name, run_id, ?only, "macro test run started");
            let result =
                execute_macro_observed(&mac, &lib, &services, token, run_id, only, &sink).await;
            // Any abnormal end releases held keys/mouse — a half-run draft must
            // not leave a modifier stuck down while the user keeps editing.
            if result.is_err() {
                services.inputs.release_all();
            }
            executions.finish(run_id);
            on_finish(run_id, result);
        });
        run_id
    }

    pub fn emergency_stop(&self) {
        let cancelled = self.executions.cancel_all();
        let released = self.services.inputs.release_all();
        tracing::warn!(cancelled, released, "EMERGENCY STOP");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::macros::model::SCHEMA_VERSION;
    use serde_json::json;

    fn blk(step: Step) -> Block {
        step.into()
    }

    fn mac(id: &str, steps: Vec<Block>) -> Macro {
        Macro {
            schema_version: SCHEMA_VERSION,
            id: id.into(),
            name: id.into(),
            description: String::new(),
            steps,
            max_runtime_ms: None,
            max_loop_iterations: None,
        }
    }

    fn set(name: &str, v: serde_json::Value) -> Block {
        blk(Step::SetVariable { name: name.into(), value: Param::Literal(v) })
    }

    fn set_expr(name: &str, expr: &str) -> Block {
        blk(Step::SetVariable { name: name.into(), value: Param::Expr { expr: expr.into() } })
    }

    fn var_is(name: &str, v: serde_json::Value) -> Condition {
        Condition::VariableComparison { variable: name.into(), op: CmpOp::Eq, value: v }
    }

    use crate::macros::audio::AudioDevice;
    use crate::macros::usb::UsbDevice;

    #[derive(Default)]
    struct FakeAudio {
        calls: Arc<Mutex<Vec<String>>>,
        devices: Vec<AudioDevice>,
    }

    impl AudioDeviceManager for FakeAudio {
        fn list(&self) -> Result<Vec<AudioDevice>, String> {
            Ok(self.devices.clone())
        }
        fn set_default(&self, id: &str) -> Result<(), String> {
            self.calls.lock().unwrap().push(format!("set_default {id}"));
            Ok(())
        }
        fn adjust_master_volume(&self, delta: i32) -> Result<i32, String> {
            self.calls.lock().unwrap().push(format!("volume {delta:+}"));
            Ok(50)
        }
        fn set_master_volume(&self, percent: i32) -> Result<i32, String> {
            let pct = percent.clamp(0, 100);
            self.calls.lock().unwrap().push(format!("volume ={pct}"));
            Ok(pct)
        }
        fn toggle_mute(&self) -> Result<bool, String> {
            self.calls.lock().unwrap().push("mute".into());
            Ok(true)
        }
        fn list_sessions(&self) -> Result<Vec<crate::macros::audio::AudioSession>, String> {
            use crate::macros::audio::AudioSession;
            Ok(vec![
                AudioSession { pid: 1000, name: "Firefox".into(), volume: 80, muted: false },
                AudioSession { pid: 1001, name: "Spotify".into(), volume: 50, muted: false },
            ])
        }
        fn set_app_volume(&self, target: &str, level: Option<i32>, mute: Option<bool>) -> Result<(), String> {
            self.calls.lock().unwrap().push(format!("app_volume {target} {level:?} {mute:?}"));
            Ok(())
        }
    }

    struct FakeUsb(Vec<UsbDevice>);

    impl UsbEnumerator for FakeUsb {
        fn list(&self) -> Result<Vec<UsbDevice>, String> {
            Ok(self.0.clone())
        }
    }

    struct Handles {
        input_events: Arc<Mutex<Vec<String>>>,
        wm_calls: Arc<Mutex<Vec<String>>>,
        audio_calls: Arc<Mutex<Vec<String>>>,
    }

    fn fake_services() -> (Services, Handles) {
        let (sim, input_events) = crate::macros::input::test_support::RecordingSim::new();
        let wm = crate::macros::window::test_support::FakeWm::default();
        let wm_calls = Arc::clone(&wm.calls);
        let audio = FakeAudio {
            devices: vec![
                AudioDevice { id: "spk-id".into(), name: "Speakers (Realtek)".into(), output: true, default: true },
                AudioDevice { id: "hp-id".into(), name: "Headphones (USB)".into(), output: true, default: false },
                AudioDevice { id: "mic-id".into(), name: "Microphone (USB)".into(), output: false, default: true },
            ],
            ..Default::default()
        };
        let audio_calls = Arc::clone(&audio.calls);
        let usb = FakeUsb(vec![UsbDevice {
            vid: 0x046D,
            pid: 0xC52B,
            name: "Logitech USB Receiver".into(),
            instance_id: r"USB\VID_046D&PID_C52B\6".into(),
        }]);
        let services = Services {
            inputs: Inputs::with_backend(sim),
            wm: Box::new(wm),
            audio: Box::new(audio),
            usb: Box::new(usb),
        };
        (services, Handles { input_events, wm_calls, audio_calls })
    }

    /// Run steps against an empty library, returning (flow/error, vars).
    async fn run(m: Macro) -> (Result<Outcome, ExecError>, HashMap<String, Value>) {
        run_in_lib(m, MacroLibrary::default()).await
    }

    async fn run_in_lib(m: Macro, lib: MacroLibrary) -> (Result<Outcome, ExecError>, HashMap<String, Value>) {
        let (services, _) = fake_services();
        let mut st = ExecState {
            lib: &lib,
            services: &services,
            vars: HashMap::new(),
            cancel: CancellationToken::new(),
            deadline: Instant::now() + Duration::from_millis(m.max_runtime_ms.unwrap_or(DEFAULT_MAX_RUNTIME_MS)),
            loop_cap: m.max_loop_iterations.unwrap_or(DEFAULT_MAX_LOOP_ITERATIONS),
            loops: 0,
            stack: vec![m.id.clone()],
        };
        let flow = run_steps(&m.steps, &mut st).await;
        let outcome = flow.map(|f| if f == Flow::Stop { Outcome::Stopped } else { Outcome::Completed });
        (outcome, st.vars)
    }

    #[tokio::test]
    async fn set_if_else() {
        let m = mac("t", vec![
            set("n", json!(2)),
            blk(Step::If {
                condition: var_is("n", json!(2)),
                then: vec![set("r", json!("yes"))],
                else_steps: vec![set("r", json!("no"))],
            }),
        ]);
        let (out, vars) = run(m).await;
        assert_eq!(out.unwrap(), Outcome::Completed);
        assert_eq!(vars["r"], json!("yes"));
    }

    #[tokio::test]
    async fn loop_with_break_and_expr() {
        let m = mac("t", vec![
            set("n", json!(0)),
            blk(Step::Loop {
                times: Param::Expr { expr: "5 + 5".into() },
                steps: vec![
                    set_expr("n", "n + 1"),
                    blk(Step::If {
                        condition: Condition::Expr { expr: "n >= 3".into() },
                        then: vec![blk(Step::Break)],
                        else_steps: vec![],
                    }),
                ],
            }),
        ]);
        let (out, vars) = run(m).await;
        assert_eq!(out.unwrap(), Outcome::Completed);
        assert_eq!(vars["n"], json!(3));
    }

    #[tokio::test]
    async fn while_loop() {
        let m = mac("t", vec![
            set("n", json!(0)),
            blk(Step::While {
                condition: Condition::Expr { expr: "n < 5".into() },
                steps: vec![set_expr("n", "n + 1")],
            }),
        ]);
        let (_, vars) = run(m).await;
        assert_eq!(vars["n"], json!(5));
    }

    #[tokio::test]
    async fn stop_skips_rest() {
        let m = mac("t", vec![set("a", json!(1)), blk(Step::StopMacro), set("b", json!(2))]);
        let (out, vars) = run(m).await;
        assert_eq!(out.unwrap(), Outcome::Stopped);
        assert!(!vars.contains_key("b"));
    }

    #[tokio::test]
    async fn loop_limit_guard() {
        let mut m = mac("t", vec![blk(Step::While {
            condition: Condition::Expr { expr: "true".into() },
            steps: vec![],
        })]);
        m.max_loop_iterations = Some(5);
        let (out, _) = run(m).await;
        assert_eq!(out.unwrap_err(), ExecError::LoopLimit);
    }

    #[tokio::test(start_paused = true)]
    async fn runtime_limit_guard() {
        let mut m = mac("t", vec![blk(Step::Wait { ms: Param::Literal(60_000) })]);
        m.max_runtime_ms = Some(100);
        let (out, _) = run(m).await;
        assert_eq!(out.unwrap_err(), ExecError::RuntimeLimit);
    }

    #[tokio::test]
    async fn cancellation() {
        let m = mac("t", vec![blk(Step::Wait { ms: Param::Literal(60_000) })]);
        let lib = MacroLibrary::default();
        let (services, _) = fake_services();
        let token = CancellationToken::new();
        token.cancel();
        let err = execute_macro(&m, &lib, &services, token).await.unwrap_err();
        assert_eq!(err, ExecError::Cancelled);
    }

    #[tokio::test(start_paused = true)]
    async fn input_steps_drive_simulator() {
        let (services, handles) = fake_services();
        let events = handles.input_events;
        let m = mac("t", vec![
            set("combo", json!("Ctrl+C")),
            blk(Step::SendKeystroke { keys: Param::Expr { expr: "combo".into() } }),
            blk(Step::TypeText { text: Param::Literal("hi".into()), char_delay_ms: 50 }),
            blk(Step::MouseMove { x: Param::Literal(10), y: Param::Literal(20), relative: false, window: None }),
            blk(Step::MouseClick { button: crate::macros::model::MouseButton::Left, double: false }),
            blk(Step::Scroll { direction: crate::macros::model::ScrollDirection::Down, amount: Param::Literal(3) }),
        ]);
        let lib = MacroLibrary::default();
        let out = execute_macro(&m, &lib, &services, CancellationToken::new()).await;
        assert_eq!(out.unwrap(), Outcome::Completed);
        assert_eq!(
            *events.lock().unwrap(),
            vec![
                "key Control Press",
                "key Unicode('c') Press",
                "key Unicode('c') Release",
                "key Control Release",
                "text \"h\"",
                "text \"i\"",
                "move abs 10,20",
                "button Left Click",
                "scroll Down 3",
            ]
        );
    }

    #[tokio::test]
    async fn abnormal_end_release_path_reports_held() {
        let (services, _) = fake_services();
        let m = mac("t", vec![
            blk(Step::HoldKey { key: Param::Literal("Shift".into()) }),
            blk(Step::Wait { ms: Param::Literal(60_000) }),
        ]);
        let lib = MacroLibrary::default();
        let token = CancellationToken::new();
        let cancel = token.clone();
        let task = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(50)).await;
            cancel.cancel();
        });
        let err = execute_macro(&m, &lib, &services, token).await.unwrap_err();
        task.await.unwrap();
        assert_eq!(err, ExecError::Cancelled);
        // what the dispatcher does on abnormal end:
        assert_eq!(services.inputs.release_all(), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn wait_until_timeout_branch() {
        let m = mac("t", vec![blk(Step::WaitUntil {
            condition: var_is("never", json!(true)),
            poll_ms: 50,
            timeout_ms: 500,
            on_timeout: vec![set("r", json!("timed out"))],
        })]);
        let (out, vars) = run(m).await;
        assert_eq!(out.unwrap(), Outcome::Completed);
        assert_eq!(vars["r"], json!("timed out"));
    }

    #[tokio::test]
    async fn wait_until_already_true() {
        let m = mac("t", vec![
            set("go", json!(true)),
            blk(Step::WaitUntil {
                condition: var_is("go", json!(true)),
                poll_ms: 50,
                timeout_ms: 10_000,
                on_timeout: vec![set("r", json!("timed out"))],
            }),
        ]);
        let (out, vars) = run(m).await;
        assert_eq!(out.unwrap(), Outcome::Completed);
        assert!(!vars.contains_key("r"));
    }

    #[tokio::test]
    async fn run_macro_shares_vars_and_detects_recursion() {
        let sub = mac("sub", vec![set_expr("n", "n * 10")]);
        let lib = library_of(vec![sub]);
        let m = mac("t", vec![set("n", json!(4)), blk(Step::RunMacro { id: "sub".into() })]);
        let (out, vars) = run_in_lib(m, lib).await;
        assert_eq!(out.unwrap(), Outcome::Completed);
        assert_eq!(vars["n"], json!(40));

        let selfcall = mac("loopy", vec![blk(Step::RunMacro { id: "loopy".into() })]);
        let lib = library_of(vec![selfcall.clone()]);
        let (out, _) = run_in_lib(selfcall, lib).await;
        assert!(matches!(out.unwrap_err(), ExecError::Recursion(_)));
    }

    fn library_of(macros: Vec<Macro>) -> MacroLibrary {
        let dir = std::env::temp_dir().join(format!("keyforge_lib_{}_{}", std::process::id(), macros[0].id));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        for m in &macros {
            crate::macros::persist::save(&dir.join(format!("{}.json", m.id)), m);
        }
        let lib = MacroLibrary::load(&dir);
        let _ = std::fs::remove_dir_all(&dir);
        lib
    }

    #[test]
    fn compare_semantics() {
        assert!(compare(CmpOp::Eq, &json!(3), &json!(3.0)).unwrap());
        assert!(compare(CmpOp::Ne, &json!("a"), &json!("b")).unwrap());
        assert!(compare(CmpOp::Lt, &json!(2), &json!(10)).unwrap());
        assert!(compare(CmpOp::Gt, &json!("b"), &json!("a")).unwrap());
        assert!(compare(CmpOp::Contains, &json!("hello world"), &json!("lo w")).unwrap());
        assert!(compare(CmpOp::Contains, &json!([1, 2, 3]), &json!(2)).unwrap());
        assert!(compare(CmpOp::Lt, &json!("a"), &json!(1)).is_err());
    }

    #[test]
    fn condition_groups() {
        let (wm, _) = fake_services();
        let vars = HashMap::from([("n".to_string(), json!(5))]);
        let t = Condition::Expr { expr: "n == 5".into() };
        let f = Condition::Expr { expr: "n == 6".into() };
        let all = Condition::All { conditions: vec![t.clone(), f.clone()] };
        let any = Condition::Any { conditions: vec![f.clone(), t.clone()] };
        let not = Condition::Not { condition: Box::new(f.clone()) };
        assert!(!eval_condition(&all, &vars, &wm).unwrap());
        assert!(eval_condition(&any, &vars, &wm).unwrap());
        assert!(eval_condition(&not, &vars, &wm).unwrap());
        // missing variable compares as null
        let missing = Condition::VariableComparison { variable: "ghost".into(), op: CmpOp::Eq, value: Value::Null };
        assert!(eval_condition(&missing, &vars, &wm).unwrap());
        // non-boolean condition expression is an error
        assert!(eval_condition(&Condition::Expr { expr: "1 + 1".into() }, &vars, &wm).is_err());
    }

    #[test]
    fn window_conditions_against_fake() {
        use crate::macros::window::{TitleMatch, WindowSelector};
        let (wm, _) = fake_services();
        let vars = HashMap::new();
        let exists = Condition::WindowExists {
            window: WindowSelector::Title { mode: TitleMatch::Contains, value: "notepad".into() },
        };
        let focused_kf = Condition::WindowFocused {
            window: WindowSelector::Process { name: "keyforge".into() },
        };
        let focused_np = Condition::WindowFocused {
            window: WindowSelector::Process { name: "notepad".into() },
        };
        let title_re = Condition::WindowTitleMatches { pattern: r"readme\.\w+ - Notepad".into() };
        assert!(eval_condition(&exists, &vars, &wm).unwrap());
        assert!(eval_condition(&focused_kf, &vars, &wm).unwrap());
        assert!(!eval_condition(&focused_np, &vars, &wm).unwrap());
        assert!(eval_condition(&title_re, &vars, &wm).unwrap());
    }

    #[tokio::test]
    async fn window_steps_drive_manager() {
        use crate::macros::window::WindowSelector;
        let (services, handles) = fake_services();
        let sel = WindowSelector::Process { name: "notepad".into() };
        let m = mac("t", vec![
            blk(Step::FocusWindow { window: sel.clone() }),
            blk(Step::MoveResizeWindow {
                window: sel.clone(),
                x: Some(Param::Literal(json!("10%"))),
                y: Some(Param::Literal(json!(0))),
                w: Some(Param::Literal(json!("50%"))),
                h: None,
            }),
            blk(Step::ToggleAlwaysOnTop { window: sel.clone() }),
            blk(Step::SetWindowTransparency { window: sel.clone(), percent: Param::Literal(80) }),
            blk(Step::CloseWindow { window: sel.clone() }),
        ]);
        let lib = MacroLibrary::default();
        let out = execute_macro(&m, &lib, &services, CancellationToken::new()).await;
        assert_eq!(out.unwrap(), Outcome::Completed);
        assert_eq!(
            *handles.wm_calls.lock().unwrap(),
            vec![
                "focus 1",
                // monitor 1920x1080: x=10% → 192, y=0, w=50% → 960, h kept (200)
                "move_resize 1 192,0 960x200",
                "set_always_on_top 1 true",
                "set_transparency 1 204",
                "close 1",
            ]
        );
    }

    #[tokio::test]
    async fn missing_window_is_clear_error() {
        let (services, _) = fake_services();
        let m = mac("t", vec![blk(Step::FocusWindow {
            window: crate::macros::window::WindowSelector::Process { name: "ghost".into() },
        })]);
        let lib = MacroLibrary::default();
        let err = execute_macro(&m, &lib, &services, CancellationToken::new()).await.unwrap_err();
        assert!(matches!(err, ExecError::Window(msg) if msg.contains("ghost")));
    }

    #[tokio::test]
    async fn audio_and_device_steps() {
        let (services, handles) = fake_services();
        let m = mac("t", vec![
            blk(Step::SetDefaultAudioDevice { name: Param::Literal("headphones".into()), input: false }),
            blk(Step::AdjustVolume { delta: Param::Literal(-10) }),
            // clamped, not passed through: 140 is a legal literal the UI can hold
            blk(Step::SetVolume { level: Param::Literal(140) }),
            blk(Step::MuteToggle),
            blk(Step::If {
                condition: Condition::All {
                    conditions: vec![
                        Condition::DeviceConnected { device: "046d:c52b".into() },
                        Condition::AudioDeviceExists { name: "microphone".into() },
                        Condition::Not {
                            condition: Box::new(Condition::DeviceConnected { device: "razer".into() }),
                        },
                    ],
                },
                then: vec![set("verdict", json!("devices ok"))],
                else_steps: vec![],
            }),
        ]);
        let lib = MacroLibrary::default();
        let (out, vars) = {
            let mut st = ExecState {
                lib: &lib,
                services: &services,
                vars: HashMap::new(),
                cancel: CancellationToken::new(),
                deadline: Instant::now() + Duration::from_secs(60),
                loop_cap: 100,
                loops: 0,
                stack: vec!["t".into()],
            };
            (run_steps(&m.steps, &mut st).await, st.vars)
        };
        out.unwrap();
        assert_eq!(vars["verdict"], json!("devices ok"));
        // fuzzy match picked the Headphones id, not the default Speakers
        assert_eq!(
            *handles.audio_calls.lock().unwrap(),
            vec!["set_default hp-id", "volume -10", "volume =100", "mute"]
        );
    }

    #[tokio::test]
    async fn shell_and_file_conditions() {
        let file = std::env::temp_dir().join(format!("keyforge_m6_{}.txt", std::process::id()));
        std::fs::write(&file, "x").unwrap();
        let m = mac("t", vec![
            blk(Step::RunShellCommand { command: Param::Literal("echo from-macro".into()), timeout_ms: None }),
            blk(Step::If {
                condition: Condition::All {
                    conditions: vec![
                        Condition::VariableComparison {
                            variable: "shell_stdout".into(),
                            op: CmpOp::Eq,
                            value: json!("from-macro"),
                        },
                        Condition::VariableComparison {
                            variable: "shell_exit_code".into(),
                            op: CmpOp::Eq,
                            value: json!(0),
                        },
                        Condition::FileExists { path: file.to_string_lossy().into_owned() },
                        Condition::DirectoryExists { path: std::env::temp_dir().to_string_lossy().into_owned() },
                        Condition::Not {
                            condition: Box::new(Condition::FileExists { path: "Z:/nope/ghost.bin".into() }),
                        },
                    ],
                },
                then: vec![set("verdict", json!("sys ok"))],
                else_steps: vec![],
            }),
        ]);
        let (out, vars) = run(m).await;
        let _ = std::fs::remove_file(&file);
        assert_eq!(out.unwrap(), Outcome::Completed);
        assert_eq!(vars["verdict"], json!("sys ok"));
    }

    // ------------------------------------------- observed (editor test) runs

    /// Run a draft through the observed path, returning the outcome and the log
    /// rows as (index, status) pairs plus the raw entries.
    async fn observed(m: Macro, only: Option<usize>) -> (Result<Outcome, ExecError>, Vec<StepProgress>) {
        let (services, _) = fake_services();
        let log = Arc::new(Mutex::new(Vec::new()));
        let collected = Arc::clone(&log);
        let sink: StepSink = Arc::new(move |p: StepProgress| collected.lock().unwrap().push(p));
        let out = execute_macro_observed(
            &m,
            &MacroLibrary::default(),
            &services,
            CancellationToken::new(),
            7,
            only,
            &sink,
        )
        .await;
        let entries = log.lock().unwrap().clone();
        (out, entries)
    }

    fn rows(entries: &[StepProgress]) -> Vec<(usize, &'static str)> {
        entries.iter().map(|e| (e.index, e.status)).collect()
    }

    #[tokio::test]
    async fn observed_run_reports_each_step_and_shares_variables() {
        let mut disabled = set("skipped", json!(true));
        disabled.disabled = true;
        // Step 2 reads step 0's variable: proves the run shares one scope even
        // though the blocks are executed one at a time.
        let m = mac("t", vec![set("n", json!(1)), disabled, set_expr("n", "n + 1")]);
        let (out, entries) = observed(m, None).await;
        assert_eq!(out.unwrap(), Outcome::Completed);
        assert_eq!(
            rows(&entries),
            vec![(0, "start"), (0, "ok"), (1, "skipped"), (2, "start"), (2, "ok")]
        );
        assert!(entries.iter().all(|e| e.run_id == 7 && e.total == 3));
        assert!(entries.iter().all(|e| e.error.is_none()));
        assert!(!entries[0].summary.is_empty());
    }

    #[tokio::test]
    async fn observed_single_step_runs_only_that_step() {
        let m = mac("t", vec![set("a", json!(1)), set("b", json!(2)), set("c", json!(3))]);
        let (out, entries) = observed(m, Some(1)).await;
        assert_eq!(out.unwrap(), Outcome::Completed);
        assert_eq!(rows(&entries), vec![(1, "start"), (1, "ok")]);
    }

    #[tokio::test]
    async fn observed_step_index_out_of_range_is_an_error() {
        let m = mac("t", vec![set("a", json!(1))]);
        let (out, entries) = observed(m, Some(4)).await;
        assert!(matches!(out, Err(ExecError::Eval(_))));
        assert!(entries.is_empty());
    }

    #[tokio::test]
    async fn observed_failing_step_logs_the_error_and_stops_the_run() {
        let m = mac(
            "t",
            vec![
                set("a", json!(1)),
                blk(Step::RunMacro { id: "ghost".into() }),
                set("never", json!(true)),
            ],
        );
        let (out, entries) = observed(m, None).await;
        assert_eq!(out, Err(ExecError::MacroNotFound("ghost".into())));
        assert_eq!(rows(&entries), vec![(0, "start"), (0, "ok"), (1, "start"), (1, "error")]);
        assert_eq!(entries[3].error.as_deref(), Some("macro not found: ghost"));
    }

    #[tokio::test]
    async fn observed_stop_macro_ends_the_run_as_stopped() {
        let m = mac("t", vec![set("a", json!(1)), blk(Step::StopMacro), set("never", json!(true))]);
        let (out, entries) = observed(m, None).await;
        assert_eq!(out.unwrap(), Outcome::Stopped);
        assert_eq!(rows(&entries), vec![(0, "start"), (0, "ok"), (1, "start"), (1, "ok")]);
    }

    #[test]
    fn executions_cancel_targets_one_run() {
        let ex = Executions::default();
        let (a, token_a) = ex.register("a");
        let (_b, token_b) = ex.register("b");
        assert!(ex.cancel(a));
        assert!(token_a.is_cancelled());
        assert!(!token_b.is_cancelled());
        assert_eq!(ex.count(), 2); // cancel signals; the run removes itself
        assert!(!ex.cancel(999));
    }
}
