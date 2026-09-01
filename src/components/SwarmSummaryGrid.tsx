// Swarm summary GUI (for-swarm.md part 2) — one card per agent instead of one
// live terminal per agent. This is the surface that makes the headless render
// tier worth having: while the grid is up, LayoutView is UNMOUNTED, so every
// pane's div is detached, terminalPool's sweep demotes them all to
// @xterm/headless, and the app pays ZERO renderers for N agents. Clicking a card
// focuses that pane and closes the grid, which mounts exactly one full terminal.
//
// Every field comes from an existing API — nothing here re-derives agent state:
//   tailText(paneId, n)   — last lines of the buffer, tier-agnostic (headless
//                           panes have a real buffer, which is the whole trick).
//                           For a PIPED pane that buffer is stream-json, so the
//                           preview comes from its transcript instead (paneTail)
//                           — the overview is where raw JSON is least readable.
//   healthOf/ageLabel/HEALTH_COLOR — SwarmHealthStrip's rules, imported not
//                           forked, so a chip and its card always agree
//   isPaused(paneId)      — the pane is out-running the GUI and its PTY is
//                           currently paused (backpressure)
//   droppedBytes(paneId)  — bytes the MAX_PENDING guard threw away: the preview
//                           has HOLES and must say so
//   outputBytes(paneId)   — cumulative bytes; deltas between samples = the rate
//                           behind each card's sparkline
//   paneTier(paneId)      — headless / full, so the tiering is visible
//   gaveUp(telemetry)     — both recovery watchers spent their budget: only a
//                           human can move that pane
//
// COST RULES (the grid must not re-introduce the per-agent frame cost it exists
// to remove):
//   * ONE setInterval at SAMPLE_MS for the whole grid — a timer, never
//     requestAnimationFrame. rAF ties the summary to the paint loop, which is
//     exactly the coupling we are trying to break, and it keeps running work
//     queued every frame while nothing on a card can change that fast.
//   * The grid is now the DEFAULT view of a launched swarm (SwarmDialog.launch
//     calls openSwarmSummary(true)), so this timer runs while people are simply
//     WATCHING, not only while they poke at a summary. Three rules keep that
//     from costing anything:
//       - hidden window = no sampling at all (visibilitychange stops the timer),
//       - a pane whose byte counter has not moved is not re-read: tailText is
//         the expensive call (translateToString over N buffer lines) and a
//         silent pane's buffer cannot have changed. A headless pane rendering
//         its transcript is gated the same way on that transcript's version
//         counter — the equivalent "could this possibly have changed" answer for
//         the structured reader,
//       - a pane whose card is off-screen is not tailed either; the virtualizer
//         already refuses to render it. It is refetched the tick after it
//         scrolls in (`staleTail`), never left showing another pane's text.
//     Cards that did not change keep their previous OBJECT IDENTITY, and Card is
//     React.memo'd, so one busy agent re-renders one card instead of forty. When
//     nothing changed at all the setCards call is skipped outright.
//   * Sparklines are plain SVG polylines over a small ring of samples; no chart
//     library, no per-frame redraw.
//   * The card list is VIRTUALIZED (fixed row height, spacer divs): a 40-agent
//     swarm renders the ~10 cards on screen, not 40.
// NOTHING IS SILENTLY BOUNDED: dropped bytes, truncated tier handoffs and
// off-screen cards are all surfaced in the header, because a summary that
// quietly omits the agent that is on fire reads as "all agents fine".
import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { brainTasks, type SwarmTask } from "../lib/ipc";
import { collectPanes, groupOfPane, isTerminal, type Pane } from "../lib/layout-tree";
import { droppedBytes, isPaused, lastOutputAt, outputBytes, paneTier, poolStats, tailText, type PaneTier } from "../lib/terminalPool";
import { isRolePane, paneRole } from "../lib/swarm";
import { subscribeAgentEvents } from "../lib/agentEvents";
import { hookTurn } from "../lib/swarmDispatch";
import { isStreamPane } from "../lib/agentStream";
import { transcriptOf, transcriptTail } from "./panes/agentTranscript";
import { useLayout, activeWorkspace } from "../stores/layout";
import { gaveUp, paneTelemetry } from "../stores/swarmTelemetry";
import { HEALTH_COLOR, ageLabel, healthOf, type Health } from "./SwarmHealthStrip";

