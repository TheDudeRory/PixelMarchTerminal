// Keystroke-path cost, measured. A BENCHMARK with assertions: it counts the two
// things that used to scale with PTY traffic and typing speed on the main
// thread — activityCb invocations per output chunk, and invoke("pty_write")
// calls per typed character.
//
// The same file runs against the pre-fix revision (both call sites existed
// there with the same names), so the numbers are directly comparable — run it
// there with PERF_BASELINE=1, which reports the numbers but skips the
// post-fix assertions. Unset (the normal case) those assertions are
// unconditional, so a coalescing regression fails the suite instead of
// silently skipping past it.
//
// Fakes mirror terminalPool.test.ts, with two additions: FakeXTerm.onData keeps
// the handler so keystrokes can actually be injected, and the ipc fake records
// every ptyWrite payload so ORDER and BYTE-EXACTNESS can be asserted — a
// coalescer that dropped or reordered input would be worse than the lag.
import { beforeEach, describe, expect, it, vi } from "vitest";

const decoder = new TextDecoder();

/** PERF_BASELINE=1 — measuring the pre-fix revision; report only, assert nothing. */
const BASELINE =
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
    ?.PERF_BASELINE === "1";

class FakeTerm {
  written: string[] = [];
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
    cb?.();
  }
  loadAddon(addon: { activate?: (t: unknown) => void }): void { addon.activate?.(this); }
  dispose(): void {}
  clear(): void {}
  resize(): void {}
  text(): string { return this.written.join(""); }
}
class FakeHeadless extends FakeTerm {}
class FakeXTerm extends FakeTerm {
  /** The pool's onData handler — this is what a real keypress reaches. */
  static dataCb: ((d: string) => void) | null = null;
  open(): void {}
  focus(): void {}
  paste(): void {}
  getSelection(): string { return ""; }
  clearSelection(): void {}
  attachCustomKeyEventHandler(): void {}
  onData(cb: (d: string) => void): { dispose(): void } { FakeXTerm.dataCb = cb; return { dispose: () => {} }; }
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

let onData: ((p: { id: string; data: string }) => void) | null = null;
/** Every pty_write the pool issued, in order: [ptyId, payload]. */
let writes: [string, string][] = [];
vi.mock("./ipc", () => ({
  ptyOpen: () => Promise.resolve(),
  ptyClose: () => Promise.resolve(),
  ptyWrite: (id: string, data: string) => { writes.push([id, data]); return Promise.resolve(); },
  ptyResize: () => Promise.resolve(),
  ptyPause: () => Promise.resolve(),
  ptyResume: () => Promise.resolve(),
  appendText: () => Promise.resolve(),
  onPtyData: (cb: (p: { id: string; data: string }) => void) => { onData = cb; return Promise.resolve(); },
  onPtyExit: () => Promise.resolve(),
}));

interface FakeEl { style: Record<string, string>; isConnected: boolean; clientWidth: number; clientHeight: number; addEventListener(): void; remove(): void }
const makeEl = (): FakeEl => ({ style: {}, isConnected: false, clientWidth: 0, clientHeight: 0, addEventListener: () => {}, remove: () => {} });
// Keyed by handle, so cancelAnimationFrame is exact across tests — the input
// coalescer holds a handle between frames and a sloppy stub would strand it.
const frames = new Map<number, FrameRequestCallback>();
let frameSeq = 0;
vi.stubGlobal("document", { createElement: () => makeEl() });
vi.stubGlobal("ResizeObserver", class { observe(): void {} disconnect(): void {} });
vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => { frames.set(++frameSeq, cb); return frameSeq; });
vi.stubGlobal("cancelAnimationFrame", (h: number) => { frames.delete(h); });

const pool = await import("./terminalPool");

