// Main-thread cost meter for the render tiering (see terminalPool.ts).
//
// The tiering thesis is: with N swarm panes running, the GUI pays for ONE full
// renderer, not N. This module is how that claim is measured instead of
// asserted. Two independent counters, because they answer different questions:
//
//   longtask  — PerformanceObserver("longtask") reports every main-thread task
//     over 50 ms. Total blocking time (the part of each task past the 50 ms
//     budget) is the "how unresponsive did the UI get" number: input handlers,
//     rAF callbacks and repaints all queue behind these.
//   frame time — a rAF loop timing the gap between presented frames. A gap of
//     more than one refresh interval means frames the compositor never got, so
//     dropped = sum(round(gap / budget) - 1). This is the "how choppy did it
//     look" number, and it catches paint cost that never shows up as a longtask
//     because it happens off the main thread or in sub-50 ms slices.
//
// Both are best-effort: Chromium/WebView2 implement longtask, WebKitGTK (the
// Linux Tauri webview) does not. Missing support is REPORTED (longTaskSupported
// false, plus a note), never silently reported as zero — a perf claim backed by
// a counter that was never running is worse than no claim.
//
// Everything here is dependency-free and safe to import in a node/vitest
// environment: the browser APIs are feature-detected, and the benchmark driver
// pulls xterm in through dynamic import() so a plain `import { … }` from this
// file costs nothing.

export interface PerfReport {
  label: string;
  /** Wall clock the probe was running, ms. */
  durationMs: number;
  /** Refresh interval the dropped-frame math used, ms (measured, not assumed). */
  frameBudgetMs: number;
  frames: number;
  fps: number;
  meanFrameMs: number;
  p95FrameMs: number;
  worstFrameMs: number;
  /** Frames the compositor never presented: sum(round(gap / budget) - 1). */
  droppedFrames: number;
  /** Frames whose gap exceeded 2x the budget — visible stutter, not jitter. */
  jankFrames: number;
  longTaskSupported: boolean;
  longTasks: number;
  /** Sum of every longtask duration, ms. */
  longTaskMs: number;
  /** Sum of (duration - 50) over longtasks — the standard Total Blocking Time. */
  blockingMs: number;
  maxLongTaskMs: number;
  /** Time spent inside the driver's own write loop, ms (benchmark legs only). */
  writeMs: number;
  bytesWritten: number;
  /** Anything bounded, dropped, unsupported or estimated. Never empty-by-omission. */
  notes: string[];
}

interface ProbeState {
  label: string;
  startedAt: number;
  frameBudgetMs: number;
  gaps: number[];
  lastFrameTs: number;
  rafHandle: number;
  observer: PerformanceObserver | null;
  longTasks: number[];
  longTaskSupported: boolean;
  writeMs: number;
  bytesWritten: number;
  notes: string[];
}

const hasRaf = typeof requestAnimationFrame === "function";
const now = (): number =>
  typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : 0;

let state: ProbeState | null = null;

/** True while a probe is collecting. */
export const perfProbeRunning = (): boolean => state !== null;

/** Add a caveat to the running report — bounded data, a dropped sample, a
 *  capability the environment lacks. Callers of the benchmark use it too. */
export function perfNote(note: string): void {
  if (state && !state.notes.includes(note)) state.notes.push(note);
}

/** Count bytes and parse time the caller spent, so a benchmark leg can report
 *  main-thread work directly rather than inferring all of it from longtasks. */
export function perfRecordWrite(ms: number, bytes: number): void {
  if (!state) return;
  state.writeMs += ms;
  state.bytesWritten += bytes;
}

/** Measure the display's refresh interval instead of assuming 60 Hz — 120 Hz
 *  and 144 Hz panels would otherwise make every frame look "dropped". Falls
 *  back to 16.67 ms where rAF does not exist. */
