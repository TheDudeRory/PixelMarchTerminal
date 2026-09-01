// markActivity cost, measured. This is a BENCHMARK with assertions, not a unit
// test: it counts how many zustand subscriber notifications a PTY flood costs.
//
// Why notifications are the metric: every one of them re-runs all ~144
// `useLayout(...)` selector call sites in src/, on the same main thread that
// echoes the user's keystrokes. markActivity used to run `set()` per PTY chunk
// — and zustand notifies on ANY set(), including an updater that returns {} —
// so a flooding pane paid the full notification storm even when nothing about
// it had changed.
//
// The test feature-detects the batched signature, so the same file produces
// comparable numbers on the pre-fix revision (where markActivity takes a single
// pane id and always set()s) — run it there with PERF_BASELINE=1, which reports
// the numbers but skips the post-fix assertions. Unset (the normal case) those
// assertions are unconditional, so a regression fails instead of skipping.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ setZoom: () => Promise.resolve() }) }));
vi.mock("../lib/terminalPool", () => ({
  setBroadcast: () => {},
  setScrollbackLimit: () => {},
  setLogging: () => {},
  restartTerminal: () => {},
  applyTerminalSettings: () => {},
  markRestoredPanes: () => {},
}));

const { useLayout } = await import("./layout");
const T = await import("../lib/layout-tree");

/** PERF_BASELINE=1 — measuring the pre-fix revision; report only, assert nothing. */
const BASELINE =
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
    ?.PERF_BASELINE === "1";

const VISIBLE = "pane-visible";
const HIDDEN = "pane-hidden";
const ROUNDS = 20000;

/** One workspace, two tabs: the active one is "visible", the other is not. */
function seed(): void {
  const visible = T.newPane({ id: VISIBLE, title: "visible" });
  const hidden = T.newPane({ id: HIDDEN, title: "hidden" });
  const group = { ...T.newGroup(visible), tabs: [visible, hidden] };
  const ws = { ...useLayout.getState().workspaces[0], root: group, focusedPaneId: VISIBLE };
  useLayout.setState({ workspaces: [ws], activeId: ws.id, unread: {} });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mark = (ids: string[]) => (useLayout.getState().markActivity as any)(batched ? ids : ids[0]);

// Feature detection: pass an array and see whether the hidden pane got marked.
// Only the batched (post-fix) signature can do that.
seed();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(useLayout.getState().markActivity as any)([HIDDEN]);
const batched = useLayout.getState().unread[HIDDEN] === true;

/** Notifications observed while `fn` runs, plus wall-clock ms. */
function measure(fn: () => void): { notifications: number; ms: number } {
  let notifications = 0;
  const unsub = useLayout.subscribe(() => { notifications++; });
  const t0 = performance.now();
  fn();
  const ms = performance.now() - t0;
  unsub();
  return { notifications, ms };
}

const report = (label: string, r: { notifications: number; ms: number }) =>
  // eslint-disable-next-line no-console
  console.log(`  ${label.padEnd(34)} ${String(r.notifications).padStart(6)} notifications  ${r.ms.toFixed(1)} ms`);

describe(`markActivity flood (${batched ? "batched" : "per-chunk"} signature)`, () => {
  beforeEach(seed);

  it("an already-unread pane costs nothing to re-mark", () => {
    mark([HIDDEN]); // first chunk: the one legitimate state change
    expect(useLayout.getState().unread[HIDDEN]).toBe(true);

    const r = measure(() => { for (let i = 0; i < ROUNDS; i++) mark([HIDDEN]); });
    report("re-mark unread pane", r);
    if (!BASELINE) expect(r.notifications).toBe(0);
  });

  it("a visible pane is never unread and must not notify", () => {
    const r = measure(() => { for (let i = 0; i < ROUNDS; i++) mark([VISIBLE]); });
    report("mark visible pane", r);
    expect(useLayout.getState().unread[VISIBLE]).toBeUndefined();
    if (!BASELINE) expect(r.notifications).toBe(0);
  });

  it("a frame's worth of panes costs one notification, not one each", () => {
    const ids = [HIDDEN, VISIBLE, "not-in-any-workspace"];
    const r = measure(() => mark(ids));
    report("mixed batch (1 frame)", r);
    if (!BASELINE) expect(r.notifications).toBe(1); // only HIDDEN actually changed
  });

  it("takes a batch of pane ids (the post-fix signature)", () => {
    if (!BASELINE) expect(batched).toBe(true);
  });

  it("still marks a hidden pane unread, and never a visible one", () => {
    mark([HIDDEN]);
    mark([VISIBLE]);
    expect(useLayout.getState().unread[HIDDEN]).toBe(true);
    expect(useLayout.getState().unread[VISIBLE]).toBeUndefined();
  });
});