const runFrame = () => { const fs = [...frames.values()]; frames.clear(); for (const f of fs) f(0); };
const settle = async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); };
const feed = (paneId: string, text: string) => onData!({ id: paneId, data: btoa(text) });
const mount = (el: HTMLDivElement) => { (el as unknown as FakeEl).isConnected = true; };

/** activityCb calls, and how many pane ids they carried (the batched signature
 *  passes an array; the pre-fix one passes a single id). */
let activityCalls = 0;
let activityIds = 0;

async function openPane(id: string): Promise<void> {
  const el = pool.ensureTerminal(id, {});
  mount(el);
  await settle();
  runFrame();
}

const report = (label: string, n: number, unit: string, ms: number) =>
  // eslint-disable-next-line no-console
  console.log(`  ${label.padEnd(38)} ${String(n).padStart(6)} ${unit.padEnd(18)} ${ms.toFixed(1)} ms`);

beforeEach(async () => {
  for (const id of ["a", "b", "c"]) pool.disposeTerminal(id);
  runFrame(); // drain the coalescers so the previous test leaves no open window
  runFrame();
  frames.clear();
  writes = [];
  activityCalls = 0;
  activityIds = 0;
  FakeXTerm.dataCb = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pool.setActivityCallback(((x: any) => { activityCalls++; activityIds += Array.isArray(x) ? x.length : 1; }) as never);
  await settle();
});

describe("PTY output -> activityCb", () => {
  it("a flood costs one activity call per frame, not one per chunk", async () => {
    await openPane("a");
    await openPane("b");
    const CHUNKS = 5000;

    const t0 = performance.now();
    for (let i = 0; i < CHUNKS; i++) {
      feed("a", `line ${i}\r\n`);
      feed("b", `line ${i}\r\n`);
    }
    const ms = performance.now() - t0;
    report(`${CHUNKS * 2} chunks, before frame`, activityCalls, "activity calls", ms);

    // Pre-fix: one call per chunk, synchronously. Post-fix: zero until the frame.
    if (!BASELINE) expect(activityCalls).toBe(0);
    runFrame();
    report(`${CHUNKS * 2} chunks, after frame`, activityCalls, "activity calls", ms);
    if (!BASELINE) {
      expect(activityCalls).toBe(1);
      expect(activityIds).toBe(2); // deduplicated to the two panes that spoke
    }
  });
});

describe("typing -> pty_write", () => {
  it("a burst collapses to one write per frame, first key still immediate", async () => {
    await openPane("a");
    const typed = "the quick brown fox jumps over the lazy dog 0123456789";

    const t0 = performance.now();
    for (const ch of typed) FakeXTerm.dataCb!(ch);
    const ms = performance.now() - t0;
    const immediate = writes.length;
    runFrame();
    report(`${typed.length} keystrokes`, writes.length, "pty_write calls", ms);

    // The first character must go out with nothing queued ahead of it: that is
    // what keeps a lone keypress as fast as it was before coalescing.
    expect(immediate).toBeGreaterThanOrEqual(1);
    expect(writes[0][1]).toBe(typed[0]);
    // ...and everything after it collapses into the frame's single batch.
    if (!BASELINE) expect(writes.length).toBe(2);
    // Nothing dropped, nothing reordered.
    expect(writes.map((w) => w[1]).join("")).toBe(typed);
    expect(writes.every((w) => w[0] === "a")).toBe(true);
  });

  it("a paste arrives as one write, unsplit", async () => {
    await openPane("a");
    const paste = "x".repeat(4096);
    FakeXTerm.dataCb!(paste);
    runFrame();
    expect(writes).toEqual([["a", paste]]);
  });

  it("control keys survive the coalescer byte for byte", async () => {
    await openPane("a");
    const seq = ["\x03", "\x1b[A", "\r", "\x7f", "\x1b[1;5D"];
    for (const s of seq) FakeXTerm.dataCb!(s);
    runFrame();
    expect(writes.map((w) => w[1]).join("")).toBe(seq.join(""));
  });
});
