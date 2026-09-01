import { describe, expect, it, vi } from "vitest";

// No jsdom in this repo: nothing here renders. The two pure functions below are
// what the view's honesty depends on, and both are decidable without a DOM.
vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.resolve(null) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => undefined) }));

const { coverage, usageLine } = await import("./HeadlessPane");

// FINDING 3: the pty://data listener attached on the FIRST headless pane view,
// so a pane opened an hour into a run showed an EMPTY transcript while its xterm
// buffer held the whole run — under copy ("no stream events yet … the agent
// prints nothing until it has read a message") that read as "the agent has done
// nothing". A debugging surface may bound what it saw; it may never imply it saw
// more than it did.
describe("coverage", () => {
  it("is complete when the reader was listening before the pane opened", () => {
    expect(coverage(1000, 2000)).toBe("complete");
  });

  it("is partial when the pane was already running", () => {
    expect(coverage(2000, 1000)).toBe("partial");
  });

  // Attached in the same tick the pane opened: nothing could have been missed.
  it("counts the same instant as complete", () => {
    expect(coverage(1000, 1000)).toBe("complete");
  });

  // No session yet (the CLI announces one only after reading a message) and no
  // listener yet are both "there is nothing it could have missed", not "partial".
  it("claims nothing when there is nothing to compare", () => {
    expect(coverage(0, 1000)).toBe("unknown");
    expect(coverage(1000, 0)).toBe("unknown");
  });
});

describe("usageLine", () => {
  it("says so plainly before the first turn", () => {
    expect(usageLine({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0, costUsd: 0 })).toBe("no turns yet");
  });

  // Cache reads are shown apart from fresh input because they are the difference
  // between an affordable swarm and an unaffordable one.
  it("reports the turn, the tokens, the cache and the cost", () => {
    expect(usageLine({ input: 4, output: 94, cacheRead: 39556, cacheWrite: 9432, turns: 1, costUsd: 0.116468 }))
      .toBe("1 turn · in 4 · out 94 · cache 39.6k · $0.116");
  });
});
