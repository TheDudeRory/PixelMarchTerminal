//! KeyForge macro engine — UI-agnostic, trait-bounded core ported from
//! Z:/SVN/KeyForge/src (exec/macros/input/window/audio/usb/sys/persist.rs).
//!
//! Structural rule preserved from KeyForge: every OS capability sits behind a
//! trait with a `#[cfg(windows)]` native impl, a `#[cfg(not(windows))]` stub,
//! and a test fake. Nothing here touches Tauri / the UI — hotkey dispatch and
//! command wiring live in the hotkeys layer (swarm task-5).

pub mod audio;
pub mod exec;
pub mod input;
pub mod model;
pub mod persist;
pub mod sys;
pub mod usb;
pub mod window;

// Re-export the surface a wiring layer (task-4/task-5) actually consumes, so
// callers can `use crate::macros::{Dispatcher, Services, Macro, ...}` directly.
pub use exec::{
    eval_condition, eval_expr, execute_macro, launch_program, Dispatcher, Executions, ExecError,
    Outcome, Services, DEFAULT_MAX_LOOP_ITERATIONS, DEFAULT_MAX_RUNTIME_MS, MAX_CALL_DEPTH,
};
pub use input::{EnigoSimulator, Inputs, InputSimulator};
pub use model::{
    Block, CmpOp, Condition, Macro, MacroLibrary, MouseButton, Param, ScrollDirection, Step,
    SCHEMA_VERSION,
};
pub use window::{
    NativeWindowManager, WindowInfo, WindowManager, WindowSelector,
};
pub use audio::{AudioDevice, AudioDeviceManager, NativeAudioManager};
pub use usb::{NativeUsbEnumerator, UsbDevice, UsbEnumerator};
