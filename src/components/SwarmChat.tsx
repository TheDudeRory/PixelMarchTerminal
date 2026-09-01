// Swarm chat bar (swarm.md M4 v1+v2) — shown under the layout when the active
// workspace hosts a swarm. Sending injects the text into the target agent's
// terminal (default coordinator, "@role ..." narrows, "@all" broadcasts to the
// ROLE panes only — see routeDraft/resolveTargets, brain-findings 1.3) AND
// mirrors it as a chat-human-<n> note; the transcript renders every chat-*
// note in the swarm's BigBrain project, so agent replies (chat-<role>-<n>,
// written per their brief) appear without any pty output parsing.
//
// TWO CHANNELS (task-4): the transcript is split into two tabs so the human's
// conversation is never drowned in agent chatter.
//   Coordinator = the durable human<->coordinator channel. It shows the human's
//     own messages and the coordinator's replies addressed "to: human". It is
//     backed entirely by brain notes, so it survives a /clear of every pane —
//     the human overseer works here and assumes NO terminal is visible.
//   Agents = agent<->agent coordination (builder/scout/reviewer/coordinator
//     traffic addressed "to: <role>|all"), kept OUT of the human channel so the
//     coordinator relaying work to builders does not flood the human's tab.
// chatChannel() below is the single classifier; the coordinator's briefs make it
// tag human-facing messages "to: human" and everything else "to: <role>".
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { isStreamPane } from "../lib/agentStream";
import { brainSave, feedNotesByPrefix, subscribeBrainFeed } from "../lib/ipc";
import { collectPanes, isTerminal } from "../lib/layout-tree";
import { isInjectable, isRolePane, paneRole } from "../lib/swarm";
import { injectPrompt } from "../lib/swarmReset";
import { useLayout } from "../stores/layout";

interface ChatMsg {
  key: string;
  sender: string; // "human" | role name
  to?: string; // parsed from human notes
  text: string;
  updated: number;
  n: number;
}

/** A human message waiting on the app-global turn budget. `panes` shrinks as
 *  each target takes a slot, so a retry never re-sends to a pane that already
 *  got it; the chat-human-<n> note is written once the last one lands. `sent`
 *  counts the panes that did land, so a message nothing reached is never
 *  recorded as delivered. */
interface Pending {
  n: number;
  target: string;
  text: string; // the message AS WRITTEN — per-pane folding happens at send time (payloadFor)
  panes: (ChatTarget & { fails: number })[];
  sent: number;
}

/** One pane an "@name" chat message can address. `name` is what the human types
 *  and what the turn budget is charged against; `label` is the pane's cosmetic
 *  title, shown only when it differs from the address. `agent` marks a real
 *  swarm role pane — a broadcast reaches only those. */
interface ChatTarget {
  id: string;
  name: string;
  label: string;
  agent: boolean;
}

/** The panes a chat message can be routed to. The address of an agent pane is
 *  its TYPED `pane.role` (paneRole/isRolePane in lib/swarm), never its title:
 *  titles are cosmetic and renaming a pane used to send an @-addressed message
 *  to the wrong agent — the same title-derived-role bug as brain-findings 1.4.
 *  A pane with no role is the human's own shell in the swarm workspace; it was
 *  addressable by title before, so it keeps the title as its address rather
 *  than silently becoming unreachable.
 *  DEDUPED BY ADDRESS (case-insensitively, first pane wins): two shells titled
 *  "Terminal 1" both matched one @name, so one typed message started two turns
 *  and the budget was charged twice under a single key (brain-findings 1.3). */
export function chatTargets(panes: { id: string; title: string; role?: string }[]): ChatTarget[] {
  const seen = new Set<string>();
  const out: ChatTarget[] = [];
  for (const p of panes) {
    const name = isRolePane(p) ? paneRole(p) : p.title.trim();
    const key = name.toLowerCase();
    if (name === "" || seen.has(key)) continue;
    seen.add(key);
    out.push({ id: p.id, name, label: p.title, agent: isRolePane(p) });
  }
  return out;
}

