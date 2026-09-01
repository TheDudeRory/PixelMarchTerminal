// Layout tree. Leaves are TAB GROUPS (a strip of panes, one active) so any slot
// can hold multiple terminals as tabs. Splits are binary with one `ratio`.
// 3+ slots come from nesting. Everything is pure + immutable (easy to test and
// to drive from a store). Pane ids are stable across every op, so the terminal
// pool (keyed by pane id) never loses a shell when the tree is restructured.
//
// Direction: "horizontal" = children side by side (row, vertical divider);
//            "vertical"   = children stacked   (column, horizontal divider).

export type Direction = "horizontal" | "vertical";
export type Side = "left" | "right" | "top" | "bottom";

export type RestartPolicy = "never" | "rerun" | "prompt";

export type PaneKind = "terminal" | "monitor";

export interface MonitorConfig {
  intervalMs: number;
  showCpu: boolean;
  showMem: boolean;
  showGpu: boolean;
  showNet: boolean;
}

export const DEFAULT_MONITOR: MonitorConfig = { intervalMs: 1000, showCpu: true, showMem: true, showGpu: true, showNet: true };

export interface Pane {
  id: string;
  title: string;
  /** Swarm role this pane runs ("coordinator", "builder-2", …) — set once by
   *  swarmPanes() and never derived from the title again. The title used to BE
   *  the role, so renaming or closing the reviewer pane silently rerouted the
   *  merge gate to the coordinator (brain-findings 1.4). With this field the
   *  title is purely cosmetic; see paneRole()/isRolePane() in lib/swarm.ts.
   *  Undefined = not an agent pane (a human's shell in a swarm workspace). */
  role?: string;
  kind?: PaneKind; // undefined = "terminal" (back-compat with older saved state)
  monitor?: MonitorConfig; // only for kind: "monitor"
  shell?: string;
  args?: string[];
  cwd?: string;
  startupCommand?: string;
  /** Command held back until the pane is actually needed (swarm lazy workers):
   *  the pane opens as a bare shell and the host types this in on the first
   *  wake, so an idle role costs no model turns. Cleared once launched. */
  pendingCommand?: string;
  /** Prompt held back until the pane is actually needed, for a CLI that is ALREADY
   *  running with a wiped context (swarm context resets): the host types this in on
   *  the first wake instead of re-briefing an idle agent. Unlike pendingCommand it
   *  never becomes startupCommand — the pane's CLI did not change. Cleared once sent. */
  pendingPrompt?: string;
  env?: Record<string, string>;
  restartPolicy?: RestartPolicy;
  color?: string;
  fontSize?: number;
  profileId?: string;
  bigBrainTargets?: string[];
}

/** A monitor pane runs no shell — the terminal pool must skip it. */
export const isTerminal = (p: Pane): boolean => p.kind !== "monitor";

export interface TabGroup {
  type: "tabs";
  id: string;
  tabs: Pane[];
  activeId: string;
}

export interface Split {
  type: "split";
  id: string;
  direction: Direction;
  ratio: number; // size fraction of child `a`
  a: LayoutNode;
  b: LayoutNode;
}

export type LayoutNode = TabGroup | Split;

export const MIN_RATIO = 0.05;
export const MAX_RATIO = 0.95;
const clampRatio = (r: number) => Math.min(MAX_RATIO, Math.max(MIN_RATIO, r));

const uid = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : Math.random().toString(36).slice(2);

let paneCounter = 0;
export function newPane(init: Partial<Pane> = {}): Pane {
  return { ...init, id: init.id ?? uid(), title: init.title ?? `Terminal ${++paneCounter}` };
}

export function newGroup(pane: Pane = newPane()): TabGroup {
  return { type: "tabs", id: uid(), tabs: [pane], activeId: pane.id };
}

const hsplit = (a: LayoutNode, b: LayoutNode, ratio = 0.5): Split => ({ type: "split", id: uid(), direction: "horizontal", ratio, a, b });
const vsplit = (a: LayoutNode, b: LayoutNode, ratio = 0.5): Split => ({ type: "split", id: uid(), direction: "vertical", ratio, a, b });

