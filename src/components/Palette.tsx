import { useEffect, useState, type CSSProperties } from "react";
import { useLayout, activeWorkspace } from "../stores/layout";
import { PRESETS, collectPanes, type PresetId } from "../lib/layout-tree";
import { fuzzyFilter } from "../lib/fuzzy";
import { clearScrollback, dumpScrollback } from "../lib/terminalPool";
import { logsDir, writeText } from "../lib/ipc";
import { useBackdropClose } from "../lib/useBackdropClose";
import { requestScreenshot } from "./ScreenshotOverlay";

async function dumpToFile(paneId: string, title: string) {
  try {
    const dir = await logsDir();
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const safe = (title || "pane").replace(/[^\w.-]/g, "_");
    await writeText(`${dir}/${safe}-dump-${stamp}.txt`, dumpScrollback(paneId));
  } catch {
    /* no Tauri */
  }
}

interface Cmd {
  id: string;
  label: string;
  run: () => void;
}

function buildCommands(): Cmd[] {
  const s = useLayout.getState();
  const cmds: Omit<Cmd, "id">[] = [];
  s.profiles.forEach((p) => cmds.push({ label: `New pane: ${p.name}`, run: () => s.newTab(p.id) }));
  cmds.push({ label: "New workspace", run: () => s.addWorkspace() });
  s.workspaces.forEach((w) => cmds.push({ label: `Switch to workspace: ${w.name}`, run: () => s.switchWorkspace(w.id) }));
  (Object.keys(PRESETS) as PresetId[]).forEach((id) => cmds.push({ label: `Apply layout: ${PRESETS[id].label}`, run: () => s.applyPreset(id) }));
  const ws = activeWorkspace(s);
  const focused = ws.focusedPaneId;
  const focusedTitle = collectPanes(ws.root).find((p) => p.id === focused)?.title ?? "pane";
  cmds.push(
    { label: "Split right", run: () => s.splitFocused("horizontal") },
    { label: "Split down", run: () => s.splitFocused("vertical") },
    { label: "Zoom / restore pane", run: () => s.toggleZoom() },
    { label: "Equalize splits", run: () => s.equalizeAll() },
    { label: "Close active pane", run: () => s.requestClose(focused) },
    { label: "Restart pane", run: () => s.restartPane(focused) },
    { label: "Find in scrollback", run: () => s.openSearch(true) },
    { label: "Broadcast: toggle this pane", run: () => s.toggleBroadcast(focused) },
    { label: "Broadcast: clear all", run: () => s.clearBroadcast() },
    { label: "Scrollback: clear", run: () => clearScrollback(focused) },
    { label: "Scrollback: dump to file", run: () => dumpToFile(focused, focusedTitle) },
    { label: "Duplicate workspace", run: () => s.duplicateWorkspace(s.activeId) },
    { label: "Take screenshot", run: () => requestScreenshot() },
    { label: "Launch swarm…", run: () => s.openSwarm(true) },
    { label: "Manage profiles…", run: () => s.openProfileManager(true) },
    { label: "Settings…", run: () => s.openSettings(true) },
    { label: "Toggle sidebar", run: () => s.toggleSidebar() },
    { label: "Keyboard shortcuts", run: () => s.toggleHelp(true) },
  );
  return cmds.map((c, i) => ({ ...c, id: String(i) }));
}

const overlay: CSSProperties = { position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", display: "flex", justifyContent: "center", alignItems: "flex-start", paddingTop: "12vh", zIndex: 120 };

export default function Palette() {
  const open = useLayout((s) => s.paletteOpen);
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);

  useEffect(() => {
    if (open) { setQuery(""); setSel(0); }
  }, [open]);

  const backdrop = useBackdropClose(() => useLayout.getState().openPalette(false));
  if (!open) return null;
  const close = () => useLayout.getState().openPalette(false);
  const results = fuzzyFilter(query, buildCommands(), (c) => c.label).slice(0, 40);
  const clampedSel = Math.min(sel, Math.max(0, results.length - 1));
  const run = (c?: Cmd) => { if (!c) return; close(); c.run(); };

  return (
    <div style={overlay} {...backdrop}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: 520, maxWidth: "90vw", background: "var(--panel)", border: "1px solid var(--border)", borderRadius: 8, boxShadow: "0 12px 48px rgba(0,0,0,0.6)", overflow: "hidden" }}>
        <input
          autoFocus
          placeholder="Type a command…"
          value={query}
          onChange={(e) => { setQuery(e.target.value); setSel(0); }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") { e.preventDefault(); setSel((v) => Math.min(v + 1, results.length - 1)); }
            else if (e.key === "ArrowUp") { e.preventDefault(); setSel((v) => Math.max(v - 1, 0)); }
            else if (e.key === "Enter") { e.preventDefault(); run(results[clampedSel]); }
            else if (e.key === "Escape") { e.preventDefault(); close(); }
          }}
          style={{ width: "100%", boxSizing: "border-box", padding: "12px 14px", fontSize: 14, background: "var(--panel)", color: "var(--text)", border: "none", borderBottom: "1px solid var(--border)", outline: "none" }}
        />
        <div style={{ maxHeight: 360, overflowY: "auto" }}>
          {results.length === 0 && <div style={{ padding: 14, color: "var(--muted)", fontSize: 13 }}>No matching commands</div>}
          {results.map((c, i) => (
            <div
              key={c.id}
              onMouseEnter={() => setSel(i)}
              onClick={() => run(c)}
              style={{ padding: "8px 14px", fontSize: 13, cursor: "pointer", color: i === clampedSel ? "#fff" : "var(--muted)", background: i === clampedSel ? "#2b3a55" : "transparent" }}
            >
              {c.label}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
