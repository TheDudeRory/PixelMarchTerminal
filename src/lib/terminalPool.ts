// Terminals live OUTSIDE the React tree, one PTY per pane id, each rendered in
// its own detached <div>. A pane frame just appendChild's that div into its
// slot, so splitting / closing / zooming / dragging / switching workspaces
// restructures the layout without ever remounting a terminal — shell,
// scrollback and PTY survive.
//
// ---- SESSION vs VIEW TIER --------------------------------------------------
// A pane's SESSION (pty + byte queue + buffer + activity stats) is created once
// on pane add and destroyed once on pane remove. Its VIEW TIER is swappable on
// top of that live byte stream and NEVER touches the pty:
//
//   headless tier — an @xterm/headless Terminal. Parses bytes into a real
//     buffer, never renders: no DOM, no WebGL, no fit/search/clipboard addons.
//     This is what every background pane runs. tailText/dumpScrollback/
//     lastOutputAt all read straight off it, so the summary GUI and the swarm
//     watchdogs (swarmNudge/swarmRunaway/swarmReset) work unchanged.
//   full tier — the DOM-attached @xterm/xterm Terminal, exactly as before.
//     Only panes whose div is actually mounted in a slot get one.
//
// Cost used to scale with N live full renderers; it now scales with the number
// of VISIBLE panes, and live WebGL contexts are capped at ONE (the focused
// pane) — WebView2/WebKitGTK limit how many exist at once, and exhausting them
// forces the much heavier DOM fallback for everybody.
//
// The trap: disposeTerminal() calls ptyClose(), which kills the agent's shell.
// Tier switches must therefore go through promote()/demote(), which dispose
// only the RENDERER. ptyOpen/ptyClose live in ensureSession/entry.dispose and
// nowhere else. Handoff between tiers is an @xterm/addon-serialize snapshot,
// taken only while no write is in flight so no parsed bytes are lost; queued
// bytes (entry.pending) are drained into whichever term is current.
import { Terminal as XTerm } from "@xterm/xterm";
import { Terminal as HeadlessTerm } from "@xterm/headless";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { SearchAddon } from "@xterm/addon-search";
import { SerializeAddon } from "@xterm/addon-serialize";
import { ClipboardAddon, type IClipboardProvider } from "@xterm/addon-clipboard";
import { readText as clipboardReadText, writeText as clipboardWriteText } from "@tauri-apps/plugin-clipboard-manager";
import "@xterm/xterm/css/xterm.css";
import { ptyOpen, ptyWrite, ptyResize, ptyClose, ptyPause, ptyResume, onPtyData, onPtyExit, appendText, type PtyData, type PtyExit } from "./ipc";
// paneRole/spawnModeFor only — swarm.ts imports layout-tree and nothing else, so this adds no cycle.
import { paneRole, spawnModeFor } from "./swarm";
import { feedStreamOutput, isStreamPane, markStreamPaneOpen, registerStreamPane, unregisterStreamPane } from "./agentStream";

// Clipboard goes through the Tauri plugin, not navigator.clipboard: WebView2
// silently drops navigator.clipboard writes without focus/permission, which is
// how OSC 52 copies (e.g. Claude Code "copied") ended up as no-ops.
//
// OSC 52 READ is write-only by default: any program printing the OSC 52 query
// sequence could otherwise silently exfiltrate the OS clipboard through the
// terminal. Reads return "" unless the user opts in (Settings). This does NOT
// affect the user-initiated Ctrl+Shift+V / right-click paste paths below —
// those read the clipboard on an explicit human keypress, not on program output.
const tauriClipboardProvider: IClipboardProvider = {
  readText: () => (termSettings.allowClipboardRead ? clipboardReadText().catch(() => "") : Promise.resolve("")),
  writeText: (_selection, text) => clipboardWriteText(text).catch(() => {}),
};

const b64ToBytes = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const utf8 = new TextEncoder();

// Both tiers expose the parts the pool actually uses (write with a completion
// callback, a buffer to read, resize/clear/dispose), which is what lets the
// flush loop, tailText and dumpScrollback stay tier-agnostic.
type PoolTerm = XTerm | HeadlessTerm;

// @xterm/headless ships its own structurally-identical ITerminalAddon type, so
// the one SerializeAddon class can't satisfy both nominal signatures.
const loadHeadlessAddon = (t: HeadlessTerm, a: SerializeAddon) =>
  t.loadAddon(a as unknown as Parameters<typeof t.loadAddon>[0]);

// ---- shared PTY event fan-in ----------------------------------------------
// ONE listener pair for the whole pool, not one per terminal. Tauri's app.emit
// fans every "pty://data" event out to EVERY registered listener, so a
// listener-per-terminal turned each frame into N callbacks (N = open terminals)
// — O(N^2) main-thread work per frame, which is what froze the GUI under a
// swarm. A single listener dispatches by pty id straight to the owning entry's
// handler. Session id == pty id == pane id, so the map is keyed by pane id.
const dataHandlers = new Map<string, (p: PtyData) => void>();
const exitHandlers = new Map<string, (p: PtyExit) => void>();
let sharedListeners: Promise<void> | null = null;
/** Attach the two shared listeners exactly once. Awaited before a pane's
 *  pty_open so no early output (incl. replayed buffer) is dropped. */
function ensureSharedListeners(): Promise<void> {
  if (!sharedListeners) {
    sharedListeners = (async () => {
      await onPtyData((p) => dataHandlers.get(p.id)?.(p));
      await onPtyExit((p) => exitHandlers.get(p.id)?.(p));
    })();
  }
  return sharedListeners;
}

