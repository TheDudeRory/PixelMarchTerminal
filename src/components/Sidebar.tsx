import { useRef, useState, type CSSProperties } from "react";
import { useLayout, type KeepAlive, type Workspace } from "../stores/layout";
import { collectPanes } from "../lib/layout-tree";

const KEEP_LABEL: Record<KeepAlive, string> = { keep: "⟳", suspend: "❚❚", kill: "✕" };
const KEEP_TITLE: Record<KeepAlive, string> = {
  keep: "On leave: keep terminals alive",
  suspend: "On leave: suspend (keep alive, stop rendering)",
  kill: "On leave: kill terminals",
};
const nextKeep: Record<KeepAlive, KeepAlive> = { keep: "suspend", suspend: "kill", kill: "keep" };

const icon: CSSProperties = { background: "transparent", border: "none", color: "var(--muted)", cursor: "pointer", fontSize: 12, padding: "0 3px", lineHeight: 1 };
const header: CSSProperties = { display: "flex", alignItems: "center", height: 32, padding: "0 8px", borderBottom: "1px solid var(--border)" };
const headerText: CSSProperties = { flex: 1, fontSize: 11, fontWeight: 700, letterSpacing: 0.8, color: "var(--muted)" };

// The screenshot thumb is position:fixed at left 10 / bottom 10, up to 96px of
// image plus 4px padding and a 1px border each side — so its top edge sits
// ~116px above the viewport bottom, right over the SWARMS header and its ＋.
// Reserve that strip (plus a little air) while the thumb is on screen.
const THUMB_CLEARANCE = 124;

export default function Sidebar() {
  const workspaces = useLayout((s) => s.workspaces);
  const activeId = useLayout((s) => s.activeId);
  const unread = useLayout((s) => s.unread);
  const collapsed = useLayout((s) => s.sidebarCollapsed);
  const switchWorkspace = useLayout((s) => s.switchWorkspace);
  const addWorkspace = useLayout((s) => s.addWorkspace);
  const openSwarm = useLayout((s) => s.openSwarm);
  const renameWorkspace = useLayout((s) => s.renameWorkspace);
  const duplicateWorkspace = useLayout((s) => s.duplicateWorkspace);
  const requestDeleteWorkspace = useLayout((s) => s.requestDeleteWorkspace);
  const setKeepAlive = useLayout((s) => s.setKeepAlive);
  const reorderWorkspace = useLayout((s) => s.reorderWorkspace);
  const shotThumbVisible = useLayout((s) => s.shotThumbVisible);

  const [editingId, setEditingId] = useState<string | null>(null);
  const dragId = useRef<string | null>(null);

  if (collapsed) return null;

  const plain = workspaces.filter((w) => !w.swarm);
  const swarms = workspaces.filter((w) => w.swarm);

  const row = (w: Workspace) => {
    const active = w.id === activeId;
    const paneCount = collectPanes(w.root).length;
    const hasActivity = collectPanes(w.root).some((p) => unread[p.id]);
    return (
      <div
        key={w.id}
        draggable={editingId !== w.id}
        onDragStart={(e) => {
          dragId.current = w.id;
          // WebKitGTK aborts a drag with an empty dataTransfer.
          e.dataTransfer.setData("text/plain", w.id);
          e.dataTransfer.effectAllowed = "move";
        }}
        onDragOver={(e) => { e.preventDefault(); if (dragId.current && dragId.current !== w.id) reorderWorkspace(dragId.current, w.id); }}
        onDragEnd={() => (dragId.current = null)}
        onClick={() => switchWorkspace(w.id)}
        className="ws-row"
        title={w.swarm}
        style={{
          display: "flex", alignItems: "center", gap: 7, padding: "5px 6px", borderRadius: 6, cursor: "pointer",
          background: active ? "#2b3a55" : "transparent", marginBottom: 2,
        }}
      >
        <span style={{ width: 9, height: 9, borderRadius: "50%", background: w.color, flex: "0 0 auto" }} />
        {editingId === w.id ? (
          <input
            autoFocus
            defaultValue={w.name}
            onClick={(e) => e.stopPropagation()}
            onBlur={(e) => { renameWorkspace(w.id, e.target.value.trim() || w.name); setEditingId(null); }}
            onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") setEditingId(null); }}
            style={{ flex: 1, minWidth: 0, background: "var(--panel-2)", color: "var(--text)", border: "1px solid #4c8bf5", borderRadius: 3, fontSize: 12, padding: "1px 4px" }}
          />
        ) : (
          <span
            onDoubleClick={(e) => { e.stopPropagation(); setEditingId(w.id); }}
            style={{ flex: 1, minWidth: 0, fontSize: 12.5, color: active ? "#fff" : "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
          >
            {w.name}
          </span>
        )}
        {hasActivity && !active && <span title="Unread activity" style={{ width: 7, height: 7, borderRadius: "50%", background: "#5fbf6a", flex: "0 0 auto" }} />}
        <span style={{ fontSize: 10, color: "var(--muted)", flex: "0 0 auto" }}>{paneCount}</span>
        <button title={KEEP_TITLE[w.keepAlive]} onClick={(e) => { e.stopPropagation(); setKeepAlive(w.id, nextKeep[w.keepAlive]); }}
          style={{ ...icon, fontSize: 10, opacity: 0.7 }}>{KEEP_LABEL[w.keepAlive]}</button>
        <span className="ws-actions" style={{ display: "none", gap: 0 }}>
          <button title="Rename" onClick={(e) => { e.stopPropagation(); setEditingId(w.id); }} style={icon}>✎</button>
          {!w.swarm && <button title="Duplicate" onClick={(e) => { e.stopPropagation(); duplicateWorkspace(w.id); }} style={icon}>⧉</button>}
          <button title="Delete" onClick={(e) => { e.stopPropagation(); requestDeleteWorkspace(w.id); }} style={{ ...icon, color: "#c66" }}>✕</button>
        </span>
      </div>
    );
  };

  return (
    <div style={{ width: 208, flex: "0 0 208px", display: "flex", flexDirection: "column", background: "var(--panel)", borderRight: "1px solid var(--border)", userSelect: "none", paddingBottom: shotThumbVisible ? THUMB_CLEARANCE : 0 }}>
      <div style={header}>
        <span style={headerText}>WORKSPACES</span>
        <button title="New workspace" onClick={addWorkspace} style={{ ...icon, fontSize: 16, color: "var(--muted)" }}>＋</button>
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: 4 }}>{plain.map(row)}</div>
      <div style={{ ...header, borderTop: "1px solid var(--border)" }}>
        <span style={headerText}>SWARMS</span>
        <button title="Launch swarm" onClick={() => openSwarm(true)} style={{ ...icon, fontSize: 16, color: "var(--muted)" }}>＋</button>
      </div>
      <div style={{ flex: swarms.length ? 1 : "0 0 auto", overflowY: "auto", padding: 4 }}>
        {swarms.length === 0 && <div style={{ padding: "5px 6px", fontSize: 11.5, color: "var(--muted)" }}>No swarms — ＋ launches one.</div>}
        {swarms.map(row)}
      </div>
    </div>
  );
}
