// Auto-nudge stalled swarm panes. A transient API failure (529 Overloaded,
// rate limit, 5xx) aborts an agent CLI's turn mid-work: the session and its
// context survive, but nothing resumes it — the pane just sits at the error.
// This watcher scans every swarm pane; when one is output-quiet with an API
// error at the bottom of its buffer, it types "continue" (exactly the manual
// recovery). Guard rails against nudge loops: a pane must be quiet for
// NUDGE_IDLE_MS, nudges are COOLDOWN_MS apart, and after NUDGE_MAX tries in
// one error episode the pane is left alone until its tail stops matching
// (episode state clears the moment the error scrolls away), and a pane whose own
// lifecycle hooks say it is mid-turn is never nudged at all.
import { useEffect } from "react";
import { collectPanes, isTerminal } from "./layout-tree";
import { lastOutputAt, tailText } from "./terminalPool";
import { NUDGE_COOLDOWN_MS, NUDGE_ERROR_RE, NUDGE_IDLE_MS, NUDGE_MAX, nudgeText, paneRole } from "./swarm";
import { injectPrompt } from "./swarmReset";
import { isStreamPane, paneTurnActive, streamErrorActive } from "./agentStream";
import { subscribeAgentEvents } from "./agentEvents";
import { hookTurn } from "./swarmDispatch";
import { useLayout } from "../stores/layout";
import { useSwarmTelemetry } from "../stores/swarmTelemetry";

const POLL_MS = 10_000;
const TAIL_LINES = 20;

/** One nudge episode: when the last nudge was sent and how many this episode has
 *  spent. Absent = no episode running for that pane. */
export interface NudgeEpisode { at: number; count: number }

/** What the watcher should do with one pane this tick.
 *   clear — no API error on screen any more; the episode is over
 *   skip  — leave the pane alone, and leave its episode exactly as it is
 *   nudge — quiet, erroring, off cooldown, under the cap: type "continue" */
export type NudgeAction = "clear" | "skip" | "nudge";

/** The whole nudge policy as a pure function, so every rule below is testable
 *  without a PTY, a store or a React effect. The effect keeps only what is not
 *  policy: reading the pane, the in-flight guard, and the injectPrompt rollback.
 *
 *  `turn` is the agent's OWN answer to "am I mid-turn?" (swarmDispatch.hookTurn),
 *  or undefined for a CLI with no hooks — in which case every rule here is
 *  exactly what it was before hooks existed. */
export function nudgeAction(input: {
  tail: string;
  /** Stream panes only: the parsed error channel's answer to "is the pane
   *  sitting at an error?" (agentStream.streamErrorActive). Their tail is a raw
   *  JSON buffer, so the regex over it would fire (or stay silent) by accident.
   *  Omitted = TUI pane, decided by NUDGE_ERROR_RE over the tail as always. */
  erroring?: boolean;
  lastOutput: number;
  turn: boolean | undefined;
  episode: NudgeEpisode | undefined;
  now: number;
}): NudgeAction {
  const { tail, erroring, lastOutput, turn, episode, now } = input;
  // The error scrolling away is the ONLY thing that ends an episode — that is
  // what lets a pane be nudged again for the next, unrelated failure. (For a
  // stream pane "scrolled away" is a successful turn-end after the error.)
  if (!(erroring ?? NUDGE_ERROR_RE.test(tail))) return "clear";
  if (!lastOutput || now - lastOutput < NUDGE_IDLE_MS) return "skip"; // mid-turn or never spoke
  // PTY silence is not proof the turn is over. An agent that hit the error,
  // recovered on its own and is now THINKING paints nothing while the error it
  // already survived is still on screen — quiet + matching tail, and the nudge
  // types "continue" into a live turn.
  if (turn === true) return "skip";
  if (episode && (episode.count >= NUDGE_MAX || now - episode.at < NUDGE_COOLDOWN_MS)) return "skip";
  return "nudge";
}