// 3.3 Hz. Fast enough that a card feels live, slow enough that the grid is not
// the thing burning the main thread (for-swarm.md asks for 2–4 Hz, timer-based).
const SAMPLE_MS = 300;
// Task-bus state moves at human speed and costs an IPC round trip; it does not
// need the card cadence.
const TASK_MS = 2000;

const TAIL_LINES = 8;      // preview lines per card
const SPARK_SAMPLES = 40;  // ring length: 40 × 300ms = the last 12 seconds
const CARD_MIN_W = 300;    // px; drives the column count
const ROW_H = 188;         // px; fixed so the list can be virtualized by row
const OVERSCAN = 1;        // rows rendered above/below the viewport

const ACTIVE_STATUS = new Set(["claimed", "changes", "open", "blocked"]);

type PoolStats = ReturnType<typeof poolStats>;

/** setInterval that stops while the window is hidden. Sampling a grid nobody
 *  can see is pure waste, and the grid is now the default view — a minimized
 *  PixelMarch would otherwise sample every 300ms all night. The callback fires
 *  once on becoming visible again so the cards are current, not 300ms late. */
function useVisibleInterval(fn: () => void, ms: number, active: boolean) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    if (!active) return;
    let timer: ReturnType<typeof setInterval> | null = null;
    const hidden = () => typeof document !== "undefined" && document.visibilityState === "hidden";
    const stop = () => { if (timer !== null) { clearInterval(timer); timer = null; } };
    const start = () => { if (timer === null) timer = setInterval(() => ref.current(), ms); };
    const sync = () => { if (hidden()) stop(); else { ref.current(); start(); } };
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => { stop(); document.removeEventListener("visibilitychange", sync); };
  }, [ms, active]);
}

export interface CardData {
  paneId: string;
  role: string;
  title: string;
  state: Health;
  age: number;
  tier: PaneTier | null;
  paused: boolean;
  dropped: number;
  rate: number; // bytes/sec since the previous sample
  spark: number[];
  tail: string;
  task: string;    // "task-3 (claimed)" or ""
  wedged: string;  // gaveUp() reason, "" if not wedged
}

/** Bytes/sec as a short cell. Sub-1 B/s reads as idle rather than "0.0 KB/s",
 *  which looked like a broken counter on a quiet pane. */
export function formatRate(bytesPerSec: number): string {
  if (!(bytesPerSec > 1)) return "idle";
  if (bytesPerSec < 1024) return `${Math.round(bytesPerSec)} B/s`;
  if (bytesPerSec < 1024 * 1024) return `${(bytesPerSec / 1024).toFixed(1)} KB/s`;
  return `${(bytesPerSec / (1024 * 1024)).toFixed(1)} MB/s`;
}

/** Short byte count for the dropped-bytes badge. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Ring push, capped at SPARK_SAMPLES — the sparkline never grows without
 *  bound no matter how long the grid stays open. */
export function pushSample(history: number[], value: number, max = SPARK_SAMPLES): number[] {
  const out = history.length >= max ? history.slice(history.length - max + 1) : history.slice();
  out.push(value);
  return out;
}

/** Ring push that FREEZES once the whole window is silent: an idle pane would
 *  otherwise allocate a fresh 40-number array 3.3× a second forever and break
 *  its card's memo every tick for a line that is already flat at zero. A ring
 *  still holding a spike keeps scrolling, so an old burst walks off the left
 *  edge exactly as before — only the all-zero steady state stops moving. */
export function nextSpark(history: number[], value: number, max = SPARK_SAMPLES): number[] {
  if (value === 0 && history.length > 0 && history.every((v) => v === 0)) return history;
  return pushSample(history, value, max);
}

/** Is this card visually identical to the previous tick's? `age` is compared
 *  through ageLabel because that is all a card SHOWS of it — raw milliseconds
 *  differ every tick and would defeat the memo on every card at once. */