/** The panes one address actually reaches.
 *  "all" is a ROLE broadcast: a role-less pane is the HUMAN's own shell (a build
 *  tail, a log), and typing a team message into it woke nothing, ate a turn slot
 *  under the shell's cosmetic title, and interrupted whatever the human was
 *  running there. It stays reachable by its own @title, never by a broadcast.
 *  Anything else matches one address, case-insensitively (the addresses are
 *  already deduped by chatTargets, so this is at most one pane). */
export function resolveTargets(targets: ChatTarget[], target: string): ChatTarget[] {
  if (target === "all") return targets.filter((t) => t.agent);
  const want = target.trim().toLowerCase();
  return targets.filter((t) => t.name.toLowerCase() === want);
}

/** Where a typed draft goes. NARROW BY DEFAULT (brain-findings 1.3): a plain
 *  send used to broadcast from the Agents tab, so one line was read into every
 *  pane's next turn — the cost of a message is paid once per reader, and almost
 *  nothing needs every role. A plain line now goes to the coordinator (the role
 *  that routes work) on either tab; a broadcast is opt-in and explicit, "@all".
 *  "@role" narrows to one pane. null = nothing to send. Pure, so a test pins the
 *  routing without a live pane registry. */
export function routeDraft(tab: "coordinator" | "agents", raw: string): { target: string; body: string } | null {
  const text = raw.trim();
  if (!text) return null;
  // The durable human channel always speaks to the coordinator; @-routing is an
  // Agents-tab affordance, so a leading @foo there is kept as message text.
  if (tab === "coordinator") return { target: "coordinator", body: text };
  const at = /^@(\S+)\s+(.+)$/s.exec(text);
  return at ? { target: at[1], body: at[2].trim() } : { target: "coordinator", body: text };
}

/** How a target is named in a message to the human: the address, plus the pane
 *  title when the two differ, so a renamed pane is still findable on screen. */
const targetLabel = (t: ChatTarget) => (t.label && t.label !== t.name ? `${t.name} ("${t.label}")` : t.name);

const QUEUE_RETRY_MS = 1500;
/** A pane whose send keeps throwing is given up on rather than retried forever. */
const MAX_SEND_ATTEMPTS = 3;

/** submitPrompt types straight into a TUI input box, so what reaches it must be
 *  one line of printable ASCII (isInjectable in swarm.ts) — a newline submits a
 *  half-typed prompt and the PTY codepage is not guaranteed to be UTF-8. Human
 *  typing brings newlines, tabs and smart punctuation, so fold those to their
 *  ASCII equivalents rather than refusing the message.
 *  This fold is a TUI-only constraint: a stream (headless) pane's JSON stdin
 *  carries multi-line UTF-8 verbatim, so the flatten is applied PER TARGET at
 *  send time (payloadFor below), never to the message itself — the transcript
 *  and the chat-human note keep exactly what the human wrote. */
export function toInjectable(raw: string): string {
  return raw
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/…/g, "...")
    .replace(/[^\x20-\x7e]/g, " ") // newlines, tabs and anything else non-ASCII
    .replace(/\s+/g, " ") // collapse AFTER stripping, so removals leave no gaps
    .trim();
}

/** What actually goes down a pane's input path: the raw message for a stream
 *  pane (JSON stdin, multi-line UTF-8 is fine), the ASCII fold for a TUI.
 *  "" for a TUI whose fold left nothing typeable — the caller skips that pane
 *  instead of submitting an empty prompt. Injected as a parameter so tests can
 *  pin the split without a live pane registry. */
export function payloadFor(paneId: string, raw: string, isStream: (id: string) => boolean = isStreamPane): string {
  if (isStream(paneId)) return raw;
  const flat = toInjectable(raw);
  return isInjectable(flat) ? flat : "";
}

