import { useEffect, type CSSProperties } from "react";
import { useLayout, type Toast } from "../stores/layout";
import { paneCount } from "../lib/terminalPool";
import { quitApp, detachQuit } from "../lib/ipc";
import { useBackdropClose } from "../lib/useBackdropClose";

const overlay: CSSProperties = { position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", display: "flex", justifyContent: "center", alignItems: "center", zIndex: 130 };

/** Graceful shutdown confirmation shown when closing with live terminals. */
export function QuitDialog() {
  const open = useLayout((s) => s.quitOpen);
  const setQuitOpen = useLayout((s) => s.setQuitOpen);
  const backdrop = useBackdropClose(() => setQuitOpen(false));
  if (!open) return null;
  const n = paneCount();
  // Detach: exit the GUI but leave the host + terminals running (reattach next
  // launch — the update path). Quit: host tree-kills every PTY, then exit.
  const detach = () => { detachQuit(); };
  const quit = () => { quitApp(); };
  return (
    <div style={overlay} {...backdrop}>
      <div onClick={(e) => e.stopPropagation()} style={{ minWidth: 380, background: "var(--panel)", border: "1px solid var(--border)", borderRadius: 10, padding: 20, boxShadow: "0 12px 48px rgba(0,0,0,0.6)" }}>
        <p style={{ margin: "0 0 16px", color: "var(--text)", fontSize: 14 }}>
          {n} terminal{n === 1 ? "" : "s"} still running. Leave {n === 1 ? "it" : "them"} running
          in the background, or close {n === 1 ? "it" : "them all"} and quit?
        </p>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button onClick={() => setQuitOpen(false)} style={{ padding: "6px 14px", background: "var(--panel-2)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 5, cursor: "pointer" }}>Cancel</button>
          <button autoFocus onClick={detach} style={{ padding: "6px 14px", background: "var(--panel-2)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 5, cursor: "pointer" }}>Leave running</button>
          <button onClick={quit} style={{ padding: "6px 14px", background: "#b23b3b", color: "#fff", border: "none", borderRadius: 5, cursor: "pointer" }}>Close all & quit</button>
        </div>
      </div>
    </div>
  );
}

function ToastItem({ toast, onDone }: { toast: Toast; onDone: () => void }) {
  useEffect(() => {
    const t = setTimeout(onDone, 5000);
    return () => clearTimeout(t);
  }, [onDone]);
  return (
    <div style={{ background: "#3a2020", border: "1px solid #6a3030", color: "#f0c0c0", borderRadius: 6, padding: "8px 12px", fontSize: 12.5, maxWidth: 320, boxShadow: "0 6px 18px rgba(0,0,0,0.4)", display: "flex", gap: 10, alignItems: "flex-start" }}>
      <span style={{ flex: 1 }}>{toast.msg}</span>
      <button onClick={onDone} style={{ background: "transparent", border: "none", color: "#f0c0c0", cursor: "pointer", fontSize: 12 }}>✕</button>
    </div>
  );
}

export function Toasts() {
  const toasts = useLayout((s) => s.toasts);
  const remove = useLayout((s) => s.removeToast);
  return (
    <div style={{ position: "fixed", right: 14, bottom: 14, zIndex: 140, display: "flex", flexDirection: "column", gap: 8 }}>
      {toasts.map((t) => <ToastItem key={t.id} toast={t} onDone={() => remove(t.id)} />)}
    </div>
  );
}
