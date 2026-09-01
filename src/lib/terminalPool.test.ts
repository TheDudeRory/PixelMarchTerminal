// Tier-swap engine tests. The pool is a singleton wired to xterm, the DOM and
// the Tauri IPC, none of which exist under vitest's node environment, so both
// terminal implementations, the addons and ./ipc are faked here. The fakes keep
// the two things the swap logic actually depends on: write(data, cb) completing
// asynchronously (that is what `writing`/`onIdle` park behind), and a serialize
// addon whose snapshot is the bytes its host term received.
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---- fake terminals --------------------------------------------------------
let autoWrite = true; // false = write callbacks queue up for manual completion
let parkedWrites: (() => void)[] = [];
const decoder = new TextDecoder();

class FakeTerm {
  static made: FakeTerm[] = [];
  written: string[] = [];
  disposed = false;
  cols: number;
  rows: number;
  options: Record<string, unknown> = {};
  buffer = { active: { length: 0, getLine: () => null } };
  constructor(opts: { cols?: number; rows?: number } = {}) {
    this.cols = opts.cols ?? 80;
    this.rows = opts.rows ?? 24;
  }
  write(data: string | Uint8Array, cb?: () => void): void {
    this.written.push(typeof data === "string" ? data : decoder.decode(data));
    if (!cb) return;
    if (autoWrite) cb();
    else parkedWrites.push(cb);
  }
  loadAddon(addon: { activate?: (t: unknown) => void }): void { addon.activate?.(this); }
  dispose(): void { this.disposed = true; }
  clear(): void {}
  resize(): void {}
  text(): string { return this.written.join(""); }
}

class FakeHeadless extends FakeTerm {
  static instances: FakeHeadless[] = [];
  constructor(o: { cols?: number; rows?: number } = {}) { super(o); FakeHeadless.instances.push(this); }
}

class FakeXTerm extends FakeTerm {
  static instances: FakeXTerm[] = [];
  /** What the pool wired to onData — lets a test type into the terminal. */
  dataCb: ((d: string) => void) | null = null;
  pasted: string[] = [];
  constructor(o: { cols?: number; rows?: number } = {}) { super(o); FakeXTerm.instances.push(this); }
  open(): void {}
  focus(): void {}
  paste(t: string): void { this.pasted.push(t); }
  getSelection(): string { return ""; }
  clearSelection(): void {}
  attachCustomKeyEventHandler(): void {}
  onData(cb: (d: string) => void): { dispose(): void } { this.dataCb = cb; return { dispose: () => {} }; }
  onBell(): { dispose(): void } { return { dispose: () => {} }; }
}

class FakeSerialize {
  private term: FakeTerm | null = null;
  activate(t: FakeTerm): void { this.term = t; }
  serialize(): string { return this.term?.text() ?? ""; }
}
class NoopAddon { activate(): void {} dispose(): void {} }

vi.mock("@xterm/xterm", () => ({ Terminal: FakeXTerm }));
vi.mock("@xterm/headless", () => ({ Terminal: FakeHeadless }));
vi.mock("@xterm/addon-serialize", () => ({ SerializeAddon: FakeSerialize }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class extends NoopAddon { fit(): void {} } }));
vi.mock("@xterm/addon-search", () => ({ SearchAddon: class extends NoopAddon { findNext(): void {} findPrevious(): void {} clearDecorations(): void {} } }));
vi.mock("@xterm/addon-webgl", () => ({ WebglAddon: class extends NoopAddon { onContextLoss(): void {} } }));
vi.mock("@xterm/addon-clipboard", () => ({ ClipboardAddon: class extends NoopAddon {} }));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  readText: () => Promise.resolve(""),
  writeText: () => Promise.resolve(),
}));

