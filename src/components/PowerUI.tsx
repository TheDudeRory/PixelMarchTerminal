import { useEffect, useState, type CSSProperties } from "react";
import { useLayout, activeWorkspace } from "../stores/layout";
import { searchInPane, clearSearch } from "../lib/terminalPool";

const smallBtn: CSSProperties = { background: "transparent", border: "1px solid var(--border)", color: "var(--text)", borderRadius: 4, fontSize: 12, padding: "2px 6px", cursor: "pointer" };

/** Warning banner shown whenever panes are armed for broadcast input. */
export function BroadcastBanner() {
  const broadcast = useLayout((s) => s.broadcast);
  const clear = useLayout((s) => s.clearBroadcast);
  if (broadcast.length < 1) return null;
  return (
    <div style={{ flex: "0 0 auto", background: "#8a2c2c", color: "#fff", fontSize: 12, padding: "3px 10px", display: "flex", alignItems: "center", gap: 10, justifyContent: "center" }}>
      <span>⚠ Broadcasting input to {broadcast.length} pane{broadcast.length > 1 ? "s" : ""} — keystrokes go to all of them</span>
      <button onClick={clear} style={{ background: "#fff", color: "#8a2c2c", border: "none", borderRadius: 4, padding: "1px 8px", cursor: "pointer", fontSize: 11 }}>Stop</button>
    </div>
  );
}

/** Find-in-scrollback bar for the focused pane (Ctrl+F). */
export function SearchBar() {
  const open = useLayout((s) => s.searchOpen);
  const focused = useLayout((s) => activeWorkspace(s).focusedPaneId);
  const [q, setQ] = useState("");

  useEffect(() => {
    if (!open) clearSearch(focused);
    else setQ("");
  }, [open, focused]);

  useEffect(() => {
    if (open) searchInPane(focused, q, "next"); // incremental
  }, [q, open, focused]);

  if (!open) return null;
  const close = () => useLayout.getState().openSearch(false);
  return (
    <div style={{ position: "absolute", top: 8, right: 14, zIndex: 70, display: "flex", gap: 4, background: "var(--panel-2)", border: "1px solid var(--border)", borderRadius: 6, padding: 4, boxShadow: "0 6px 18px rgba(0,0,0,0.4)" }}>
      <input
        autoFocus
        value={q}
        placeholder="Find in scrollback…"
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); searchInPane(focused, q, e.shiftKey ? "prev" : "next"); }
          else if (e.key === "Escape") { e.preventDefault(); close(); }
        }}
        style={{ background: "var(--panel-2)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 4, padding: "3px 6px", fontSize: 12, width: 170, outline: "none" }}
      />
      <button title="Previous (Shift+Enter)" onClick={() => searchInPane(focused, q, "prev")} style={smallBtn}>↑</button>
      <button title="Next (Enter)" onClick={() => searchInPane(focused, q, "next")} style={smallBtn}>↓</button>
      <button title="Close (Esc)" onClick={close} style={smallBtn}>✕</button>
    </div>
  );
}

/** Per-pane status footer: elapsed runtime, or exit code + restart. */
export function StatusStrip({ paneId }: { paneId: string }) {
  const status = useLayout((s) => s.paneStatus[paneId]);
  const logging = useLayout((s) => !!s.logging[paneId]);
  const restartPane = useLayout((s) => s.restartPane);
  const [, tick] = useState(0);

  useEffect(() => {
    if (status?.exit) return; // stopped counting
    const t = setInterval(() => tick((v) => v + 1), 1000);
    return () => clearInterval(t);
  }, [status?.exit]);

  if (!status) return null;
  const end = status.exit?.at ?? Date.now();
  const secs = Math.max(0, Math.floor((end - status.startedAt) / 1000));
  const mmss = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;

  return (
    <div style={{ flex: "0 0 auto", height: 20, display: "flex", alignItems: "center", gap: 8, padding: "0 8px", fontSize: 11, background: "var(--panel)", borderTop: "1px solid var(--border)", color: "var(--muted)" }}>
      {status.exit ? (
        <>
          <span style={{ color: status.exit.code === 0 ? "#5fbf6a" : "#e06c6c" }}>
            ● exited{status.exit.code != null ? ` (code ${status.exit.code})` : ""} · ran {mmss}
          </span>
          <button onClick={() => restartPane(paneId)} style={{ ...smallBtn, fontSize: 10, padding: "0 6px" }}>↻ Restart</button>
        </>
      ) : (
        <span style={{ color: "#7bbf86" }}>● running · {mmss}</span>
      )}
      {logging && <span style={{ marginLeft: "auto", color: "#e0a44c" }}>● logging</span>}
    </div>
  );
}
