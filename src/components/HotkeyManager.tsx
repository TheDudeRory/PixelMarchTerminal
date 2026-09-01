import { useEffect, useState, type CSSProperties } from "react";
import { useLayout } from "../stores/layout";
import { hotkeysList, hotkeysSave, type HotkeyBinding, type HotkeyAction } from "../lib/ipc";
import {
  MacroEditor, macrosList, macrosRun, macrosStopAll, macrosDelete,
  type MacroInfo,
} from "./MacroEditor";
import DevicesTab from "./DevicesTab";
import { KeyField } from "./KeyPicker";
import "./macros.css";

const overlay: CSSProperties = { position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex", justifyContent: "center", alignItems: "center", zIndex: 110 };
const label: CSSProperties = { fontSize: 11, color: "var(--muted)", marginBottom: 3, display: "block" };
const field: CSSProperties = { width: "100%", boxSizing: "border-box", background: "var(--panel-2)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 4, padding: "5px 7px", fontSize: 12.5, marginBottom: 10 };

const normalize = (s: string) => s.replace(/\s+/g, "").toLowerCase();

const summarize = (a: HotkeyAction, macroName?: (id: string) => string): string => {
  switch (a.type) {
    case "launch_program": return `Launch ${a.path}${a.args && a.args.length ? " " + a.args.join(" ") : ""}`;
    case "run_command": return `Run: ${a.command}`;
    case "run_macro": return `Macro: ${macroName ? macroName(a.id) : a.id || "(none)"}`;
    default: return "";
  }
};

type Tab = "hotkeys" | "macros" | "devices";

export default function HotkeyManager() {
  const open = useLayout((s) => s.hotkeysOpen);
  const close = useLayout((s) => s.openHotkeys);
  const [tab, setTab] = useState<Tab>("hotkeys");

  // shared macro library (also used to name RunMacro bindings)
  const [macros, setMacros] = useState<MacroInfo[]>([]);
  const reloadMacros = () => macrosList().then(setMacros).catch(() => setMacros([]));
  useEffect(() => { if (open) reloadMacros(); }, [open]);
  const macroName = (id: string) => macros.find((m) => m.id === id)?.name ?? id ?? "(none)";

  // editor overlay: undefined = closed, null = new macro, string = edit id
  const [editing, setEditing] = useState<string | null | undefined>(undefined);

  // hotkeys state
  const [bindings, setBindings] = useState<HotkeyBinding[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [selIdx, setSelIdx] = useState<number | null>(null);
  useEffect(() => {
    if (!open) return;
    hotkeysList()
      .then((v) => { setBindings(v.bindings); setErrors(v.errors); setSelIdx(v.bindings.length ? 0 : null); })
      .catch(() => { setBindings([]); setErrors({}); setSelIdx(null); });
  }, [open]);

  if (!open) return null;

  const commit = (next: HotkeyBinding[]) => {
    setBindings(next);
    hotkeysSave(next).then((v) => { setBindings(v.bindings); setErrors(v.errors); }).catch(() => {});
  };
  const patch = (i: number, b: Partial<HotkeyBinding>) => commit(bindings.map((x, j) => (j === i ? { ...x, ...b } : x)));
  const setAction = (i: number, action: HotkeyAction) => patch(i, { action });
  const add = () => {
    const next = [...bindings, { hotkey: "", enabled: true, action: { type: "launch_program", path: "", args: [] } as HotkeyAction }];
    commit(next);
    setSelIdx(next.length - 1);
  };
  const remove = (i: number) => { commit(bindings.filter((_, j) => j !== i)); setSelIdx(null); };

  const sel = selIdx != null ? bindings[selIdx] : undefined;
  const selAction = sel?.action;
  const selErr = sel ? errors[normalize(sel.hotkey)] : undefined;

  const stopAll = () => macrosStopAll().catch(() => {});

  return (
    <div style={overlay} onMouseDown={(e) => { if (e.target === e.currentTarget) close(false); }}>
      <div style={{ width: 820, maxWidth: "94vw", height: 560, maxHeight: "90vh", display: "flex", flexDirection: "column", background: "var(--panel)", border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden", boxShadow: "0 12px 48px rgba(0,0,0,0.6)" }}>
        {/* tab bar */}
        <div className="mac-tabs">
          <button className={`mac-tab${tab === "hotkeys" ? " active" : ""}`} onClick={() => setTab("hotkeys")}>Hotkeys</button>
          <button className={`mac-tab${tab === "macros" ? " active" : ""}`} onClick={() => setTab("macros")}>Macros</button>
          <button className={`mac-tab${tab === "devices" ? " active" : ""}`} onClick={() => setTab("devices")}>Devices</button>
          <div style={{ flex: 1 }} />
          <button className="mac-btn estop" style={{ margin: "6px 8px" }} title="Cancel every running macro and release held keys/mouse" onClick={stopAll}>■ Stop all</button>
        </div>

        {/* body */}
        <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
          {tab === "hotkeys" && (
            <>
              {/* list — left */}
              <div style={{ width: 220, flex: "0 0 220px", borderRight: "1px solid var(--border)", display: "flex", flexDirection: "column" }}>
                <div style={{ padding: "10px 12px", fontSize: 11, fontWeight: 700, letterSpacing: 0.6, color: "var(--muted)", borderBottom: "1px solid var(--border)" }}>GLOBAL HOTKEYS</div>
                <div style={{ flex: 1, overflowY: "auto", padding: 4 }}>
                  {bindings.length === 0 && <div style={{ padding: 10, fontSize: 12, color: "var(--muted)" }}>No hotkeys yet.</div>}
                  {bindings.map((b, i) => {
                    const err = errors[normalize(b.hotkey)];
                    return (
                      <div key={i} onClick={() => setSelIdx(i)}
                        style={{ display: "flex", alignItems: "center", gap: 7, padding: "6px 8px", borderRadius: 5, cursor: "pointer", background: i === selIdx ? "#2b3a55" : "transparent", fontSize: 12, color: i === selIdx ? "#fff" : "var(--text)", opacity: b.enabled ? 1 : 0.5 }}>
                        <span title={err ?? (b.enabled ? "active" : "disabled")}
                          style={{ width: 8, height: 8, borderRadius: "50%", flex: "0 0 auto", background: err ? "#d66" : b.enabled ? "#5a5" : "#666" }} />
                        <div style={{ flex: 1, overflow: "hidden" }}>
                          <div style={{ fontFamily: "monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{b.hotkey || "(unset)"}</div>
                          <div style={{ fontSize: 10.5, color: "var(--muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{summarize(b.action, macroName)}</div>
                        </div>
                      </div>
                    );
                  })}
                </div>
                <button onClick={add} style={{ margin: 8, padding: "6px", background: "var(--border)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 5, cursor: "pointer", fontSize: 12 }}>＋ Add hotkey</button>
              </div>

              {/* editor — right */}
              <div style={{ flex: 1, padding: 16, overflowY: "auto" }}>
                {!sel || selIdx == null || !selAction ? (
                  <div style={{ color: "var(--muted)", fontSize: 13 }}>No hotkey selected. Add one to get started.</div>
                ) : (
                  <>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                      <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>Edit hotkey</span>
                      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                        <label style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 12, color: "var(--text)", cursor: "pointer" }}>
                          <input type="checkbox" checked={sel.enabled} onChange={(e) => patch(selIdx, { enabled: e.target.checked })} /> Enabled
                        </label>
                        <button onClick={() => remove(selIdx)} style={{ fontSize: 11, padding: "4px 8px", background: "#5a2a2a", color: "#eaa", border: "none", borderRadius: 4, cursor: "pointer" }}>Delete</button>
                      </div>
                    </div>

                    <label style={label}>Hotkey</label>
                    <KeyField value={sel.hotkey} placeholder="click to set" onChange={(combo) => patch(selIdx, { hotkey: combo })} />
                    {selErr && <div style={{ fontSize: 11, color: "#e88", margin: "6px 0 10px" }}>⚠ {selErr}</div>}
                    <div style={{ height: selErr ? 0 : 10 }} />

                    <label style={label}>Action</label>
                    <select style={field} value={selAction.type}
                      onChange={(e) => {
                        const t = e.target.value;
                        setAction(selIdx, t === "launch_program" ? { type: "launch_program", path: "", args: [] }
                          : t === "run_command" ? { type: "run_command", command: "" }
                          : { type: "run_macro", id: macros[0]?.id ?? "" });
                      }}>
                      <option value="launch_program">Launch program</option>
                      <option value="run_command">Run command</option>
                      <option value="run_macro">Run macro</option>
                    </select>

                    {selAction.type === "launch_program" ? (
                      <>
                        <label style={label}>Program path</label>
                        <input style={field} placeholder="e.g. notepad.exe or C:\\path\\to\\app.exe" value={selAction.path}
                          onChange={(e) => setAction(selIdx, { type: "launch_program", path: e.target.value, args: selAction.args ?? [] })} />
                        <label style={label}>Arguments (one per line)</label>
                        <textarea style={{ ...field, height: 60, fontFamily: "monospace", resize: "vertical" }} value={(selAction.args ?? []).join("\n")}
                          onChange={(e) => setAction(selIdx, { type: "launch_program", path: selAction.path, args: e.target.value.split("\n").map((l) => l.trim()).filter(Boolean) })} />
                      </>
                    ) : selAction.type === "run_command" ? (
                      <>
                        <label style={label}>Command line</label>
                        <input style={field} placeholder="e.g. code .   (runs through the OS shell)" value={selAction.command}
                          onChange={(e) => setAction(selIdx, { type: "run_command", command: e.target.value })} />
                      </>
                    ) : (
                      <>
                        <label style={label}>Macro</label>
                        <select style={field} value={selAction.id} onChange={(e) => setAction(selIdx, { type: "run_macro", id: e.target.value })}>
                          <option value="">— select macro —</option>
                          {macros.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                        </select>
                        {macros.length === 0 && <div style={{ fontSize: 11, color: "var(--muted)" }}>No macros yet — create one in the Macros tab.</div>}
                      </>
                    )}
                  </>
                )}
              </div>
            </>
          )}

          {tab === "macros" && (
            <div className="mac-lib">
              <div className="mac-lib-toolbar">
                <button className="mac-btn primary" onClick={() => setEditing(null)}>＋ New macro</button>
                <button className="mac-btn" onClick={reloadMacros}>↻ Reload</button>
                <div style={{ flex: 1 }} />
                <span style={{ fontSize: 12, color: "var(--muted)" }}>{macros.length} macro{macros.length === 1 ? "" : "s"}</span>
              </div>
              <div className="mac-lib-list">
                {macros.length === 0 && <div style={{ padding: 16, color: "var(--muted)", fontSize: 13 }}>No macros yet. Click <b>New macro</b> to build one with the visual editor.</div>}
                {macros.map((m) => (
                  <div className="mac-lib-row" key={m.id} onDoubleClick={() => setEditing(m.id)}>
                    <div style={{ flex: 1, overflow: "hidden" }}>
                      <div className="mac-lib-name">{m.name}</div>
                      {m.description && <div className="mac-lib-desc">{m.description}</div>}
                    </div>
                    <div className="mac-lib-actions">
                      <button className="mac-btn tiny" title="Run now" onClick={() => macrosRun(m.id).catch(() => {})}>▶ Run</button>
                      <button className="mac-btn tiny" onClick={() => setEditing(m.id)}>Edit</button>
                      <button className="mac-btn danger tiny" onClick={() => { if (confirm(`Delete macro "${m.name}"?`)) macrosDelete(m.id).then(reloadMacros).catch(() => {}); }}>Delete</button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {tab === "devices" && <DevicesTab active={tab === "devices"} />}
        </div>
      </div>

      {editing !== undefined && (
        <MacroEditor macroId={editing} onClose={() => setEditing(undefined)} onSaved={reloadMacros} />
      )}
    </div>
  );
}