// ---- batched terminal writes ----------------------------------------------
// PTY output is queued per terminal and flushed once per animation frame from a
// single shared rAF, instead of calling term.write() straight from every event.
// Under a swarm flood the direct path issued many writes per frame, each
// re-entering xterm's parser; batching hands xterm ONE contiguous chunk per
// frame. Backpressure has two layers:
//   1. Local: a new chunk is only handed over once the previous one has finished
//      parsing (xterm's write callback) — data waits in our own cheap byte
//      queue, never piling up inside xterm.
//   2. End-to-end (#3): when the queue crosses HIGH_WATER we tell the host to
//      stop reading this PTY (ptyPause) — the kernel buffer fills and the child
//      process blocks, so a runaway producer is throttled to our paint rate. We
//      resume once the queue drains below LOW_WATER. Against a host that predates flow control
//      pause/resume are no-ops and only layer 1 + the MAX_PENDING cap apply.
// Background (headless) panes go through this SAME queue on purpose: a flooding
// agent nobody is watching still has to be throttled, or it silently eats
// MAX_PENDING bytes of heap per pane. A headless Terminal's write() takes the
// same completion callback, so none of the machinery below cares about tier.
const HIGH_WATER = 2 * 1024 * 1024;   // pause the PTY above this many queued bytes
const LOW_WATER = 256 * 1024;         // resume once drained below this
const MAX_PENDING = 16 * 1024 * 1024; // last-resort per-pane memory cap (drop-oldest)
let rafHandle = 0;
const flushQueue = new Set<Entry>();

function scheduleFlush(entry: Entry): void {
  flushQueue.add(entry);
  if (!rafHandle) rafHandle = requestAnimationFrame(flushAll);
}

