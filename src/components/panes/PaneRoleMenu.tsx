// Per-pane "set role" control. A swarm's panes get their typed Pane.role from
// swarmPanes() at launch, and nothing could change it afterwards: a pane closed
// by accident, an agent moved to another CLI, or a human shell promoted to a
// second reviewer all left the workspace short a role with no way back short of
// relaunching the swarm. This assigns or clears any pane's role in place, and
// the layout store persists it like any other pane field.
import { useState, type CSSProperties } from "react";
import { MAX_REVIEWERS, ROLE_RE, paneRole } from "../../lib/swarm";
import { collectPanes, type Pane } from "../../lib/layout-tree";
import { useLayout, activeWorkspace } from "../../stores/layout";

/** How many builder slots the role picker offers — the Team category's cap. */
export const MAX_BUILDER_SLOTS = 4;

export interface RoleOption {
  role: string;
  /** Held by a DIFFERENT pane: offered but not selectable, since two panes on
   *  one role would double-wake it and double-count it against the turn cap. */
  taken: boolean;
}

/** The roles assignable in a workspace: the canonical set, plus any role already
 *  in use that the canonical set does not cover (a legacy bare "reviewer" pane,
 *  or a builder-7 from a bigger swarm) so an existing pane is never listed as
 *  free. `paneId` is the pane being edited — its own role is not "taken". */
export function roleOptions(panes: Pane[], paneId: string): RoleOption[] {
  const canonical = [
    "coordinator",
    ...Array.from({ length: MAX_BUILDER_SLOTS }, (_, i) => `builder-${i + 1}`),
    "scout",
    ...Array.from({ length: MAX_REVIEWERS }, (_, i) => `reviewer-${i + 1}`),
  ];
  const held = new Map<string, string>(); // role -> pane id holding it
  for (const p of panes) {
    const r = paneRole(p);
    if (r) held.set(r, p.id);
  }
  const extra = [...held.keys()].filter((r) => !canonical.includes(r)).sort();
  return [...canonical, ...extra].map((role) => ({
    role,
    taken: (held.get(role) ?? paneId) !== paneId,
  }));
}

const item: CSSProperties = { padding: "5px 8px", borderRadius: 4, fontSize: 12, whiteSpace: "nowrap" };

/** Renders nothing outside a swarm workspace — role identity means nothing there. */
export default function PaneRoleMenu({ pane }: { pane: Pane }) {
  const swarm = useLayout((s) => activeWorkspace(s).swarm);
  const root = useLayout((s) => activeWorkspace(s).root);
  const setPaneRole = useLayout((s) => s.setPaneRole);
  const [open, setOpen] = useState<{ x: number; y: number } | null>(null);

  if (!swarm) return null;
  const current = paneRole(pane);
  const options = roleOptions(collectPanes(root), pane.id);

  const pick = (role: string | undefined) => {
    setOpen(null);
    setPaneRole(pane.id, role);
  };

  return (
    <div style={{ position: "relative", display: "flex" }}>
      <button
        title={current ? `Swarm role: ${current} — click to reassign` : "No swarm role — click to assign one"}
        onClick={(e) => {
          e.stopPropagation();
          const r = e.currentTarget.getBoundingClientRect();
          setOpen(open ? null : { x: r.left, y: r.bottom + 2 });
        }}
        style={{
          background: "transparent", border: "none", cursor: "pointer", padding: "0 5px",
          fontSize: 11, lineHeight: 1, color: current ? "#c576d6" : "var(--muted)",
          maxWidth: 92, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}
      >
        ◆ {current || "no role"}
      </button>
      {open && (
        <>
          <div onClick={() => setOpen(null)} style={{ position: "fixed", inset: 0, zIndex: 79 }} />
          {/* fixed, like the new-tab profile menu: the tab strip clips overflow */}
          <div style={{ position: "fixed", top: open.y, left: open.x, zIndex: 80, background: "var(--panel-2)", border: "1px solid var(--border)", borderRadius: 6, padding: 4, minWidth: 150, maxHeight: 280, overflowY: "auto", boxShadow: "0 8px 24px rgba(0,0,0,0.5)" }}>
            <div
              onClick={(e) => { e.stopPropagation(); pick(undefined); }}
              style={{ ...item, cursor: "pointer", color: current ? "var(--text)" : "var(--muted)", borderBottom: "1px solid var(--border)" }}
            >
              No role (human shell)
            </div>
            {options.map((o) => (
              <div
                key={o.role}
                onClick={(e) => { e.stopPropagation(); if (!o.taken) pick(o.role); }}
                title={o.taken ? "already held by another pane" : undefined}
                style={{
                  ...item,
                  cursor: o.taken ? "not-allowed" : "pointer",
                  opacity: o.taken ? 0.4 : 1,
                  color: o.role === current ? "#c576d6" : "var(--text)",
                }}
              >
                {o.role}{o.role === current ? " ✓" : ""}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/** Exported for the store/tests: the same guard setPaneRole() applies. */
export const isAssignableRole = (role: string) => ROLE_RE.test(role);
