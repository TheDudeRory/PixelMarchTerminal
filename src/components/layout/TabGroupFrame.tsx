import { useCallback, useRef, useState, type CSSProperties, type PointerEvent as RPointerEvent } from "react";
import { useLayout, activeWorkspace } from "../../stores/layout";
import { disposeTerminal, ensureTerminal, spawnOptsForPane, pasteText } from "../../lib/terminalPool";
import { isStreamPane } from "../../lib/agentStream";
import { computeTarget } from "../../lib/drag";
import { logsDir } from "../../lib/ipc";
import { StatusStrip } from "../PowerUI";
import SystemMonitorPane from "../panes/SystemMonitorPane";
import HeadlessPane, { BAR_H } from "../panes/HeadlessPane";
import PaneRoleMenu from "../panes/PaneRoleMenu";
import { isTerminal, type TabGroup } from "../../lib/layout-tree";

const MENU_W = 150; // profile dropdown width — also its horizontal clamp against the window edge

const iconBtn: CSSProperties = {
  background: "transparent", border: "none", color: "var(--muted)", cursor: "pointer",
  fontSize: 12, lineHeight: 1, padding: "0 5px",
};

// Pointer-based tab drag: select on press, start dragging past a small threshold.
function beginTabDrag(paneId: string, e: RPointerEvent) {
  const s = useLayout.getState();
  const startX = e.clientX;
  const startY = e.clientY;
  let started = false;
  const move = (ev: PointerEvent) => {
    if (!started) {
      if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 5) return;
      started = true;
      s.startDrag(paneId, ev.clientX, ev.clientY);
    }
    s.updateDrag(ev.clientX, ev.clientY, computeTarget(ev.clientX, ev.clientY));
  };
  const up = () => {
    window.removeEventListener("pointermove", move, true);
    window.removeEventListener("pointerup", up, true);
    if (started) s.endDrag();
  };
  window.addEventListener("pointermove", move, true);
  window.addEventListener("pointerup", up, true);
}

