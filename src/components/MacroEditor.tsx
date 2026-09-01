import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import {
  macrosTestCancel, macrosTestRun, macrosTestStep, onMacroTestDone, onMacroTestStep,
  type MacroTestDone, type MacroTestStatus, type MacroTestStep,
} from "../lib/ipc";
import { label as labelStyle } from "../lib/uiStyles";
import { KeyField } from "./KeyPicker";
import { isKnownToken } from "../lib/keys";
import "./macros.css";

/* =====================================================================
   KeyForge visual macro editor — React reimplementation of editor.rs +
   forms.rs. Scratch-style nested block editor over the macro model that
   the Rust engine (src-tauri/src/macros/model.rs) serializes. All JSON
   shapes here MUST match that model exactly (serde tags "type"/"by",
   snake_case, Param<T> untagged literal-or-{expr}).
   ===================================================================== */

// ------------------------------------------------------------ model types
export type Param<T> = T | { expr: string };
export const isExpr = (p: unknown): p is { expr: string } =>
  typeof p === "object" && p !== null && "expr" in (p as object);

export type TitleMode = "exact" | "contains" | "regex";
export type WindowSelector =
  | { by: "focused" }
  | { by: "title"; mode?: TitleMode; value: string }
  | { by: "process"; name: string }
  | { by: "class"; name: string };

export type CmpOp = "eq" | "ne" | "lt" | "gt" | "contains";

export type Condition =
  | { type: "all"; conditions: Condition[] }
  | { type: "any"; conditions: Condition[] }
  | { type: "not"; condition: Condition }
  | { type: "expr"; expr: string }
  | { type: "variable_comparison"; variable: string; op: CmpOp; value: unknown }
  | { type: "window_exists"; window: WindowSelector }
  | { type: "window_focused"; window: WindowSelector }
  | { type: "window_title_matches"; pattern: string }
  | { type: "process_running"; name: string }
  | { type: "device_connected"; device: string }
  | { type: "audio_device_exists"; name: string }
  | { type: "audio_device_is_default"; name: string }
  | { type: "file_exists"; path: string }
  | { type: "directory_exists"; path: string }
  | { type: "pixel_color_at"; x: number; y: number; color: string; tolerance?: number }
  | { type: "clipboard_contains"; pattern: string; regex?: boolean }
  | { type: "time_is_between"; start: string; end: string }
  | { type: "day_of_week_is"; days: string[] };

export type MouseButton = "left" | "right" | "middle";
export type ScrollDir = "up" | "down" | "left" | "right";

// Step is an open record keyed by "type"; typed access is done per-variant in
// the inspector. Keeping it loose avoids a 37-arm discriminated union here.
export interface Step {
  type: string;
  [k: string]: unknown;
}
export interface Block {
  disabled?: boolean;
  type: string; // flattened Step — Block = { disabled?, ...step }
  [k: string]: unknown;
}
export interface Macro {
  schema_version?: number;
  id: string;
  name: string;
  description?: string;
  steps: Block[];
  max_runtime_ms?: number | null;
  max_loop_iterations?: number | null;
}
export interface MacroInfo {
  id: string;
  name: string;
  description: string;
}

// ------------------------------------------------------------------- IPC
export const macrosList = (): Promise<MacroInfo[]> => invoke("macros_list");
export const macrosRun = (id: string): Promise<void> => invoke("macros_run", { id });
export const macrosStopAll = (): Promise<number> => invoke("macros_stop_all");
// The three below are wired by the coordinator (see chat-builder-1-2). Callers
// tolerate their absence: get/save/delete reject and the UI surfaces a note.
export const macrosGet = (id: string): Promise<Macro | null> => invoke("macros_get", { id });
export const macrosSave = (macro: Macro): Promise<MacroInfo> => invoke("macros_save", { macro });
export const macrosDelete = (id: string): Promise<void> => invoke("macros_delete", { id });

export interface AudioDeviceDto { id: string; name: string; output: boolean; default: boolean; }
export interface UsbDeviceDto { vid: string; pid: string; name: string; instance_id: string; }
export interface AudioSessionDto { pid: number; name: string; volume: number; muted: boolean; }
export const devicesAudio = (): Promise<AudioDeviceDto[]> => invoke("devices_audio");
export const devicesUsb = (): Promise<UsbDeviceDto[]> => invoke("devices_usb");
export const devicesAudioSessions = (): Promise<AudioSessionDto[]> => invoke("devices_audio_sessions");
export const setAppVolume = (target: string, level: number | null, mute: boolean | null): Promise<void> =>
  invoke("set_app_volume", { target, level, mute });

// Optional backend helper (flagged as bonus): capture a screen point + its
// pixel colour after a countdown. Falls back to manual entry when absent.
export interface ScreenPick { x: number; y: number; color: string; }
export const screenPick = (delayMs: number): Promise<ScreenPick> => invoke("screen_pick", { delayMs });

// ---------------------------------------------------------- step catalog
interface StepDef {
  type: string;
  label: string;
  cat: string;
  icon: string;
  make: () => Step;
}
const P0 = (): Param<number> => 0;
// Palette definitions — 37 step types across 5 categories (KeyForge Step enum).
export const STEP_DEFS: StepDef[] = [
  // Control
  { type: "if", cat: "Control", icon: "◇", label: "If / Else", make: () => ({ type: "if", condition: { type: "expr", expr: "true" }, then: [], else: [] }) },
  { type: "loop", cat: "Control", icon: "↻", label: "Loop (N times)", make: () => ({ type: "loop", times: 3 as Param<number>, steps: [] }) },
  { type: "while", cat: "Control", icon: "∞", label: "While", make: () => ({ type: "while", condition: { type: "expr", expr: "true" }, steps: [] }) },
  { type: "break", cat: "Control", icon: "⊘", label: "Break", make: () => ({ type: "break" }) },
  { type: "wait", cat: "Control", icon: "⏲", label: "Wait (ms)", make: () => ({ type: "wait", ms: 500 as Param<number> }) },
  { type: "wait_until", cat: "Control", icon: "⌛", label: "Wait until…", make: () => ({ type: "wait_until", condition: { type: "expr", expr: "true" }, poll_ms: 100, timeout_ms: 10000, on_timeout: [] }) },
  { type: "set_variable", cat: "Control", icon: "𝑥", label: "Set variable", make: () => ({ type: "set_variable", name: "var", value: 0 }) },
  { type: "stop_macro", cat: "Control", icon: "■", label: "Stop macro", make: () => ({ type: "stop_macro" }) },
  { type: "run_macro", cat: "Control", icon: "▶", label: "Run macro", make: () => ({ type: "run_macro", id: "" }) },
  { type: "confirm_dialog", cat: "Control", icon: "❓", label: "Confirm dialog", make: () => ({ type: "confirm_dialog", message: "Continue?" as Param<string> }) },
  // Input
  { type: "send_keystroke", cat: "Input", icon: "⌨", label: "Send keystroke", make: () => ({ type: "send_keystroke", keys: "Ctrl+C" as Param<string> }) },
  { type: "type_text", cat: "Input", icon: "🗛", label: "Type text", make: () => ({ type: "type_text", text: "" as Param<string>, char_delay_ms: 0 }) },
  { type: "hold_key", cat: "Input", icon: "⇩", label: "Hold key", make: () => ({ type: "hold_key", key: "Shift" as Param<string> }) },
  { type: "release_key", cat: "Input", icon: "⇧", label: "Release key", make: () => ({ type: "release_key", key: "Shift" as Param<string> }) },
  { type: "mouse_move", cat: "Input", icon: "✛", label: "Mouse move", make: () => ({ type: "mouse_move", x: P0(), y: P0(), relative: false }) },
  { type: "mouse_click", cat: "Input", icon: "🖱", label: "Mouse click", make: () => ({ type: "mouse_click", button: "left", double: false }) },
  { type: "mouse_drag", cat: "Input", icon: "⇖", label: "Mouse drag", make: () => ({ type: "mouse_drag", from_x: P0(), from_y: P0(), to_x: P0(), to_y: P0(), button: "left" }) },
  { type: "scroll", cat: "Input", icon: "⇳", label: "Scroll", make: () => ({ type: "scroll", direction: "down", amount: 3 as Param<number> }) },
  // Windows
  { type: "focus_window", cat: "Windows", icon: "◱", label: "Focus window", make: () => ({ type: "focus_window", window: { by: "focused" } }) },
  { type: "move_resize_window", cat: "Windows", icon: "⤢", label: "Move / resize", make: () => ({ type: "move_resize_window", window: { by: "focused" } }) },
  { type: "minimize_window", cat: "Windows", icon: "▁", label: "Minimize", make: () => ({ type: "minimize_window", window: { by: "focused" } }) },
  { type: "maximize_window", cat: "Windows", icon: "▢", label: "Maximize", make: () => ({ type: "maximize_window", window: { by: "focused" } }) },
  { type: "restore_window", cat: "Windows", icon: "❐", label: "Restore", make: () => ({ type: "restore_window", window: { by: "focused" } }) },
  { type: "close_window", cat: "Windows", icon: "✕", label: "Close window", make: () => ({ type: "close_window", window: { by: "focused" } }) },
  { type: "toggle_always_on_top", cat: "Windows", icon: "⌃", label: "Toggle on-top", make: () => ({ type: "toggle_always_on_top", window: { by: "focused" } }) },
  { type: "move_window_to_monitor", cat: "Windows", icon: "🖥", label: "To monitor", make: () => ({ type: "move_window_to_monitor", window: { by: "focused" }, monitor: 1 as Param<number> }) },
  { type: "set_window_transparency", cat: "Windows", icon: "◍", label: "Transparency", make: () => ({ type: "set_window_transparency", window: { by: "focused" }, percent: 100 as Param<number> }) },
  // Devices
  { type: "set_default_audio_device", cat: "Devices", icon: "🔊", label: "Default audio", make: () => ({ type: "set_default_audio_device", name: "" as Param<string>, input: false }) },
  { type: "adjust_volume", cat: "Devices", icon: "🔉", label: "Adjust volume", make: () => ({ type: "adjust_volume", delta: 10 as Param<number> }) },
  { type: "set_volume", cat: "Devices", icon: "🔊", label: "Set volume", make: () => ({ type: "set_volume", level: 50 as Param<number> }) },
  { type: "mute_toggle", cat: "Devices", icon: "🔇", label: "Mute toggle", make: () => ({ type: "mute_toggle" }) },
  { type: "set_app_volume", cat: "Devices", icon: "🎚", label: "App volume", make: () => ({ type: "set_app_volume", target: "" as Param<string>, level: 100 as Param<number> }) },
  // System
  { type: "launch_program", cat: "System", icon: "🚀", label: "Launch program", make: () => ({ type: "launch_program", path: "" as Param<string>, args: [] }) },
  { type: "open_path", cat: "System", icon: "📂", label: "Open path / URL", make: () => ({ type: "open_path", path: "" as Param<string> }) },
  { type: "run_shell_command", cat: "System", icon: "❯", label: "Run shell command", make: () => ({ type: "run_shell_command", command: "" as Param<string> }) },
  { type: "set_clipboard", cat: "System", icon: "📋", label: "Set clipboard", make: () => ({ type: "set_clipboard", text: "" as Param<string> }) },
  { type: "clipboard_to_variable", cat: "System", icon: "📥", label: "Clipboard → var", make: () => ({ type: "clipboard_to_variable", variable: "clip" }) },
  { type: "show_notification", cat: "System", icon: "🔔", label: "Notification", make: () => ({ type: "show_notification", title: "", message: "" as Param<string> }) },
  { type: "play_sound", cat: "System", icon: "🎵", label: "Play sound", make: () => ({ type: "play_sound", path: "" as Param<string> }) },
];
const DEF_BY_TYPE = new Map(STEP_DEFS.map((d) => [d.type, d]));
const CATEGORIES = ["Control", "Input", "Windows", "Devices", "System"];

