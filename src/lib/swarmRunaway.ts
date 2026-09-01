// Runaway-turn watchdog for swarm panes. A local model served over an
// OpenAI-compatible endpoint (LM Studio, ollama, …) has no turn budget: given a
// short prompt and reasoning enabled it can spiral and generate until it fills
// its context — observed with qwen3.6-35b-a3b burning 20k+ tokens on a bare boot
// turn, ~20 minutes of GPU with zero tool calls. The CLI is happily streaming,
// so the auto-nudge watcher (which needs a quiet pane + an error tail) never
// fires and the pane stays wedged until a human notices.
//
// Detection lives in swarm.ts (scanForRunaways) and is deliberately
// conservative: the pane must be CONTINUOUSLY busy for RUNAWAY_MS *and* its tail
// must be unchanged over that whole window once volatile glyphs are stripped —
// spinners, elapsed timers and token counters normalize away, a long build that
// keeps printing new lines does not. Recovery is what a human would do: abort
// the turn, re-send the role prompt. Then RUNAWAY_RESTART_MAX and stop.
import { useEffect } from "react";
import { brainUrl, ptyWrite } from "./ipc";
import { collectPanes, isTerminal } from "./layout-tree";
import { lastOutputAt, tailText } from "./terminalPool";
import { bootPrompt, interruptKey, paneRole, scanForRunaways, scanForStreamRunaways, type RunawayWatch } from "./swarm";
import { isStreamPane, paneTurnSince, waitForStreamPane } from "./agentStream";
import { compacting, subscribeAgentEvents } from "./agentEvents";
import { injectPromptWaiting } from "./swarmReset";
import { restartTerminal } from "./terminalPool";
import { useLayout } from "../stores/layout";
import { useSwarmTelemetry } from "../stores/swarmTelemetry";

const POLL_MS = 30_000;
const TAIL_LINES = 12;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** What both scans are told to KEEP despite not seeing it this pass: exactly the
 *  panes mid-recovery, never every live id.
 *
 *  A pane is scanned by exactly ONE detector (headless or TUI), and each scan
 *  ends by deleting the ids it did not see, so the union would make each map
 *  refuse to prune the other's entries. That matters because a takeover flips a
 *  live pane from headless to TUI WITHOUT changing its id: its stream entry, and
 *  the `restarts` it already spent, would survive forever unscanned, and a pane
 *  that went headless again could resume at RUNAWAY_RESTART_MAX with the
 *  watchdog silently off and no event to explain it. A recovering pane is kept
 *  for both because during the respawn window `isStreamPane` cannot say which
 *  detector owns it. Exported for the test that pins exactly this. */
export function keepSet(all: readonly { id: string }[], recovering: ReadonlySet<string>): Set<string> {
  return new Set(all.filter((p) => recovering.has(p.id)).map((p) => p.id));
}