// ---- fake IPC --------------------------------------------------------------
let onData: ((p: { id: string; data: string }) => void) | null = null;
const ptyClose = vi.fn();
const ptyOpen = vi.fn(() => Promise.resolve());
const ptyWrite = vi.fn(() => Promise.resolve());
const ptyResize = vi.fn();
vi.mock("./ipc", () => ({
  ptyOpen: (...a: unknown[]) => ptyOpen(...(a as [])),
  ptyClose: (...a: unknown[]) => ptyClose(...(a as [])),
  ptyWrite: (...a: unknown[]) => ptyWrite(...(a as [])),
  ptyResize: (...a: unknown[]) => ptyResize(...(a as [])),
  ptyPause: vi.fn(() => Promise.resolve()),
  ptyResume: vi.fn(() => Promise.resolve()),
  appendText: vi.fn(() => Promise.resolve()),
  onPtyData: (cb: (p: { id: string; data: string }) => void) => { onData = cb; return Promise.resolve(); },
  onPtyExit: () => Promise.resolve(),
}));

// ---- fake DOM --------------------------------------------------------------
interface FakeEl { style: Record<string, string>; isConnected: boolean; clientWidth: number; clientHeight: number; addEventListener(): void; remove(): void }
const makeEl = (): FakeEl => ({
  style: {}, isConnected: false, clientWidth: 0, clientHeight: 0,
  addEventListener: () => {}, remove: () => {},
});
let frames: FrameRequestCallback[] = [];
vi.stubGlobal("document", { createElement: () => makeEl() });
vi.stubGlobal("ResizeObserver", class { observe(): void {} disconnect(): void {} });
vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => { frames.push(cb); return frames.length; });

const pool = await import("./terminalPool");

/** Run every rAF callback queued so far (the batched-write flush). */
const runFrame = () => { const fs = frames; frames = []; for (const f of fs) f(0); };
/** Let the scheduled sweep microtask and the ensureSession async IIFE run. */
const settle = async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); };
/** Complete the write that is currently parked mid-parse. */
const completeWrite = () => { const w = parkedWrites.shift(); w?.(); };
const feed = (paneId: string, text: string) => onData!({ id: paneId, data: btoa(text) });
/** Mount the div the pool handed back, as TabGroupFrame does right after the call. */
const mount = (el: HTMLDivElement) => { (el as unknown as FakeEl).isConnected = true; };
const detach = (el: HTMLDivElement) => { (el as unknown as FakeEl).isConnected = false; };
/** A detached div is only noticed on the next pool call — that is the app's own
 *  "not visible any more" signal. Stand in for it and let the sweep run. */
const poke = async (...ids: string[]) => { pool.syncTerminals(ids.map((id) => ({ id }))); await settle(); };

beforeEach(async () => {
  for (const id of ["a", "b", "s"]) pool.disposeTerminal(id);
  pool.setBroadcast([]);
  FakeXTerm.instances = [];
  FakeHeadless.instances = [];
  parkedWrites = [];
  frames = [];
  autoWrite = true;
  ptyClose.mockClear();
  ptyOpen.mockClear();
  ptyWrite.mockClear();
  ptyResize.mockClear();
  await settle();
  ptyClose.mockClear();
});

describe("session vs view tier", () => {
  it("demote never closes the PTY", async () => {
    const el = pool.ensureTerminal("a", {});
    mount(el);
    await settle();
    runFrame();
    expect(pool.paneTier("a")).toBe("full");

    detach(el); // tab switched away from
    await poke("a");

    expect(pool.paneTier("a")).toBe("headless");
    expect(ptyClose).not.toHaveBeenCalled();
    expect(pool.paneCount()).toBe(1);
  });

  it("closes the PTY exactly once, on pane removal", async () => {
    pool.ensureSession("a", {});
    await settle();
    pool.syncTerminals([]); // pane gone from the live set
    await settle();
    expect(ptyClose).toHaveBeenCalledTimes(1);
    expect(pool.paneCount()).toBe(0);
  });

  it("sweeps after the caller mounts, not before", async () => {
    const a = pool.ensureTerminal("a", {});
    mount(a);
    await settle();
    runFrame();

    // Tab switch: the frame asks for B, then replaces the slot's children —
    // A is still connected at the moment ensureTerminal("b") runs.
    const b = pool.ensureTerminal("b", {});
    detach(a);
    mount(b);
    await settle();
    runFrame();

    expect(pool.paneTier("a")).toBe("headless");
    expect(pool.paneTier("b")).toBe("full");
    expect(pool.poolStats().full).toBe(1); // no stale renderer left behind
  });
});