export function sameCard(a: CardData, b: CardData): boolean {
  return a.paneId === b.paneId && a.role === b.role && a.title === b.title
    && a.state === b.state && ageLabel(a.age) === ageLabel(b.age)
    && a.tier === b.tier && a.paused === b.paused && a.dropped === b.dropped
    && formatRate(a.rate) === formatRate(b.rate) && a.spark === b.spark
    && a.tail === b.tail && a.task === b.task && a.wedged === b.wedged;
}

/** Pool counters, compared by value: poolStats() allocates a fresh object every
 *  call, so a plain setStats would re-render the header once a tick forever. */
export function sameStats(a: PoolStats, b: PoolStats): boolean {
  return a.panes === b.panes && a.full === b.full && a.headless === b.headless
    && a.webgl === b.webgl && a.droppedBytes === b.droppedBytes
    && a.truncatedHandoffs === b.truncatedHandoffs;
}

/** SVG polyline points for a rate history, scaled to its own peak (each card's
 *  sparkline shows ITS shape; a global scale would flatten every quiet agent to
 *  a dead line the moment one agent floods). */
export function sparkPoints(history: number[], w: number, h: number): string {
  if (history.length < 2) return "";
  const peak = Math.max(...history, 1);
  const step = w / (history.length - 1);
  return history
    .map((v, i) => `${(i * step).toFixed(1)},${(h - (v / peak) * h).toFixed(1)}`)
    .join(" ");
}

/** Columns that fit `width`. At least 1 — a narrow window shows a single
 *  column rather than clipping cards. */
export function gridColumns(width: number): number {
  return Math.max(1, Math.floor(width / CARD_MIN_W));
}

/** Which card indices to actually render for a scroll position. Everything
 *  outside is replaced by spacer height, so a 40-agent swarm mounts ~10 cards. */
export function visibleRange(
  count: number, columns: number, scrollTop: number, viewportH: number, rowH = ROW_H, overscan = OVERSCAN,
): { start: number; end: number; topPad: number; bottomPad: number; rows: number } {
  const rows = Math.ceil(count / Math.max(1, columns));
  const firstRow = Math.max(0, Math.floor(scrollTop / rowH) - overscan);
  const lastRow = Math.min(rows, Math.ceil((scrollTop + Math.max(viewportH, rowH)) / rowH) + overscan);
  const start = firstRow * columns;
  const end = Math.min(count, lastRow * columns);
  return { start, end, topPad: firstRow * rowH, bottomPad: Math.max(0, (rows - lastRow) * rowH), rows };
}

/** The header's honesty line: everything this view is bounding or missing.
 *  Empty string = nothing is being hidden. */
export function truncationNote(o: {
  cards: number; rendered: number; droppedPanes: number; droppedTotal: number; truncatedHandoffs: number;
}): string {
  const parts: string[] = [];
  if (o.droppedPanes > 0) {
    parts.push(`${o.droppedPanes} pane${o.droppedPanes > 1 ? "s" : ""} dropped ${formatBytes(o.droppedTotal)} of output (previews have gaps)`);
  }
  if (o.truncatedHandoffs > 0) parts.push(`${o.truncatedHandoffs} scrollback handoff${o.truncatedHandoffs > 1 ? "s" : ""} truncated`);
  if (o.rendered < o.cards) parts.push(`showing ${o.rendered} of ${o.cards} cards — scroll for the rest`);
  return parts.join(" · ");
}

// ---- sampling ---------------------------------------------------------------

/** One card's preview text. A HEADLESS worker's buffer holds line-delimited
 *  stream-json, so tailing it put raw JSON on the one surface a human watches a
 *  whole swarm on — the pane view was made readable in Phase C5 and the OVERVIEW
 *  was left serialised, which is the half people look at more. Its transcript is
 *  captured from spawn (agentTranscript.startTranscriptCapture), so this is a
 *  Map lookup, not a second parse.
 *
 *  Falls back to the raw tail when there is no transcript yet: a pane that has
 *  printed only unparseable bytes still has something to show, and a blank card
 *  reads as a dead agent. */
