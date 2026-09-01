import { type CSSProperties, useEffect, useState } from "react";
import { useLayout } from "../stores/layout";
import { appShortcutsGet, appShortcutsSet, type AppShortcuts } from "../lib/ipc";

// Keybinds settings category (registry entry in SettingsModal.tsx). Edits the
// persisted `keymap` (in-app actions, handled in App.tsx) plus the two OS-level
// global shortcuts owned by Rust (summon/hide + screenshot). The same keymap is
// the source the About panel reads, so nothing drifts.

const label: CSSProperties = { fontSize: 12, color: "var(--muted)" };
const row: CSSProperties = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "6px 0", borderBottom: "1px solid var(--border)" };
const field: CSSProperties = { background: "var(--panel-2)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 4, padding: "4px 7px", fontSize: 12.5 };
const kbd: CSSProperties = { background: "var(--border)", border: "1px solid var(--border)", borderRadius: 4, padding: "1px 7px", fontSize: 12, color: "var(--text)", whiteSpace: "nowrap" };

// Ordered action -> label list for the editable in-app keymap.
const KEYBIND_ACTIONS: [string, string][] = [
  ["palette", "Command palette"],
  ["settings", "Settings"],
  ["find", "Find in scrollback"],
  ["help", "About / shortcuts"],
  ["zoomIn", "Interface zoom in"],
  ["zoomOut", "Interface zoom out"],
  ["resetScale", "Reset interface zoom"],
  ["splitHorizontal", "Split right"],
  ["splitVertical", "Split down"],
  ["newTab", "New tab in pane"],
  ["closePane", "Close active pane"],
  ["zoomPane", "Zoom / restore pane"],
  ["broadcast", "Toggle broadcast (pane)"],
  ["bigBrain", "BigBrain memory"],
  ["equalize", "Equalize splits"],
  ["moveFocusLeft", "Move focus left"],
  ["moveFocusRight", "Move focus right"],
  ["moveFocusUp", "Move focus up"],
  ["moveFocusDown", "Move focus down"],
];

// Same physical-key mapping the central handler uses (App.tsx), kept in sync so a
// captured combo matches what handleKey will fire on.
function comboKeyToken(e: KeyboardEvent): string | null {
  const c = e.code;
  if (c.startsWith("Key")) return c.slice(3);
  if (c.startsWith("Digit")) return c.slice(5);
  if (c.startsWith("Arrow")) return c.slice(5);
  if (c.startsWith("Numpad")) {
    const n = c.slice(6);
    if (/^\d$/.test(n)) return n;
    if (n === "Add") return "=";
    if (n === "Subtract") return "-";
    return null;
  }
  return ({ Comma: ",", Slash: "/", Equal: "=", Minus: "-" } as Record<string, string>)[c] ?? null;
}

function eventToCombo(e: KeyboardEvent): string | null {
  const key = comboKeyToken(e);
  if (!key) return null;
  const parts: string[] = [];
  if (e.ctrlKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  parts.push(key);
  return parts.join("+");
}

function normalizeCombo(combo: string): string {
  const parts = combo.split("+");
  const key = parts.pop() ?? "";
  const mods = new Set(parts.map((m) => m.trim().toLowerCase()));
  const out: string[] = [];
  if (mods.has("ctrl") || mods.has("control") || mods.has("cmd") || mods.has("cmdorctrl") || mods.has("command")) out.push("Ctrl");
  if (mods.has("alt") || mods.has("option")) out.push("Alt");
  if (mods.has("shift")) out.push("Shift");
  out.push(key);
  return out.join("+");
}

export default function KeybindsSettings() {
  const keymap = useLayout((s) => s.keymap);
  const setKeybind = useLayout((s) => s.setKeybind);
  const resetKeymap = useLayout((s) => s.resetKeymap);
  const [capturing, setCapturing] = useState<string | null>(null);

  // While capturing, the next real combo keydown is written to the bound action.
  useEffect(() => {
    if (!capturing) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") return setCapturing(null);
      const combo = eventToCombo(e);
      if (!combo) return; // modifier-only / unsupported key: keep listening
      setKeybind(capturing, combo);
      setCapturing(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [capturing, setKeybind]);

  // Conflict badges: a normalized combo bound to more than one action.
  const counts: Record<string, number> = {};
  for (const [, combo] of Object.entries(keymap)) {
    const n = normalizeCombo(combo);
    counts[n] = (counts[n] ?? 0) + 1;
  }

  return (
    <div>
      <p style={{ margin: "0 0 10px", fontSize: 11, color: "var(--muted)" }}>
        Click <b>Rebind</b>, then press the key combination. Esc cancels. Conflicts (the same
        combo bound twice) are flagged — the first matching action wins.
      </p>

      {KEYBIND_ACTIONS.map(([action, text]) => {
        const combo = keymap[action] ?? "";
        const conflict = combo && counts[normalizeCombo(combo)] > 1;
        return (
          <div style={row} key={action}>
            <span style={label}>
              {text}
              {conflict ? <span style={{ color: "#e0a06c", fontSize: 10, marginLeft: 6 }}>conflict</span> : null}
            </span>
            <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <kbd style={kbd}>{capturing === action ? "Press keys…" : combo || "—"}</kbd>
              <button onClick={() => setCapturing(action)} style={{ ...field, cursor: "pointer" }}>Rebind</button>
            </span>
          </div>
        );
      })}

      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 10 }}>
        <button onClick={() => resetKeymap()} style={{ ...field, cursor: "pointer" }}>Reset to defaults</button>
      </div>

      <GlobalShortcuts />
    </div>
  );
}

// The two OS-level global shortcuts live in Rust (editable via app_shortcuts_set).
// They use the plugin's combo syntax (e.g. "CmdOrCtrl+Alt+S"), so they are edited
// as text and applied on Save rather than key-captured.
function GlobalShortcuts() {
  const [sc, setSc] = useState<AppShortcuts | null>(null);
  const [msg, setMsg] = useState("");

  useEffect(() => {
    appShortcutsGet().then(setSc).catch(() => setSc(null));
  }, []);

  if (!sc) {
    return (
      <p style={{ marginTop: 16, fontSize: 11, color: "var(--muted)" }}>
        System-wide global shortcuts are unavailable (no Tauri backend).
      </p>
    );
  }

  const save = async () => {
    setMsg("Applying…");
    try {
      await appShortcutsSet(sc);
      setMsg("Saved.");
    } catch (e) {
      setMsg(`Failed: ${e}`);
    }
  };

  return (
    <div style={{ marginTop: 16, paddingTop: 8, borderTop: "1px solid var(--border)" }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", marginBottom: 4 }}>Global (system-wide)</div>
      <p style={{ margin: "0 0 8px", fontSize: 11, color: "var(--muted)" }}>
        Registered with the OS so they work while other apps are focused. Use the plugin syntax,
        e.g. <code>CmdOrCtrl+Alt+S</code>.
      </p>
      <div style={row}>
        <span style={label}>Show / hide window</span>
        <input style={{ ...field, width: 200 }} value={sc.summon} onChange={(e) => setSc({ ...sc, summon: e.target.value })} />
      </div>
      <div style={row}>
        <span style={label}>Screenshot every monitor</span>
        <input style={{ ...field, width: 200 }} value={sc.screenshot} onChange={(e) => setSc({ ...sc, screenshot: e.target.value })} />
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, justifyContent: "flex-end", marginTop: 10 }}>
        {msg && <span style={{ fontSize: 11, color: "var(--muted)" }}>{msg}</span>}
        <button onClick={save} style={{ ...field, cursor: "pointer", background: "var(--accent)", color: "#fff", borderColor: "var(--accent)" }}>Apply global shortcuts</button>
      </div>
    </div>
  );
}
