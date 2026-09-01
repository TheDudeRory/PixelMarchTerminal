import { describe, expect, it, vi } from "vitest";

// FirstRun pulls in the layout store -> terminalPool -> xterm, which touches
// `self` at import time and dies under vitest's node environment (no jsdom in
// this repo) — same stub as SwarmDialog.test.ts. Nothing below runs the pool or
// touches the backend.
const noop = () => undefined;
vi.mock("../lib/terminalPool", () => ({
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

const { stateFileMissing, shouldWelcome } = await import("./FirstRun");

describe("stateFileMissing", () => {
  it("treats only an absent (or empty) state file as fresh", () => {
    // load_state returns null when pixelmarch.json does not exist.
    expect(stateFileMissing(null)).toBe(true);
    expect(stateFileMissing(undefined)).toBe(true);
    expect(stateFileMissing("")).toBe(true);
    expect(stateFileMissing("   \n")).toBe(true);
    expect(stateFileMissing('{"schemaVersion":1}')).toBe(false);
    // Corrupt-but-present is NOT a fresh profile: that user has history, they
    // just lost it, and greeting them as new would be wrong.
    expect(stateFileMissing("}}} not json")).toBe(false);
  });
});

describe("shouldWelcome", () => {
  const base = { freshProfile: true, fileMissing: true, dismissed: false };

  it("greets a genuinely fresh install", () => {
    expect(shouldWelcome(base)).toBe(true);
    expect(shouldWelcome({ ...base, dismissed: undefined })).toBe(true);
  });

  it("never greets an existing user", () => {
    expect(shouldWelcome({ ...base, freshProfile: false })).toBe(false);
    expect(shouldWelcome({ ...base, fileMissing: false })).toBe(false);
  });

  it("stays dismissed once dismissed", () => {
    expect(shouldWelcome({ ...base, dismissed: true })).toBe(false);
  });

  // The store flag alone is not enough: a corrupt or schema-mismatched file also
  // makes loadPersisted return null, and that user is not new.
  it("requires the file check to agree with the store flag", () => {
    expect(shouldWelcome({ freshProfile: true, fileMissing: false, dismissed: false })).toBe(false);
    expect(shouldWelcome({ freshProfile: false, fileMissing: true, dismissed: false })).toBe(false);
  });
});