function paneTail(paneId: string, lines: number): string {
  if (isStreamPane(paneId)) {
    const t = transcriptTail(paneId, lines);
    if (t) return t;
  }
  return tailText(paneId, lines);
}

interface Sample { bytes: number; ver: number; at: number; spark: number[]; tail: string; staleTail: boolean; card: CardData }

/** Build one tick's worth of card data. Pure apart from the pool reads, and the
 *  sample map it mutates is the caller's ring state.
 *
 *  `onScreen(paneId, index)` says whether the virtualizer is actually rendering
 *  that card right now; a false answer skips tailText for that pane (the single
 *  most expensive read here) and keeps the last preview it had. Cards that came
 *  out identical to the previous tick are returned as the SAME object, and
 *  `changed` is false when every one of them did, so the caller can skip
 *  setCards entirely. */
export function sampleCards(
  panes: Pane[], samples: Map<string, Sample>, tasks: Map<string, SwarmTask>, wsId: string, now: number,
  onScreen: (paneId: string, index: number) => boolean = () => true,
  project = "", // swarm name — empty means "no hook channel", i.e. the PTY-quiet rules alone
): { cards: CardData[]; changed: boolean } {
  const cards: CardData[] = [];
  let changed = panes.length !== samples.size;
  for (let i = 0; i < panes.length; i++) {
    const p = panes[i];
    const role = paneRole(p);
    const bytes = outputBytes(p.id);
    const prev = samples.get(p.id);
    const dt = prev ? Math.max(1, now - prev.at) : 0;
    const rate = prev ? ((bytes - prev.bytes) * 1000) / dt : 0;
    const spark = nextSpark(prev?.spark ?? [], rate);

    // The buffer can only have changed if the byte counter moved. A pane whose
    // preview is stale AND off-screen stays stale until it scrolls back in.
    //
    // A headless pane is gated the SAME way against its transcript's version
    // counter, which is the equivalent "could this possibly have changed" answer
    // for the structured reader: a piped agent moves its byte counter with every
    // frame it prints, including the hook and rate-limit bookkeeping that
    // contributes no row, so gating it on bytes would re-derive the same preview
    // on ticks where nothing a human can see moved. A stream pane with no rows
    // yet is still showing the raw fallback (paneTail), so it stays on bytes.
    const t = isStreamPane(p.id) ? transcriptOf(p.id) : null;
    const ver = t?.version ?? 0;
    const structured = !!t && t.entries.length > 0;
    const grew = !prev || (structured ? ver !== prev.ver : bytes !== prev.bytes);
    const visible = onScreen(p.id, i);
    const wantTail = !prev || (visible && (grew || prev.staleTail));
    const tail = wantTail ? paneTail(p.id, TAIL_LINES) : (prev?.tail ?? "");
    const staleTail = wantTail ? false : (grew || (prev?.staleTail ?? false));

    const task = tasks.get(role);
    const wedged = gaveUp(paneTelemetry(wsId, role)) ?? "";
    const { state, age } = healthOf(p.id, !!task, now, !!wedged, project ? hookTurn(project, p) : undefined);
    const fresh: CardData = {
      paneId: p.id,
      role,
      title: p.title,
      state,
      age: lastOutputAt(p.id) ? age : 0,
      tier: paneTier(p.id),
      paused: isPaused(p.id),
      dropped: droppedBytes(p.id),
      rate,
      spark,
      tail,
      task: task ? `${task.key} (${task.status})` : "",
      wedged,
    };
    // Reuse the previous object when nothing on screen moved: Card is memo'd on
    // identity, so an idle agent costs zero React work.
    const card = prev && sameCard(prev.card, fresh) ? prev.card : fresh;
    if (card !== prev?.card) changed = true;
    samples.set(p.id, { bytes, ver, at: now, spark, tail, staleTail, card });
    cards.push(card);
  }
  // Drop samples for panes that no longer exist, or the map leaks across a long
  // session of workspace churn.
  const live = new Set(panes.map((p) => p.id));
  for (const id of [...samples.keys()]) if (!live.has(id)) { samples.delete(id); changed = true; }
  return { cards, changed };
}

