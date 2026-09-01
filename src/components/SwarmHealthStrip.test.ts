import { describe, expect, it, vi } from "vitest";

// Same stub the other component tests use: importing the module pulls the layout
// store -> terminalPool -> xterm, which touches `self` at import time and dies
// under vitest's node environment. Nothing below renders.
const lastOutput = new Map<string, number>();
const noop = () => undefined;

vi.mock("../lib/terminalPool", () => ({
  lastOutputAt: (id: string) => lastOutput.get(id) ?? 0,
  droppedBytes: () => 0,
  isPaused: () => false,
  outputBytes: () => 0,
  paneTier: () => "headless",
  poolStats: () => ({ panes: 0, full: 0, headless: 0, webgl: 0, droppedBytes: 0, truncatedHandoffs: 0 }),
  tailText: () => "",
  setBroadcast: noop,
  setScrollbackLimit: noop,
  setLogging: noop,
  restartTerminal: noop,
  applyTerminalSettings: noop,
  markRestoredPanes: noop,
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.resolve(null) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => undefined) }));
vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ setZoom: () => Promise.resolve() }) }));

const { healthOf, STALL_MS, WORKING_MS } = await import("./SwarmHealthStrip");

const NOW = 1_700_000_000_000;

describe("healthOf", () => {
  it("keeps the PTY-quiet rules when the CLI reports no turn state", () => {
    lastOutput.set("p", NOW - WORKING_MS + 1);
    expect(healthOf("p", false, NOW, false).state).toBe("working");
    lastOutput.set("p", NOW - WORKING_MS - 1);
    expect(healthOf("p", false, NOW, false).state).toBe("idle");
    lastOutput.set("p", NOW - STALL_MS);
    expect(healthOf("p", true, NOW, false).state).toBe("stalled");
    lastOutput.delete("p");
    expect(healthOf("p", false, NOW, false).state).toBe("booting");
  });

  // The bug: an agent doing extended thinking paints nothing, so PTY silence
  // alone called it idle after 4 s and stalled after 60 s while it was working.
  it("reports working while the agent's own hooks say it is mid-turn", () => {
    lastOutput.set("p", NOW - STALL_MS * 5);
    expect(healthOf("p", true, NOW, false, true).state).toBe("working");
    expect(healthOf("p", false, NOW, false, true).state).toBe("working");
    // Never seen any output but already mid-turn (a piped pane): still working,
    // and the age it reports is 0 rather than "since the epoch".
    lastOutput.delete("p");
    expect(healthOf("p", false, NOW, false, true)).toEqual({ state: "working", age: 0 });
  });

  it("still lets a hook-reported ENDED turn read as idle or stalled", () => {
    lastOutput.set("p", NOW - STALL_MS);
    expect(healthOf("p", false, NOW, false, false).state).toBe("idle");
    expect(healthOf("p", true, NOW, false, false).state).toBe("stalled");
  });

  it("keeps wedged outranking a live turn — nothing will move that pane anyway", () => {
    lastOutput.set("p", NOW - 1000);
    expect(healthOf("p", true, NOW, true, true).state).toBe("wedged");
  });
});