// Slots (child block lists) a container step exposes — mirrors Step::child_lists.
interface Slot { key: string; label: string; }
export function slotsOf(step: { type: string }): Slot[] {
  switch (step.type) {
    case "if": return [{ key: "then", label: "then" }, { key: "else", label: "else" }];
    case "loop": return [{ key: "steps", label: "do" }];
    case "while": return [{ key: "steps", label: "do" }];
    case "wait_until": return [{ key: "on_timeout", label: "on timeout" }];
    default: return [];
  }
}
const isContainer = (s: { type: string }) => slotsOf(s).length > 0;

// -------------------------------------------------------- summaries (log line)
const ps = (p: unknown): string => (isExpr(p) ? `(${p.expr})` : String(p));
const describeSel = (w?: WindowSelector): string => {
  if (!w) return "";
  switch (w.by) {
    case "focused": return "focused window";
    case "title": return `title ${w.mode ?? "contains"} "${w.value}"`;
    case "process": return `process "${w.name}"`;
    case "class": return `class "${w.name}"`;
  }
};
export function stepSummary(s: Step): string {
  const w = s.window as WindowSelector | undefined;
  switch (s.type) {
    case "if": return "If …";
    case "loop": return `Loop ${ps(s.times)}×`;
    case "while": return "While …";
    case "break": return "Break";
    case "wait": return `Wait ${ps(s.ms)} ms`;
    case "wait_until": return `Wait until (timeout ${s.timeout_ms} ms)`;
    case "set_variable": return `Set ${s.name} = ${ps(s.value)}`;
    case "stop_macro": return "Stop macro";
    case "run_macro": return `Run macro ${s.id || "?"}`;
    case "confirm_dialog": return `Confirm: ${ps(s.message)}`;
    case "send_keystroke": return `Press ${ps(s.keys)}`;
    case "type_text": return `Type "${ps(s.text)}"`;
    case "hold_key": return `Hold ${ps(s.key)}`;
    case "release_key": return `Release ${ps(s.key)}`;
    case "mouse_move": return `Mouse ${s.window ? "in window" : s.relative ? "by" : "to"} (${ps(s.x)}, ${ps(s.y)})`;
    case "mouse_click": return `${s.double ? "Double-click" : "Click"} ${s.button}`;
    case "mouse_drag": return `Drag ${s.button} (${ps(s.from_x)},${ps(s.from_y)})→(${ps(s.to_x)},${ps(s.to_y)})`;
    case "scroll": return `Scroll ${s.direction} ${ps(s.amount)}`;
    case "focus_window": return `Focus ${describeSel(w)}`;
    case "move_resize_window": return `Move/resize ${describeSel(w)}`;
    case "minimize_window": return `Minimize ${describeSel(w)}`;
    case "maximize_window": return `Maximize ${describeSel(w)}`;
    case "restore_window": return `Restore ${describeSel(w)}`;
    case "close_window": return `Close ${describeSel(w)}`;
    case "toggle_always_on_top": return `Toggle on-top ${describeSel(w)}`;
    case "move_window_to_monitor": return `Move ${describeSel(w)} → monitor ${ps(s.monitor)}`;
    case "set_window_transparency": return `Opacity ${ps(s.percent)}% ${describeSel(w)}`;
    case "set_default_audio_device": return `Default ${s.input ? "input" : "output"} → ${ps(s.name)}`;
    case "adjust_volume": return `Volume ${ps(s.delta)}`;
    case "set_volume": return `Volume = ${ps(s.level)}%`;
    case "mute_toggle": return "Mute toggle";
    case "set_app_volume": {
      const parts: string[] = [];
      if (s.level !== undefined) parts.push(`vol ${ps(s.level)}`);
      if (s.mute !== undefined) parts.push(s.mute ? "mute" : "unmute");
      return `App ${ps(s.target)} → ${parts.length ? parts.join(", ") : "(no change)"}`;
    }
    case "launch_program": return `Launch ${ps(s.path)}`;
    case "open_path": return `Open ${ps(s.path)}`;
    case "run_shell_command": return `Shell: ${ps(s.command)}`;
    case "set_clipboard": return `Set clipboard "${ps(s.text)}"`;
    case "clipboard_to_variable": return `Clipboard → ${s.variable}`;
    case "show_notification": return `Notify "${s.title}"`;
    case "play_sound": return `Play ${ps(s.path)}`;
    default: return s.type;
  }
}
const stepLabel = (t: string) => DEF_BY_TYPE.get(t)?.label ?? t;

// ============================================================ path helpers
// A block path is [idx, slotKey, idx, slotKey, …, idx] (odd length). A "list
// path" is the even-length prefix that resolves to a Block[] container.
type Path = (number | string)[];
const pathKey = (p: Path) => p.join("/");
function resolveList(macro: Macro, listPath: Path): Block[] {
  let list = macro.steps;
  for (let i = 0; i < listPath.length; i += 2) {
    const idx = listPath[i] as number;
    const slot = listPath[i + 1] as string;
    const blk = list[idx] as Block;
    list = (blk[slot] as Block[]) ?? [];
  }
  return list;
}
function getBlock(macro: Macro, path: Path): Block | undefined {
  const listPath = path.slice(0, -1);
  const idx = path[path.length - 1] as number;
  return resolveList(macro, listPath)[idx];
}
const listPathsEqual = (a: Path, b: Path) => a.length === b.length && a.every((v, i) => v === b[i]);
// Is `inner` inside (or equal to) the block at `outer` path? Blocks the illegal
// "drop a container into its own child" move.
function isDescendant(outerBlockPath: Path, innerListPath: Path): boolean {
  if (innerListPath.length < outerBlockPath.length) return false;
  return outerBlockPath.every((v, i) => v === innerListPath[i]);
}

