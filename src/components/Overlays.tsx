import { type CSSProperties, useEffect, useState } from "react";
import { useLayout } from "../stores/layout";
import { useBackdropClose } from "../lib/useBackdropClose";
import { appShortcutsGet, type AppShortcuts } from "../lib/ipc";
import ScreenshotGallery from "./ScreenshotGallery";

// One-time welcome on a fresh install. It decides for itself whether to render
// (fresh profile + no state file + not yet dismissed), so it is grouped with the
// other self-gating overlays here and mounted unconditionally by App.
export { default as FirstRunOverlay } from "./FirstRun";

const overlay: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.5)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 100,
};
const card: CSSProperties = {
  background: "var(--panel)",
  border: "1px solid var(--border)",
  borderRadius: 8,
  padding: 20,
  minWidth: 320,
  boxShadow: "0 10px 40px rgba(0,0,0,0.5)",
};

// Human labels for each keymap action id. The shortcut reference below is built
// from the LIVE keymap (store) so it can never drift from what the handler uses
// or what the Keybinds settings category shows.
const ACTION_LABELS: Record<string, string> = {
  palette: "Command palette",
  settings: "Settings",
  find: "Find in scrollback",
  help: "About / shortcuts",
  zoomIn: "Interface zoom in",
  zoomOut: "Interface zoom out",
  resetScale: "Reset interface zoom",
  splitHorizontal: "Split right",
  splitVertical: "Split down",
  newTab: "New tab in pane",
  closePane: "Close active pane",
  zoomPane: "Zoom / restore pane",
  broadcast: "Toggle broadcast (pane)",
  bigBrain: "BigBrain memory",
  equalize: "Equalize splits",
  moveFocusLeft: "Move focus left",
  moveFocusRight: "Move focus right",
  moveFocusUp: "Move focus up",
  moveFocusDown: "Move focus down",
};

function ShortcutRow({ k, d }: { k: string; d: string }) {
  return (
    <tr>
      <td style={{ padding: "3px 14px 3px 0", verticalAlign: "top" }}>
        <kbd style={{ background: "var(--border)", border: "1px solid var(--border)", borderRadius: 4, padding: "1px 6px", fontSize: 12, color: "var(--text)", whiteSpace: "nowrap" }}>{k}</kbd>
      </td>
      <td style={{ color: "var(--text)", fontSize: 13 }}>{d}</td>
    </tr>
  );
}

// The "?" toolbar button and Ctrl+/ open this. Renamed from Keyboard-shortcuts
// help to an About panel (app identity + the live shortcut reference). The app
// will be renamed later, so the identity text here is intentionally a placeholder.
export function HelpOverlay() {
  const show = useLayout((s) => s.showHelp);
  const toggle = useLayout((s) => s.toggleHelp);
  const keymap = useLayout((s) => s.keymap);
  const backdrop = useBackdropClose(() => toggle(false));
  const [globals, setGlobals] = useState<AppShortcuts | null>(null);

  useEffect(() => {
    if (show) appShortcutsGet().then(setGlobals).catch(() => setGlobals(null));
  }, [show]);

  if (!show) return null;
  const rows = Object.entries(keymap).filter(([a]) => ACTION_LABELS[a]);
  return (
    <div style={overlay} {...backdrop}>
      <div style={{ ...card, maxHeight: "86vh", overflowY: "auto" }} onClick={(e) => e.stopPropagation()}>
        <h2 style={{ margin: "0 0 4px", fontSize: 18, color: "var(--text)" }}>PixelMarch</h2>
        <p style={{ margin: "0 0 14px", fontSize: 12, color: "var(--muted)" }}>
          Multi-workspace terminal manager — part of the <b>PixelMarch</b> family
          (<span style={{ color: "var(--text)" }}>pixelmarch.io</span>).
        </p>

        <h3 style={{ margin: "0 0 6px", fontSize: 12, fontWeight: 700, letterSpacing: 0.5, color: "var(--muted)" }}>KEYBOARD SHORTCUTS</h3>
        <table style={{ borderCollapse: "collapse" }}>
          <tbody>
            {rows.map(([action, combo]) => (
              <ShortcutRow key={action} k={combo} d={ACTION_LABELS[action]} />
            ))}
            {globals && <ShortcutRow k={globals.summon} d="Show / hide window (global)" />}
            {globals && <ShortcutRow k={globals.screenshot} d="Screenshot every monitor (global)" />}
            <ShortcutRow k="Ctrl+Alt+H" d="Global Hotkeys manager" />
            <ShortcutRow k="Ctrl+wheel" d="Interface zoom" />
          </tbody>
        </table>
        <p style={{ margin: "14px 0 4px", fontSize: 11, color: "var(--muted)" }}>
          Shortcuts are editable in <b>Settings → Keybinds</b>. Drag a tab onto a pane's edge to
          split, or its center/tab-strip to tab in. Use <b>Layouts ▾</b> for snap presets.
        </p>
        <p style={{ margin: 0, fontSize: 11, color: "var(--muted)" }}>Esc or Ctrl+/ to close</p>
      </div>
    </div>
  );
}

// Screenshot history, opened from the toolbar's 📷 button. ScreenshotThumb owns
// its own instance for the pinned-thumb flow; this one is standalone, so there
// is no thumb to re-point and onPicked is left off.
export function ScreenshotGalleryOverlay() {
  const open = useLayout((s) => s.galleryOpen);
  const openGallery = useLayout((s) => s.openGallery);
  if (!open) return null;
  return <ScreenshotGallery onClose={() => openGallery(false)} />;
}

export function ConfirmDialog() {
  const pending = useLayout((s) => s.pendingConfirm);
  const resolve = useLayout((s) => s.resolveConfirm);
  const cancel = useLayout((s) => s.cancelConfirm);
  const backdrop = useBackdropClose(cancel);
  if (!pending) return null;
  return (
    <div style={overlay} {...backdrop}>
      <div style={card} onClick={(e) => e.stopPropagation()}>
        <p style={{ margin: "0 0 18px", color: "var(--text)", fontSize: 14 }}>{pending.message}</p>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button onClick={cancel} style={{ padding: "6px 14px", background: "var(--border)", color: "var(--text)", border: "none", borderRadius: 5, cursor: "pointer" }}>
            Cancel
          </button>
          <button autoFocus onClick={resolve} style={{ padding: "6px 14px", background: pending.danger ? "#b23b3b" : "#3a6ea5", color: "#fff", border: "none", borderRadius: 5, cursor: "pointer" }}>
            {pending.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