export function calibrateFrameBudget(samples = 20): Promise<number> {
  if (!hasRaf) return Promise.resolve(1000 / 60);
  return new Promise((resolve) => {
    const gaps: number[] = [];
    let last = 0;
    const tick = (ts: number): void => {
      if (last) gaps.push(ts - last);
      last = ts;
      if (gaps.length < samples) { requestAnimationFrame(tick); return; }
      gaps.sort((a, b) => a - b);
      const median = gaps[Math.floor(gaps.length / 2)];
      // Clamp to sane refresh rates: a throttled/background tab reports huge
      // gaps, and a busy calibration would otherwise inflate the budget and
      // hide real drops. The 6 ms floor covers up to ~165 Hz; above that (240 Hz
      // = 4.17 ms) the budget is over-estimated and drops are under-counted, so
      // lower the floor before trusting numbers from a faster panel.
      resolve(Math.min(34, Math.max(6, median)));
    };
    requestAnimationFrame(tick);
  });
}

/** Start collecting. `frameBudgetMs` should come from calibrateFrameBudget();
 *  omit it and 60 Hz is assumed (and noted). */
export function startPerfProbe(label: string, frameBudgetMs?: number): void {
  if (state) stopPerfProbe();
  const notes: string[] = [];
  if (frameBudgetMs === undefined) notes.push("frame budget assumed 60 Hz (not calibrated)");

  const s: ProbeState = {
    label,
    startedAt: now(),
    frameBudgetMs: frameBudgetMs ?? 1000 / 60,
    gaps: [],
    lastFrameTs: 0,
    rafHandle: 0,
    observer: null,
    longTasks: [],
    longTaskSupported: false,
    writeMs: 0,
    bytesWritten: 0,
    notes,
  };
  state = s;

  if (typeof PerformanceObserver === "function") {
    try {
      const obs = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) s.longTasks.push(e.duration);
      });
      obs.observe({ type: "longtask", buffered: false });
      s.observer = obs;
      s.longTaskSupported = true;
    } catch {
      // WebKitGTK (Linux Tauri webview) has PerformanceObserver but no
      // "longtask" entry type — observe() throws. Frame timing still works.
      s.notes.push("longtask entries unsupported in this engine — blocking time not measured");
    }
  } else {
    s.notes.push("PerformanceObserver missing — blocking time not measured");
  }

  if (hasRaf) {
    const tick = (ts: number): void => {
      if (state !== s) return;
      if (s.lastFrameTs) s.gaps.push(ts - s.lastFrameTs);
      s.lastFrameTs = ts;
      s.rafHandle = requestAnimationFrame(tick);
    };
    s.rafHandle = requestAnimationFrame(tick);
  } else {
    s.notes.push("requestAnimationFrame missing — frame timing not measured");
  }
}

/** Stop and return the report. Safe to call with no probe running. */
export function stopPerfProbe(): PerfReport {
  const s = state;
  state = null;
  if (!s) {
    return {
      label: "(none)", durationMs: 0, frameBudgetMs: 1000 / 60, frames: 0, fps: 0,
      meanFrameMs: 0, p95FrameMs: 0, worstFrameMs: 0, droppedFrames: 0, jankFrames: 0,
      longTaskSupported: false, longTasks: 0, longTaskMs: 0, blockingMs: 0, maxLongTaskMs: 0,
      writeMs: 0, bytesWritten: 0, notes: ["no probe was running"],
    };
  }
  if (s.observer) {
    // Drain anything the observer queued but has not delivered yet.
    for (const e of s.observer.takeRecords()) s.longTasks.push(e.duration);
    s.observer.disconnect();
  }
  if (s.rafHandle && typeof cancelAnimationFrame === "function") cancelAnimationFrame(s.rafHandle);

  const durationMs = Math.max(0, now() - s.startedAt);
  const budget = s.frameBudgetMs;
  const gaps = s.gaps;
  const sorted = [...gaps].sort((a, b) => a - b);
  const sum = gaps.reduce((a, b) => a + b, 0);
  let dropped = 0;
  let jank = 0;
  for (const g of gaps) {
    // round(), not floor(): a 17.1 ms gap on a 16.7 ms budget is one frame that
    // arrived slightly late, not one presented plus one lost.
    const missed = Math.round(g / budget) - 1;
    if (missed > 0) dropped += missed;
    if (g > budget * 2) jank++;
  }
  const longTaskMs = s.longTasks.reduce((a, b) => a + b, 0);
  const blockingMs = s.longTasks.reduce((a, b) => a + Math.max(0, b - 50), 0);

  return {
    label: s.label,
    durationMs: round2(durationMs),
    frameBudgetMs: round2(budget),
    frames: gaps.length,
    fps: durationMs > 0 ? round2((gaps.length / durationMs) * 1000) : 0,
    meanFrameMs: gaps.length ? round2(sum / gaps.length) : 0,
    p95FrameMs: sorted.length ? round2(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]) : 0,
    worstFrameMs: sorted.length ? round2(sorted[sorted.length - 1]) : 0,
    droppedFrames: dropped,
    jankFrames: jank,
    longTaskSupported: s.longTaskSupported,
    longTasks: s.longTasks.length,
    longTaskMs: round2(longTaskMs),
    blockingMs: round2(blockingMs),
    maxLongTaskMs: s.longTasks.length ? round2(Math.max(...s.longTasks)) : 0,
    writeMs: round2(s.writeMs),
    bytesWritten: s.bytesWritten,
    notes: s.notes,
  };
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

