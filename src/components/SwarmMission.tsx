// Swarm mission tree (swarm.md M4) — live task board for the active swarm
// workspace, rendered from the brain's task bus. Toggled from the chat bar.
import { useEffect, useState, type CSSProperties } from "react";
import { brainUrl, subscribeBrainFeed, type SwarmTask } from "../lib/ipc";
import { collectPanes, isTerminal } from "../lib/layout-tree";
import { isSettled, paneRole } from "../lib/swarm";
import { cancelTask } from "../lib/swarmReset";
import { useLayout } from "../stores/layout";

const STATUS_COLOR: Record<string, string> = {
  open: "#4c8bf5",
  blocked: "#9aa0a6",
  claimed: "#e0a44c",
  done: "#46c7c7",
  changes: "#e06c6c",
  approved: "#5fbf6a",
  merged: "#7f8ea3",
  cancelled: "#6b6b6b",
};

const panel: CSSProperties = {
  width: 300, flex: "0 0 300px", minHeight: 0,
  display: "flex", flexDirection: "column", background: "var(--panel)",
  borderLeft: "1px solid var(--border)",
};

export default function SwarmMission() {
  const open = useLayout((s) => s.swarmMissionOpen);
  const workspaces = useLayout((s) => s.workspaces);
  const activeId = useLayout((s) => s.activeId);
  const toggle = useLayout((s) => s.toggleSwarmMission);
  const ws = workspaces.find((w) => w.id === activeId);
  const project = ws?.swarm;

  const [tasks, setTasks] = useState<SwarmTask[]>([]);
  const [mission, setMission] = useState("");
  const [result, setResult] = useState<string | null>(null);
  // Rows start collapsed (empty set) so a fresh panel stays compact; clicking a
  // row adds its key here to reveal the full detail.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggleExpanded = (key: string) => setExpanded((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });
  // Cancelling stops an agent mid-work and cannot be undone from here (only the
  // host can put a cancelled task back), so the ✕ arms an inline confirm on the
  // row rather than firing on the click. Inline, not a dialog: a modal over a
  // live board hides the very statuses you are deciding from.
  const [confirming, setConfirming] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [cancelError, setCancelError] = useState<{ key: string; msg: string } | null>(null);

  // Off the shared swarm feed (lib/ipc), and only while the panel is open — the
  // subscription is what starts any polling at all, so a closed board costs
  // nothing. "mission" and "result" are `watch` keys: rewritten in place, so the
  // feed refreshes them on its slower body gap rather than every tick.
  useEffect(() => {
    if (!open || !project) return;
    return subscribeBrainFeed(
      project,
      { intervalMs: 2000, hiddenMs: 15_000, watch: ["mission", "result"] },
      (feed) => {
        setTasks(feed.tasks);
        setMission(feed.notes["mission"]?.value ?? "");
        setResult(feed.notes["result"]?.value ?? null);
      },
    );
  }, [open, project]);

  // Kill one task: mark it cancelled on the bus, stop and wipe whichever pane owns
  // it, and tell the coordinator to re-plan (cancelTask does all three as one
  // fenced operation — see swarmReset). The row is updated optimistically so the
  // board answers the click immediately; the next feed tick (2 s) confirms it from
  // the brain, and a refusal puts the real status straight back.
  const doCancel = async (task: SwarmTask) => {
    if (!ws || !project || cancelling) return;
    setCancelling(task.key);
    setCancelError(null);
    setConfirming(null);
    try {
      const url = await brainUrl();
      // By TYPED role, never by title — a renamed pane must still be findable, or
      // the cancel would move the bus and leave its builder running.
      const pane = task.owner
        ? collectPanes(ws.root).filter(isTerminal).find((p) => paneRole(p) === task.owner)
        : undefined;
      const out = await cancelTask(project, task.key, pane ? {
        paneId: pane.id,
        role: paneRole(pane),
        startupCommand: pane.startupCommand ?? pane.pendingCommand ?? "",
        dispatch: !!ws.swarmDispatch,
      } : undefined, url);
      if (!out.ok) {
        setCancelError({ key: task.key, msg: out.reason ?? "the brain refused the cancel" });
        return;
      }
      setTasks((prev) => prev.map((t) => (t.key === task.key ? { ...t, status: "cancelled" } : t)));
      // Cancelled on the bus, owner still live: say so rather than showing a clean
      // row — that pane is fenced (it gets no further turns) but not wiped.
      if (out.fencedOpen) setCancelError({ key: task.key, msg: out.reason ?? "cancelled, but its pane could not be stopped" });
    } catch (e) {
      setCancelError({ key: task.key, msg: e instanceof Error ? e.message : String(e) });
    } finally {
      setCancelling(null);
    }
  };

  if (!open || !ws || !project) return null;
  const doneish = tasks.filter((t) => t.status === "approved" || t.status === "done").length;

  return (
    <div style={panel}>
      <div style={{ display: "flex", alignItems: "center", padding: "8px 10px", borderBottom: "1px solid var(--border)" }}>
        <span style={{ flex: 1, fontSize: 11, fontWeight: 700, letterSpacing: 0.8, color: "var(--muted)" }}>
          MISSION · {doneish}/{tasks.length || "…"}
        </span>
        {result && (
          <span style={{
            fontSize: 10, fontWeight: 700, letterSpacing: 0.5, padding: "1px 7px", borderRadius: 8,
            color: "#0b0e14", background: "#5fbf6a", marginRight: 6,
          }}>COMPLETE</span>
        )}
        <button onClick={toggle} title="Close" style={{ background: "transparent", border: "none", color: "var(--muted)", cursor: "pointer", fontSize: 13 }}>✕</button>
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: 10, display: "flex", flexDirection: "column", gap: 8 }}>
        {mission && (
          <div style={{ fontSize: 12, color: "var(--text)", whiteSpace: "pre-wrap", paddingBottom: 6, borderBottom: "1px solid var(--border)" }}>{mission}</div>
        )}
        {result && (
          <div style={{ fontSize: 12, color: "#5fbf6a", whiteSpace: "pre-wrap", padding: "6px 8px", border: "1px solid #5fbf6a44", borderRadius: 6 }}>
            <b>Result:</b> {result}
          </div>
        )}
        {tasks.length === 0 && <div style={{ fontSize: 12, color: "var(--muted)" }}>No tasks yet — the coordinator is still planning.</div>}
        {tasks.map((t) => {
          const isOpen = expanded.has(t.key);
          // Settled work (merged, or already cancelled) has nothing left to stop.
          const killable = !isSettled(t.status);
          const busy = cancelling === t.key;
          const err = cancelError?.key === t.key ? cancelError.msg : null;
          return (
            <div key={t.key} style={{ border: "1px solid var(--border)", borderRadius: 6, padding: "6px 8px" }}>
              <div
                role="button"
                tabIndex={0}
                aria-expanded={isOpen}
                onClick={() => toggleExpanded(t.key)}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleExpanded(t.key); } }}
                title={isOpen ? "Collapse" : "Expand"}
                style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", userSelect: "none" }}
              >
                <span aria-hidden style={{
                  fontSize: 9, color: "var(--muted)", width: 9, flex: "0 0 9px", display: "inline-block",
                  transform: isOpen ? "rotate(90deg)" : "none", transition: "transform 0.12s",
                }}>▶</span>
                <span style={{ fontSize: 11.5, fontWeight: 600, color: "var(--text)" }}>{t.key}</span>
                <span style={{
                  fontSize: 10, fontWeight: 700, padding: "1px 7px", borderRadius: 8, color: "#0b0e14",
                  background: STATUS_COLOR[t.status] ?? "var(--muted)",
                }}>{t.status}</span>
                {!isOpen && (
                  <span style={{ flex: 1, minWidth: 0, fontSize: 11, color: "var(--muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {t.desc.split("\n")[0]}
                  </span>
                )}
                {t.owner && <span style={{ fontSize: 10.5, color: "var(--muted)", marginLeft: "auto" }}>{t.owner}</span>}
                {killable && (
                  <button
                    onClick={(e) => { e.stopPropagation(); setCancelError(null); setConfirming(confirming === t.key ? null : t.key); }}
                    disabled={busy}
                    aria-label={`Cancel ${t.key}`}
                    title={`Cancel ${t.key} — stops its agent and takes it off the bus`}
                    style={{
                      marginLeft: t.owner ? 0 : "auto", background: "transparent", border: "none", padding: "0 2px",
                      color: confirming === t.key ? "#ff6b6b" : "#e06c6c", opacity: busy ? 0.5 : 1,
                      cursor: busy ? "default" : "pointer", fontSize: 12, lineHeight: 1,
                    }}
                  >{busy ? "…" : "✕"}</button>
                )}
              </div>
              {confirming === t.key && (
                <div style={{ marginTop: 5, display: "flex", alignItems: "center", gap: 6, fontSize: 10.5, color: "var(--muted)" }}>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    Cancel {t.key}?{t.owner ? ` ${t.owner} is stopped and wiped.` : ""} Its branch is kept.
                  </span>
                  <button
                    onClick={(e) => { e.stopPropagation(); void doCancel(t); }}
                    style={{
                      background: "#e06c6c", border: "none", borderRadius: 4, color: "#0b0e14",
                      fontSize: 10, fontWeight: 700, padding: "2px 7px", cursor: "pointer",
                    }}
                  >Cancel task</button>
                  <button
                    onClick={(e) => { e.stopPropagation(); setConfirming(null); }}
                    style={{
                      background: "transparent", border: "1px solid var(--border)", borderRadius: 4,
                      color: "var(--muted)", fontSize: 10, padding: "2px 7px", cursor: "pointer",
                    }}
                  >Keep</button>
                </div>
              )}
              {err && (
                <div style={{ marginTop: 5, fontSize: 10.5, color: "#e06c6c", whiteSpace: "pre-wrap" }}>{err}</div>
              )}
              {isOpen && (
                <div style={{ marginTop: 5, paddingTop: 5, borderTop: "1px solid var(--border)", display: "flex", flexDirection: "column", gap: 3 }}>
                  {t.role && t.role !== "-" && <div style={{ fontSize: 10.5, color: "var(--muted)" }}>role: {t.role}</div>}
                  {t.files && t.files !== "-" && <div style={{ fontSize: 10.5, color: "var(--muted)", wordBreak: "break-all" }}>{t.files}</div>}
                  <div style={{ fontSize: 11.5, color: "var(--text)", whiteSpace: "pre-wrap" }}>{t.desc}</div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