// ============================================== test-run (play button) state
// Pure reducer over the macro-test-step / macro-test-done events from the
// backend (src/lib/ipc.ts). Kept out of the component so it is unit-testable
// (MacroEditor.test.ts) — the component only wires events into it.
export interface RunLogEntry {
  index: number;            // top-level step index
  summary: string;
  status: MacroTestStatus;  // "start" while in flight, then ok/skipped/error
  error?: string;
}
export interface RunState {
  runId: number | null;     // null until macros_test_run resolves / first event
  running: boolean;
  mode: "full" | "step" | null;
  total: number;
  log: RunLogEntry[];
  result: { status: "completed" | "stopped" | "error"; error: string | null } | null;
}
export type RunAction =
  | { kind: "begin"; mode: "full" | "step" }          // dispatched before invoke
  | { kind: "attach"; runId: number }                 // invoke resolved with the id
  | { kind: "step"; ev: MacroTestStep }
  | { kind: "done"; ev: MacroTestDone }
  | { kind: "fail"; error: string }                   // invoke itself rejected
  | { kind: "clear" };

export const EMPTY_RUN: RunState = { runId: null, running: false, mode: null, total: 0, log: [], result: null };
const MAX_RUN_LOG = 200;

// Events for a run we are not watching are dropped. `runId` may still be null
// when the first event lands (events can beat the invoke promise), in which
// case the event's id is adopted.
const forThisRun = (s: RunState, id: number) => s.running && (s.runId === null || s.runId === id);

export function runReducer(s: RunState, a: RunAction): RunState {
  switch (a.kind) {
    case "begin":
      return { runId: null, running: true, mode: a.mode, total: 0, log: [], result: null };
    case "attach":
      return s.running && s.runId === null ? { ...s, runId: a.runId } : s;
    case "step": {
      const ev = a.ev;
      if (!forThisRun(s, ev.run_id)) return s;
      const entry: RunLogEntry = { index: ev.index, summary: ev.summary, status: ev.status, ...(ev.error ? { error: ev.error } : {}) };
      // A "start" opens the line; the terminal status for that same index
      // replaces it in place so each step shows exactly one row.
      const at = s.log.findIndex((e) => e.index === ev.index && e.status === "start");
      const log = at >= 0 && ev.status !== "start"
        ? s.log.map((e, i) => (i === at ? entry : e))
        : [...s.log, entry].slice(-MAX_RUN_LOG);
      return { ...s, runId: s.runId ?? ev.run_id, total: ev.total || s.total, log };
    }
    case "done": {
      const ev = a.ev;
      if (!forThisRun(s, ev.run_id)) return s;
      // A run that ended while a step line was still "start" (cancel, crash)
      // would otherwise show a spinner forever.
      const log = s.log.map((e) => (e.status === "start" ? { ...e, status: "skipped" as MacroTestStatus } : e));
      return { ...s, running: false, runId: s.runId ?? ev.run_id, log, result: { status: ev.status, error: ev.error } };
    }
    case "fail":
      return { ...s, running: false, result: { status: "error", error: a.error } };
    case "clear":
      return EMPTY_RUN;
  }
}

export const runStatusText = (s: RunState): string => {
  if (s.running) return s.mode === "step" ? "Running step…" : `Running… ${s.log.filter((e) => e.status !== "start").length}/${s.total || "?"}`;
  if (!s.result) return "";
  const errs = s.log.filter((e) => e.status === "error").length;
  switch (s.result.status) {
    case "completed": return errs ? `Finished with ${errs} error${errs > 1 ? "s" : ""}` : "Finished";
    case "stopped": return "Stopped";
    case "error": return `Failed: ${s.result.error ?? "unknown error"}`;
  }
};

// ===================================================================== UI
type DragState = { kind: "palette"; stepType: string } | { kind: "move"; path: Path } | null;

