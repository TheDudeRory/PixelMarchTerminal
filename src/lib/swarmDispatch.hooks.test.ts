import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// Same reason as swarmDispatch.test.ts: the module pulls in the terminal pool
// (xterm touches `self` at import time in the node env). Here the pool IS the
// thing under test alongside the hooks, so the stub is a settable clock stamp
// rather than a constant.
let output = 0;
vi.mock("./terminalPool", () => ({ lastOutputAt: () => output, tailText: () => "" }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.resolve(null) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => undefined) }));

import { ingestAgentEvents, resetAgentEvents } from "./agentEvents";
import { paneBusy, paneIdle } from "./swarmDispatch";
import type { Pane } from "./layout-tree";

const P = "demo-swarm";
const NOW = 1_700_000_000_000;
const QUIET_MS = 3000;
const CAP_MS = 120_000;

const pane = (cmd: string): Pane => ({ id: "p1", kind: "terminal", role: "builder-1", startupCommand: cmd } as unknown as Pane);
const hookPane = () => pane("claude --dangerously-skip-permissions");
const dumbPane = () => pane("opencode");

beforeEach(() => {
  resetAgentEvents();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  output = NOW; // the pane has produced output "just now"
});
afterEach(() => vi.useRealTimers());

describe("a compacting pane is busy, not idle", () => {
  const compactAt = (at: number) => ingestAgentEvents(P, { events: [{ seq: 1, role: "builder-1", event: "compacting", at }], seq: 1 });

  it("answers busy while the CLI compacts, even with no turn open and the pane PTY-quiet", () => {
    // The false-idle that typed wakes into a TUI mid-compaction: no prompt is
    // outstanding (a manual /compact, or a turn whose Stop already fired), so the
    // turn state says "idle" and the quiet timer agrees.
    compactAt(NOW);
    vi.setSystemTime(NOW + QUIET_MS * 4);
    output = NOW; // long PTY-quiet
    expect(paneIdle(P, hookPane())).toBe(false);
    expect(paneBusy(P, hookPane())).toBe(true);
  });

  it("goes back to the ordinary answer once the compaction ends", () => {
    compactAt(NOW);
    ingestAgentEvents(P, { events: [{ seq: 2, role: "builder-1", event: "session-start", at: NOW + 1000 }], seq: 2 });
    vi.setSystemTime(NOW + 1000 + QUIET_MS * 4);
    output = NOW + 1000; // quiet since the compaction ended
    expect(paneIdle(P, hookPane())).toBe(true);
  });

  it("says nothing for a CLI with no hooks — that pane is decided by its screen, as before", () => {
    compactAt(NOW);
    vi.setSystemTime(NOW + QUIET_MS * 4);
    output = NOW;
    expect(paneIdle(P, dumbPane())).toBe(true); // quiet timer, unchanged
  });
});

describe("hook turn state is bounded", () => {
  it("trusts an active turn while it is fresh, even with the pane long PTY-quiet", () => {
    ingestAgentEvents(P, { events: [{ seq: 1, role: "builder-1", event: "prompt-submitted", at: NOW }], seq: 1 });
    vi.setSystemTime(NOW + QUIET_MS * 4); // quiet timer would have called this idle
    expect(paneIdle(P, hookPane())).toBe(false);
    expect(paneBusy(P, hookPane())).toBe(true);
  });

  it("falls back to the quiet timer once a never-ending turn passes the cap — the wedged-pane case", () => {
    // Prompt accepted, then the Stop hook never fires (Esc mid-turn, CLI killed,
    // hook command failed). Before this bound the pane answered "busy" forever.
    ingestAgentEvents(P, { events: [{ seq: 1, role: "builder-1", event: "prompt-submitted", at: NOW }], seq: 1 });
    vi.setSystemTime(NOW + CAP_MS + 1);
    output = NOW + CAP_MS + 1 - QUIET_MS - 1; // and PTY-quiet as well
    expect(paneIdle(P, hookPane())).toBe(true);
    expect(paneBusy(P, hookPane())).toBe(false);
  });

  it("keeps believing a past-cap turn that is still painting the TUI", () => {
    ingestAgentEvents(P, { events: [{ seq: 1, role: "builder-1", event: "prompt-submitted", at: NOW }], seq: 1 });
    vi.setSystemTime(NOW + CAP_MS + 1);
    output = NOW + CAP_MS; // output a moment ago — a long turn, not a wedged one
    expect(paneIdle(P, hookPane())).toBe(false);
    expect(paneBusy(P, hookPane())).toBe(true);
  });

  it("takes the turn-end hook at face value with no staleness games", () => {
    ingestAgentEvents(P, { events: [
      { seq: 1, role: "builder-1", event: "prompt-submitted", at: NOW },
      { seq: 2, role: "builder-1", event: "turn-end", at: NOW + 10 },
    ], seq: 2 });
    expect(paneIdle(P, hookPane())).toBe(true); // idle straight away, no 3s wait
    expect(paneBusy(P, hookPane())).toBe(false);
  });

  it("leaves a non-hook CLI on exactly the path it took before", () => {
    ingestAgentEvents(P, { events: [{ seq: 1, role: "builder-1", event: "prompt-submitted", at: NOW }], seq: 1 });
    expect(paneIdle(P, dumbPane())).toBe(false); // output NOW — inside the quiet window
    expect(paneBusy(P, dumbPane())).toBe(true);
    vi.setSystemTime(NOW + QUIET_MS);
    expect(paneIdle(P, dumbPane())).toBe(true); // …and the hook events never enter into it
    expect(paneBusy(P, dumbPane())).toBe(false);
  });

  it("falls back for a hook pane the hooks have said nothing about yet", () => {
    expect(paneIdle(P, hookPane())).toBe(false); // fresh output = mid-turn by the old rule
    vi.setSystemTime(NOW + QUIET_MS);
    expect(paneIdle(P, hookPane())).toBe(true);
  });
});