// ---- A/B benchmark ---------------------------------------------------------
// Drives the SAME synthetic swarm through both tier layouts and reports both.
//
//   "full"     — every pane is a DOM-attached @xterm/xterm, each asking for its
//                own WebGL context (opts.webgl:false runs the same leg on the
//                DOM renderer, which models a webview that caps live contexts —
//                WebView2/WebKitGTK do — and hands back the losers). This is
//                pre-tiering PixelMarch.
//   "headless" — one DOM-attached @xterm/xterm (the focused pane) and N-1
//                @xterm/headless terminals. This is what terminalPool does now.
//
// It deliberately does NOT go through terminalPool: the pool's byte source is
// the Tauri PTY event stream, which cannot be driven from a browser tab, and
// faking that far up would measure the fake. Instead it reproduces the pool's
// write path exactly — per-pane pending queue, ONE contiguous write per pane
// per animation frame, next chunk only handed over once xterm's write callback
// fires (terminalPool.ts:92-203) — so what differs between the two legs is only
// the thing under test: the renderer.

export interface TierBenchOpts {
  /** Number of swarm panes to simulate. */
  panes: number;
  /** How long each leg runs, ms. */
  durationMs: number;
  /** Bytes of output per pane per second. A chatty agent is ~2-20 KB/s. */
  bytesPerPaneSecond: number;
  /** Where to mount the DOM terminals. */
  container: HTMLElement;
  cols?: number;
  rows?: number;
  /** Try to load the WebGL addon on the focused/full terminals. */
  webgl?: boolean;
}

export interface TierBenchResult {
  panes: number;
  durationMs: number;
  bytesPerPaneSecond: number;
  full: PerfReport;
  headless: PerfReport;
  /** full/headless ratios for the headline numbers. */
  ratios: { blockingMs: number | null; droppedFrames: number | null; writeMs: number | null; fps: number | null };
  notes: string[];
}

/** Terminal-shaped subset both xterm builds satisfy. */
interface BenchTerm {
  write(data: string | Uint8Array, cb?: () => void): void;
  dispose(): void;
  open?(el: HTMLElement): void;
  loadAddon?(addon: unknown): void;
}

interface BenchPane {
  term: BenchTerm;
  pending: Uint8Array[];
  pendingBytes: number;
  writing: boolean;
  /** Bytes dropped by the MAX_PENDING-style guard — reported, never silent. */
  dropped: number;
}

// Mirrors terminalPool's per-pane cap so a leg that cannot keep up degrades the
// same way the app does instead of growing the heap until the tab dies.
const BENCH_MAX_PENDING = 16 * 1024 * 1024;

/** Synthetic agent output: coloured status lines plus an in-place spinner
 *  rewrite, i.e. the escape-heavy traffic a Claude-Code-style TUI actually
 *  emits. Deterministic (no Math.random) so both legs parse identical bytes. */