// ---- styles -----------------------------------------------------------------

const bar: CSSProperties = {
  display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap",
  padding: "4px 8px", background: "var(--panel-2)",
  borderBottom: "1px solid var(--border)", fontSize: 10, color: "var(--muted)",
};

const pill: CSSProperties = {
  padding: "1px 5px", border: "1px solid var(--border)", borderRadius: 4, whiteSpace: "nowrap",
};

const toggleBtn: CSSProperties = {
  background: "none", border: "1px solid var(--border)", borderRadius: 4,
  color: "var(--muted)", fontSize: 10, padding: "1px 7px", cursor: "pointer",
};

/** Role panes of the active swarm workspace, or [] when this is not a swarm. */
function useRolePanes(): { project: string | undefined; panes: Pane[]; wsId: string } {
  const workspaces = useLayout((s) => s.workspaces);
  const activeId = useLayout((s) => s.activeId);
  const root = useLayout((s) => activeWorkspace(s).root);
  const project = workspaces.find((w) => w.id === activeId)?.swarm;
  const panes = project ? collectPanes(root).filter(isTerminal).filter(isRolePane) : [];
  return { project, panes, wsId: activeId };
}

/** The thin always-visible bar that opens the grid. Lives under the health
 *  strip; renders nothing outside a swarm workspace. Also the place the pool's
 *  tier counters are visible without opening anything — `full` staying at 1
 *  while `panes` grows IS the headless tier working. */
export function SwarmSummaryBar() {
  const { project, panes } = useRolePanes();
  const open = useLayout((s) => s.swarmSummaryOpen);
  const openSummary = useLayout((s) => s.openSwarmSummary);
  const [stats, setStats] = useState<PoolStats>(() => poolStats());

  // Counters only; keep the previous object when they have not moved so the bar
  // does not re-render once a second on a quiet swarm.
  useVisibleInterval(() => setStats((s) => { const n = poolStats(); return sameStats(s, n) ? s : n; }), 1000, !!project);

  if (!project || panes.length === 0) return null;
  return (
    <div style={bar}>
      <span style={{ fontWeight: 700, letterSpacing: 0.8 }}>AGENTS</span>
      <span style={pill} title="agent panes in this workspace">{panes.length} panes</span>
      <span
        style={pill}
        title={"live DOM terminals / headless buffers / WebGL contexts\nthe headless tier's whole claim is that `full` stays flat while panes grow"}
      >
        {stats.full} full · {stats.headless} headless · {stats.webgl} webgl
      </span>
      {stats.droppedBytes > 0 && (
        <span style={{ ...pill, color: "#e06c6c" }} title="output discarded by the per-pane memory cap — buffers (and every preview of them) have gaps">
          {formatBytes(stats.droppedBytes)} dropped
        </span>
      )}
      <button
        style={{ ...toggleBtn, marginLeft: "auto", color: open ? "#4c8bf5" : "var(--muted)" }}
        onClick={() => openSummary(!open)}
        title="Summary grid: one card per agent, no live terminals (Esc / click a card to go back)"
      >
        {open ? "▣ terminals" : "▦ summary"}
      </button>
    </div>
  );
}

// ---- the grid ---------------------------------------------------------------