describe("tier handoff", () => {
  it("drains bytes queued during a parked swap into the new terminal", async () => {
    autoWrite = false;
    pool.ensureSession("a", {});
    await settle();

    feed("a", "AAA");
    runFrame(); // hands AAA to the headless term; its write is now in flight

    const el = pool.ensureTerminal("a", {}); // promote parks behind that write
    mount(el);
    expect(FakeXTerm.instances).toHaveLength(0);

    feed("a", "BBB"); // arrives while the swap is still parked

    completeWrite(); // AAA parsed -> attachFull runs, writes the snapshot
    expect(FakeXTerm.instances).toHaveLength(1);
    const full = FakeXTerm.instances[0];
    expect(full.text()).toContain("AAA");

    completeWrite(); // snapshot parsed
    runFrame();
    expect(full.text()).toBe("AAABBB"); // nothing lost across the swap
  });

  it("parks a swap behind the handoff write itself", async () => {
    pool.ensureSession("a", {});
    await settle();
    feed("a", "AAA"); // give the headless buffer something to hand over
    runFrame();

    autoWrite = false;
    const el = pool.ensureTerminal("a", {});
    mount(el);
    await settle();
    expect(FakeXTerm.instances).toHaveLength(1);

    // The handoff snapshot is mid-parse. A demote landing now must NOT build a
    // headless term off a half-filled buffer.
    const headlessBefore = FakeHeadless.instances.length;
    detach(el);
    await poke("a");
    expect(FakeHeadless.instances).toHaveLength(headlessBefore);

    completeWrite(); // handoff done -> the parked demote runs
    expect(FakeHeadless.instances).toHaveLength(headlessBefore + 1);
    expect(ptyClose).not.toHaveBeenCalled();
  });

  it("disposes the terminal it replaces in both directions", async () => {
    const el = pool.ensureTerminal("a", {});
    mount(el);
    await settle();
    const headless = FakeHeadless.instances[0];
    const full = FakeXTerm.instances[0];
    expect(headless.disposed).toBe(true); // promote must not strand the buffer

    detach(el);
    await poke("a");
    expect(full.disposed).toBe(true);
  });

  it("re-promoting cancels a parked demote instead of building a second view", async () => {
    autoWrite = false;
    const el = pool.ensureTerminal("a", {});
    mount(el);
    await settle();
    completeWrite(); // handoff lands, pane is fully promoted
    expect(FakeXTerm.instances).toHaveLength(1);

    feed("a", "X");
    runFrame(); // a write is in flight again, so the next swap parks

    detach(el);
    await poke("a"); // demote -> parked behind that write
    expect(pool.paneTier("a")).toBe("headless");

    const again = pool.ensureTerminal("a", {}); // re-promoted before it ran
    mount(again);
    await settle();
    completeWrite();

    expect(FakeXTerm.instances).toHaveLength(1); // same renderer, no orphan
    expect(pool.paneTier("a")).toBe("full");
    expect(ptyClose).not.toHaveBeenCalled();
  });
});