function parseHit(h: { key: string; value: string; updated: number }): ChatMsg | null {
  const m = /^chat-(.+)-(\d+)$/.exec(h.key);
  if (!m) return null;
  let text = h.value;
  let to: string | undefined;
  // Every chat note may lead with a "to: <role>|all|human|coordinator" routing
  // line — the human's always do, and agents' replies do per their brief. Parse
  // it for ALL senders so the two-channel split can route by recipient, not just
  // by who wrote the note. A note without the line keeps `to` undefined.
  const first = text.indexOf("\n");
  const head = (first < 0 ? text : text.slice(0, first)).trim();
  const t = /^to:\s*(\S+)/i.exec(head);
  if (t) { to = t[1].toLowerCase(); text = first < 0 ? "" : text.slice(first + 1); }
  return { key: h.key, sender: m[1], to, text: text.trim(), updated: h.updated, n: Number(m[2]) };
}

/** Which chat tab a message belongs to. The Coordinator tab is the durable
 *  human<->coordinator axis ONLY: the human's own messages (which default to the
 *  coordinator) and the coordinator's replies addressed back "to: human".
 *  Everything else — the coordinator relaying work to builders, builder/scout/
 *  reviewer cross-talk, broadcasts — is agent chatter. An untagged coordinator
 *  note falls to Agents on purpose, so a coordinator that forgets "to: human"
 *  cannot flood the human channel. Pure + exported so a test pins the routing. */
export function chatChannel(m: { sender: string; to?: string }): "coordinator" | "agents" {
  if (m.sender === "human") return m.to === undefined || m.to === "coordinator" ? "coordinator" : "agents";
  if (m.sender === "coordinator" && m.to === "human") return "coordinator";
  return "agents";
}

// ── Structured questions (submit-answers) ──────────────────────────────────
// The coordinator can ask the human a structured question IN THE PROGRAM instead
// of on a terminal the human never watches, so it survives a /clear like the rest
// of the durable channel. It posts a note "ask-<n>" and the Coordinator tab renders
// it as a form; the human's reply is written back as note "ask-answer-<n>", which
// both marks the ask consumed (the form stops rendering) and lets the coordinator
// read the choice. No Rust change — it is all ordinary brain notes.

/** A pending structured question parsed from an "ask-<n>" note. */
export interface Ask {
  key: string;
  n: number;
  question: string;
  options: string[];
  free: boolean; // a free-text answer box is offered
  updated: number;
}

/** Parse a coordinator "ask-<n>" note, or null if it is not a well-formed ask.
 *  Body is one directive per line:
 *    ask: <question>   (required — the prompt shown to the human)
 *    option: <text>    (zero or more clickable choices)
 *    free: 1           (offer a free-text box; any value but 0/false/no enables it)
 *  With no options we force the free-text box on, so an ask is always answerable. */
export function parseAsk(h: { key: string; value: string; updated: number }): Ask | null {
  const m = /^ask-(\d+)$/.exec(h.key);
  if (!m) return null;
  let question = "";
  const options: string[] = [];
  let free = false;
  for (const raw of h.value.split("\n")) {
    const line = raw.trim();
    let mm: RegExpExecArray | null;
    if ((mm = /^ask:\s*(.*)$/i.exec(line))) { if (!question) question = mm[1].trim(); }
    else if ((mm = /^option:\s*(.+)$/i.exec(line))) { const o = mm[1].trim(); if (o) options.push(o); }
    else if ((mm = /^free:\s*(.*)$/i.exec(line))) { const v = mm[1].trim().toLowerCase(); free = v !== "0" && v !== "false" && v !== "no"; }
  }
  if (!question) return null;
  if (options.length === 0) free = true;
  return { key: h.key, n: Number(m[1]), question, options, free, updated: h.updated };
}

/** The human-readable answer parsed from an "ask-answer-<n>" note, for showing the
 *  reply back once an ask is consumed. Falls back to the raw body if unstructured. */