export function useSwarmNudge() {
  useEffect(() => {
    const episodes = new Map<string, { at: number; count: number }>(); // paneId → nudge state
    const nudging = new Set<string>();
    const events = new Map<string, () => void>(); // swarm project → agent-event unsubscribe
    const tick = () => {
      const swarms = useLayout.getState().workspaces.filter((w) => w.swarm);
      const live = new Set<string>();
      const tele = useSwarmTelemetry.getState();
      // Keep an agent-event subscription per swarm project, or `hookTurn` above
      // has nothing to read whenever host dispatch is off (it is the only other
      // subscriber on this path). Ref-counted, so when dispatch IS on this costs
      // no extra poller.
      const projects = new Set(swarms.map((w) => w.swarm!));
      for (const p of projects) if (!events.has(p)) events.set(p, subscribeAgentEvents(p));
      for (const [p, off] of [...events]) if (!projects.has(p)) { off(); events.delete(p); }
      for (const ws of swarms) {
        for (const pane of collectPanes(ws.root).filter(isTerminal)) {
          live.add(pane.id);
          // Only role panes get mirrored: a human's shell split into a swarm
          // workspace has no role row in the health strip, so reporting it would
          // add a "<workspace>/<title>" entry nothing ever reads. It is still
          // nudged — an API error stalls a plain CLI pane just the same.
          const role = paneRole(pane);
          const mirror = role ? tele : null;
          // Every branch below mirrors the episode into the telemetry store so the
          // health strip can show "next nudge in Xs" / "2/3 used". The Map here
          // stays authoritative; the store is a copy.
          const ep = episodes.get(pane.id);
          // A stream pane has no screen: its tail is a raw JSON buffer, so both
          // questions the policy asks are answered from the parsed stream —
          // "erroring?" by streamErrorActive and "mid-turn?" by the pane's own
          // turn boundary (falling back to the role's hook channel). TUI panes
          // keep the exact tail-regex path they always had.
          const stream = isStreamPane(pane.id);
          const action = nudgeAction({
            tail: stream ? "" : tailText(pane.id, TAIL_LINES),
            erroring: stream ? streamErrorActive(pane.id) : undefined,
            lastOutput: lastOutputAt(pane.id),
            turn: (stream ? paneTurnActive(pane.id) : undefined) ?? hookTurn(ws.swarm!, pane),
            episode: ep,
            now: Date.now(),
          });
          if (action === "clear") {
            episodes.delete(pane.id);
            mirror?.reportNudge(ws.id, role, null); // error scrolled away — episode over
            continue;
          }
          // A skip leaves the episode untouched on purpose: nothing was sent, so
          // it must not spend one of the NUDGE_MAX tries.
          if (action === "skip") continue;
          if (nudging.has(pane.id)) continue; // one in flight — not policy, just concurrency
          nudging.add(pane.id);
          const next = { at: Date.now(), count: (ep?.count ?? 0) + 1 };
          episodes.set(pane.id, next);
          mirror?.reportNudge(ws.id, role, next);
          // The nudge goes through the app-global turn funnel: a "continue"
          // starts a real LLM turn, and firing it beside a live wake was how a
          // cap=1 endpoint ended up serving two completions at once.
          // At the cap nothing was sent, so roll the episode back — this tick
          // must not spend one of the NUDGE_MAX tries.
          injectPrompt(ws.swarm!, pane.id, role || pane.title, nudgeText(role))
            .then((sent) => {
              if (sent) return;
              if (ep) episodes.set(pane.id, ep); else episodes.delete(pane.id);
              mirror?.reportNudge(ws.id, role, ep ?? null);
            })
            .catch(() => {})
            .finally(() => nudging.delete(pane.id));
        }
      }
      for (const id of [...episodes.keys()]) if (!live.has(id)) episodes.delete(id); // pane gone
    };
    const t = setInterval(tick, POLL_MS);
    return () => { clearInterval(t); for (const off of events.values()) off(); events.clear(); };
  }, []);
}