export default function SwarmSummaryGrid() {
  const { project, panes, wsId } = useRolePanes();
  const openSummary = useLayout((s) => s.openSwarmSummary);
  const focusPane = useLayout((s) => s.focusPane);
  const selectTab = useLayout((s) => s.selectTab);
  const root = useLayout((s) => activeWorkspace(s).root);

  const [cards, setCards] = useState<CardData[]>([]);
  const [stats, setStats] = useState<PoolStats>(() => poolStats());
  const [view, setView] = useState({ width: 0, height: 0, scrollTop: 0 });
  const samples = useRef(new Map<string, Sample>());
  const tasks = useRef(new Map<string, SwarmTask>());
  const scroller = useRef<HTMLDivElement | null>(null);
  // What the virtualizer is currently rendering, so the sampler can skip the
  // expensive buffer read for cards nobody can see. Written during render.
  const rendered = useRef({ start: 0, end: 0 });

  // ONE timer for the whole grid (see the cost rules up top). It reads the pool
  // directly — no subscription, no re-render per agent, no rAF. The pane list
  // comes from the last render (useVisibleInterval always calls the freshest
  // callback), so a tick is not a layout-tree walk either: useRolePanes already
  // did that work, driven by the store, only when the tree actually changed.
  useVisibleInterval(() => {
    const now = Date.now();
    const { start, end } = rendered.current;
    const { cards: next, changed } = sampleCards(
      panes, samples.current, tasks.current, wsId, now,
      (_id, i) => i >= start && i < end,
      project ?? "",
    );
    if (changed) setCards(next);
    setStats((s) => { const n = poolStats(); return sameStats(s, n) ? s : n; });
  }, SAMPLE_MS, !!project);

  // Task-bus poll on its own slower cadence; failures keep the last view (the
  // brain is a local process that can restart under us). Hidden window = no IPC
  // round trip either.
  useVisibleInterval(() => {
    if (!project) return;
    void (async () => {
      try {
        const list = await brainTasks(project);
        const byRole = new Map<string, SwarmTask>();
        for (const t of list) {
          if (t.owner && ACTIVE_STATUS.has(t.status) && !byRole.has(t.owner)) byRole.set(t.owner, t);
        }
        tasks.current = byRole;
      } catch { /* brain unavailable — keep what we have */ }
    })();
  }, TASK_MS, !!project);

  // Viewport geometry for the virtualizer.
  const measure = useCallback((el: HTMLDivElement | null) => {
    scroller.current = el;
    if (!el) return;
    setView((v) => ({ ...v, width: el.clientWidth, height: el.clientHeight }));
  }, []);

  // Real turn boundaries for the card state (ref-counted — swarmDispatch usually
  // already holds this subscription). Without it a thinking agent paints nothing
  // and its card reads idle, then stalled.
  useEffect(() => {
    if (!project) return;
    return subscribeAgentEvents(project);
  }, [project]);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setView((v) => ({ ...v, width: el.clientWidth, height: el.clientHeight })));
    ro.observe(el);
    return () => ro.disconnect();
  }, [project]);

  // Stable across ticks, or every memo'd Card would re-render anyway.
  const open = useCallback((paneId: string) => {
    const grp = groupOfPane(root, paneId);
    if (grp) selectTab(grp.id, paneId);
    focusPane(paneId);
    openSummary(false); // mounts LayoutView -> ensureTerminal promotes this pane
  }, [root, selectTab, focusPane, openSummary]);

  // Esc leaves the grid — same reflex as every other overlay in the app.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") openSummary(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openSummary]);

  const columns = gridColumns(view.width || CARD_MIN_W);
  const range = useMemo(
    () => visibleRange(cards.length, columns, view.scrollTop, view.height),
    [cards.length, columns, view.scrollTop, view.height],
  );
  const shown = cards.slice(range.start, range.end);
  rendered.current = { start: range.start, end: range.end };
  const droppedPanes = cards.filter((c) => c.dropped > 0).length;
  const note = truncationNote({
    cards: cards.length,
    rendered: shown.length,
    droppedPanes,
    droppedTotal: cards.reduce((n, c) => n + c.dropped, 0),
    truncatedHandoffs: stats.truncatedHandoffs,
  });

  if (!project) return null;

  return (
    <div style={{ position: "absolute", inset: 6, display: "flex", flexDirection: "column", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 4, overflow: "hidden" }}>
      <div style={{ ...bar, background: "var(--panel)" }}>
        <span style={{ fontWeight: 700, letterSpacing: 0.8, color: "var(--text)" }}>SWARM SUMMARY</span>
        <span style={pill} title="no pane is rendering while this grid is up">{cards.length} agents · {stats.full} live renderer{stats.full === 1 ? "" : "s"}</span>
        {note && <span style={{ ...pill, color: "#e0a86c", borderColor: "#e0a86c" }} title="what this view is bounding — never silent">{note}</span>}
        <span style={{ marginLeft: "auto", opacity: 0.8 }}>click a card to open that terminal · Esc to go back</span>
      </div>
      <div
        ref={measure}
        onScroll={(e) => setView((v) => ({ ...v, scrollTop: e.currentTarget.scrollTop }))}
        style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 8 }}
      >
        {cards.length === 0 && <div style={{ color: "var(--muted)", fontSize: 12 }}>No agent panes in this workspace.</div>}
        <div style={{ height: range.topPad }} />
        <div style={{ display: "grid", gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, gap: 8, alignContent: "start" }}>
          {shown.map((c) => <Card key={c.paneId} c={c} onOpen={open} />)}
        </div>
        <div style={{ height: range.bottomPad }} />
      </div>
    </div>
  );
}