export function parseAnswer(h: { key: string; value: string }): { n: number; text: string } | null {
  const m = /^ask-answer-(\d+)$/.exec(h.key);
  if (!m) return null;
  const parts: string[] = [];
  for (const raw of h.value.split("\n")) {
    const line = raw.trim();
    let mm: RegExpExecArray | null;
    if ((mm = /^(?:option|text|answer):\s*(.+)$/i.exec(line))) parts.push(mm[1].trim());
  }
  return { n: Number(m[1]), text: parts.join(" — ") || h.value.trim() };
}

/** The chat line an answered ask also sends to the coordinator. Names the ask so the
 *  coordinator can re-read the structured note, and carries the choice inline so the
 *  transcript reads on its own. Exported so a test pins the wording. */
export function askAnswerNudge(n: number, shown: string): string {
  return `answered ask-${n}: ${shown} (full answer in note ask-answer-${n})`;
}

/** The body written back to "ask-answer-<n>" — the chosen option and/or free text,
 *  each on its own labelled line so the coordinator can read either. Empty when the
 *  human supplied neither (the form refuses to submit that). */
export function askAnswerBody(option: string, free: string): string {
  const lines: string[] = [];
  const o = option.trim();
  const f = free.trim();
  if (o) lines.push(`option: ${o}`);
  if (f) lines.push(`text: ${f}`);
  return lines.join("\n");
}