function synthLines(paneIndex: number, seq: number): string {
  const spin = "|/-\\"[seq % 4];
  const pct = seq % 100;
  return (
    `\r\x1b[2K\x1b[36m${spin}\x1b[0m agent-${paneIndex} working ${pct}%` +
    `\r\n\x1b[90m[${seq}]\x1b[0m \x1b[32mread\x1b[0m src/lib/module-${seq % 37}.ts ` +
    `\x1b[90m(${(seq * 131) % 4096} bytes)\x1b[0m\r\n` +
    `  \x1b[33m~\x1b[0m patch hunk ${seq % 9}: ${"=".repeat(20 + (seq % 40))}\r\n`
  );
}

function makeChunk(paneIndex: number, seq: number, targetBytes: number, enc: TextEncoder): Uint8Array {
  let s = "";
  let i = seq;
  while (s.length < targetBytes) { s += synthLines(paneIndex, i); i++; }
  return enc.encode(s);
}

function enqueue(pane: BenchPane, bytes: Uint8Array): void {
  pane.pending.push(bytes);
  pane.pendingBytes += bytes.length;
  while (pane.pendingBytes > BENCH_MAX_PENDING && pane.pending.length > 1) {
    const gone = pane.pending.shift()!.length;
    pane.pendingBytes -= gone;
    pane.dropped += gone;
  }
}

