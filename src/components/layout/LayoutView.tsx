import { useRef } from "react";
import { useLayout, activeWorkspace } from "../../stores/layout";
import type { Direction, LayoutNode } from "../../lib/layout-tree";
import { highlightRect } from "../../lib/drag";
import TabGroupFrame from "./TabGroupFrame";

function Divider({ splitId, direction }: { splitId: string; direction: Direction }) {
  const setRatio = useLayout((s) => s.setRatio);
  const dragging = useRef(false);
  const isRow = direction === "horizontal";

  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    const container = e.currentTarget.parentElement;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const pos = isRow ? (e.clientX - rect.left) / rect.width : (e.clientY - rect.top) / rect.height;
    setRatio(splitId, pos);
  };

  return (
    <div
      onPointerDown={(e) => { dragging.current = true; e.currentTarget.setPointerCapture(e.pointerId); }}
      onPointerMove={onMove}
      onPointerUp={(e) => { dragging.current = false; e.currentTarget.releasePointerCapture(e.pointerId); }}
      style={{ flex: "0 0 6px", cursor: isRow ? "col-resize" : "row-resize", background: "var(--border)", zIndex: 5 }}
    />
  );
}

function render(node: LayoutNode) {
  if (node.type === "tabs") return <TabGroupFrame key={node.id} group={node} />;
  const isRow = node.direction === "horizontal";
  const slot = { position: "relative" as const, minWidth: 0, minHeight: 0, flexBasis: 0 };
  return (
    <div key={node.id} style={{ display: "flex", flexDirection: isRow ? "row" : "column", width: "100%", height: "100%" }}>
      <div style={{ ...slot, flexGrow: node.ratio }}>{render(node.a)}</div>
      <Divider splitId={node.id} direction={node.direction} />
      <div style={{ ...slot, flexGrow: 1 - node.ratio }}>{render(node.b)}</div>
    </div>
  );
}

/** Ghost following the cursor + a highlighted drop zone while dragging a tab. */
function DragOverlay() {
  const drag = useLayout((s) => s.drag);
  if (!drag) return null;
  const rect = drag.target ? highlightRect(drag.target) : null;
  return (
    <>
      {rect && (
        <div
          style={{
            position: "fixed", left: rect.left, top: rect.top, width: rect.width, height: rect.height,
            background: "rgba(76,139,245,0.25)", border: "2px solid #4c8bf5", borderRadius: 4,
            pointerEvents: "none", zIndex: 90, transition: "all 90ms ease",
          }}
        />
      )}
      <div
        style={{
          position: "fixed", left: drag.x + 12, top: drag.y + 12, pointerEvents: "none", zIndex: 95,
          background: "#2b3a55", color: "#fff", fontSize: 12, padding: "3px 8px", borderRadius: 4,
          border: "1px solid #4c8bf5", boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
        }}
      >
        {drag.title}
      </div>
    </>
  );
}

export default function LayoutView() {
  const root = useLayout((s) => activeWorkspace(s).root);
  const activeId = useLayout((s) => s.activeId);
  return (
    <div key={activeId} style={{ position: "relative", width: "100%", height: "100%" }}>
      {render(root)}
      <DragOverlay />
    </div>
  );
}