// A stream (piped) pane's stdin is line-delimited JSON — the agent protocol.
// Raw bytes from any UI input path (typing, paste, drag-drop, broadcast) would
// corrupt it mid-frame; the only legitimate way in is the prompt funnel
// (submitStreamPrompt). These tests pin the guard: stream panes drop UI input,
// PTY panes keep taking it unchanged.
describe("stream (piped) pane input guards", () => {
  const streamOpts = { mode: "piped" as const, startupCommand: "claude -p" };

  it("drops keystrokes into a stream pane; a PTY pane still sends them", async () => {
    const elS = pool.ensureTerminal("s", streamOpts);
    mount(elS);
    const elA = pool.ensureTerminal("a", {});
    mount(elA);
    await settle();
    runFrame();
    const [termS, termA] = FakeXTerm.instances;

    termS.dataCb!("x");
    runFrame(); // drain the keystroke-coalescing window
    expect(ptyWrite).not.toHaveBeenCalled();

    termA.dataCb!("y");
    runFrame();
    expect(ptyWrite).toHaveBeenCalledWith("a", "y");
  });

  it("paste (Ctrl+Shift+V / right-click / drag-drop all land here) is a no-op on a stream pane", async () => {
    const elS = pool.ensureTerminal("s", streamOpts);
    mount(elS);
    const elA = pool.ensureTerminal("a", {});
    mount(elA);
    await settle();
    runFrame();
    const [termS, termA] = FakeXTerm.instances;

    pool.pasteText("s", "dropped text");
    expect(termS.pasted).toHaveLength(0);

    pool.pasteText("a", "dropped text");
    expect(termA.pasted).toEqual(["dropped text"]);
  });

  it("never calls ptyResize for a stream pane — a piped child has no PTY", async () => {
    const elS = pool.ensureTerminal("s", streamOpts);
    (elS as unknown as FakeEl).clientWidth = 800;
    (elS as unknown as FakeEl).clientHeight = 600;
    mount(elS);
    await settle();
    runFrame(); // the attach-time resize
    expect(ptyResize).not.toHaveBeenCalled();

    const elA = pool.ensureTerminal("a", {});
    (elA as unknown as FakeEl).clientWidth = 800;
    (elA as unknown as FakeEl).clientHeight = 600;
    mount(elA);
    await settle();
    runFrame();
    expect(ptyResize).toHaveBeenCalledWith("a", 40, 120);
  });

  it("broadcast fan-out skips stream panes", async () => {
    const elA = pool.ensureTerminal("a", {});
    mount(elA);
    const elS = pool.ensureTerminal("s", streamOpts);
    mount(elS);
    await settle();
    runFrame();
    const termA = FakeXTerm.instances[0];

    pool.setBroadcast(["a", "s"]);
    termA.dataCb!("z");
    runFrame();

    expect(ptyWrite).toHaveBeenCalledWith("a", "z");
    for (const call of ptyWrite.mock.calls) expect((call as unknown[])[0]).not.toBe("s");
  });
});

// The pane-identity vars the installed lifecycle hook reads. Without them every
// hook posts an empty role, /agent-event answers 400, and the whole Phase A
// event path is silently dead behind the quiet-timer fallback.
describe("pane identity in the child environment", () => {
  const pane = { role: "builder-2", title: "builder-2", startupCommand: "claude" };

  it("a swarm role pane spawns with PIXELMARCH_ROLE and PIXELMARCH_PROJECT", () => {
    const opts = pool.spawnOptsForPane(pane, "ws", "repo-swarm-mission-ab12");
    expect(opts.env).toEqual({ PIXELMARCH_ROLE: "builder-2", PIXELMARCH_PROJECT: "repo-swarm-mission-ab12" });
  });

  it("a plain terminal gets NEITHER var — not an empty one", () => {
    // No role at all (a human's shell), and a role pane in a non-swarm workspace.
    expect(pool.spawnOptsForPane({ title: "Terminal 3" }, "ws", "repo-swarm-mission-ab12").env).toBeUndefined();
    expect(pool.spawnOptsForPane(pane, "ws").env).toBeUndefined();
    const withProfileEnv = pool.spawnOptsForPane({ ...pane, env: { FOO: "1" } }, "ws");
    expect(withProfileEnv.env).toEqual({ FOO: "1" });
    expect(Object.keys(withProfileEnv.env!)).not.toContain("PIXELMARCH_ROLE");
  });

  it("keeps the pane's own env and substitution, and identity is not overridable", () => {
    const opts = pool.spawnOptsForPane(
      { ...pane, env: { FOO: "${workspaceName}", PIXELMARCH_ROLE: "coordinator" } },
      "ws",
      "proj",
    );
    expect(opts.env).toEqual({ FOO: "ws", PIXELMARCH_ROLE: "builder-2", PIXELMARCH_PROJECT: "proj" });
  });

  it("a title that looks like a role is not identity — only the typed role field is", () => {
    expect(pool.spawnOptsForPane({ title: "builder-2" }, "ws", "proj").env).toBeUndefined();
    expect(pool.spawnOptsForPane({ role: "not-a-role", title: "x" }, "ws", "proj").env).toBeUndefined();
  });
});