// Memo on card identity: sampleCards hands back the SAME object for a card that
// did not change, so a 40-agent swarm with one busy agent re-renders one card.
const Card = memo(function Card({ c, onOpen }: { c: CardData; onOpen: (paneId: string) => void }) {
  const color = HEALTH_COLOR[c.state];
  const title = [
    `${c.role || c.title}: ${c.state}`,
    c.wedged,
    c.task ? `task ${c.task}` : "no active task",
    `last output ${ageLabel(c.age)} ago`,
    `tier ${c.tier ?? "none"}${c.paused ? " · PTY paused (backpressure)" : ""}`,
    c.dropped > 0 ? `${formatBytes(c.dropped)} of output dropped — this preview has gaps` : "",
  ].filter(Boolean).join("\n");

  return (
    <div
      onClick={() => onOpen(c.paneId)}
      title={title}
      style={{
        height: ROW_H - 8, boxSizing: "border-box", display: "flex", flexDirection: "column", gap: 4,
        border: `1px solid ${c.wedged ? "#ff8a3d" : "var(--border)"}`, borderLeft: `3px solid ${color}`,
        borderRadius: 6, padding: "6px 8px", background: "var(--panel)", cursor: "pointer", overflow: "hidden",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{ width: 7, height: 7, borderRadius: "50%", background: color, flex: "0 0 auto" }} />
        <span style={{ fontSize: 12, fontWeight: 700, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {c.role || c.title}
        </span>
        <span style={{ fontSize: 9, fontWeight: 700, color, textTransform: "uppercase", letterSpacing: 0.4 }}>{c.state}</span>
        <span style={{ marginLeft: "auto", fontSize: 10, color: "var(--muted)" }}>{ageLabel(c.age)}</span>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 9, color: "var(--muted)", flexWrap: "nowrap", overflow: "hidden" }}>
        {c.task && <span style={{ ...pill, color: "var(--text)" }}>{c.task}</span>}
        <span style={{ ...pill, opacity: c.tier === "full" ? 1 : 0.7 }}>{c.tier ?? "—"}</span>
        <span style={pill}>{formatRate(c.rate)}</span>
        {c.paused && <span style={{ ...pill, color: "#e0a86c", borderColor: "#e0a86c" }} title="the agent is out-running the GUI — its PTY is paused until we drain">paused</span>}
        {c.dropped > 0 && <span style={{ ...pill, color: "#e06c6c", borderColor: "#e06c6c" }}>gaps {formatBytes(c.dropped)}</span>}
        <svg viewBox="0 0 60 14" preserveAspectRatio="none" style={{ marginLeft: "auto", width: 60, height: 14, flex: "0 0 auto" }}>
          <polyline points={sparkPoints(c.spark, 60, 14)} fill="none" stroke={color} strokeWidth={1} vectorEffect="non-scaling-stroke" />
        </svg>
      </div>

      {c.wedged && (
        <div style={{ fontSize: 9, color: "#ff8a3d", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          NEEDS A HUMAN — {c.wedged}
        </div>
      )}

      <pre
        style={{
          flex: 1, minHeight: 0, margin: 0, overflow: "hidden", whiteSpace: "pre",
          fontSize: 9, lineHeight: 1.25, color: "var(--muted)", background: "var(--panel-2)",
          borderRadius: 4, padding: "3px 5px",
        }}
      >
        {c.tail || "(no output yet)"}
      </pre>
    </div>
  );
});