export function useSwarmRunaway() {
  useEffect(() => {
    // ONE MAP PER SCANNER. They must not share: each scan ends by deleting every
    // id that is not in ITS OWN live set, so a shared map means each tick wipes
    // the other detector's entries — and since the stream scan runs even when no
    // pane is headless, an empty live set used to delete the whole map, which
    // reset the TUI busy streak every tick and stopped the watchdog firing at
    // all.
    // Separate maps are necessary for `restarts` to accumulate but NOT sufficient:
    // that prune also has to be told about panes deliberately left out of a pass
    // (`keep` below), or a pane's budget resets every time it recovers.
    const state = new Map<string, RunawayWatch>();
    const streamState = new Map<string, RunawayWatch>();
    const recovering = new Set<string>();
    // The compaction signal comes off the agent-event channel, and that channel
    // only polls while something subscribes. The other two watchers subscribe for
    // swarms THEY serve (dispatch on, context resets on) — this one watches every
    // swarm pane there is, so it keeps its own ref-counted subscription or a swarm
    // with both of those switched off would go back to reading a compaction as a
    // runaway. Ref-counted in agentEvents: sharing a poller, not opening a second.
    const events = new Map<string, () => void>();
    const tick = async () => {
      const swarms = useLayout.getState().workspaces.filter((w) => w.swarm);
      const liveProjects = new Set(swarms.map((w) => w.swarm!));
      for (const [project, stop] of [...events]) if (!liveProjects.has(project)) { stop(); events.delete(project); }
      for (const project of liveProjects) if (!events.has(project)) events.set(project, subscribeAgentEvents(project));
      if (swarms.length === 0) { state.clear(); streamState.clear(); return; }
      // Role panes only. A human's own shell in a swarm workspace has role ""
      // and can legitimately run a build forever; scanning it accrued restarts
      // up to the cap for hits that were dropped again below.
      const all = swarms.flatMap((ws) =>
        collectPanes(ws.root)
          .filter((p) => isTerminal(p) && !!paneRole(p))
          .map((p) => ({
            id: p.id,
            // TYPED role, not the title: a renamed pane used to be re-briefed
            // with a bogus role name (brain-findings 1.4). "" = not an agent
            // pane, and the recovery paths below skip it.
            role: paneRole(p),
            project: ws.swarm!,
            ws: ws.id,
            command: p.startupCommand ?? p.pendingCommand ?? "",
          })),
      );
      // A pane mid-recovery is excluded from the SCAN (its turn is being aborted
      // and re-briefed, so a busy streak means nothing) but not from the MIRROR:
      // skipping it would freeze its "runaway due" cell at the pre-recovery value
      // for the whole recovery. Report it with no streak instead.
      // It is passed to the scans as `keep` (below) for a third reason: a recovery outlasts
      // a poll (abort, up to 30 s for the respawn, 3 s settle, then a turn slot),
      // so without it every scan in between pruned the pane's entry as "gone" and
      // its `restarts` came back 0. RUNAWAY_RESTART_MAX therefore never capped a
      // real restart loop — the only panes that reached the cap were ones that hit
      // it twice inside one poll. See the note on scanForRunaways.
      const panes = all.filter((p) => !recovering.has(p.id));
      const keep = keepSet(all, recovering); // recovering panes ONLY — see keepSet
      // COMPACTING panes are scanned but PAUSED. A CLI summarising its own context
      // is busy for minutes with a frozen screen and an open turn — the exact
      // signature this watchdog hunts — and aborting it costs the agent its turn,
      // its compaction and one of the two restarts a human is meant to be told
      // about. They stay in `panes` (so the prune still sees them live) and the
      // scans hold their streak at zero for as long as it lasts.
      const paused = new Set(panes.filter((p) => compacting(p.project, p.role)).map((p) => p.id));
      // Two detectors, one state map each (see above). A headless pane has no
      // tail worth comparing — its output is JSON objects, and a spiralling agent emits
      // plenty of new ones — but it does report exactly when its turn began and
      // ended, so its runaway test is simply "this turn has been open too long".
      const now = Date.now();
      const hits = [
        ...scanForRunaways(panes.filter((p) => !isStreamPane(p.id)), state, now, {
          lastOutput: lastOutputAt,
          tail: (id) => tailText(id, TAIL_LINES),
        }, keep, paused),
        ...scanForStreamRunaways(panes.filter((p) => isStreamPane(p.id)), streamState, now, {
          turnSince: paneTurnSince,
        }, keep, paused),
      ];
      // Mirror the streak bookkeeping for the health strip: `since` gives the
      // countdown to RUNAWAY_MS, `restarts` the N/RUNAWAY_RESTART_MAX budget.
      const tele = useSwarmTelemetry.getState();
      for (const pane of all) {
        if (!pane.role) continue;
        const w = state.get(pane.id) ?? streamState.get(pane.id); // whichever detector owns it
        // A compacting pane shows no countdown either — it is not accruing one.
        const busyStreak = recovering.has(pane.id) || paused.has(pane.id) ? null : w?.since ?? null;
        tele.reportRunaway(pane.ws, pane.role, { since: busyStreak, restarts: w?.restarts ?? 0, compacting: paused.has(pane.id) });
      }
      if (hits.length === 0) return;
      let url = "";
      try { url = await brainUrl(); } catch { return; }
      if (!url) return;
      for (const pane of hits) {
        if (!pane.role) continue; // not a role pane — nothing to re-brief it with
        recovering.add(pane.id);
        (async () => {
          try {
            if (isStreamPane(pane.id)) {
              // A piped child has no input box and no key to press: ESC is a
              // byte on stdin that a JSON reader discards. The abort IS the
              // signal — restartTerminal closes the pane, which kill_tree's the
              // whole process group, and the respawn comes up on a new session.
              restartTerminal(pane.id);
              // The respawn is asynchronous, and a write before the host has
              // the new session open is dropped without a word.
              await waitForStreamPane(pane.id, 30_000);
            } else {
              await ptyWrite(pane.id, interruptKey(pane.command)); // abort the spiralling turn
            }
            await sleep(3000); // let the TUI drop back to its input box (or the new CLI come up)
            // Re-brief through the app-global turn funnel — a restart is a full
            // turn and used to bypass the budget entirely. The waiting variant:
            // the spiralling turn has already been aborted, so a pane dropped at
            // the cap would sit with no prompt until the NEXT runaway, i.e.
            // never. Wait for a slot instead.
            await injectPromptWaiting(pane.project, pane.id, pane.role, bootPrompt(pane.project, url, pane.role), 30_000);
          } catch { /* pane gone or pty write failed — the streak already reset */ }
          recovering.delete(pane.id);
        })();
      }
    };
    const t = setInterval(tick, POLL_MS);
    void tick(); // subscribe to the event channel now, not one poll from now
    return () => {
      clearInterval(t);
      for (const stop of events.values()) stop();
      events.clear();
    };
  }, []);
}