export function MacroEditor({ macroId, onClose, onSaved }: { macroId: string | null; onClose: () => void; onSaved: () => void }) {
  const [macro, setMacro] = useState<Macro | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<Path | null>(null);
  const [drag, setDrag] = useState<DragState>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [ctx, setCtx] = useState<{ x: number; y: number; path: Path } | null>(null);
  const [search, setSearch] = useState("");
  const [showWarns, setShowWarns] = useState(false);
  const undoRef = useRef<string[]>([]);
  const redoRef = useRef<string[]>([]);
  const clipRef = useRef<Block[]>([]);

  // load / init ------------------------------------------------------------
  useEffect(() => {
    let live = true;
    if (macroId == null) {
      setMacro({ schema_version: 1, id: "", name: "New macro", description: "", steps: [] });
      return;
    }
    macrosGet(macroId)
      .then((m) => { if (!live) return; if (m) setMacro(m); else setLoadErr("Macro not found."); })
      .catch((e) => { if (live) setLoadErr(`Could not load macro (backend command missing?): ${e}`); });
    return () => { live = false; };
  }, [macroId]);

  // commit a mutation (deep-cloned) with an undo snapshot -------------------
  const commit = useCallback((mutate: (m: Macro) => void, opts?: { clearSel?: boolean }) => {
    setMacro((prev) => {
      if (!prev) return prev;
      undoRef.current.push(JSON.stringify(prev));
      if (undoRef.current.length > 100) undoRef.current.shift();
      redoRef.current = [];
      const next: Macro = structuredClone(prev);
      mutate(next);
      return next;
    });
    setDirty(true);
    if (opts?.clearSel) { setSel(new Set()); setAnchor(null); }
  }, []);

  const undo = useCallback(() => {
    setMacro((prev) => {
      if (!prev || undoRef.current.length === 0) return prev;
      redoRef.current.push(JSON.stringify(prev));
      return JSON.parse(undoRef.current.pop()!) as Macro;
    });
    setSel(new Set()); setAnchor(null); setDirty(true);
  }, []);
  const redo = useCallback(() => {
    setMacro((prev) => {
      if (!prev || redoRef.current.length === 0) return prev;
      undoRef.current.push(JSON.stringify(prev));
      return JSON.parse(redoRef.current.pop()!) as Macro;
    });
    setSel(new Set()); setAnchor(null); setDirty(true);
  }, []);

  // structural ops ---------------------------------------------------------
  const insertAt = useCallback((listPath: Path, idx: number, block: Block) => {
    commit((m) => { resolveList(m, listPath).splice(idx, 0, block); }, { clearSel: true });
  }, [commit]);

  const moveBlock = useCallback((srcPath: Path, dstListPath: Path, dstIdx: number) => {
    if (isDescendant(srcPath, dstListPath)) return; // no self-nesting
    commit((m) => {
      const srcListPath = srcPath.slice(0, -1);
      const srcIdx = srcPath[srcPath.length - 1] as number;
      const srcList = resolveList(m, srcListPath);
      const [removed] = srcList.splice(srcIdx, 1);
      let di = dstIdx;
      if (listPathsEqual(srcListPath, dstListPath) && srcIdx < dstIdx) di--;
      resolveList(m, dstListPath).splice(di, 0, removed);
    }, { clearSel: true });
  }, [commit]);

  const patchBlock = useCallback((path: Path, patch: Record<string, unknown>) => {
    commit((m) => { const b = getBlock(m, path); if (b) Object.assign(b, patch); });
  }, [commit]);

  const deletePaths = useCallback((paths: Path[]) => {
    // delete deepest-last so earlier indices stay valid within each list
    const sorted = [...paths].sort((a, b) => pathKey(b).localeCompare(pathKey(a)));
    commit((m) => {
      for (const p of sorted) {
        const lp = p.slice(0, -1); const i = p[p.length - 1] as number;
        resolveList(m, lp).splice(i, 1);
      }
    }, { clearSel: true });
  }, [commit]);

  const selectedPaths = useMemo<Path[]>(() => macro ? [...sel].map((k) => k.split("/").map((s) => (/^\d+$/.test(s) ? Number(s) : s))) : [], [sel, macro]);

  // selection handling -----------------------------------------------------
  const onBlockClick = useCallback((path: Path, e: React.MouseEvent) => {
    const key = pathKey(path);
    if (e.ctrlKey || e.metaKey) {
      setSel((s) => { const n = new Set(s); n.has(key) ? n.delete(key) : n.add(key); return n; });
      setAnchor(path);
    } else if (e.shiftKey && anchor && listPathsEqual(anchor.slice(0, -1), path.slice(0, -1))) {
      // range within the same list
      const a = anchor[anchor.length - 1] as number, b = path[path.length - 1] as number;
      const lp = path.slice(0, -1);
      const lo = Math.min(a, b), hi = Math.max(a, b);
      const n = new Set<string>();
      for (let i = lo; i <= hi; i++) n.add(pathKey([...lp, i]));
      setSel(n);
    } else {
      setSel(new Set([key])); setAnchor(path);
    }
  }, [anchor]);

  // clipboard --------------------------------------------------------------
  const doCopy = useCallback((paths: Path[]) => {
    if (!macro) return;
    clipRef.current = paths.map((p) => structuredClone(getBlock(macro, p))).filter(Boolean) as Block[];
  }, [macro]);
  const doCut = useCallback((paths: Path[]) => { doCopy(paths); deletePaths(paths); }, [doCopy, deletePaths]);
  const pasteBelow = useCallback((path: Path) => {
    if (clipRef.current.length === 0) return;
    const lp = path.slice(0, -1); const idx = (path[path.length - 1] as number) + 1;
    commit((m) => { resolveList(m, lp).splice(idx, 0, ...structuredClone(clipRef.current)); }, { clearSel: true });
  }, [commit]);
  const duplicate = useCallback((path: Path) => {
    commit((m) => { const b = getBlock(m, path); if (b) { const lp = path.slice(0, -1); const idx = (path[path.length - 1] as number) + 1; resolveList(m, lp).splice(idx, 0, structuredClone(b)); } }, { clearSel: true });
  }, [commit]);
  const toggleDisabled = useCallback((paths: Path[]) => {
    commit((m) => { for (const p of paths) { const b = getBlock(m, p); if (b) b.disabled = !b.disabled; } });
  }, [commit]);

  // keyboard shortcuts -----------------------------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      const typing = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && !e.shiftKey) { e.preventDefault(); undo(); return; }
      if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === "y" || (e.key.toLowerCase() === "z" && e.shiftKey))) { e.preventDefault(); redo(); return; }
      if (typing) return;
      const paths = selectedPaths;
      if (e.key === "Delete" && paths.length) { e.preventDefault(); deletePaths(paths); }
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c" && paths.length) { e.preventDefault(); doCopy(paths); }
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "x" && paths.length) { e.preventDefault(); doCut(paths); }
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "v" && paths.length === 1) { e.preventDefault(); pasteBelow(paths[0]); }
      else if (e.key === "Escape") { if (ctx) setCtx(null); else onClose(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo, selectedPaths, deletePaths, doCopy, doCut, pasteBelow, ctx, onClose]);

  // validation (save-time warnings) ---------------------------------------
  const warnings = useMemo<string[]>(() => (macro ? validateMacro(macro) : []), [macro]);

  // save -------------------------------------------------------------------
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const doSave = useCallback(async () => {
    if (!macro) return;
    setSaveErr(null);
    try {
      await macrosSave(macro);
      setDirty(false);
      onSaved();
      onClose();
    } catch (e) {
      setSaveErr(`Save failed (backend command missing?): ${e}`);
    }
  }, [macro, onSaved, onClose]);

  // test run (play button) -------------------------------------------------
  const [run, dispatchRun] = useReducer(runReducer, EMPTY_RUN);
  const runRef = useRef(run);
  runRef.current = run;

  useEffect(() => {
    let live = true;
    const uns: (() => void)[] = [];
    const keep = (u: () => void) => { if (live) uns.push(u); else u(); };
    onMacroTestStep((ev) => dispatchRun({ kind: "step", ev })).then(keep).catch(() => {});
    onMacroTestDone((ev) => dispatchRun({ kind: "done", ev })).then(keep).catch(() => {});
    return () => {
      live = false;
      uns.forEach((u) => u());
      // Never leave a draft running behind a closed editor.
      const cur = runRef.current;
      if (cur.running && cur.runId != null) macrosTestCancel(cur.runId).catch(() => {});
    };
  }, []);

  const startRun = useCallback(async (index: number | null) => {
    if (!macro || runRef.current.running) return;
    dispatchRun({ kind: "begin", mode: index == null ? "full" : "step" });
    try {
      const id = index == null ? await macrosTestRun(macro) : await macrosTestStep(macro, index);
      dispatchRun({ kind: "attach", runId: id });
    } catch (e) {
      dispatchRun({ kind: "fail", error: `test run failed (backend command missing?): ${e}` });
    }
  }, [macro]);

  const stopRun = useCallback(() => {
    const cur = runRef.current;
    if (!cur.running || cur.runId == null) return;
    macrosTestCancel(cur.runId).catch(() => {});
  }, []);

  // "Run this step" targets a single selected top-level block; nested blocks
  // have no standalone index in macros_test_step.
  const stepIndex = selectedPaths.length === 1 && selectedPaths[0].length === 1 ? (selectedPaths[0][0] as number) : null;

  // palette drag start -----------------------------------------------------
  // WebKitGTK (the Linux webview) refuses to start a drag whose dataTransfer is
  // empty — dragstart fires, then nothing else does. Always seed a payload.
  const onPalletDragStart = (e: React.DragEvent, stepType: string) => {
    e.dataTransfer.setData("text/plain", stepType);
    e.dataTransfer.effectAllowed = "copy";
    setDrag({ kind: "palette", stepType });
  };

  // handle a drop into a list at index -------------------------------------
  const handleDrop = useCallback((dstListPath: Path, dstIdx: number) => {
    if (!drag) return;
    if (drag.kind === "palette") {
      const def = DEF_BY_TYPE.get(drag.stepType);
      if (def) insertAt(dstListPath, dstIdx, def.make() as Block);
    } else {
      moveBlock(drag.path, dstListPath, dstIdx);
    }
    setDrag(null); setDropTarget(null);
  }, [drag, insertAt, moveBlock]);

  if (loadErr) {
    return (
      <div className="mac-editor">
        <div className="mac-editor-head"><span style={{ flex: 1, fontWeight: 700 }}>Macro editor</span><button className="mac-btn" onClick={onClose}>Close</button></div>
        <div style={{ padding: 24, color: "#e88" }}>{loadErr}</div>
      </div>
    );
  }
  if (!macro) return <div className="mac-editor"><div style={{ padding: 24, color: "var(--muted)" }}>Loading…</div></div>;

  const selPath0 = selectedPaths.length === 1 ? selectedPaths[0] : null;
  const selBlock = selPath0 ? getBlock(macro, selPath0) : undefined;

  const palItems = STEP_DEFS.filter((d) => !search || d.label.toLowerCase().includes(search.toLowerCase()) || d.type.includes(search.toLowerCase()));

  return (
    <div className="mac-editor" onClick={() => ctx && setCtx(null)}>
      <div className="mac-editor-head">
        <input className="mac-name" value={macro.name} placeholder="Macro name"
          onChange={(e) => { setMacro({ ...macro, name: e.target.value }); setDirty(true); }} />
        <input className="mac-input" style={{ maxWidth: 260 }} value={macro.description ?? ""} placeholder="Description (optional)"
          onChange={(e) => { setMacro({ ...macro, description: e.target.value }); setDirty(true); }} />
        <div style={{ flex: 1 }} />
        {run.running ? (
          <button className="mac-btn estop" title="Stop the test run" onClick={stopRun}>■ Stop</button>
        ) : (
          <button className="mac-btn play" title="Run this macro as edited, without saving" disabled={macro.steps.length === 0}
            onClick={() => startRun(null)}>▶ Test</button>
        )}
        <button className="mac-btn tiny" title={stepIndex == null ? "Select one top-level block to run it alone" : `Run step ${stepIndex + 1} only`}
          disabled={run.running || stepIndex == null} onClick={() => startRun(stepIndex)}>▶| Step</button>
        <button className="mac-btn tiny" title="Undo (Ctrl+Z)" onClick={undo} disabled={!undoRef.current.length}>↶ Undo</button>
        <button className="mac-btn tiny" title="Redo (Ctrl+Y)" onClick={redo} disabled={!redoRef.current.length}>↷ Redo</button>
        {warnings.length > 0 && <button className="mac-btn tiny" style={{ color: "#f0c060" }} onClick={() => setShowWarns((v) => !v)}>⚠ {warnings.length}</button>}
        <button className="mac-btn primary" onClick={doSave}>{dirty ? "Save" : "Saved"}</button>
        <button className="mac-btn" onClick={onClose}>Close</button>
      </div>

      <div className="mac-editor-body">
        {/* palette */}
        <div className="mac-palette">
          <input className="mac-input mac-palette-search" placeholder="Search blocks…" value={search} onChange={(e) => setSearch(e.target.value)} />
          <div className="mac-palette-list">
            {CATEGORIES.map((cat) => {
              const items = palItems.filter((d) => d.cat === cat);
              if (!items.length) return null;
              return (
                <div key={cat}>
                  <div className="mac-cat">{cat}</div>
                  {items.map((d) => (
                    <div key={d.type} className="mac-pal-item" draggable
                      onDragStart={(e) => onPalletDragStart(e, d.type)}
                      onDragEnd={() => { setDrag(null); setDropTarget(null); }}
                      onDoubleClick={() => insertAt([], macro.steps.length, d.make() as Block)}
                      title="Drag into the canvas, or double-click to append">
                      <span className="mac-pal-icon">{d.icon}</span>{d.label}
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        </div>

        {/* canvas — the whole area is a drop target; inner drop-strips stopPropagation so they win when hit */}
        <div className="mac-canvas"
          onDragOver={(e) => { if (drag) { e.preventDefault(); } }}
          onDrop={(e) => { if (drag) { e.preventDefault(); handleDrop([], macro.steps.length); } }}>
          {showWarns && warnings.length > 0 && (
            <div className="mac-warns">Save-time warnings:<ul>{warnings.map((w, i) => <li key={i}>{w}</li>)}</ul></div>
          )}
          {saveErr && <div className="mac-warns" style={{ background: "#4a1a1a", borderColor: "#6a2020", color: "#f2b0b0" }}>{saveErr}</div>}
          {macro.steps.length === 0 && (
            <div className={`mac-canvas-empty${drag ? " drop" : ""}`} style={{ pointerEvents: "none" }}>
              {drag ? "Drop here to add the block." : "Empty macro. Drag blocks from the left, or double-click a block to append."}
            </div>
          )}
          <BlockList
            list={macro.steps} listPath={[]}
            sel={sel} onBlockClick={onBlockClick}
            drag={drag} dropTarget={dropTarget} setDropTarget={setDropTarget} onDrop={handleDrop} setDrag={setDrag}
            onCtx={(path, e) => { e.preventDefault(); e.stopPropagation(); if (!sel.has(pathKey(path))) { setSel(new Set([pathKey(path)])); setAnchor(path); } setCtx({ x: e.clientX, y: e.clientY, path }); }}
          />
        </div>

        {/* inspector */}
        <div className="mac-inspector">
          {!selBlock ? (
            <div style={{ color: "var(--muted)", fontSize: 12.5 }}>
              {selectedPaths.length > 1 ? `${selectedPaths.length} blocks selected.` : "Select a block to edit its parameters."}
            </div>
          ) : (
            <>
              <h4>{stepLabel(selBlock.type)}</h4>
              <label className="mac-check">
                <input type="checkbox" checked={!selBlock.disabled} onChange={(e) => patchBlock(selPath0!, { disabled: !e.target.checked })} />
                Enabled
              </label>
              <Inspector step={selBlock as Step} onPatch={(patch) => patchBlock(selPath0!, patch)} />
              <div style={{ marginTop: 14, borderTop: "1px solid var(--border)", paddingTop: 12 }}>
                <button className="mac-btn danger tiny" onClick={() => deletePaths([selPath0!])}>Delete block</button>
              </div>
            </>
          )}
          <div style={{ marginTop: 20, borderTop: "1px solid var(--border)", paddingTop: 12 }}>
            <h4>Runaway guards</h4>
            <NumOpt label="Max runtime (ms)" value={macro.max_runtime_ms ?? null} placeholder="60000 (default)"
              onChange={(v) => { setMacro({ ...macro, max_runtime_ms: v }); setDirty(true); }} />
            <NumOpt label="Max loop iterations" value={macro.max_loop_iterations ?? null} placeholder="10000 (default)"
              onChange={(v) => { setMacro({ ...macro, max_loop_iterations: v }); setDirty(true); }} />
          </div>
        </div>
      </div>

      {(run.running || run.log.length > 0 || run.result) && (
        <div className="mac-runbar">
          <div className="mac-runbar-head">
            <span className={`mac-run-state${run.running ? " live" : run.result?.status === "error" ? " err" : ""}`}>
              {run.running ? "▶" : run.result?.status === "error" ? "✕" : "●"}
            </span>
            <span style={{ ...labelStyle, color: "var(--text)", fontWeight: 600 }}>{runStatusText(run)}</span>
            <div style={{ flex: 1 }} />
            {!run.running && <button className="mac-btn tiny" onClick={() => dispatchRun({ kind: "clear" })}>Clear</button>}
          </div>
          <div className="mac-runbar-log">
            {run.log.map((e, i) => (
              <div key={`${e.index}-${i}`} className={`mac-run-item ${e.status}`} title={e.error ?? ""}>
                <span className="mac-run-dot" />
                <span className="mac-run-idx">{e.index + 1}</span>
                <span className="mac-run-sum">{e.summary}</span>
                {e.error && <span className="mac-run-err">{e.error}</span>}
              </div>
            ))}
            {run.result?.status === "error" && run.result.error && (
              <div className="mac-run-item error"><span className="mac-run-dot" /><span className="mac-run-err">{run.result.error}</span></div>
            )}
          </div>
        </div>
      )}

      {ctx && (
        <div className="mac-ctx" style={{ left: Math.min(ctx.x, window.innerWidth - 180), top: Math.min(ctx.y, window.innerHeight - 240) }} onClick={(e) => e.stopPropagation()}>
          <CtxItem label="Cut" k="Ctrl+X" onClick={() => { doCut(selectedPaths); setCtx(null); }} />
          <CtxItem label="Copy" k="Ctrl+C" onClick={() => { doCopy(selectedPaths); setCtx(null); }} />
          <CtxItem label="Paste below" k="Ctrl+V" disabled={clipRef.current.length === 0} onClick={() => { pasteBelow(ctx.path); setCtx(null); }} />
          <CtxItem label="Duplicate" onClick={() => { duplicate(ctx.path); setCtx(null); }} />
          <div className="mac-ctx-sep" />
          <CtxItem label={getBlock(macro, ctx.path)?.disabled ? "Enable" : "Disable"} onClick={() => { toggleDisabled(selectedPaths); setCtx(null); }} />
          <div className="mac-ctx-sep" />
          <CtxItem label="Delete" k="Del" onClick={() => { deletePaths(selectedPaths); setCtx(null); }} />
        </div>
      )}
    </div>
  );
}

function CtxItem({ label, k, onClick, disabled }: { label: string; k?: string; onClick: () => void; disabled?: boolean }) {
  return <div className={`mac-ctx-item${disabled ? " disabled" : ""}`} onClick={onClick}><span>{label}</span>{k && <span className="mac-ctx-key">{k}</span>}</div>;
}

// -------------------------------------------------------- recursive block list
function BlockList(props: {
  list: Block[]; listPath: Path;
  sel: Set<string>; onBlockClick: (p: Path, e: React.MouseEvent) => void;
  drag: DragState; dropTarget: string | null; setDropTarget: (s: string | null) => void;
  onDrop: (listPath: Path, idx: number) => void; setDrag: (d: DragState) => void;
  onCtx: (p: Path, e: React.MouseEvent) => void;
}) {
  const { list, listPath, drag } = props;
  const dz = (idx: number) => {
    const key = `${pathKey(listPath)}#${idx}`;
    const over = props.dropTarget === key && !!drag;
    return (
      <div className={`mac-drop${over ? " over" : ""}`} key={`dz-${idx}`}
        onDragOver={(e) => { if (drag) { e.preventDefault(); props.setDropTarget(key); } }}
        onDragLeave={() => { if (props.dropTarget === key) props.setDropTarget(null); }}
        onDrop={(e) => { e.preventDefault(); e.stopPropagation(); props.onDrop(listPath, idx); }} />
    );
  };
  return (
    <>
      {dz(0)}
      {list.map((blk, i) => {
        const path = [...listPath, i];
        return (
          <div key={i}>
            <BlockNode blk={blk} path={path} {...props} />
            {dz(i + 1)}
          </div>
        );
      })}
    </>
  );
}

function BlockNode(props: {
  blk: Block; path: Path;
  sel: Set<string>; onBlockClick: (p: Path, e: React.MouseEvent) => void;
  drag: DragState; dropTarget: string | null; setDropTarget: (s: string | null) => void;
  onDrop: (listPath: Path, idx: number) => void; setDrag: (d: DragState) => void;
  onCtx: (p: Path, e: React.MouseEvent) => void;
}) {
  const { blk, path } = props;
  const selected = props.sel.has(pathKey(path));
  const container = isContainer(blk);
  return (
    <div className={`mac-block${selected ? " selected" : ""}${blk.disabled ? " disabled" : ""}${container ? " container" : ""}`}
      onContextMenu={(e) => props.onCtx(path, e)}>
      <div className="mac-block-head"
        draggable
        onDragStart={(e) => {
          e.stopPropagation();
          // Empty dataTransfer => WebKitGTK aborts the drag before dragover.
          e.dataTransfer.setData("text/plain", pathKey(path));
          e.dataTransfer.effectAllowed = "move";
          props.setDrag({ kind: "move", path });
        }}
        onDragEnd={() => props.setDrag(null)}
        onClick={(e) => { e.stopPropagation(); props.onBlockClick(path, e); }}>
        <span className="mac-grip">⠿</span>
        <span className="mac-block-title">
          <span className="mac-block-kind">{stepLabel(blk.type)}</span>
          <span className="mac-block-sum">{stepSummary(blk as Step)}</span>
        </span>
      </div>
      {container && slotsOf(blk).map((slot) => (
        <div className="mac-slot" key={slot.key}>
          <div className="mac-slot-label">{slot.label}</div>
          <BlockList list={(blk[slot.key] as Block[]) ?? []} listPath={[...path, slot.key]}
            sel={props.sel} onBlockClick={props.onBlockClick}
            drag={props.drag} dropTarget={props.dropTarget} setDropTarget={props.setDropTarget}
            onDrop={props.onDrop} setDrag={props.setDrag} onCtx={props.onCtx} />
        </div>
      ))}
    </div>
  );
}

// ------------------------------------------- shared small field components
function NumOpt({ label, value, onChange, placeholder }: { label: string; value: number | null; onChange: (v: number | null) => void; placeholder?: string }) {
  return (
    <div className="mac-field">
      <label>{label}</label>
      <input className="mac-input" type="number" value={value ?? ""} placeholder={placeholder}
        onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))} />
    </div>
  );
}

// A Param<T> editor: literal widget + an "fx" toggle that switches to a Rhai
// expression ({ expr }). kind picks the literal input shape.
function ParamField({ label, value, onChange, kind, placeholder, deviceNames }: {
  label: string; value: unknown; onChange: (v: unknown) => void;
  kind: "string" | "int" | "json" | "dim"; placeholder?: string; deviceNames?: string[];
}) {
  const expr = isExpr(value);
  const listId = deviceNames ? `dl-${label.replace(/\W/g, "")}` : undefined;
  const toLit = (): unknown => (kind === "int" ? 0 : kind === "json" ? "" : "");
  const setLit = (raw: string) => {
    if (kind === "int") onChange(raw === "" ? 0 : Number(raw));
    else if (kind === "dim") onChange(/^-?\d+$/.test(raw.trim()) ? Number(raw) : raw);
    else if (kind === "json") { try { onChange(JSON.parse(raw)); } catch { onChange(raw); } }
    else onChange(raw);
  };
  const litStr = expr ? "" : (kind === "json" && typeof value !== "string" ? JSON.stringify(value) : String(value ?? ""));
  return (
    <div className="mac-field">
      <label>{label}</label>
      <div className="mac-row">
        {expr ? (
          <input className="mac-input mac-mono" value={(value as { expr: string }).expr} placeholder="rhai expression"
            onChange={(e) => onChange({ expr: e.target.value })} />
        ) : kind === "int" ? (
          <input className="mac-input" type="number" value={litStr} placeholder={placeholder} onChange={(e) => setLit(e.target.value)} />
        ) : (
          <>
            <input className="mac-input" value={litStr} placeholder={placeholder} list={listId} onChange={(e) => setLit(e.target.value)} />
            {deviceNames && <datalist id={listId}>{deviceNames.map((n) => <option key={n} value={n} />)}</datalist>}
          </>
        )}
        <button className={`mac-fx${expr ? " on" : ""}`} title="Toggle Rhai expression" onClick={() => onChange(expr ? toLit() : { expr: "" })}>fx</button>
      </div>
    </div>
  );
}

function TextField({ label, value, onChange, placeholder, options }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string; options?: string[] }) {
  const listId = options ? `dl-cond-${label.replace(/\W/g, "")}` : undefined;
  return <div className="mac-field"><label>{label}</label>
    <input className="mac-input" value={value} placeholder={placeholder} list={listId} onChange={(e) => onChange(e.target.value)} />
    {options && <datalist id={listId}>{options.map((n) => <option key={n} value={n} />)}</datalist>}
  </div>;
}
function NumField({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return <div className="mac-field"><label>{label}</label><input className="mac-input" type="number" value={value} onChange={(e) => onChange(Number(e.target.value))} /></div>;
}
function SelectField<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: readonly T[]; onChange: (v: T) => void }) {
  return <div className="mac-field"><label>{label}</label><select className="mac-select" value={value} onChange={(e) => onChange(e.target.value as T)}>{options.map((o) => <option key={o} value={o}>{o}</option>)}</select></div>;
}
function CheckField({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return <label className="mac-check"><input type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} />{label}</label>;
}

// ------------------------------------------------ key-combo capture widget
// Recording only reaches keys the keyboard has; KeyField pairs it with a picker
// over the shared catalog (media keys, F13-F24, numpad — see src/lib/keys.ts).
function KeyCombo({ label, value, onChange, single }: { label: string; value: unknown; onChange: (v: unknown) => void; single?: boolean }) {
  const expr = isExpr(value);
  return (
    <div className="mac-field">
      <label>{label}</label>
      {expr ? (
        <div className="mac-row">
          <input className="mac-input mac-mono" value={(value as { expr: string }).expr} onChange={(e) => onChange({ expr: e.target.value })} placeholder="rhai expression" />
          <button className="mac-fx on" title="Toggle Rhai expression" onClick={() => onChange("")}>fx</button>
        </div>
      ) : (
        <KeyField value={String(value ?? "")} single={single} onChange={(v) => onChange(v)}
          trailing={<button className="mac-fx" title="Toggle Rhai expression" onClick={() => onChange({ expr: "" })}>fx</button>} />
      )}
    </div>
  );
}

// ------------------------------------------------ screen position picker
function PositionPicker({ onPicked }: { onPicked: (p: ScreenPick) => void }) {
  const [count, setCount] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const start = async () => {
    setErr(null); setCount(3);
    for (let n = 3; n > 0; n--) { setCount(n); await new Promise((r) => setTimeout(r, 1000)); }
    setCount(null);
    try { onPicked(await screenPick(0)); }
    catch { setErr("Screen picker needs a backend command (screen_pick) — enter coordinates manually."); }
  };
  return (
    <div style={{ marginBottom: 10 }}>
      <button className="mac-btn tiny" onClick={start}>◎ Pick on screen (3s hover)</button>
      {err && <div style={{ fontSize: 11, color: "#e0a860", marginTop: 4 }}>{err}</div>}
      {count != null && (
        <div className="mac-pick-overlay" onClick={() => setCount(null)}>
          <div className="mac-pick-card"><div className="mac-pick-count">{count}</div><div style={{ color: "var(--muted)", fontSize: 12 }}>hover the target — capturing position + pixel colour</div></div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------- window selector editor
function WindowSelectorEditor({ value, onChange }: { value: WindowSelector; onChange: (v: WindowSelector) => void }) {
  const by = value.by;
  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: 6, padding: 8, marginBottom: 11 }}>
      <div className="mac-field" style={{ marginBottom: by === "focused" ? 0 : 8 }}>
        <label>Target window</label>
        <select className="mac-select" value={by} onChange={(e) => {
          const nb = e.target.value as WindowSelector["by"];
          onChange(nb === "focused" ? { by: "focused" } : nb === "title" ? { by: "title", mode: "contains", value: "" } : nb === "process" ? { by: "process", name: "" } : { by: "class", name: "" });
        }}>
          <option value="focused">Focused window</option>
          <option value="title">By title</option>
          <option value="process">By process</option>
          <option value="class">By window class</option>
        </select>
      </div>
      {value.by === "title" && (
        <>
          <SelectField label="Match mode" value={value.mode ?? "contains"} options={["exact", "contains", "regex"] as const} onChange={(m) => onChange({ ...value, mode: m })} />
          <TextField label="Title" value={value.value} onChange={(v) => onChange({ ...value, value: v })} placeholder="window title" />
        </>
      )}
      {value.by === "process" && <TextField label="Process name" value={value.name} onChange={(v) => onChange({ ...value, name: v })} placeholder="notepad.exe" />}
      {value.by === "class" && <TextField label="Window class" value={value.name} onChange={(v) => onChange({ ...value, name: v })} placeholder="Notepad" />}
    </div>
  );
}

// -------------------------------------------------------- condition editor
const CONDITION_TYPES: { type: Condition["type"]; label: string }[] = [
  { type: "expr", label: "Expression (rhai)" },
  { type: "all", label: "All of (AND)" },
  { type: "any", label: "Any of (OR)" },
  { type: "not", label: "Not" },
  { type: "variable_comparison", label: "Variable comparison" },
  { type: "window_exists", label: "Window exists" },
  { type: "window_focused", label: "Window focused" },
  { type: "window_title_matches", label: "Window title matches" },
  { type: "process_running", label: "Process running" },
  { type: "device_connected", label: "Device connected" },
  { type: "audio_device_exists", label: "Audio device exists" },
  { type: "audio_device_is_default", label: "Audio device is default" },
  { type: "file_exists", label: "File exists" },
  { type: "directory_exists", label: "Directory exists" },
  { type: "pixel_color_at", label: "Pixel colour at" },
  { type: "clipboard_contains", label: "Clipboard contains" },
  { type: "time_is_between", label: "Time is between" },
  { type: "day_of_week_is", label: "Day of week is" },
];
function newCondition(type: Condition["type"]): Condition {
  switch (type) {
    case "all": return { type: "all", conditions: [] };
    case "any": return { type: "any", conditions: [] };
    case "not": return { type: "not", condition: { type: "expr", expr: "true" } };
    case "expr": return { type: "expr", expr: "true" };
    case "variable_comparison": return { type: "variable_comparison", variable: "x", op: "eq", value: 0 };
    case "window_exists": return { type: "window_exists", window: { by: "focused" } };
    case "window_focused": return { type: "window_focused", window: { by: "focused" } };
    case "window_title_matches": return { type: "window_title_matches", pattern: "" };
    case "process_running": return { type: "process_running", name: "" };
    case "device_connected": return { type: "device_connected", device: "" };
    case "audio_device_exists": return { type: "audio_device_exists", name: "" };
    case "audio_device_is_default": return { type: "audio_device_is_default", name: "" };
    case "file_exists": return { type: "file_exists", path: "" };
    case "directory_exists": return { type: "directory_exists", path: "" };
    case "pixel_color_at": return { type: "pixel_color_at", x: 0, y: 0, color: "#ffffff", tolerance: 0 };
    case "clipboard_contains": return { type: "clipboard_contains", pattern: "", regex: false };
    case "time_is_between": return { type: "time_is_between", start: "09:00", end: "17:00" };
    case "day_of_week_is": return { type: "day_of_week_is", days: [] };
  }
}
function ConditionEditor({ value, onChange }: { value: Condition; onChange: (c: Condition) => void }) {
  const c = value;
  const [audioNames, setAudioNames] = useState<string[]>([]);
  const [usbNames, setUsbNames] = useState<string[]>([]);
  useEffect(() => {
    if (c.type === "audio_device_exists" || c.type === "audio_device_is_default")
      devicesAudio().then((d) => setAudioNames(d.map((x) => x.name))).catch(() => {});
    if (c.type === "device_connected")
      devicesUsb().then((d) => setUsbNames(d.map((x) => x.name))).catch(() => {});
  }, [c.type]);
  return (
    <div className="mac-cond">
      <SelectField label="Condition" value={CONDITION_TYPES.find((t) => t.type === c.type)!.label as string}
        options={CONDITION_TYPES.map((t) => t.label)}
        onChange={(lbl) => { const t = CONDITION_TYPES.find((x) => x.label === lbl)!.type; onChange(newCondition(t)); }} />
      {(c.type === "all" || c.type === "any") && (
        <div className="mac-cond-group">
          {c.conditions.map((child, i) => (
            <div key={i}>
              <ConditionEditor value={child} onChange={(nc) => onChange({ ...c, conditions: c.conditions.map((x, j) => j === i ? nc : x) })} />
              <button className="mac-btn danger tiny" onClick={() => onChange({ ...c, conditions: c.conditions.filter((_, j) => j !== i) })}>Remove</button>
            </div>
          ))}
          <button className="mac-btn tiny" style={{ marginTop: 6 }} onClick={() => onChange({ ...c, conditions: [...c.conditions, { type: "expr", expr: "true" }] })}>＋ Add sub-condition</button>
        </div>
      )}
      {c.type === "not" && <div className="mac-cond-group"><ConditionEditor value={c.condition} onChange={(nc) => onChange({ type: "not", condition: nc })} /></div>}
      {c.type === "expr" && <TextField label="Expression" value={c.expr} onChange={(v) => onChange({ type: "expr", expr: v })} placeholder="e.g. n > 3" />}
      {c.type === "variable_comparison" && (
        <>
          <TextField label="Variable" value={c.variable} onChange={(v) => onChange({ ...c, variable: v })} />
          <SelectField label="Operator" value={c.op} options={["eq", "ne", "lt", "gt", "contains"] as const} onChange={(op) => onChange({ ...c, op })} />
          <TextField label="Value" value={typeof c.value === "string" ? c.value : JSON.stringify(c.value)} onChange={(v) => { let pv: unknown; try { pv = JSON.parse(v); } catch { pv = v; } onChange({ ...c, value: pv }); }} />
        </>
      )}
      {(c.type === "window_exists" || c.type === "window_focused") && <WindowSelectorEditor value={c.window} onChange={(w) => onChange({ ...c, window: w })} />}
      {c.type === "window_title_matches" && <TextField label="Title regex" value={c.pattern} onChange={(v) => onChange({ ...c, pattern: v })} />}
      {c.type === "process_running" && <TextField label="Process name" value={c.name} onChange={(v) => onChange({ ...c, name: v })} placeholder="chrome.exe" />}
      {c.type === "device_connected" && <TextField label="VID:PID or name" value={c.device} onChange={(v) => onChange({ ...c, device: v })} placeholder="1234:abcd or Logitech" options={usbNames} />}
      {c.type === "audio_device_exists" && <TextField label="Device name" value={c.name} onChange={(v) => onChange({ ...c, name: v })} options={audioNames} />}
      {c.type === "audio_device_is_default" && <TextField label="Device name" value={c.name} onChange={(v) => onChange({ ...c, name: v })} placeholder="Speakers or Headphones" options={audioNames} />}
      {c.type === "file_exists" && <TextField label="File path" value={c.path} onChange={(v) => onChange({ ...c, path: v })} />}
      {c.type === "directory_exists" && <TextField label="Directory path" value={c.path} onChange={(v) => onChange({ ...c, path: v })} />}
      {c.type === "pixel_color_at" && (
        <>
          <PositionPicker onPicked={(p) => onChange({ ...c, x: p.x, y: p.y, color: p.color })} />
          <div className="mac-row"><NumField label="X" value={c.x} onChange={(v) => onChange({ ...c, x: v })} /><NumField label="Y" value={c.y} onChange={(v) => onChange({ ...c, y: v })} /></div>
          <div className="mac-field"><label>Colour <span className="mac-swatch" style={{ background: c.color }} /></label><input className="mac-input" type="color" value={c.color} onChange={(e) => onChange({ ...c, color: e.target.value })} /></div>
          <NumField label="Tolerance (0-255)" value={c.tolerance ?? 0} onChange={(v) => onChange({ ...c, tolerance: v })} />
        </>
      )}
      {c.type === "clipboard_contains" && (
        <>
          <TextField label="Pattern" value={c.pattern} onChange={(v) => onChange({ ...c, pattern: v })} />
          <CheckField label="Treat as regex" value={!!c.regex} onChange={(v) => onChange({ ...c, regex: v })} />
        </>
      )}
      {c.type === "time_is_between" && (
        <div className="mac-row"><TextField label="Start (HH:MM)" value={c.start} onChange={(v) => onChange({ ...c, start: v })} /><TextField label="End (HH:MM)" value={c.end} onChange={(v) => onChange({ ...c, end: v })} /></div>
      )}
      {c.type === "day_of_week_is" && (
        <div className="mac-field"><label>Days</label>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map((d) => (
              <label key={d} className="mac-check" style={{ margin: 0 }}>
                <input type="checkbox" checked={c.days.includes(d)} onChange={(e) => onChange({ ...c, days: e.target.checked ? [...c.days, d] : c.days.filter((x) => x !== d) })} />{d}
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ================================================================ inspector
function Inspector({ step, onPatch }: { step: Step; onPatch: (patch: Record<string, unknown>) => void }) {
  const [audioNames, setAudioNames] = useState<string[]>([]);
  useEffect(() => {
    if (step.type === "set_default_audio_device") devicesAudio().then((d) => setAudioNames(d.map((x) => x.name))).catch(() => {});
  }, [step.type]);
  const [sessionNames, setSessionNames] = useState<string[]>([]);
  useEffect(() => {
    if (step.type === "set_app_volume")
      devicesAudioSessions().then((d) => setSessionNames([...new Set(d.map((x) => x.name))])).catch(() => {});
  }, [step.type]);
  const [macros, setMacros] = useState<MacroInfo[]>([]);
  useEffect(() => { if (step.type === "run_macro") macrosList().then(setMacros).catch(() => {}); }, [step.type]);

  const P = (key: string, label: string, kind: "string" | "int" | "json" | "dim", placeholder?: string, deviceNames?: string[]) =>
    <ParamField label={label} value={step[key]} kind={kind} placeholder={placeholder} deviceNames={deviceNames} onChange={(v) => onPatch({ [key]: v })} />;
  const Win = () => <WindowSelectorEditor value={(step.window as WindowSelector) ?? { by: "focused" }} onChange={(w) => onPatch({ window: w })} />;
  const OptDim = (key: string, label: string) => (
    <div className="mac-field" style={{ marginBottom: 0 }}>
      <label className="mac-check" style={{ margin: "0 0 4px" }}>
        <input type="checkbox" checked={step[key] !== undefined} onChange={(e) => onPatch({ [key]: e.target.checked ? 0 : undefined })} />{label} (unchecked = keep current)
      </label>
      {step[key] !== undefined && <ParamField label="" value={step[key]} kind="dim" placeholder="px or NN%" onChange={(v) => onPatch({ [key]: v })} />}
    </div>
  );

  switch (step.type) {
    case "if": case "while":
      return <div className="mac-field"><label>Condition</label><ConditionEditor value={step.condition as Condition} onChange={(c) => onPatch({ condition: c })} /></div>;
    case "loop": return P("times", "Times", "int");
    case "wait": return P("ms", "Milliseconds", "int");
    case "wait_until":
      return (<>
        <div className="mac-field"><label>Condition</label><ConditionEditor value={step.condition as Condition} onChange={(c) => onPatch({ condition: c })} /></div>
        <NumField label="Poll interval (ms)" value={(step.poll_ms as number) ?? 100} onChange={(v) => onPatch({ poll_ms: v })} />
        <NumField label="Timeout (ms)" value={(step.timeout_ms as number) ?? 10000} onChange={(v) => onPatch({ timeout_ms: v })} />
      </>);
    case "set_variable":
      return (<><TextField label="Variable name" value={step.name as string} onChange={(v) => onPatch({ name: v })} />{P("value", "Value", "json", "literal JSON or fx expression")}</>);
    case "run_macro":
      return (
        <div className="mac-field"><label>Macro</label>
          <select className="mac-select" value={step.id as string} onChange={(e) => onPatch({ id: e.target.value })}>
            <option value="">— select macro —</option>
            {macros.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        </div>);
    case "confirm_dialog": return P("message", "Message", "string");
    case "break": case "stop_macro": case "mute_toggle":
      return <div style={{ color: "var(--muted)", fontSize: 12 }}>No parameters.</div>;
    case "send_keystroke": return <KeyCombo label="Keys" value={step.keys} onChange={(v) => onPatch({ keys: v })} />;
    case "hold_key": return <KeyCombo label="Key" value={step.key} single onChange={(v) => onPatch({ key: v })} />;
    case "release_key": return <KeyCombo label="Key" value={step.key} single onChange={(v) => onPatch({ key: v })} />;
    case "type_text":
      return (<>{P("text", "Text", "string")}<NumField label="Per-char delay (ms)" value={(step.char_delay_ms as number) ?? 0} onChange={(v) => onPatch({ char_delay_ms: v })} /></>);
    case "mouse_move":
      return (<>
        <PositionPicker onPicked={(p) => onPatch({ x: p.x, y: p.y })} />
        <div className="mac-row">{P("x", "X", "int")}{P("y", "Y", "int")}</div>
        <CheckField label="Relative to current position" value={!!step.relative} onChange={(v) => onPatch({ relative: v })} />
        <CheckField label="Relative to a window" value={step.window !== undefined} onChange={(v) => onPatch({ window: v ? { by: "focused" } : undefined })} />
        {step.window !== undefined && <Win />}
      </>);
    case "mouse_click":
      return (<><SelectField label="Button" value={(step.button as MouseButton) ?? "left"} options={["left", "right", "middle"] as const} onChange={(b) => onPatch({ button: b })} /><CheckField label="Double-click" value={!!step.double} onChange={(v) => onPatch({ double: v })} /></>);
    case "mouse_drag":
      return (<>
        <div className="mac-row">{P("from_x", "From X", "int")}{P("from_y", "From Y", "int")}</div>
        <div className="mac-row">{P("to_x", "To X", "int")}{P("to_y", "To Y", "int")}</div>
        <SelectField label="Button" value={(step.button as MouseButton) ?? "left"} options={["left", "right", "middle"] as const} onChange={(b) => onPatch({ button: b })} />
      </>);
    case "scroll":
      return (<><SelectField label="Direction" value={(step.direction as ScrollDir) ?? "down"} options={["up", "down", "left", "right"] as const} onChange={(d) => onPatch({ direction: d })} />{P("amount", "Amount", "int")}</>);
    case "focus_window": case "minimize_window": case "maximize_window": case "restore_window": case "close_window": case "toggle_always_on_top":
      return <Win />;
    case "move_resize_window":
      return (<><Win />{OptDim("x", "X")}{OptDim("y", "Y")}{OptDim("w", "Width")}{OptDim("h", "Height")}</>);
    case "move_window_to_monitor": return (<><Win />{P("monitor", "Monitor (1-based)", "int")}</>);
    case "set_window_transparency": return (<><Win />{P("percent", "Opacity % (0-100)", "int")}</>);
    case "set_default_audio_device":
      return (<>{P("name", "Device name (fuzzy)", "string", "e.g. Speakers", audioNames)}<CheckField label="Input device (mic)" value={!!step.input} onChange={(v) => onPatch({ input: v })} /></>);
    case "adjust_volume": return P("delta", "Delta % (signed)", "int");
    case "set_volume": return P("level", "Volume % (0-100)", "int");
    case "set_app_volume":
      return (<>
        {P("target", "App name or PID (fuzzy)", "string", "e.g. Firefox or 1234", sessionNames)}
        <div className="mac-field" style={{ marginBottom: 0 }}>
          <label className="mac-check" style={{ margin: "0 0 4px" }}>
            <input type="checkbox" checked={step.level !== undefined} onChange={(e) => onPatch({ level: e.target.checked ? 100 : undefined })} />Set volume (unchecked = keep current)
          </label>
          {step.level !== undefined && <ParamField label="" value={step.level} kind="int" placeholder="0-100" onChange={(v) => onPatch({ level: v })} />}
        </div>
        <SelectField label="Mute" value={step.mute === undefined ? "leave" : step.mute ? "mute" : "unmute"} options={["leave", "mute", "unmute"] as const}
          onChange={(v) => onPatch({ mute: v === "leave" ? undefined : v === "mute" })} />
      </>);
    case "launch_program":
      return (<>{P("path", "Program path", "string", "notepad.exe")}
        <div className="mac-field"><label>Arguments (one per line)</label>
          <textarea className="mac-textarea" value={((step.args as Param<string>[]) ?? []).map((a) => (isExpr(a) ? `{fx}${a.expr}` : a)).join("\n")}
            onChange={(e) => onPatch({ args: e.target.value.split("\n").filter((l) => l.length).map((l) => l.startsWith("{fx}") ? { expr: l.slice(4) } : l) })} />
        </div></>);
    case "open_path": return P("path", "File / folder / URL", "string");
    case "run_shell_command":
      return (<>{P("command", "Command", "string")}<NumOpt label="Timeout (ms)" value={(step.timeout_ms as number) ?? null} placeholder="30000 (default)" onChange={(v) => onPatch({ timeout_ms: v ?? undefined })} /></>);
    case "set_clipboard": return P("text", "Text", "string");
    case "clipboard_to_variable": return <TextField label="Variable name" value={step.variable as string} onChange={(v) => onPatch({ variable: v })} />;
    case "show_notification":
      return (<><TextField label="Title" value={(step.title as string) ?? ""} onChange={(v) => onPatch({ title: v })} />{P("message", "Message", "string")}</>);
    case "play_sound": return P("path", "Sound file (.wav)", "string");
    default: return <div style={{ color: "var(--muted)", fontSize: 12 }}>No parameters.</div>;
  }
}

// ==================================================== save-time validation
// Key tokens the backend cannot parse fail only once the step runs, so they are
// caught here. fx expressions are opaque until run time — never flagged.
function unknownTokens(value: unknown): string[] {
  if (isExpr(value) || value === undefined) return [];
  return String(value).split("+").map((t) => t.trim()).filter(Boolean)
    .filter((t) => !isKnownToken(t)).map((t) => `“${t}”`);
}

export function validateMacro(m: Macro): string[] {
  const warns: string[] = [];
  if (!m.name.trim()) warns.push("Macro has no name.");
  const walk = (list: Block[], where: string) => {
    list.forEach((b, i) => {
      const at = `${where}#${i + 1} (${stepLabel(b.type)})`;
      const emptyStr = (v: unknown) => !isExpr(v) && (v === undefined || String(v).trim() === "");
      switch (b.type) {
        case "run_macro": if (!b.id) warns.push(`${at}: no target macro selected.`); break;
        case "send_keystroke": {
          if (emptyStr(b.keys)) { warns.push(`${at}: no keys set.`); break; }
          const bad = unknownTokens(b.keys);
          if (bad.length) warns.push(`${at}: ${bad.join(", ")} — not a key the engine can send.`);
          break;
        }
        case "hold_key": case "release_key": {
          if (emptyStr(b.key)) { warns.push(`${at}: no key set.`); break; }
          const bad = unknownTokens(b.key);
          if (bad.length) warns.push(`${at}: ${bad.join(", ")} — not a key the engine can send.`);
          break;
        }
        case "launch_program": if (emptyStr(b.path)) warns.push(`${at}: program path is empty.`); break;
        case "open_path": if (emptyStr(b.path)) warns.push(`${at}: path is empty.`); break;
        case "run_shell_command": if (emptyStr(b.command)) warns.push(`${at}: command is empty.`); break;
        case "set_variable": if (!String(b.name ?? "").trim()) warns.push(`${at}: variable name is empty.`); break;
        case "play_sound": if (emptyStr(b.path)) warns.push(`${at}: sound path is empty.`); break;
        case "set_app_volume": if (emptyStr(b.target)) warns.push(`${at}: no app/PID target set.`); break;
      }
      const w = b.window as WindowSelector | undefined;
      if (w && w.by === "title" && !w.value.trim()) warns.push(`${at}: window title is empty.`);
      if (w && w.by === "process" && !w.name.trim()) warns.push(`${at}: process name is empty.`);
      for (const slot of slotsOf(b)) walk((b[slot.key] as Block[]) ?? [], `${at}/${slot.label}`);
    });
  };
  walk(m.steps, "step");
  return warns;
}