const bar: CSSProperties = { display: "flex", flexDirection: "column", borderTop: "1px solid var(--border)", background: "var(--panel)" };
const field: CSSProperties = { background: "var(--panel-2)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 4, padding: "6px 9px", fontSize: 12.5 };

export default function SwarmChat() {
  const workspaces = useLayout((s) => s.workspaces);
  const activeId = useLayout((s) => s.activeId);
  const addToast = useLayout((s) => s.addToast);
  const missionOpen = useLayout((s) => s.swarmMissionOpen);
  const toggleMission = useLayout((s) => s.toggleSwarmMission);
  const tab = useLayout((s) => s.swarmChatTab);
  const setTab = useLayout((s) => s.setSwarmChatTab);
  const ws = workspaces.find((w) => w.id === activeId);
  const project = ws?.swarm;

  const [msgs, setMsgs] = useState<ChatMsg[]>([]);
  const [draft, setDraft] = useState("");
  const [showLog, setShowLog] = useState(true);
  const nextN = useRef(1);
  const logRef = useRef<HTMLDivElement>(null);
  const queue = useRef<Pending[]>([]);
  const draining = useRef(false);
  const [waiting, setWaiting] = useState(0); // rendered mirror of the queue depth
  // Queued messages are not in the brain yet, so the 2s poll cannot render them.
  // Mirror them separately and append below the polled transcript, otherwise a
  // message sitting on the budget disappears from the log while it waits.
  const [pending, setPending] = useState<ChatMsg[]>([]);
  // Structured questions the coordinator posted (ask-<n> notes), the answers
  // already given (ask-answer-<n>, keyed by n), and the human's per-ask free-text
  // draft. All durable in the brain, so they survive a /clear like the chat.
  const [asks, setAsks] = useState<Ask[]>([]);
  const [answered, setAnswered] = useState<Record<number, string>>({});
  const [askDrafts, setAskDrafts] = useState<Record<number, string>>({});

  // Called only when the queue actually changed — a no-op drain pass must not
  // set state, or the drain effect (keyed on `waiting`) restarts in a tight loop.
  const syncQueue = () => {
    setWaiting(queue.current.reduce((a, q) => a + q.panes.length, 0));
    setPending(queue.current.map((q) => ({
      key: `chat-human-${q.n}`, sender: "human", to: q.target, text: q.text, updated: Date.now() / 1000, n: q.n,
    })));
  };

  // The transcript AND the coordinator's structured questions come off the shared
  // brain feed (lib/ipc), which mirrors the chat-*/ask-* notes for the whole app.
  // This used to be two full-store `brainSearch` scans of its own every 2 s — and
  // swarmDispatch ran a third for the same notes. The feed reads each note's body
  // once, the tick its key appears, so a transcript that has grown to hundreds of
  // messages costs the same as an empty one. A message the human sends shows up
  // without waiting for a tick at all: brainSave folds it into the feed.
  //
  // The "ask" family shares the mirror: the key regexes in parseAsk/parseAnswer
  // drop anything that is not a well-formed ask, exactly as parseHit filters chat.
  useEffect(() => {
    if (!project) return;
    return subscribeBrainFeed(
      project,
      { intervalMs: 2000, hiddenMs: 15_000, tasks: false, prefixes: ["chat-", "ask-"] },
      (feed) => {
        const parsed = feedNotesByPrefix(feed, "chat-").map(parseHit).filter((x): x is ChatMsg => !!x)
          .sort((a, b) => a.updated - b.updated || a.n - b.n);
        setMsgs(parsed);
        // NEVER let the counter go backwards: a queued message's note is only
        // written once it drains, which can be minutes later, so the brain's
        // highest n lags behind the ns already handed out and two queued
        // messages would otherwise share a key and clobber each other.
        const brainMax = Math.max(0, ...parsed.filter((p) => p.sender === "human").map((p) => p.n));
        const queuedMax = Math.max(0, ...queue.current.map((q) => q.n));
        nextN.current = Math.max(nextN.current, brainMax + 1, queuedMax + 1);

        const askNotes = feedNotesByPrefix(feed, "ask-");
        setAsks(askNotes.map(parseAsk).filter((x): x is Ask => !!x).sort((a, b) => a.n - b.n));
        const ans: Record<number, string> = {};
        for (const h of askNotes) { const a = parseAnswer(h); if (a) ans[a.n] = a.text; }
        setAnswered(ans);
      },
    );
  }, [project]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [msgs.length, pending.length, showLog, tab]);

  // Drain the queue: every human message goes through injectPrompt, which takes
  // a slot out of the ONE app-global turn budget and hands it back if the send
  // throws. false = the budget is spent; the message stays queued (and visible
  // as a busy state) instead of being dropped or, as before, starting an
  // uncounted turn on top of the cap.
  useEffect(() => {
    if (!project || waiting === 0) return;
    let dead = false;
    const drain = async () => {
      if (dead || draining.current) return;
      draining.current = true;
      let changed = false;
      // A pane that has no slot left stays blocked for the rest of the pass, so
      // a later message cannot slip into it ahead of an earlier one.
      const blocked = new Set<string>();
      try {
        for (const item of [...queue.current]) {
          const left: Pending["panes"] = [];
          for (const p of item.panes) {
            if (blocked.has(p.id)) { left.push(p); continue; }
            // Per-target payload: raw multi-line text into a stream pane's JSON
            // stdin, the ASCII fold into a TUI. Decided at send time, not
            // enqueue time, so a headless pane mid-restart still gets the raw
            // form once it is registered again.
            const payload = payloadFor(p.id, item.text);
            if (payload === "") {
              addToast(`Message to ${targetLabel(p)} has nothing typeable for a terminal pane — dropped there.`);
              continue;
            }
            try {
              if (await injectPrompt(project, p.id, p.name, payload)) item.sent++;
              else { blocked.add(p.id); left.push(p); }
            } catch (e) {
              // The slot is already released; retry a couple of times, then give
              // up on this pane so the item cannot sit in the queue forever.
              p.fails++;
              if (p.fails < MAX_SEND_ATTEMPTS) left.push(p);
              else addToast(`Chat send to ${targetLabel(p)} failed ${p.fails}x, giving up: ${e}`);
            }
          }
          if (left.length !== item.panes.length) changed = true;
          item.panes = left;
          if (left.length > 0) continue;
          queue.current = queue.current.filter((q) => q !== item);
          changed = true;
          if (item.sent === 0) {
            // Nothing landed anywhere — do not record the message as delivered.
            addToast(`Message to ${item.target} was not delivered to any pane.`);
            continue;
          }
          try {
            await brainSave(project, `chat-human-${item.n}`, `to: ${item.target}\n${item.text}`);
          } catch (e) {
            addToast(`Chat note save failed: ${e}`);
          }
        }
      } finally {
        draining.current = false;
        if (!dead && changed) syncQueue();
      }
    };
    void drain();
    const t = setInterval(drain, QUEUE_RETRY_MS);
    return () => { dead = true; clearInterval(t); };
  }, [project, waiting, addToast]);

  // Switching workspaces abandons the old swarm's queue — its pane ids are gone.
  // Say so, or an undelivered message vanishes with no trace anywhere.
  useEffect(() => {
    return () => {
      const dropped = queue.current.length;
      queue.current = [];
      setWaiting(0);
      setPending([]);
      if (dropped > 0) addToast(`${dropped} queued swarm message(s) dropped — the swarm's panes are gone.`);
    };
  }, [project, addToast]);

  if (!ws || !project) return null;
  // A queued message shows until its note lands; once the poll picks the note up
  // the polled copy wins, so it never renders twice.
  const all = [
    ...msgs.map((m) => ({ m, queued: false })),
    ...pending.filter((p) => !msgs.some((m) => m.key === p.key)).map((m) => ({ m, queued: true })),
  ];
  // Split by channel so each tab is a self-contained conversation, and count the
  // OTHER tab so its header can show it has unseen traffic.
  const shown = all.filter(({ m }) => chatChannel(m) === tab);
  const agentsCount = all.filter(({ m }) => chatChannel(m) === "agents").length;
  const coordCount = all.length - agentsCount;
  // Asks are not chat notes, so they contribute nothing to the tab counts above — a
  // question waiting on the Coordinator tab was completely invisible from the Agents
  // tab. Count the unanswered ones so the tab can say a decision is blocking the swarm.
  const pendingAsks = asks.filter((a) => !(a.n in answered)).length;
  const roles = chatTargets(collectPanes(ws.root).filter(isTerminal));

  /** Queue `body` for every pane `target` addresses and mirror it in the transcript.
   *  Shared by the chat box and the ask form, so an answered question reaches the
   *  coordinator through exactly the same turn-budgeted path a typed message does.
   *  Returns false when nothing could be addressed or nothing typeable survived. */
  function enqueue(target: string, body: string): boolean {
    const targets = resolveTargets(roles, target);
    if (targets.length === 0) { addToast(`No agent "${target}" — roles: ${roles.map((r) => r.name).join(", ")}, all`); return false; }
    // Queue the message AS WRITTEN. Flattening happens per pane at send time
    // (payloadFor): a stream pane takes it verbatim, only a TUI needs the fold.
    // Reject up front only when NO current target could take it — all-TUI and
    // nothing survives the fold.
    const text = body.trim();
    if (targets.every((t) => payloadFor(t.id, text) === "")) { addToast("Nothing typeable in that message — a terminal pane needs printable ASCII."); return false; }
    const n = nextN.current++;
    queue.current = [...queue.current, { n, target, text, sent: 0, panes: targets.map((t) => ({ ...t, fails: 0 })) }];
    syncQueue(); // renders it in the transcript AND wakes the drain effect
    return true;
  }

  function send() {
    const route = routeDraft(tab, draft);
    if (!route) return;
    // Only clear the box once the message is actually queued — a rejected message
    // used to be wiped along with the text the human would have had to retype.
    if (!enqueue(route.target, route.body)) return;
    setDraft("");
    // A plain line typed on the Agents tab is narrow now: it went to the
    // coordinator, so it renders in the OTHER tab. Follow it, or the human's own
    // message looks like it vanished.
    if (tab === "agents" && route.target === "coordinator") setTab("coordinator");
  }

  // Answer a structured question: write ask-answer-<n>, which both records the
  // choice for the coordinator to read and consumes the ask so it stops rendering
  // as an open form. Clicking an option carries any free text typed alongside it.
  //
  // THEN ANNOUNCE IT. The note on its own is inert: the coordinator ends its turn the
  // moment it posts the ask, and nothing in the swarm wakes an agent on an ask-answer
  // note (the host watchers key off the task bus, not brain notes). The first live run
  // of this mechanic answered ask-1 correctly and then sat there — from the human's
  // seat a delivered answer and a broken form look identical, so they retyped it into
  // a terminal. Sending the answer as an ordinary coordinator message fixes both ends:
  // it starts the coordinator's turn through the turn budget, and it lands in the
  // transcript as the human's own visible confirmation that the answer went out.
  async function answerAsk(a: Ask, option: string) {
    if (!project) return;
    const body = askAnswerBody(option, askDrafts[a.n] ?? "");
    if (!body) { addToast("Pick an option or type an answer first."); return; }
    const shown = [option.trim(), (askDrafts[a.n] ?? "").trim()].filter(Boolean).join(" — ");
    setAnswered((prev) => ({ ...prev, [a.n]: shown })); // optimistic — poll confirms
    try {
      await brainSave(project, `ask-answer-${a.n}`, body);
      setAskDrafts((prev) => { const c = { ...prev }; delete c[a.n]; return c; });
    } catch (e) {
      addToast(`Answer save failed: ${e}`);
      setAnswered((prev) => { const c = { ...prev }; delete c[a.n]; return c; });
      return; // nothing was recorded — do not tell the coordinator it was
    }
    // The note is the contract and it is already durable; the nudge is best-effort, so
    // a swarm whose coordinator pane is gone still keeps the answer rather than losing
    // it. enqueue() toasts on that, so the human is not left guessing either.
    enqueue("coordinator", askAnswerNudge(a.n, shown));
  }

  return (
    <div style={bar}>
      <div style={{ display: "flex", gap: 4, padding: "5px 8px 0", alignItems: "center" }}>
        {(["coordinator", "agents"] as const).map((t) => {
          const active = t === tab;
          const other = t === "coordinator" ? coordCount : agentsCount;
          return (
            <button
              key={t}
              onClick={() => setTab(t)}
              title={t === "coordinator" ? "Human <-> coordinator — saved to the swarm, survives /clear" : "Agent <-> agent coordination"}
              style={{
                ...field,
                cursor: "pointer",
                padding: "3px 10px",
                fontSize: 12,
                background: active ? "#2b3a55" : "var(--panel-2)",
                color: active ? "#fff" : "var(--muted)",
                fontWeight: active ? 600 : 400,
              }}
            >
              {t === "coordinator" ? "Coordinator" : "Agents"}
              {!active && other > 0 && (
                <span style={{ marginLeft: 6, fontSize: 10.5, opacity: 0.8 }}>({other})</span>
              )}
              {t === "coordinator" && pendingAsks > 0 && (
                <span
                  title={`${pendingAsks} question(s) waiting for your answer — the swarm is blocked on it`}
                  style={{ marginLeft: 6, fontSize: 10.5, color: "#e0a44c", fontWeight: 700 }}
                >
                  ● {pendingAsks}
                </span>
              )}
            </button>
          );
        })}
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 10.5, color: "var(--muted)", whiteSpace: "nowrap" }}>
          {tab === "coordinator" ? "human ↔ coordinator · survives /clear" : "agent ↔ agent coordination"}
        </span>
      </div>
      {showLog && shown.length > 0 && (
        <div ref={logRef} style={{ maxHeight: 180, overflowY: "auto", padding: "6px 10px", display: "flex", flexDirection: "column", gap: 4 }}>
          {shown.map(({ m, queued }) => (
            <div key={m.key} style={{ fontSize: 12, lineHeight: 1.45, opacity: queued ? 0.65 : 1 }}>
              <span style={{ color: m.sender === "human" ? "#e0a44c" : "#4c8bf5", fontWeight: 600 }}>
                {m.sender === "human" ? `you → ${m.to ?? "coordinator"}` : m.to ? `${m.sender} → ${m.to}` : m.sender}
              </span>
              <span style={{ color: "var(--text)", whiteSpace: "pre-wrap" }}> {m.text}</span>
              {queued && <span title="Queued on the app-global turn budget" style={{ color: "#e0a44c" }}> ⏳</span>}
            </div>
          ))}
        </div>
      )}
      {tab === "coordinator" && asks.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: "6px 10px 0" }}>
          {asks.map((a) => {
            if (a.n in answered) {
              return (
                <div key={a.key} style={{ fontSize: 11.5, lineHeight: 1.4, color: "var(--muted)" }}>
                  <span style={{ color: "#5fbf6a" }}>✓</span> {a.question}
                  {answered[a.n] && <span style={{ color: "var(--text)" }}> — {answered[a.n]}</span>}
                </div>
              );
            }
            return (
              <div key={a.key} style={{ border: "1px solid var(--border)", borderRadius: 6, padding: "8px 10px", background: "var(--panel-2)", display: "flex", flexDirection: "column", gap: 6 }}>
                <div style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text)" }}>
                  <span title="The coordinator is asking — your answer is saved to the swarm and survives /clear" style={{ color: "#4c8bf5", marginRight: 6 }}>?</span>
                  {a.question}
                </div>
                {a.options.length > 0 && (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                    {a.options.map((opt, i) => (
                      <button key={i} onClick={() => answerAsk(a, opt)} style={{ ...field, cursor: "pointer", background: "#2b3a55", color: "#fff", padding: "4px 10px" }}>
                        {opt}
                      </button>
                    ))}
                  </div>
                )}
                {a.free && (
                  <div style={{ display: "flex", gap: 6 }}>
                    <input
                      style={{ ...field, flex: 1 }}
                      placeholder={a.options.length > 0 ? "…or type your own answer" : "Type your answer"}
                      value={askDrafts[a.n] ?? ""}
                      onChange={(e) => setAskDrafts((p) => ({ ...p, [a.n]: e.target.value }))}
                      onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); answerAsk(a, ""); } }}
                    />
                    <button onClick={() => answerAsk(a, "")} style={{ ...field, cursor: "pointer", background: "#2b3a55", color: "#fff" }}>
                      Submit
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      <div style={{ display: "flex", gap: 8, padding: 8, alignItems: "center" }}>
        <button
          title={showLog ? "Hide transcript" : "Show transcript"}
          onClick={() => setShowLog((v) => !v)}
          style={{ background: "transparent", border: "none", color: "var(--muted)", cursor: "pointer", fontSize: 12, padding: "0 2px" }}
        >
          {showLog ? "▾" : "▴"}
        </button>
        <input
          style={{ ...field, flex: 1 }}
          placeholder={tab === "coordinator"
            ? "Message the coordinator — saved to the swarm, survives /clear"
            : `Message agents — @role to reach one (${roles.map((r) => r.name).join(", ")}), @all to broadcast; plain text goes to the coordinator`}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); send(); } }}
        />
        {waiting > 0 && (
          <span
            title="Every prompt typed into a swarm pane is charged against the app-global turn budget. Your message is queued and goes in as soon as a slot frees up."
            style={{ fontSize: 12, color: "#e0a44c", whiteSpace: "nowrap" }}
          >
            ⏳ waiting for a turn slot ({waiting})
          </span>
        )}
        <button onClick={send} style={{ ...field, cursor: "pointer", background: "#2b3a55", color: "#fff" }}>Send</button>
        <button
          onClick={toggleMission}
          title="Mission board — live task status"
          style={{ ...field, cursor: "pointer", background: missionOpen ? "#2b3a55" : "var(--panel-2)", color: missionOpen ? "#fff" : "var(--text)" }}
        >
          Mission
        </button>
      </div>
    </div>
  );
}