export default function TabGroupFrame({ group }: { group: TabGroup }) {
  const focusedPaneId = useLayout((s) => activeWorkspace(s).focusedPaneId);
  const zoomedGroupId = useLayout((s) => s.zoomedGroupId);
  const draggingId = useLayout((s) => s.drag?.paneId ?? null);
  const unread = useLayout((s) => s.unread);
  const focusGroup = useLayout((s) => s.focusGroup);
  const selectTab = useLayout((s) => s.selectTab);
  const splitFocused = useLayout((s) => s.splitFocused);
  const newTab = useLayout((s) => s.newTab);
  const requestClose = useLayout((s) => s.requestClose);
  const toggleZoom = useLayout((s) => s.toggleZoom);
  const setZoom = useLayout((s) => s.setZoom);
  const profiles = useLayout((s) => s.profiles);
  const workspaceName = useLayout((s) => activeWorkspace(s).name);
  const broadcast = useLayout((s) => s.broadcast);
  const toggleBroadcast = useLayout((s) => s.toggleBroadcast);
  const logging = useLayout((s) => s.logging);
  const setLogging = useLayout((s) => s.setLogging);
  // Way back to the swarm summary grid from a terminal. Swarm workspaces only —
  // the button (like the grid) is meaningless without agent panes.
  // Also the PIXELMARCH_PROJECT a role pane spawns with — same string the brain keys on.
  const swarmProject = useLayout((s) => activeWorkspace(s).swarm ?? "");
  const isSwarm = !!swarmProject;
  const openSwarmSummary = useLayout((s) => s.openSwarmSummary);
  // `up` anchors the dropdown by its bottom edge instead of its top, and `max`
  // caps its height to the space actually on screen — a long profile list used
  // to run straight off the bottom of the window with no way to reach the rest.
  const [menu, setMenu] = useState<{ x: number; y: number; up: boolean; max: number } | null>(null);
  // Headless (piped-stdio) panes render a transcript instead of raw stream-json
  // — see panes/HeadlessPane.tsx. `headless` is set from the attach callback
  // rather than read during render because the pane only becomes a stream pane
  // inside ensureTerminal, which runs in the commit phase.
  const [headless, setHeadless] = useState(false);
  const [raw, setRaw] = useState(false);
  // Bumped by a takeover: the pane's command line changed, so its terminal has
  // to be rebuilt from the new one. Nothing else remounts a terminal, so every
  // pane that is never taken over keeps today's exact lifecycle.
  const [epoch, setEpoch] = useState(0);
  const patchPaneAnywhere = useLayout((s) => s.patchPaneAnywhere);

  const focused = group.tabs.some((t) => t.id === focusedPaneId);
  const zoomed = zoomedGroupId === group.id;
  const active = group.tabs.find((t) => t.id === group.activeId) ?? group.tabs[0];
  const isBroadcasting = broadcast.includes(active.id);
  const isLogging = !!logging[active.id];

  const toggleLog = async () => {
    if (isLogging) { setLogging(active.id, null); return; }
    try {
      const dir = await logsDir();
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const safe = (active.title || "pane").replace(/[^\w.-]/g, "_");
      setLogging(active.id, `${dir}/${safe}-${stamp}.log`);
    } catch {
      /* no Tauri (browser) */
    }
  };

  // The pane as the STORE has it right now. The attach callback below is
  // memoised on the pane id, so without this it would spawn from the command
  // line the pane had when the callback was built — which is exactly the one a
  // takeover just replaced.
  const activeRef = useRef(active);
  activeRef.current = active;

  const attach = useCallback(
    (slot: HTMLDivElement | null) => {
      if (!slot) return;
      const p = activeRef.current;
      const el = ensureTerminal(p.id, spawnOptsForPane(p, workspaceName, swarmProject));
      if (el.parentElement !== slot) slot.replaceChildren(el);
      // ensureTerminal has just registered (or not) this pane as a stream pane,
      // so this is the first moment the answer exists.
      setHeadless(isStreamPane(p.id));
      setRaw(false);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [active.id, epoch],
  );

  /** Kill the headless process and reopen this pane as an interactive CLI on the
   *  same session. The pane's command line is genuinely rewritten: from here on
   *  it IS a TUI pane, to this component and to every swarm watcher.
   *
   *  `pendingPrompt: undefined` is DELIBERATE, including in the one case where it
   *  loses something: a pane taken over before its brief was ever delivered comes
   *  up unbriefed. From this click the human is driving that pane — having the
   *  app type a role brief into a session someone just took manual control of is
   *  the worse surprise, and the brief is one curl away in the swarm notes. */
  const takeover = (cmd: string) => {
    patchPaneAnywhere(active.id, { startupCommand: cmd, pendingPrompt: undefined });
    disposeTerminal(active.id); // kill_tree on the piped child, unregisters the stream pane
    setHeadless(false);
    setEpoch((n) => n + 1); // remount the slot → attach spawns from the new command line
  };

  return (
    <>
      {/* click-outside catcher: dismiss zoom when clicking anywhere but the zoomed group */}
      {zoomed && <div onMouseDown={() => setZoom(null)} style={{ position: "fixed", inset: 0, zIndex: 49, background: "rgba(0,0,0,0.35)", backdropFilter: "blur(3px)" }} />}
    <div
      data-group-id={group.id}
      onMouseDownCapture={() => focusGroup(group.id)}
      style={{
        position: zoomed ? "fixed" : "absolute",
        inset: zoomed ? "10%" : 0,
        boxShadow: zoomed ? "0 12px 48px rgba(0,0,0,0.55)" : "none",
        zIndex: zoomed ? 50 : "auto",
        display: "flex",
        flexDirection: "column",
        border: `1px solid ${focused ? "#4c8bf5" : "var(--border)"}`,
        borderRadius: 4,
        overflow: "hidden",
        background: "var(--bg)",
      }}
    >
      <div
        style={{
          display: "flex", alignItems: "stretch", height: 30, minHeight: 30,
          background: "var(--panel-2)", userSelect: "none",
        }}
      >
        <div style={{ display: "flex", alignItems: "stretch", flex: 1, overflow: "hidden" }}>
          {group.tabs.map((t) => {
            const isActive = t.id === group.activeId;
            return (
              <div
                key={t.id}
                title={t.title}
                onPointerDown={(e) => { e.preventDefault(); selectTab(group.id, t.id); beginTabDrag(t.id, e); }}
                onDoubleClick={(e) => { e.stopPropagation(); focusGroup(group.id); selectTab(group.id, t.id); setZoom(group.id); }}
                style={{
                  display: "flex", alignItems: "center", gap: 6, maxWidth: 160, padding: "0 6px 0 10px",
                  fontSize: 12, cursor: "grab", whiteSpace: "nowrap",
                  color: isActive ? "#fff" : "var(--muted)",
                  background: isActive ? "var(--bg)" : "transparent",
                  borderRight: "1px solid var(--border)",
                  borderTop: isActive ? "2px solid #4c8bf5" : "2px solid transparent",
                  opacity: draggingId === t.id ? 0.4 : 1,
                }}
              >
                {unread[t.id] && !isActive && (
                  <span title="Unread activity" style={{ width: 6, height: 6, borderRadius: "50%", background: "#5fbf6a", flex: "0 0 auto" }} />
                )}
                <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{t.title}</span>
                <button
                  title="Close tab"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => { e.stopPropagation(); requestClose(t.id); }}
                  style={{ ...iconBtn, padding: 0, color: "var(--muted)" }}
                >✕</button>
              </div>
            );
          })}
          <div style={{ position: "relative", display: "flex" }}>
            <button title="New tab (right-click to choose profile)"
              onClick={(e) => { e.stopPropagation(); focusGroup(group.id); newTab(); }}
              onContextMenu={(e) => {
                e.preventDefault(); e.stopPropagation();
                if (menu) { setMenu(null); return; }
                const r = e.currentTarget.getBoundingClientRect();
                const below = window.innerHeight - r.bottom - 10;
                const above = r.top - 10;
                const up = below < 140 && above > below; // no room under the ＋ → hang it upward
                setMenu({
                  x: Math.max(4, Math.min(r.left, window.innerWidth - MENU_W - 4)),
                  y: up ? r.top - 2 : r.bottom + 2,
                  up,
                  max: Math.max(120, up ? above : below),
                });
              }}
              style={{ ...iconBtn, padding: "0 8px" }}>＋</button>
            {menu && (
              <>
                <div onClick={() => setMenu(null)} style={{ position: "fixed", inset: 0, zIndex: 79 }} />
                {/* fixed so the dropdown escapes the tab strip's overflow:hidden and paints above the terminal */}
                <div style={{
                  position: "fixed",
                  ...(menu.up ? { bottom: window.innerHeight - menu.y } : { top: menu.y }),
                  left: menu.x, zIndex: 80, background: "var(--panel-2)", border: "1px solid var(--border)",
                  borderRadius: 6, padding: 4, minWidth: MENU_W, maxHeight: menu.max, overflowY: "auto",
                  overscrollBehavior: "contain", boxShadow: "0 8px 24px rgba(0,0,0,0.5)",
                }}>
                  {profiles.map((p) => (
                    <div key={p.id}
                      onClick={(e) => { e.stopPropagation(); setMenu(null); focusGroup(group.id); newTab(p.id); }}
                      style={{ display: "flex", alignItems: "center", gap: 7, padding: "5px 8px", borderRadius: 4, cursor: "pointer", fontSize: 12, color: "var(--text)" }}
                      onMouseEnter={(e) => (e.currentTarget.style.background = "var(--border)")}
                      onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}>
                      <span style={{ width: 8, height: 8, borderRadius: "50%", background: p.color ?? "#666" }} />{p.name}
                    </div>
                  ))}
                  {profiles.length === 0 && <div style={{ padding: "5px 8px", fontSize: 12, color: "var(--muted)" }}>No profiles</div>}
                </div>
              </>
            )}
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", paddingRight: 2 }}>
          {/* swarm workspaces only — renders nothing elsewhere */}
          <PaneRoleMenu pane={active} />
          {isSwarm && (
            <button title="Swarm summary grid (one card per agent, no live terminals)" style={iconBtn}
              onClick={(e) => { e.stopPropagation(); openSwarmSummary(true); }}>▦</button>
          )}
          <button title={isLogging ? "Stop logging to file" : "Log output to file"} style={{ ...iconBtn, color: isLogging ? "#e0a44c" : "var(--muted)" }}
            onClick={(e) => { e.stopPropagation(); focusGroup(group.id); toggleLog(); }}>⤓</button>
          <button title={isBroadcasting ? "Remove from broadcast" : "Add to broadcast group"} style={{ ...iconBtn, color: isBroadcasting ? "#e06c6c" : "var(--muted)" }}
            onClick={(e) => { e.stopPropagation(); focusGroup(group.id); toggleBroadcast(active.id); }}>📡</button>
          <button title="Split right (Alt+Shift+=)" style={iconBtn}
            onClick={(e) => { e.stopPropagation(); focusGroup(group.id); splitFocused("horizontal"); }}>▐</button>
          <button title="Split down (Alt+Shift+-)" style={iconBtn}
            onClick={(e) => { e.stopPropagation(); focusGroup(group.id); splitFocused("vertical"); }}>▁</button>
          <button title="Zoom / restore (Ctrl+Shift+Z)" style={iconBtn}
            onClick={(e) => { e.stopPropagation(); focusGroup(group.id); toggleZoom(); }}>{zoomed ? "❐" : "▢"}</button>
        </div>
      </div>
      {isTerminal(active) ? (
        <>
          {/* The terminal is ALWAYS mounted, headless pane or not: it is what
              provisions the session, holds the scrollback, feeds the logger and
              backs the "raw stream" view. A headless pane simply draws its
              transcript over the top of it. */}
          <div style={{ flex: 1, minHeight: 0, position: "relative", border: isBroadcasting ? "1px solid #8a2c2c" : "none" }}>
            <div
              key={`${active.id}:${epoch}`}
              ref={attach}
              // Text dropped on a terminal (screenshot thumb, dragged selection…)
              // pastes into it. Needs window.dragDropEnabled=false in
              // tauri.conf.json — Tauri's native controller otherwise swallows
              // every drop before the DOM sees it (WebView2).
              onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; }}
              // For a stream (piped) pane pasteText is a no-op — its stdin is
              // line-delimited JSON, not a paste target (terminalPool guard).
              onDrop={(e) => {
                e.preventDefault();
                pasteText(active.id, e.dataTransfer.getData("text/plain"));
              }}
              // A headless pane's control bar sits above the terminal rather
              // than over it, so "raw stream" shows every line of the buffer.
              style={{ position: "absolute", inset: 0, top: headless ? BAR_H : 0 }}
            />
            {headless && (
              <HeadlessPane
                key={active.id}
                pane={active}
                raw={raw}
                onToggleRaw={() => setRaw((v) => !v)}
                onTakeover={takeover}
              />
            )}
          </div>
          <StatusStrip paneId={active.id} />
        </>
      ) : (
        <div style={{ flex: 1, minHeight: 0, position: "relative" }}>
          <SystemMonitorPane key={active.id} pane={active} />
        </div>
      )}
    </div>
    </>
  );
}
