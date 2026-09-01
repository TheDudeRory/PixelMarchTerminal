import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The component reaches the layout store, which pulls terminalPool -> xterm,
// and xterm touches `self` at import time (no jsdom in this repo). Same stub
// SwarmChat.test.ts uses.
const noop = () => undefined;
vi.mock("../lib/terminalPool", () => ({
  setBroadcast: noop,
  setScrollbackLimit: noop,
  setLogging: noop,
  restartTerminal: noop,
  applyTerminalSettings: noop,
  markRestoredPanes: noop,
}));

// convertFileSrc needs the Tauri IPC globals; outside the webview it throws.
// The prefix is all these tests care about.
vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (p: string) => `asset://localhost/${p}`,
  invoke: async () => undefined,
}));

const { afterPrune, pinnedAfterPrune, bustedSrc, nextBust, makeClickGuard, DBL_CLICK_MS } =
  await import("./ScreenshotGallery");

describe("afterPrune", () => {
  it("drops the paths retention deleted from an open grid", () => {
    const shown = ["c.png", "b.png", "a.png"];
    expect(afterPrune(shown, ["c.png"])).toEqual(["c.png"]);
  });

  it("keeps the order the grid is already scrolled through", () => {
    const shown = ["e.png", "d.png", "c.png", "b.png", "a.png"];
    expect(afterPrune(shown, ["e.png", "c.png", "a.png"])).toEqual(["e.png", "c.png", "a.png"]);
  });

  it("puts a capture that raced the prune on top, newest-first", () => {
    // screenshot_list is newest first, so f.png landed after the grid last read.
    expect(afterPrune(["e.png", "d.png"], ["f.png", "e.png"])).toEqual(["f.png", "e.png"]);
  });

  it("empties the grid when the policy took everything", () => {
    expect(afterPrune(["b.png", "a.png"], [])).toEqual([]);
  });

  it("is a no-op when nothing was actually removed", () => {
    const shown = ["b.png", "a.png"];
    expect(afterPrune(shown, ["b.png", "a.png"])).toEqual(shown);
  });
});

describe("pinnedAfterPrune", () => {
  it("keeps a pinned OLDER shot that survived — the pin is not always newest", () => {
    expect(pinnedAfterPrune("a.png", ["c.png", "b.png", "a.png"])).toBe("a.png");
  });

  it("steps to the newest survivor when retention deleted the pinned shot", () => {
    // Retention protects only the newest file, so an older pin is fair game.
    expect(pinnedAfterPrune("a.png", ["c.png", "b.png"])).toBe("c.png");
  });

  it("drops the pin entirely when nothing survived", () => {
    expect(pinnedAfterPrune("a.png", [])).toBeNull();
  });

  it("adopts the newest shot when there was no pin", () => {
    expect(pinnedAfterPrune(null, ["c.png", "b.png"])).toBe("c.png");
    expect(pinnedAfterPrune(null, [])).toBeNull();
  });
});

describe("bustedSrc", () => {
  it("changes the src for the same path when the token moves", () => {
    const a = bustedSrc("/shots/x.png", nextBust());
    const b = bustedSrc("/shots/x.png", nextBust());
    expect(a).not.toBe(b);
  });

  it("is stable for one token, so a re-render does not reload the image", () => {
    const token = nextBust();
    expect(bustedSrc("/shots/x.png", token)).toBe(bustedSrc("/shots/x.png", token));
  });

  it("keeps the asset URL and appends the token as a query", () => {
    expect(bustedSrc("/shots/x.png", 7)).toBe("asset://localhost//shots/x.png?t=7");
  });

  it("hands out a fresh token every call", () => {
    expect(nextBust()).not.toBe(nextBust());
  });
});

describe("makeClickGuard", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("runs the single-click action once when no second click arrives", () => {
    const guard = makeClickGuard();
    const single = vi.fn();
    guard.click("a.png", single);
    expect(single).not.toHaveBeenCalled();
    vi.advanceTimersByTime(DBL_CLICK_MS);
    expect(single).toHaveBeenCalledTimes(1);
  });

  it("swallows BOTH clicks of a double click — one crop, zero copy toasts", () => {
    const guard = makeClickGuard();
    const single = vi.fn();
    const double = vi.fn();
    // The DOM order for a double click: click, click, dblclick.
    guard.click("a.png", single);
    guard.click("a.png", single);
    guard.doubleClick("a.png", double);
    vi.advanceTimersByTime(DBL_CLICK_MS * 4);
    expect(single).not.toHaveBeenCalled();
    expect(double).toHaveBeenCalledTimes(1);
  });

  it("does not let one thumb cancel another thumb's pending click", () => {
    const guard = makeClickGuard();
    const copyA = vi.fn();
    const cropB = vi.fn();
    guard.click("a.png", copyA);
    guard.click("b.png", noop);
    guard.click("b.png", noop);
    guard.doubleClick("b.png", cropB);
    vi.advanceTimersByTime(DBL_CLICK_MS);
    expect(copyA).toHaveBeenCalledTimes(1);
    expect(cropB).toHaveBeenCalledTimes(1);
  });

  it("still fires a later single click on the same thumb", () => {
    const guard = makeClickGuard();
    const single = vi.fn();
    guard.click("a.png", single);
    vi.advanceTimersByTime(DBL_CLICK_MS);
    guard.click("a.png", single);
    vi.advanceTimersByTime(DBL_CLICK_MS);
    expect(single).toHaveBeenCalledTimes(2);
  });

  it("runs the double-click action even with no click pending", () => {
    const guard = makeClickGuard();
    const double = vi.fn();
    guard.doubleClick("a.png", double);
    expect(double).toHaveBeenCalledTimes(1);
  });

  it("cancelAll drops pending clicks so an unmounted grid stays quiet", () => {
    const guard = makeClickGuard();
    const single = vi.fn();
    guard.click("a.png", single);
    guard.click("b.png", single);
    guard.cancelAll();
    vi.advanceTimersByTime(DBL_CLICK_MS * 4);
    expect(single).not.toHaveBeenCalled();
  });
});
