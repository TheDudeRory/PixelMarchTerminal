// DOM hit-testing for pane drag & drop: which drop target is under the cursor,
// and the rectangle to highlight for it.
import type { DropTarget, Side } from "./layout-tree";

const EDGE_MARGIN = 40; // px from window edge that docks to the whole window
const TABSTRIP_H = 30; // px at the top of a group counts as "drop as tab"
const CENTER = 0.18; // half-size of the central "drop as tab" zone

export function computeTarget(x: number, y: number): DropTarget | null {
  const W = window.innerWidth;
  const H = window.innerHeight;
  if (x < EDGE_MARGIN) return { kind: "edge", side: "left" };
  if (x > W - EDGE_MARGIN) return { kind: "edge", side: "right" };
  if (y < EDGE_MARGIN) return { kind: "edge", side: "top" };
  if (y > H - EDGE_MARGIN) return { kind: "edge", side: "bottom" };

  const groupEl = document
    .elementsFromPoint(x, y)
    .find((e): e is HTMLElement => e instanceof HTMLElement && !!e.dataset.groupId);
  if (!groupEl) return null;
  const groupId = groupEl.dataset.groupId!;
  const r = groupEl.getBoundingClientRect();

  if (y - r.top < TABSTRIP_H) return { kind: "tab", groupId };

  const rx = (x - r.left) / r.width;
  const ry = (y - r.top) / r.height;
  if (Math.abs(rx - 0.5) < CENTER && Math.abs(ry - 0.5) < CENTER) return { kind: "tab", groupId };

  const d: Record<Side, number> = { left: rx, right: 1 - rx, top: ry, bottom: 1 - ry };
  const side = (Object.keys(d) as Side[]).reduce((m, s) => (d[s] < d[m] ? s : m), "left");
  return { kind: "split", groupId, side };
}

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export function highlightRect(target: DropTarget): Rect | null {
  if (target.kind === "edge") {
    const W = window.innerWidth;
    const H = window.innerHeight;
    switch (target.side) {
      case "left": return { left: 0, top: 0, width: W * 0.3, height: H };
      case "right": return { left: W * 0.7, top: 0, width: W * 0.3, height: H };
      case "top": return { left: 0, top: 0, width: W, height: H * 0.3 };
      case "bottom": return { left: 0, top: H * 0.7, width: W, height: H * 0.3 };
    }
  }
  const el = document.querySelector<HTMLElement>(`[data-group-id="${CSS.escape(target.groupId)}"]`);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const base = { left: r.left, top: r.top, width: r.width, height: r.height };
  if (target.kind === "tab") return base;
  switch (target.side) {
    case "left": return { ...base, width: r.width / 2 };
    case "right": return { left: r.left + r.width / 2, top: r.top, width: r.width / 2, height: r.height };
    case "top": return { ...base, height: r.height / 2 };
    case "bottom": return { left: r.left, top: r.top + r.height / 2, width: r.width, height: r.height / 2 };
  }
}