/** Replace the node with `id` by applying `fn`; returns a new tree. */
function replaceNode(node: LayoutNode, id: string, fn: (n: LayoutNode) => LayoutNode): LayoutNode {
  if (node.id === id) return fn(node);
  if (node.type === "split") {
    const a = replaceNode(node.a, id, fn);
    const b = replaceNode(node.b, id, fn);
    return a === node.a && b === node.b ? node : { ...node, a, b };
  }
  return node;
}

export function collectGroups(node: LayoutNode): TabGroup[] {
  return node.type === "tabs" ? [node] : [...collectGroups(node.a), ...collectGroups(node.b)];
}

/** Deep-clone a tree with brand-new ids everywhere (for duplicating a workspace,
 *  so the copy gets its own terminals). Returns the clone + old→new pane id map. */
export function remapIds(node: LayoutNode, map: Record<string, string> = {}): { node: LayoutNode; map: Record<string, string> } {
  if (node.type === "tabs") {
    const tabs = node.tabs.map((t) => {
      const id = uid();
      map[t.id] = id;
      return { ...t, id };
    });
    const activeIdx = node.tabs.findIndex((t) => t.id === node.activeId);
    return { node: { type: "tabs", id: uid(), tabs, activeId: tabs[Math.max(0, activeIdx)].id }, map };
  }
  const a = remapIds(node.a, map);
  const b = remapIds(node.b, map);
  return { node: { ...node, id: uid(), a: a.node, b: b.node }, map };
}

export function collectPanes(node: LayoutNode): Pane[] {
  return collectGroups(node).flatMap((g) => g.tabs);
}

export function groupOfPane(node: LayoutNode, paneId: string): TabGroup | undefined {
  return collectGroups(node).find((g) => g.tabs.some((t) => t.id === paneId));
}

/** Split a group in two; the new group (with a fresh pane) goes to side `b` unless placeFirst. */
export function splitGroup(
  root: LayoutNode,
  groupId: string,
  direction: Direction,
  placeFirst = false,
  fresh: TabGroup = newGroup(),
): { root: LayoutNode; newGroupId: string; newPaneId: string } {
  const next = replaceNode(root, groupId, (g) => ({
    type: "split",
    id: uid(),
    direction,
    ratio: 0.5,
    a: placeFirst ? fresh : g,
    b: placeFirst ? g : fresh,
  }));
  return { root: next, newGroupId: fresh.id, newPaneId: fresh.tabs[0].id };
}

export function addTab(root: LayoutNode, groupId: string, pane: Pane = newPane()): { root: LayoutNode; paneId: string } {
  const next = replaceNode(root, groupId, (g) =>
    g.type === "tabs" ? { ...g, tabs: [...g.tabs, pane], activeId: pane.id } : g,
  );
  return { root: next, paneId: pane.id };
}

/** Patch a single pane in place (by id), preserving all ids. */
export function updatePane(root: LayoutNode, paneId: string, patch: Partial<Pane>): LayoutNode {
  const rec = (node: LayoutNode): LayoutNode => {
    if (node.type === "tabs") {
      if (!node.tabs.some((t) => t.id === paneId)) return node;
      return { ...node, tabs: node.tabs.map((t) => (t.id === paneId ? { ...t, ...patch } : t)) };
    }
    const a = rec(node.a);
    const b = rec(node.b);
    return a === node.a && b === node.b ? node : { ...node, a, b };
  };
  return rec(root);
}

export function setActiveTab(root: LayoutNode, groupId: string, paneId: string): LayoutNode {
  return replaceNode(root, groupId, (g) =>
    g.type === "tabs" && g.tabs.some((t) => t.id === paneId) ? { ...g, activeId: paneId } : g,
  );
}

export function setRatio(root: LayoutNode, splitId: string, ratio: number): LayoutNode {
  return replaceNode(root, splitId, (n) => (n.type === "split" ? { ...n, ratio: clampRatio(ratio) } : n));
}

export function equalize(node: LayoutNode): LayoutNode {
  return node.type === "tabs" ? node : { ...node, ratio: 0.5, a: equalize(node.a), b: equalize(node.b) };
}

/** Remove a pane; its group collapses when emptied, and the parent split
 *  collapses to the surviving sibling. Returns null only if it was the last pane. */
