import { describe, it, expect } from "vitest";
import * as T from "./layout-tree";

const group = () => T.newGroup();

describe("layout-tree", () => {
  it("splits a group into a split with the new group as child b", () => {
    const g = group();
    const { root, newGroupId } = T.splitGroup(g, g.id, "horizontal");
    expect(root.type).toBe("split");
    if (root.type === "split") {
      expect(root.direction).toBe("horizontal");
      expect(root.a.id).toBe(g.id);
      expect(root.b.id).toBe(newGroupId);
    }
  });

  it("adds and closes tabs within a group", () => {
    const g = group();
    const { root, paneId } = T.addTab(g, g.id);
    const grp = T.collectGroups(root)[0];
    expect(grp.tabs).toHaveLength(2);
    expect(grp.activeId).toBe(paneId);
    const afterClose = T.closePane(root, paneId);
    expect(T.collectGroups(afterClose!)[0].tabs).toHaveLength(1);
  });

  it("collapses a group to its sibling when its last tab closes", () => {
    const g = group();
    const { root, newPaneId } = T.splitGroup(g, g.id, "vertical");
    const next = T.closePane(root, newPaneId);
    expect(next?.type).toBe("tabs");
    expect(next?.id).toBe(g.id);
  });

  it("returns null when closing the only pane", () => {
    const g = group();
    expect(T.closePane(g, g.tabs[0].id)).toBeNull();
  });

  it("drop 'tab' moves a pane into another group as a tab", () => {
    const g = group();
    const { root, newGroupId, newPaneId } = T.splitGroup(g, g.id, "horizontal");
    const moved = T.dropPane(root, newPaneId, { kind: "tab", groupId: g.id });
    // the split collapses (source group emptied) -> single group with both tabs
    expect(moved.type).toBe("tabs");
    expect(T.collectPanes(moved)).toHaveLength(2);
    expect(newGroupId).toBeDefined();
  });

  it("drop 'split' re-slots a pane beside a target group", () => {
    const g = group();
    const extra = T.addTab(g, g.id); // group now has 2 tabs
    const dropped = T.dropPane(extra.root, extra.paneId, { kind: "split", groupId: g.id, side: "right" });
    expect(dropped.type).toBe("split");
    expect(T.collectPanes(dropped)).toHaveLength(2);
  });

  it("applyPreset re-slots panes and preserves their ids", () => {
    let root: T.LayoutNode = group();
    const first = T.collectPanes(root)[0].id;
    root = T.splitGroup(root, T.collectGroups(root)[0].id, "horizontal").root; // 2 panes
    const grid = T.applyPreset(root, "grid"); // 4 leaves
    expect(T.collectGroups(grid)).toHaveLength(4);
    expect(T.collectPanes(grid).map((p) => p.id)).toContain(first);
  });

  it("remapIds clones a tree with fresh ids and a full old→new map", () => {
    const g = group();
    const { root } = T.splitGroup(g, g.id, "horizontal"); // 2 panes
    const origIds = T.collectPanes(root).map((p) => p.id);
    const { node, map } = T.remapIds(root);
    const newIds = T.collectPanes(node).map((p) => p.id);
    expect(newIds).toHaveLength(2);
    for (const id of newIds) expect(origIds).not.toContain(id); // all new
    for (const id of origIds) expect(map[id]).toBeDefined(); // full mapping
  });

  it("clamps ratio into [MIN, MAX]", () => {
    const g = group();
    const { root } = T.splitGroup(g, g.id, "horizontal");
    expect((T.setRatio(root, root.id, 5) as T.Split).ratio).toBe(T.MAX_RATIO);
    expect((T.setRatio(root, root.id, -1) as T.Split).ratio).toBe(T.MIN_RATIO);
  });
});