function takePending(entry: Entry): Uint8Array {
  const chunks = entry.pending;
  entry.pending = [];
  const total = entry.pendingBytes;
  entry.pendingBytes = 0;
  if (chunks.length === 1) return chunks[0];
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

function flushAll(): void {
  rafHandle = 0;
  const entries = [...flushQueue];
  flushQueue.clear();
  for (const entry of entries) {
    if (!entry.alive) continue;
    // A write already in flight: its completion callback reschedules. Handing
    // xterm a second chunk now would let its internal buffer grow unbounded —
    // exactly what this guards against.
    if (entry.writing) continue;
    if (entry.pendingBytes === 0) { runIdle(entry); continue; }
    const chunk = takePending(entry);
    entry.writing = true;
    entry.term.write(chunk, () => {
      entry.writing = false;
      // Drained enough — let the PTY flow again.
      if (entry.paused && entry.alive && entry.pendingBytes <= LOW_WATER && entry.ptyId) {
        entry.paused = false;
        ptyResume(entry.ptyId).catch(() => {});
      }
      // A tier swap parked here waits for exactly this moment: the bytes just
      // handed over are now IN the buffer, so serializing it loses none.
      runIdle(entry);
      if (entry.pendingBytes > 0) scheduleFlush(entry);
    });
  }
}

/** Run a tier swap that was parked behind an in-flight write, if any. */
function runIdle(entry: Entry): void {
  const fn = entry.onIdle;
  if (!fn) return;
  entry.onIdle = null;
  fn();
}

/** Do `fn` once no chunk is mid-parse, so a serialize() snapshot of the current
 *  term is complete. Swaps chain rather than clobber (promote→demote→promote).
 *  A parked swap is guaranteed to run: a write is only ever in flight when a
 *  completion callback is pending, and that callback always calls runIdle. */
function whenIdle(entry: Entry, fn: () => void): void {
  if (!entry.alive) return;
  if (!entry.writing) { fn(); return; }
  const prev = entry.onIdle;
  entry.onIdle = prev ? () => { prev(); fn(); } : fn;
}

/** Queue PTY bytes for the next frame's flush, dropping the oldest whole chunks
 *  if a runaway pane outruns xterm's parser for long enough to breach the cap. */
function enqueueOutput(entry: Entry, bytes: Uint8Array): void {
  entry.pending.push(bytes);
  entry.pendingBytes += bytes.length;
  // End-to-end backpressure: ask the host to stop reading this PTY so the child
  // blocks instead of us buffering an ever-growing backlog. In-flight bytes
  // (socket + event queue) keep arriving briefly after this, hence the cap below.
  if (!entry.paused && entry.alive && entry.pendingBytes > HIGH_WATER && entry.ptyId) {
    entry.paused = true;
    ptyPause(entry.ptyId).catch(() => {});
  }
  // Last-resort memory guard for a host that predates flow control (no real pause) or a burst that
  // outruns the pause round-trip. Dropping mid-stream can corrupt rendering (a
  // split escape sequence) but is strictly better than unbounded growth; the
  // runaway watchdog (swarmRunaway.ts) is the real remedy for a pane that never quiets.
  // Dropped bytes are COUNTED (droppedBytes()) so a summary card can say its
  // preview is incomplete instead of quietly showing a tidy, wrong tail.
  while (entry.pendingBytes > MAX_PENDING && entry.pending.length > 1) {
    const gone = entry.pending.shift()!.length;
    entry.pendingBytes -= gone;
    entry.dropped += gone;
  }
  scheduleFlush(entry);
}

export interface SpawnPaneOpts {
  shell?: string;
  args?: string[];
  cwd?: string;
  startupCommand?: string;
  env?: Record<string, string>;
  restartPolicy?: "never" | "rerun" | "prompt";
  fontSize?: number;
  bigBrainTargets?: string[];
  /** How the host spawns the child. Absent = "pty" = what every pane has always
   *  been; "piped" gives the process plain stdio instead of a terminal, for a
   *  CLI driven by a JSON stream (agentStream.ts). Derived from the startup
   *  command by `spawnModeFor`, never chosen independently of it. */
  mode?: "pty" | "piped";
}

export type PaneTier = "headless" | "full";

interface Entry {
  paneId: string;
  /** Current sink for PTY bytes — headless or full. Swapped by promote/demote. */
  term: PoolTerm;
  tier: PaneTier;
  /** Loaded on whichever term is current; the tier-handoff mechanism. */
  serialize: SerializeAddon;
  // ---- full tier only (all null while headless) ----
  el: HTMLDivElement | null;
  fit: FitAddon | null;
  search: SearchAddon | null;
  webgl: WebglAddon | null;
  ro: ResizeObserver | null;
  input: { dispose(): void } | null;
  /** True between promote() and the frame the div actually lands in a slot —
   *  keeps the detached-pane sweep from demoting a pane that is mid-attach. */
  awaitingAttach: boolean;
  promotedAt: number;
  // ---- session state (survives every tier switch) ----
  /** PTY geometry. The headless term is built at exactly this size so agents
   *  that wrap to $COLUMNS (Claude Code and friends) keep wrapping the same way
   *  off-screen as on. Only the full tier drives ptyResize; demoting leaves the
   *  PTY at the size it was last seen at rather than reflowing the child. */
  cols: number;
  rows: number;
  ptyId: string | null;
  opts: SpawnPaneOpts;
  logPath: string | null;
  decoder: TextDecoder;
  lastOutput: number; // Date.now() of the last PTY output chunk (0 = none yet)
  bytesSeen: number;  // cumulative PTY bytes — drives activity-rate sparklines
  dropped: number;    // bytes discarded by the MAX_PENDING guard (surface it!)
  // Batched-write queue (see the flush machinery above). Incoming PTY bytes land
  // in `pending` and are handed to the current term one contiguous chunk per
  // animation frame; `writing` is true while it is still parsing the last chunk.
  pending: Uint8Array[];
  pendingBytes: number;
  writing: boolean;
  onIdle: (() => void) | null; // tier swap parked until the in-flight write lands
  paused: boolean; // true while we've asked the host to stop reading this PTY (backpressure)
  alive: boolean; // false once disposed — the flush loop must not touch a dead term
  dispose: () => void;
}

const pool = new Map<string, Entry>();
let scrollbackLimit = 10000;
const broadcastIds = new Set<string>();

// Geometry a pane's PTY runs at until a full renderer measures a real slot.
// Not 80x24: agent TUIs wrap to $COLUMNS, and a summary card built from an
// 80-column reflow of output drawn at 200 columns is unreadable.
const BG_COLS = 120;
const BG_ROWS = 40;

// Scrollback carried across a tier swap. Serializing 10k lines on every tab
// switch is real main-thread cost, so the handoff is capped; anything older is
// dropped from the NEW term's scrollback (live output is untouched). Counted,
// not silent — see poolStats().truncatedHandoffs.
const HANDOFF_SCROLLBACK = 5000;
let truncatedHandoffs = 0;

/** The pane the user is actually looking at — the only one allowed a live
 *  WebGL context. "" = none. */
let focusedPaneId = "";

const THEMES = {
  dark: { background: "#1e1e1e", foreground: "#dddddd", cursor: "#e0e0e0", selectionBackground: "#3a5170" },
  light: { background: "#ffffff", foreground: "#1a1a1a", cursor: "#333333", selectionBackground: "#b4d0f0" },
};

const termSettings = {
  fontFamily: 'Cascadia Code, MesloLGS Nerd Font Mono, Hack, Consolas, "Courier New", DejaVu Sans Mono, monospace',
  fontSize: 14,
  ligatures: false,
  gpu: true, // WebGL renderer by default (#4) — cheaper repaints; DOM fallback on context loss
  cursorStyle: "block" as "block" | "bar" | "underline",
  theme: "dark" as keyof typeof THEMES,
  // OSC 52 clipboard READ opt-in. Off = programs cannot query the OS clipboard
  // through the terminal (write-only). Flows in via applyTerminalSettings.
  allowClipboardRead: false,
};

/** Apply font/cursor/theme settings to every live terminal (and future ones).
 *  Headless terms have no font, theme or cursor; they pick the current settings
 *  up if and when they are promoted. */
export function applyTerminalSettings(s: Partial<typeof termSettings>): void {
  Object.assign(termSettings, s);
  for (const e of pool.values()) {
    if (!(e.term instanceof XTerm)) continue;
    e.term.options.fontFamily = termSettings.fontFamily;
    e.term.options.fontSize = e.opts.fontSize ?? termSettings.fontSize;
    e.term.options.cursorStyle = termSettings.cursorStyle;
    e.term.options.theme = THEMES[termSettings.theme];
    if (e.el && e.el.clientWidth) e.fit?.fit();
  }
  applyWebglCap(); // the gpu / ligatures toggles change who may hold a context
}

let activityCb: ((paneIds: string[]) => void) | null = null;
let startedCb: ((paneId: string) => void) | null = null;
let exitedCb: ((paneId: string, code: number | null) => void) | null = null;
let errorCb: ((paneId: string, msg: string) => void) | null = null;

export const setActivityCallback = (cb: (paneIds: string[]) => void) => { activityCb = cb; };
export const setStatusCallbacks = (started: (id: string) => void, exited: (id: string, code: number | null) => void) => { startedCb = started; exitedCb = exited; };
export const setErrorCallback = (cb: (id: string, msg: string) => void) => { errorCb = cb; };

/** rAF is stubbed in tests and cancelAnimationFrame is not always alongside it;
 *  a missed cancel only costs one wasted frame callback, so degrade quietly. */
const cancelFrame = (h: number) => { if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(h); };

// ---- activity coalescing ---------------------------------------------------
// activityCb used to fire on EVERY PTY chunk. Each call walked the layout tree
// and ran a zustand set(), and zustand notifies every subscriber on any set() —
// even one that changes nothing — so a flooding pane re-ran every selector in
// the app thousands of times a second, on the same thread that echoes
// keystrokes. Ids now pile up in a set and the store hears about them once per
// frame, deduplicated: N chunks across M panes cost one store update, not N.
const activityPending = new Set<string>();
let activityFrame = 0;
let activityTimer: ReturnType<typeof setTimeout> | null = null;

function flushActivity(): void {
  if (activityFrame) { cancelFrame(activityFrame); activityFrame = 0; }
  if (activityTimer) { clearTimeout(activityTimer); activityTimer = null; }
  if (activityPending.size === 0) return;
  const ids = [...activityPending];
  activityPending.clear();
  activityCb?.(ids);
}

function noteActivity(paneId: string): void {
  activityPending.add(paneId);
  if (activityFrame || activityTimer) return;
  activityFrame = requestAnimationFrame(flushActivity);
  // Same backstop as the input window: rAF stops firing while the window is
  // hidden, and an unread badge should be right by the time it is shown again.
  activityTimer = setTimeout(flushActivity, 16);
}

// ---- keystroke coalescing --------------------------------------------------
// One onData event used to mean one invoke("pty_write") — one IPC round trip
// per character, each queued behind whatever else held the main thread, and in
// broadcast mode multiplied by the size of the group. Bursts (key repeat, a
// paste, broadcast fan-out) now collapse into one write per pty per frame.
//
// The FIRST byte of a burst still goes out immediately: the coalescing window
// only opens after that leading write, so a lone keypress gains no latency and
// nothing is ever delayed beyond one frame. Order is preserved per pty — the
// leading write happens before anything can be queued for that pty, and queued
// data is appended in arrival order — so paste, fast typing and control keys
// arrive byte-for-byte as typed.
const inputQueue = new Map<string, string>();
let inputFrame = 0;
let inputTimer: ReturnType<typeof setTimeout> | null = null;

function openInputWindow(): void {
  if (inputFrame || inputTimer) return;
  inputFrame = requestAnimationFrame(flushInput);
  // rAF stops firing while the window is hidden/minimised; without this
  // backstop a keystroke queued at that moment would sit there indefinitely.
  inputTimer = setTimeout(flushInput, 16);
}

function flushInput(): void {
  if (inputFrame) { cancelFrame(inputFrame); inputFrame = 0; }
  if (inputTimer) { clearTimeout(inputTimer); inputTimer = null; }
  if (inputQueue.size === 0) return; // window closed with nothing queued: burst over
  for (const [ptyId, data] of inputQueue) ptyWrite(ptyId, data).catch(() => {});
  inputQueue.clear();
  openInputWindow(); // still hot -> keep coalescing until a frame comes up empty
}

function queueInput(ptyId: string, data: string): void {
  if (!inputFrame && !inputTimer) {
    ptyWrite(ptyId, data).catch(() => {}); // leading edge: instant, no added latency
    openInputWindow();
    return;
  }
  const prev = inputQueue.get(ptyId);
  inputQueue.set(ptyId, prev === undefined ? data : prev + data);
}
export const setScrollbackLimit = (n: number) => { scrollbackLimit = n; };
export const setBroadcast = (ids: string[]) => { broadcastIds.clear(); ids.forEach((id) => broadcastIds.add(id)); };

const subst = (s: string | undefined, vars: Record<string, string>) =>
  s?.replace(/\$\{(\w+)\}/g, (_, k) => vars[k] ?? "");

/** Spawn options a pane carries, with ${workspaceName}/${paneTitle} substituted.
 *  Used by BOTH the pane frame and the pool sync so a terminal always gets its
 *  full profile settings.
 *
 *  `swarmProject` is the hosting workspace's BigBrain project (Workspace.swarm),
 *  "" for a normal workspace. Together with the pane's typed role it becomes the
 *  ONLY source of PIXELMARCH_ROLE / PIXELMARCH_PROJECT in the child environment:
 *  the lifecycle hook installed by the Rust side reads pane identity from those
 *  two vars, and with nothing setting them every hook posts an empty role,
 *  /agent-event answers 400, and the whole hook path is silently dead while the
 *  quiet-timer fallback covers for it (decision-pane-env).
 *
 *  The project string is taken from the WORKSPACE rather than baked into the
 *  pane at creation, so it is by construction the same string bootPrompt and
 *  brainFeedNow use — a pane whose env disagreed would file its events under a
 *  project nobody polls.
 *
 *  A non-agent pane (no role, or a workspace with no swarm) gets NEITHER var —
 *  not an empty one: the hook's own guard is "unset = not a swarm pane", and an
 *  empty value would turn that into a 400 per turn. */
export function spawnOptsForPane(p: SpawnPaneOpts & { title?: string; role?: string }, workspaceName = "", swarmProject = ""): SpawnPaneOpts {
  const vars = { workspaceName, paneTitle: p.title ?? "" };
  const env = p.env
    ? Object.fromEntries(Object.entries(p.env).map(([k, v]) => [k, subst(v, vars) ?? ""]))
    : undefined;
  const role = swarmProject ? paneRole(p) : "";
  return {
    shell: p.shell,
    args: p.args,
    cwd: subst(p.cwd, vars),
    startupCommand: subst(p.startupCommand, vars),
    // A user-set PIXELMARCH_ROLE/PIXELMARCH_PROJECT in the pane profile does not
    // win: pane identity is the app's, not the profile's.
    env: role ? { ...env, PIXELMARCH_ROLE: role, PIXELMARCH_PROJECT: swarmProject } : env,
    restartPolicy: p.restartPolicy,
    fontSize: p.fontSize,
    bigBrainTargets: p.bigBrainTargets,
    // Read off the command line the pane is actually going to run, so the two
    // can never disagree — a piped child with a TUI command line, or a PTY with
    // a stream-json one, is a pane that hangs with no output to explain itself.
    mode: spawnModeFor(subst(p.startupCommand, vars) ?? ""),
  };
}

// Panes hydrated from persisted state, as opposed to panes created this session.
// restartPolicy is an "On restore" policy: it only gates the startup command for
// RESTORED panes — a freshly created pane always runs its startup command.
const restoredPanes = new Set<string>();
export const markRestoredPanes = (ids: string[]) => ids.forEach((id) => restoredPanes.add(id));

/** Route typed input: a broadcast pane sends to every pane in the group.
 *  A stream (piped) pane's stdin is line-delimited JSON, not a keyboard: raw
 *  bytes landing in it corrupt the protocol mid-frame. The ONLY legitimate way
 *  in is the prompt funnel (deliverPrompt → submitStreamPrompt), which writes
 *  whole frames. Every UI input path converges here — typing via term.onData,
 *  and Ctrl+Shift+V / right-click paste / drag-drop via term.paste, which xterm
 *  re-emits through onData — so this one guard covers them all, both when the
 *  stream pane is the source and when it is a broadcast target. */
function writeInput(paneId: string, data: string) {
  if (isStreamPane(paneId)) return;
  if (broadcastIds.has(paneId) && broadcastIds.size > 1) {
    for (const id of broadcastIds) {
      if (isStreamPane(id)) continue;
      const p = pool.get(id)?.ptyId;
      if (p) queueInput(p, data);
    }
  } else {
    const p = pool.get(paneId)?.ptyId;
    if (p) queueInput(p, data);
  }
}

// ---- session layer ---------------------------------------------------------
// ptyOpen lives here and ONLY here; ptyClose lives in entry.dispose and ONLY
// there. Nothing in the tier machinery below may call either — that is what
// makes a renderer swap safe for a running agent.

function newHeadless(cols: number, rows: number): HeadlessTerm {
  return new HeadlessTerm({ cols, rows, scrollback: scrollbackLimit, allowProposedApi: true });
}

/** Create (or return) a pane's session: headless buffer + PTY + byte queue. No
 *  renderer, no DOM. Every pane in the live set gets one of these; only the
 *  ones actually on screen are promoted to a full terminal. */
export function ensureSession(paneId: string, opts: SpawnPaneOpts): void {
  if (pool.has(paneId)) return;

  const term = newHeadless(BG_COLS, BG_ROWS);
  const serialize = new SerializeAddon();
  loadHeadlessAddon(term, serialize);

  const entry: Entry = {
    paneId, term, tier: "headless", serialize,
    el: null, fit: null, search: null, webgl: null, ro: null, input: null,
    awaitingAttach: false, promotedAt: 0,
    cols: BG_COLS, rows: BG_ROWS,
    ptyId: null, opts, logPath: null, decoder: new TextDecoder(),
    lastOutput: 0, bytesSeen: 0, dropped: 0,
    pending: [], pendingBytes: 0, writing: false, onIdle: null,
    paused: false, alive: true, dispose: () => {},
  };
  let disposed = false;

  // Register the pane's data/exit handlers in the shared dispatch maps. Keyed by
  // pane id (== pty id); the single shared listener routes events here. No
  // per-terminal listen() — that was the O(N^2) fan-out. The handler is
  // renderer-agnostic: it feeds the queue, and the queue feeds whichever term
  // the pane currently owns.
  // A piped pane's bytes are line-delimited JSON, not terminal output: the same
  // frames still land in the buffer (so the pane is dumpable, loggable and
  // renderable), and they are ALSO parsed for the control path — that stream is
  // where a headless agent's real turn boundaries live.
  // "On restore" policy: only a RESTORED "never" pane boots an empty shell — and
  // an empty shell is a TERMINAL, never a piped child. Dropping the command
  // without dropping the mode would leave a stdio-only `sh` that looks like a
  // headless agent to every control-path branch and is not one.
  const startupCommand = restoredPanes.has(paneId) && opts.restartPolicy === "never" ? undefined : opts.startupCommand;
  const streaming = opts.mode === "piped" && !!startupCommand;
  if (streaming) registerStreamPane(paneId, opts.env?.PIXELMARCH_PROJECT ?? "", opts.env?.PIXELMARCH_ROLE ?? "");
  dataHandlers.set(paneId, (p) => {
    const bytes = b64ToBytes(p.data);
    entry.lastOutput = Date.now();
    entry.bytesSeen += bytes.length;
    noteActivity(paneId);
    // One decode for however many consumers want text — `stream: true` keeps a
    // split multi-byte character across chunk boundaries, so decoding twice
    // would corrupt one of the two.
    const text = entry.logPath || streaming ? entry.decoder.decode(bytes, { stream: true }) : "";
    if (entry.logPath) appendText(entry.logPath, text).catch(() => {});
    if (streaming) feedStreamOutput(paneId, text);
    enqueueOutput(entry, bytes); // batched write on the next frame, not now
  });
  exitHandlers.set(paneId, (p) => {
    // Route the notice through the same queue so it lands after buffered output,
    // not ahead of it.
    enqueueOutput(entry, utf8.encode(`\r\n\x1b[90m[process exited${p.code != null ? ` (${p.code})` : ""}]\x1b[0m\r\n`));
    exitedCb?.(paneId, p.code);
  });

  (async () => {
    await ensureSharedListeners(); // listeners live before pty_open → no lost output
    // Session id == pane id: on a GUI restart the host reattaches the SAME
    // running shell and replays its buffer. Set it before opening so replayed
    // output isn't filtered out.
    entry.ptyId = paneId;
    try {
      await ptyOpen(paneId, {
        rows: entry.rows,
        cols: entry.cols,
        shell: opts.shell,
        args: opts.args,
        cwd: opts.cwd,
        env: opts.env,
        bigBrainTargets: opts.bigBrainTargets,
        mode: streaming ? "piped" : undefined,
        startupCommand,
      });
    } catch (err) {
      errorCb?.(paneId, err instanceof Error ? err.message : String(err));
      return;
    }
    if (disposed) {
      ptyClose(paneId);
      return;
    }
    // Only now does a write to this pane have anywhere to go: the host drops
    // writes for an id it has no session for, silently.
    if (streaming) markStreamPaneOpen(paneId);
    startedCb?.(paneId);
  })();

  entry.dispose = () => {
    disposed = true;
    entry.alive = false; // in-flight flush callbacks must not write a disposed term
    entry.onIdle = null;
    dataHandlers.delete(paneId);
    exitHandlers.delete(paneId);
    unregisterStreamPane(paneId); // a restart re-registers: new process, new session
    flushQueue.delete(entry);
    entry.pending = [];
    entry.pendingBytes = 0;
    teardownFull(entry);
    // The ONLY ptyClose in the pool: a genuine pane removal, never a tier switch.
    if (entry.ptyId) ptyClose(entry.ptyId);
    entry.term.dispose();
  };

  pool.set(paneId, entry);
}

// ---- view tier -------------------------------------------------------------

/** Build the DOM-attached terminal and hand the headless buffer over to it.
 *  Runs only once no write is mid-parse (see whenIdle), so the serialize
 *  snapshot contains every byte the headless term ever received. */
function attachFull(entry: Entry): void {
  if (!entry.alive || entry.tier !== "full" || !entry.el || entry.term instanceof XTerm) return;
  const el = entry.el;
  const paneId = entry.paneId;

  const term = new XTerm({
    fontFamily: termSettings.fontFamily,
    fontSize: entry.opts.fontSize ?? termSettings.fontSize,
    cursorBlink: true,
    cursorStyle: termSettings.cursorStyle,
    allowProposedApi: true,
    scrollback: scrollbackLimit,
    theme: THEMES[termSettings.theme],
    cols: entry.cols,
    rows: entry.rows,
  });
  const fit = new FitAddon();
  const search = new SearchAddon();
  const serialize = new SerializeAddon();
  term.loadAddon(fit);
  term.loadAddon(search);
  term.loadAddon(serialize);
  term.loadAddon(new ClipboardAddon(undefined, tauriClipboardProvider)); // OSC 52 → OS clipboard
  term.open(el);

  // Ctrl+Shift+C / Ctrl+Shift+V — the terminal-standard copy/paste chords
  // (plain Ctrl+C/V must keep going to the shell).
  term.attachCustomKeyEventHandler((ev) => {
    if (ev.type !== "keydown" || !ev.ctrlKey || !ev.shiftKey || ev.altKey || ev.metaKey) return true;
    if (ev.code === "KeyC") {
      const sel = term.getSelection();
      if (!sel) return true;
      clipboardWriteText(sel).catch(() => {});
      return false;
    }
    if (ev.code === "KeyV") {
      clipboardReadText().then((t) => { if (t) term.paste(t); }).catch(() => {});
      return false;
    }
    return true;
  });

  // Windows-terminal-style right-click: copy the selection if there is one,
  // otherwise paste. No context menu on the terminal.
  el.addEventListener("contextmenu", (ev) => {
    ev.preventDefault();
    const sel = term.getSelection();
    if (sel) {
      clipboardWriteText(sel).catch(() => {});
      term.clearSelection();
    } else {
      clipboardReadText().then((t) => { if (t) term.paste(t); }).catch(() => {});
    }
  });

  // Scrollback handoff: replay the headless buffer into the DOM terminal, THEN
  // point the byte queue at it. No ptyClose/ptyOpen anywhere on this path.
  const prev = entry.term;
  handoff(entry, term);
  entry.term = term;
  // serialize() above already extracted the snapshot synchronously, so the
  // outgoing headless term is dead weight — up to scrollbackLimit lines of it.
  // Mirrors teardownFull disposing the XTerm on the way back down.
  if (!(prev instanceof XTerm)) prev.dispose();
  entry.serialize = serialize;
  entry.fit = fit;
  entry.search = search;
  entry.input = term.onData((d) => writeInput(paneId, d));
  term.onBell(() => noteActivity(paneId));

  const resize = () => {
    if (el.clientWidth === 0 || el.clientHeight === 0) return; // hidden -> don't resize to 0
    fit.fit();
    entry.cols = term.cols;
    entry.rows = term.rows;
    // A piped child has plain stdio, no PTY — there is nothing to resize and
    // the host would be told to resize a terminal that does not exist.
    if (entry.ptyId && !isStreamPane(entry.paneId)) ptyResize(entry.ptyId, term.rows, term.cols);
  };
  const ro = new ResizeObserver(resize);
  ro.observe(el);
  entry.ro = ro;
  requestAnimationFrame(() => { if (entry.fit === fit) resize(); }); // still ours?

  applyWebglCap();
  // Bytes queued while the swap was parked go to the new term on the next frame.
  if (entry.pendingBytes > 0) scheduleFlush(entry);
}

/** Serialize whatever term the entry currently owns into `next`. Capped — the
 *  overflow is counted rather than silently vanishing. */
function handoff(entry: Entry, next: PoolTerm): void {
  let snapshot = "";
  try {
    snapshot = entry.serialize.serialize({ scrollback: HANDOFF_SCROLLBACK });
    // buffer.active.length counts scrollback + the viewport rows, so compare
    // like for like against the scrollback-only handoff cap.
    if (entry.term.buffer.active.length - entry.rows > HANDOFF_SCROLLBACK) truncatedHandoffs++;
  } catch {
    // A serialize failure must not cost the pane its session — worst case the
    // new tier starts from a blank screen and refills from live output.
  }
  if (!snapshot) return;
  // The replay rides the SAME writing/onIdle lane as a normal flush chunk: until
  // it is parsed, `next` holds a half-filled buffer, so a swap landing in this
  // window must park behind it instead of serializing a partial screen — the
  // exact loss whenIdle exists to prevent.
  entry.writing = true;
  next.write(snapshot, () => {
    entry.writing = false;
    runIdle(entry);
    if (entry.alive && entry.pendingBytes > 0) scheduleFlush(entry);
  });
}

/** Tear the DOM terminal down. Renderer only — the PTY, the byte queue and the
 *  entry itself survive. */
function teardownFull(entry: Entry): void {
  entry.webgl?.dispose();
  entry.webgl = null;
  entry.ro?.disconnect();
  entry.ro = null;
  entry.input?.dispose();
  entry.input = null;
  entry.fit = null;
  entry.search = null;
  if (entry.term instanceof XTerm) entry.term.dispose();
  entry.el?.remove();
  entry.el = null;
  entry.awaitingAttach = false;
}

/** Rebuild the headless buffer from the DOM terminal, then drop the renderer. */
function attachHeadless(entry: Entry): void {
  if (!entry.alive || entry.tier !== "headless" || !(entry.term instanceof XTerm)) return;
  const term = newHeadless(entry.cols, entry.rows);
  const serialize = new SerializeAddon();
  loadHeadlessAddon(term, serialize);
  handoff(entry, term);
  teardownFull(entry);
  entry.term = term;
  entry.serialize = serialize;
  if (entry.pendingBytes > 0) scheduleFlush(entry);
}

/** Give the pane a real renderer and return the div to mount. Idempotent.
 *  Re-promoting a pane whose demote is still parked behind an in-flight write
 *  just cancels the demote — building a second div here would strand the DOM
 *  terminal on the first one. */
function promote(entry: Entry): HTMLDivElement {
  if (entry.el && (entry.tier === "full" || entry.term instanceof XTerm)) {
    entry.tier = "full";
    entry.awaitingAttach = true;
    entry.promotedAt = Date.now();
    return entry.el;
  }
  const el = document.createElement("div");
  el.style.width = "100%";
  el.style.height = "100%";
  entry.el = el;
  entry.tier = "full";
  entry.awaitingAttach = true;
  entry.promotedAt = Date.now();
  // Park the swap behind any in-flight write so the serialize snapshot is whole.
  whenIdle(entry, () => attachFull(entry));
  return el;
}

/** Drop the pane back to the headless tier. Never touches the PTY. */
function demote(entry: Entry): void {
  if (entry.tier !== "full") return;
  entry.tier = "headless";
  entry.awaitingAttach = false;
  // Promoted but never attached (the div was never mounted, or a parked
  // attachFull hasn't run): there is no DOM terminal to hand off from — just
  // drop the orphan div. The headless term is still the live sink.
  if (!(entry.term instanceof XTerm)) { teardownFull(entry); return; }
  whenIdle(entry, () => attachHeadless(entry));
}

/** Exactly one live WebGL context — the focused pane's. WebView2/WebKitGTK cap
 *  how many exist at once and a wall of panes used to exhaust them, which
 *  forced the much slower DOM renderer on everyone. Unfocused-but-visible panes
 *  (splits) keep a DOM-rendered full terminal: correct, just not accelerated. */
function applyWebglCap(): void {
  for (const e of pool.values()) {
    const wants = e.paneId === focusedPaneId && e.term instanceof XTerm
      && termSettings.gpu && !termSettings.ligatures;
    if (wants && !e.webgl) {
      try {
        const webgl = new WebglAddon();
        // If the GPU drops this context, dispose the addon so xterm falls back
        // to the DOM renderer instead of leaving the pane blank.
        webgl.onContextLoss(() => { webgl.dispose(); if (e.webgl === webgl) e.webgl = null; });
        (e.term as XTerm).loadAddon(webgl);
        e.webgl = webgl;
      } catch {
        // WebGL unavailable -> DOM renderer.
      }
    } else if (!wants && e.webgl) {
      e.webgl.dispose();
      e.webgl = null;
    }
  }
}

/** Demote panes whose div is no longer in the document — a closed split, a tab
 *  switched away from, a workspace left behind. This is the only "not visible
 *  any more" signal the pool needs: TabGroupFrame mounts a pane's div by
 *  calling ensureTerminal and detaches it by replacing the slot's children. */
function sweepDetached(): void {
  const now = Date.now();
  for (const e of pool.values()) {
    if (e.tier !== "full" || !e.el) continue;
    if (e.el.isConnected) { e.awaitingAttach = false; continue; }
    // Promoted this tick and not mounted yet — the caller appends the div after
    // we return. Grace window, then reclaim it if it never landed anywhere.
    if (e.awaitingAttach && now - e.promotedAt < 5000) continue;
    demote(e);
  }
}

/** Sweep AFTER the caller has mounted, never during. ensureTerminal's callers
 *  (TabGroupFrame) mount the div they get back on the line after the call and
 *  detach the outgoing pane's div in the same breath, so a sweep run inline
 *  still sees the pane being switched away from as connected — and leaves a live
 *  DOM renderer per tab group behind, which is exactly what the tiering is
 *  supposed to stop. A microtask runs once that synchronous mount is done. */
let sweepScheduled = false;
function scheduleSweep(): void {
  if (sweepScheduled) return;
  sweepScheduled = true;
  queueMicrotask(() => { sweepScheduled = false; sweepDetached(); });
}

/** Provision the pane and hand back the div to mount. Called by the pane frame
 *  when a pane becomes visible, so it doubles as the "promote me" signal. */
export function ensureTerminal(paneId: string, opts: SpawnPaneOpts): HTMLDivElement {
  ensureSession(paneId, opts);
  const entry = pool.get(paneId)!;
  const el = promote(entry);
  scheduleSweep();
  return el;
}

export function disposeTerminal(paneId: string): void {
  const e = pool.get(paneId);
  if (!e) return;
  e.dispose();
  pool.delete(paneId);
}

/** Tree-kill and tear down every terminal (called on graceful quit). */
export function disposeAllTerminals(): void {
  for (const id of [...pool.keys()]) disposeTerminal(id);
}

export function paneCount(): number {
  return pool.size;
}

/** Date.now() of a pane's last PTY output (0 = no output yet / pane unknown).
 *  THE FALLBACK turn signal: output silence stands in for "the turn is over" for
 *  every CLI that cannot say so itself. A CLI with lifecycle hooks reports real
 *  boundaries instead (agentEvents.ts, preferred by swarmDispatch/swarmReset);
 *  this stays the only signal for the rest, so it is not going anywhere. */
export function lastOutputAt(paneId: string): number {
  return pool.get(paneId)?.lastOutput ?? 0;
}

/** True while the host has been told to stop reading this PTY — the agent is
 *  out-running the GUI and is currently blocked on write(). */
export function isPaused(paneId: string): boolean {
  return pool.get(paneId)?.paused ?? false;
}

/** Which renderer a pane currently owns (null = no such pane). */
export function paneTier(paneId: string): PaneTier | null {
  return pool.get(paneId)?.tier ?? null;
}

/** Cumulative PTY bytes seen by a pane — deltas between samples give an
 *  activity rate without touching the terminal buffer. */
export function outputBytes(paneId: string): number {
  return pool.get(paneId)?.bytesSeen ?? 0;
}

/** Bytes discarded by the MAX_PENDING guard for a pane. Non-zero means this
 *  pane's buffer has holes and any summary of it is incomplete — say so. */
export function droppedBytes(paneId: string): number {
  return pool.get(paneId)?.dropped ?? 0;
}

/** Pool-wide counters for the summary GUI and the perf probe. `full` is the
 *  number of live DOM renderers; the whole thesis of the tiering is that it
 *  stays small and flat while `panes` grows. */
export function poolStats(): { panes: number; full: number; headless: number; webgl: number; droppedBytes: number; truncatedHandoffs: number } {
  let full = 0, webgl = 0, dropped = 0;
  for (const e of pool.values()) {
    if (e.tier === "full") full++;
    if (e.webgl) webgl++;
    dropped += e.dropped;
  }
  return { panes: pool.size, full, headless: pool.size - full, webgl, droppedBytes: dropped, truncatedHandoffs };
}

/** Focus a pane's terminal. Also the "the user is looking at THIS one" signal
 *  that moves the single WebGL context. A pane with no renderer (not on screen)
 *  records the focus and picks the context up when it is next mounted. */
export function focusTerminal(paneId: string): void {
  focusedPaneId = paneId;
  applyWebglCap();
  const e = pool.get(paneId);
  if (e?.term instanceof XTerm) e.term.focus();
}

/** Paste text into a pane as if typed — goes through xterm's paste path, so
 *  bracketed-paste mode is honored (a dropped path won't auto-execute). A
 *  background pane has no paste surface, so this is a no-op there. */
export function pasteText(paneId: string, text: string): void {
  const e = pool.get(paneId);
  // Stream panes: their stdin is protocol, not a keyboard. The writeInput guard
  // would eat the bytes anyway; bailing here also skips the focus steal.
  if (!e || !text || !(e.term instanceof XTerm) || isStreamPane(paneId)) return;
  e.term.paste(text);
  e.term.focus();
}

/** Reconcile the pool with the live set of panes: create new, dispose removed.
 *  Provisions a SESSION per pane (headless), not a full renderer — the pane
 *  frame promotes the ones it actually mounts. Signature unchanged (App.tsx). */
export function syncTerminals(panes: ({ id: string } & SpawnPaneOpts)[]): void {
  const ids = new Set(panes.map((p) => p.id));
  for (const p of panes) ensureSession(p.id, p);
  for (const id of [...pool.keys()]) if (!ids.has(id)) disposeTerminal(id);
  scheduleSweep(); // panes mount in their own effects — sweep after this tick
}

// ---- power features --------------------------------------------------------

export function searchInPane(paneId: string, query: string, dir: "next" | "prev"): void {
  const e = pool.get(paneId);
  if (!e?.search || !query) { e?.search?.clearDecorations(); return; }
  if (dir === "next") e.search.findNext(query);
  else e.search.findPrevious(query);
}

export function clearSearch(paneId: string): void {
  pool.get(paneId)?.search?.clearDecorations();
}

export function clearScrollback(paneId: string): void {
  pool.get(paneId)?.term.clear();
}

/** Last `maxLines` lines of a pane's buffer as plain text (trailing blank
 *  lines skipped) — cheap peek at what the pane currently shows. Tier-agnostic:
 *  a headless pane has a real buffer, which is exactly what lets the summary
 *  GUI show every agent without a renderer per agent. */
export function tailText(paneId: string, maxLines = 25): string {
  const e = pool.get(paneId);
  if (!e) return "";
  const buf = e.term.buffer.active;
  const lines: string[] = [];
  for (let i = buf.length - 1; i >= 0 && lines.length < maxLines; i--) {
    const s = buf.getLine(i)?.translateToString(true) ?? "";
    if (lines.length === 0 && !s.trim()) continue;
    lines.unshift(s);
  }
  return lines.join("\n");
}

/** Plain-text dump of a pane's whole buffer (scrollback + screen). */
export function dumpScrollback(paneId: string): string {
  const e = pool.get(paneId);
  if (!e) return "";
  const buf = e.term.buffer.active;
  const lines: string[] = [];
  for (let i = 0; i < buf.length; i++) lines.push(buf.getLine(i)?.translateToString(true) ?? "");
  return lines.join("\n").replace(/\s+$/, "") + "\n";
}

export function setLogging(paneId: string, path: string | null): void {
  const e = pool.get(paneId);
  if (e) e.logPath = path;
}

export function isLogging(paneId: string): boolean {
  return !!pool.get(paneId)?.logPath;
}

/** Restart a pane's shell in place (reruns its startup command). */
export function restartTerminal(paneId: string): void {
  const e = pool.get(paneId);
  if (!e) return;
  restoredPanes.delete(paneId); // explicit restart always reruns the startup command
  const parent = e.el?.parentElement ?? null;
  const opts = e.opts;
  disposeTerminal(paneId);
  if (parent) parent.appendChild(ensureTerminal(paneId, opts));
  else ensureSession(paneId, opts); // background pane: restart it without a renderer
}