export function closePane(root: LayoutNode, paneId: string): LayoutNode | null {
  const rec = (node: LayoutNode): LayoutNode | null => {
    if (node.type === "tabs") {
      if (!node.tabs.some((t) => t.id === paneId)) return node;
      const tabs = node.tabs.filter((t) => t.id !== paneId);
      if (tabs.length === 0) return null;
      const activeId = node.activeId === paneId ? tabs[tabs.length - 1].id : node.activeId;
      return { ...node, tabs, activeId };
    }
    const a = rec(node.a);
    const b = rec(node.b);
    if (a === null) return b;
    if (b === null) return a;
    return a === node.a && b === node.b ? node : { ...node, a, b };
  };
  return rec(root);
}

// ---- drag & drop -----------------------------------------------------------

export type DropTarget =
  | { kind: "tab"; groupId: string }
  | { kind: "split"; groupId: string; side: Side }
  | { kind: "edge"; side: Side };

const sideDir = (s: Side): Direction => (s === "left" || s === "right" ? "horizontal" : "vertical");
const sideFirst = (s: Side): boolean => s === "left" || s === "top";

/** Apply a drag drop. Pane ids are preserved, so terminals survive the move. */
export function dropPane(root: LayoutNode, paneId: string, target: DropTarget): LayoutNode {
  const pane = collectPanes(root).find((p) => p.id === paneId);
  if (!pane) return root;

  if (target.kind === "tab") {
    if (groupOfPane(root, paneId)?.id === target.groupId) return root; // already here
    const removed = closePane(root, paneId);
    if (!removed || !collectGroups(removed).some((g) => g.id === target.groupId)) return root;
    return addTab(removed, target.groupId, pane).root;
  }

  if (target.kind === "split") {
    const src = groupOfPane(root, paneId);
    if (src?.id === target.groupId && src.tabs.length === 1) return root; // no-op onto own solo group
    const removed = closePane(root, paneId);
    if (!removed || !collectGroups(removed).some((g) => g.id === target.groupId)) return root;
    return splitGroup(removed, target.groupId, sideDir(target.side), sideFirst(target.side), newGroup(pane)).root;
  }

  // edge → split the whole root
  if (collectPanes(root).length === 1) return root;
  const removed = closePane(root, paneId);
  if (!removed) return root;
  const fresh = newGroup(pane);
  return sideDir(target.side) === "horizontal"
    ? sideFirst(target.side) ? hsplit(fresh, removed, 0.3) : hsplit(removed, fresh, 0.7)
    : sideFirst(target.side) ? vsplit(fresh, removed, 0.3) : vsplit(removed, fresh, 0.7);
}

// ---- snap presets ----------------------------------------------------------

export type PresetId = "2h" | "2v" | "3col" | "grid" | "main-side" | "main-bottom";

interface Preset {
  label: string;
  leaves: number;
  build: (g: TabGroup[]) => LayoutNode;
}

export const PRESETS: Record<PresetId, Preset> = {
  "2h": { label: "Side by side", leaves: 2, build: ([a, b]) => hsplit(a, b, 0.5) },
  "2v": { label: "Stacked", leaves: 2, build: ([a, b]) => vsplit(a, b, 0.5) },
  "3col": { label: "3 columns", leaves: 3, build: ([a, b, c]) => hsplit(a, hsplit(b, c, 0.5), 1 / 3) },
  grid: { label: "2 × 2 grid", leaves: 4, build: ([a, b, c, d]) => hsplit(vsplit(a, c), vsplit(b, d)) },
  "main-side": { label: "Main + sidebar", leaves: 2, build: ([a, b]) => hsplit(a, b, 0.7) },
  "main-bottom": { label: "Main + bottom", leaves: 2, build: ([a, b]) => vsplit(a, b, 0.75) },
};

/** Re-slot existing panes into a preset template, in order. Extra panes tab into
 *  the last slot; empty slots get a fresh pane. Existing pane ids are preserved. */
export function applyPreset(root: LayoutNode, id: PresetId, makePane: () => Pane = newPane): LayoutNode {
  const preset = PRESETS[id];
  const panes = collectPanes(root);
  const groups: TabGroup[] = [];
  for (let i = 0; i < preset.leaves; i++) {
    if (i < preset.leaves - 1) {
      groups.push(newGroup(panes[i] ?? makePane()));
    } else {
      const rest = panes.slice(i);
      const tabs = rest.length ? rest : [makePane()];
      groups.push({ type: "tabs", id: uid(), tabs, activeId: tabs[0].id });
    }
  }
  return preset.build(groups);
}