function takePending(pane: BenchPane): Uint8Array {
  const chunks = pane.pending;
  pane.pending = [];
  const total = pane.pendingBytes;
  pane.pendingBytes = 0;
  if (chunks.length === 1) return chunks[0];
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

/** Run one leg. Resolves once `durationMs` of wall clock has elapsed. */
async function runLeg(
  label: string,
  tier: "full" | "headless",
  opts: TierBenchOpts,
  frameBudgetMs: number,
): Promise<PerfReport> {
  const { panes, durationMs, bytesPerPaneSecond, container } = opts;
  const cols = opts.cols ?? 120;
  const rows = opts.rows ?? 40;

  const { Terminal: XTerm } = await import("@xterm/xterm");
  const { Terminal: HeadlessTerm } = await import("@xterm/headless");

  const hosts: HTMLDivElement[] = [];
  const list: BenchPane[] = [];
  // Construction runs before startPerfProbe(), where perfNote() is a no-op, so
  // caveats found while building panes are parked here and replayed into the
  // report once the probe is live.
  const setupNotes: string[] = [];
  // Full-tier panes are laid out in a grid, as a wall of swarm panes would be.
  const cellSide = Math.ceil(Math.sqrt(Math.max(1, tier === "full" ? panes : 1)));

  for (let i = 0; i < panes; i++) {
    const wantsDom = tier === "full" || i === 0; // headless leg: only the focused pane renders
    let term: BenchTerm;
    if (wantsDom) {
      const el = document.createElement("div");
      el.style.width = `${Math.floor(100 / cellSide)}%`;
      el.style.height = `${Math.floor(100 / cellSide)}%`;
      el.style.float = "left";
      container.appendChild(el);
      hosts.push(el);
      const t = new XTerm({ cols, rows, scrollback: 10000, allowProposedApi: true });
      t.open(el);
      if (opts.webgl !== false) {
        try {
          const { WebglAddon } = await import("@xterm/addon-webgl");
          t.loadAddon(new WebglAddon());
        } catch {
          setupNotes.push(
            `WebGL addon unavailable on pane ${i} — DOM renderer used instead (paint cost differs)`,
          );
        }
      }
      term = t as unknown as BenchTerm;
    } else {
      term = new HeadlessTerm({ cols, rows, scrollback: 10000, allowProposedApi: true }) as unknown as BenchTerm;
    }
    list.push({ term, pending: [], pendingBytes: 0, writing: false, dropped: 0 });
  }

  // Let layout/first paint settle so the probe measures steady state, not mount.
  await raf();
  await raf();

  const enc = new TextEncoder();
  const producerHz = 20; // PTY chunks arrive far more often than frames
  const perTick = Math.max(1, Math.round(bytesPerPaneSecond / producerHz));
  let seq = 0;

  startPerfProbe(label, frameBudgetMs);
  for (const n of setupNotes) perfNote(n);

  let producedBytes = 0;
  const producer = setInterval(() => {
    seq++;
    for (let i = 0; i < list.length; i++) {
      const chunk = makeChunk(i, seq + i * 7, perTick, enc);
      producedBytes += chunk.length;
      enqueue(list[i], chunk);
    }
  }, 1000 / producerHz);

  // The pool's flush loop: one contiguous write per pane per frame, and never a
  // second chunk while the previous one is still parsing.
  let flushing = true;
  const flush = (): void => {
    if (!flushing) return;
    const t0 = now();
    let bytes = 0;
    for (const pane of list) {
      if (pane.writing || pane.pendingBytes === 0) continue;
      const chunk = takePending(pane);
      bytes += chunk.length;
      pane.writing = true;
      pane.term.write(chunk, () => { pane.writing = false; });
    }
    perfRecordWrite(now() - t0, bytes);
    requestAnimationFrame(flush);
  };
  requestAnimationFrame(flush);

  await sleep(durationMs);

  flushing = false;
  clearInterval(producer);
  const droppedBytes = list.reduce((a, p) => a + p.dropped, 0);
  const stillQueued = list.reduce((a, p) => a + p.pendingBytes, 0);
  if (droppedBytes > 0) perfNote(`${droppedBytes} bytes dropped by the ${BENCH_MAX_PENDING}-byte per-pane cap`);
  if (stillQueued > 0) perfNote(`${stillQueued} bytes still queued at leg end (renderer never caught up)`);
  // The producer is a setInterval, so a leg that pins the main thread starves
  // its own load generator: fewer bytes offered, which would otherwise read as
  // "this leg had less work to do". Report the offered total either way.
  perfNote(`producer offered ${producedBytes} bytes over ${durationMs} ms`);
  const report = stopPerfProbe();

  for (const p of list) p.term.dispose();
  for (const el of hosts) el.remove();
  // Give the engine a beat to release WebGL contexts before the next leg builds
  // its own, so leg B is not measured against leg A's leftovers.
  await sleep(500);
  return report;
}

const raf = (): Promise<void> =>
  new Promise((r) => (hasRaf ? requestAnimationFrame(() => r()) : r()));
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const ratio = (a: number, b: number): number | null => (b > 0 ? round2(a / b) : null);

/** Run both legs back to back and return both reports plus their ratios.
 *  Order is headless-then-full on purpose: the expensive leg runs last, so a
 *  browser that throttles or crashes under N live renderers still leaves the
 *  cheap leg's numbers intact. */
export async function runTierBenchmark(opts: TierBenchOpts): Promise<TierBenchResult> {
  const frameBudgetMs = await calibrateFrameBudget();
  const headless = await runLeg(`headless-tier x${opts.panes}`, "headless", opts, frameBudgetMs);
  const full = await runLeg(`full-tier x${opts.panes}`, "full", opts, frameBudgetMs);

  const notes: string[] = [];
  if (!full.longTaskSupported || !headless.longTaskSupported) {
    notes.push("longtask unsupported here — compare droppedFrames/writeMs, not blockingMs");
  }
  notes.push(`frame budget ${round2(frameBudgetMs)} ms (measured refresh interval)`);

  return {
    panes: opts.panes,
    durationMs: opts.durationMs,
    bytesPerPaneSecond: opts.bytesPerPaneSecond,
    full,
    headless,
    ratios: {
      blockingMs: ratio(full.blockingMs, headless.blockingMs),
      droppedFrames: ratio(full.droppedFrames, headless.droppedFrames),
      writeMs: ratio(full.writeMs, headless.writeMs),
      fps: ratio(full.fps, headless.fps),
    },
    notes,
  };
}

/** Expose the probe on `window` so it can be driven from devtools against the
 *  real app (`__perf.start("focused"); … __perf.stop()`), which is the only way
 *  to get numbers from the actual Tauri webview with real PTYs behind it. */
export function installPerfProbe(): void {
  if (typeof window === "undefined") return;
  (window as unknown as Record<string, unknown>).__perf = {
    start: startPerfProbe,
    stop: stopPerfProbe,
    running: perfProbeRunning,
    calibrate: calibrateFrameBudget,
    bench: runTierBenchmark,
  };
}
