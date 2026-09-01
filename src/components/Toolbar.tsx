import { useState, type CSSProperties } from "react";
import { useLayout } from "../stores/layout";
import { PRESETS, type PresetId } from "../lib/layout-tree";

const cell: CSSProperties = { background: "#4c8bf5", borderRadius: 1 };
const gap = { gap: 2, display: "flex" } as const;

// Tiny diagram of each preset's arrangement, built from divs.
function Mini({ id }: { id: PresetId }) {
  const box: CSSProperties = { width: 34, height: 24, ...gap };
  switch (id) {
    case "2h": return <div style={box}><div style={{ ...cell, flex: 1 }} /><div style={{ ...cell, flex: 1 }} /></div>;
    case "2v": return <div style={{ ...box, flexDirection: "column" }}><div style={{ ...cell, flex: 1 }} /><div style={{ ...cell, flex: 1 }} /></div>;
    case "3col": return <div style={box}><div style={{ ...cell, flex: 1 }} /><div style={{ ...cell, flex: 1 }} /><div style={{ ...cell, flex: 1 }} /></div>;
    case "grid": return (
      <div style={{ ...box, flexDirection: "column" }}>
        <div style={{ ...gap, flex: 1 }}><div style={{ ...cell, flex: 1 }} /><div style={{ ...cell, flex: 1 }} /></div>
        <div style={{ ...gap, flex: 1 }}><div style={{ ...cell, flex: 1 }} /><div style={{ ...cell, flex: 1 }} /></div>
      </div>
    );
    case "main-side": return <div style={box}><div style={{ ...cell, flex: 7 }} /><div style={{ ...cell, flex: 3 }} /></div>;
    case "main-bottom": return <div style={{ ...box, flexDirection: "column" }}><div style={{ ...cell, flex: 3 }} /><div style={{ ...cell, flex: 1 }} /></div>;
  }
}

export default function Toolbar() {
  const applyPreset = useLayout((s) => s.applyPreset);
  const toggleHelp = useLayout((s) => s.toggleHelp);
  const toggleSidebar = useLayout((s) => s.toggleSidebar);
  const openPalette = useLayout((s) => s.openPalette);
  const openProfileManager = useLayout((s) => s.openProfileManager);
  const openSettings = useLayout((s) => s.openSettings);
  const openBigBrain = useLayout((s) => s.openBigBrain);
  const bigBrainOpen = useLayout((s) => s.bigBrainOpen);
  const openGallery = useLayout((s) => s.openGallery);
  const galleryOpen = useLayout((s) => s.galleryOpen);
  const [open, setOpen] = useState(false);

  const pick = (id: PresetId) => { applyPreset(id); setOpen(false); };

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, height: 32, padding: "0 8px", background: "var(--panel)", borderBottom: "1px solid var(--border)", position: "relative", flex: "0 0 auto" }}>
      <button onClick={toggleSidebar} title="Toggle workspaces sidebar"
        style={{ fontSize: 14, background: "transparent", color: "var(--muted)", border: "none", cursor: "pointer", padding: "0 2px" }}>☰</button>
      <span style={{ fontSize: 12, fontWeight: 600, color: "#8aa", letterSpacing: 0.5 }}>PixelMarch</span>
      <div style={{ position: "relative" }}>
        <button onClick={() => setOpen((v) => !v)}
          style={{ fontSize: 12, background: "var(--border)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 5, padding: "3px 10px", cursor: "pointer" }}>
          Layouts ▾
        </button>
        {open && (
          <>
            <div onClick={() => setOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 40 }} />
            <div style={{ position: "absolute", top: 28, left: 0, zIndex: 41, background: "var(--panel-2)", border: "1px solid var(--border)", borderRadius: 8, padding: 8, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, boxShadow: "0 8px 24px rgba(0,0,0,0.5)" }}>
              {(Object.keys(PRESETS) as PresetId[]).map((id) => (
                <button key={id} title={PRESETS[id].label} onClick={() => pick(id)}
                  style={{ display: "flex", alignItems: "center", gap: 8, background: "transparent", border: "1px solid transparent", borderRadius: 6, padding: 6, cursor: "pointer", color: "var(--text)" }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = "var(--border)")}
                  onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}>
                  <Mini id={id} />
                  <span style={{ fontSize: 11, whiteSpace: "nowrap" }}>{PRESETS[id].label}</span>
                </button>
              ))}
            </div>
          </>
        )}
      </div>
      <div style={{ flex: 1 }} />
      <button onClick={() => openPalette(true)} title="Command palette (Ctrl+Shift+P)"
        style={{ fontSize: 12, background: "var(--border)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 5, padding: "3px 9px", cursor: "pointer" }}>⌘ Commands</button>
      <button onClick={() => openProfileManager(true)} title="Manage profiles"
        style={{ fontSize: 12, background: "transparent", color: "var(--muted)", border: "1px solid var(--border)", borderRadius: 5, padding: "3px 9px", cursor: "pointer" }}>Profiles</button>
      <button onClick={() => openGallery(!galleryOpen)} title="Screenshot gallery"
        style={{ fontSize: 14, lineHeight: 1, background: galleryOpen ? "var(--accent)" : "transparent", color: galleryOpen ? "#fff" : "var(--muted)", border: "1px solid var(--border)", borderRadius: 5, padding: "3px 8px", cursor: "pointer" }}>📷</button>
      <button onClick={() => openBigBrain(!bigBrainOpen)} title="BigBrain — local memory service (Ctrl+Shift+M)"
        style={{ fontSize: 14, lineHeight: 1, background: bigBrainOpen ? "var(--accent)" : "transparent", color: bigBrainOpen ? "#fff" : "var(--muted)", border: "1px solid var(--border)", borderRadius: 5, padding: "3px 8px", cursor: "pointer" }}>🧠</button>
      <button onClick={() => openSettings(true)} title="Settings (Ctrl+,)"
        style={{ fontSize: 12, background: "transparent", color: "var(--muted)", border: "1px solid var(--border)", borderRadius: 5, padding: "3px 9px", cursor: "pointer" }}>⚙</button>
      <button onClick={() => toggleHelp()} title="About + keyboard shortcuts (Ctrl+/)"
        style={{ fontSize: 12, background: "transparent", color: "var(--muted)", border: "1px solid var(--border)", borderRadius: 5, padding: "3px 9px", cursor: "pointer" }}>About</button>
    </div>
  );
}
