import { beforeEach, describe, expect, it, vi } from "vitest";

// swarmReset pulls in the terminal pool (xterm), whose clipboard addon touches
// `self` at import time — undefined in the node env. Only the two functions the
// injection path calls are needed here.
vi.mock("./terminalPool", () => ({ lastOutputAt: () => 0, restartTerminal: () => {} }));
const writes: { id: string; data: string }[] = [];
let writeFails = false;
vi.mock("./ipc", () => ({
  ptyWrite: (id: string, data: string) => {
    if (writeFails) return Promise.reject(new Error("pane is gone"));
    writes.push({ id, data });
    return Promise.resolve();
  },
  brainDelete: () => Promise.resolve(),
  brainFeedNow: () => undefined,
  brainUrl: () => Promise.resolve(""),
  subscribeBrainFeed: () => () => {},
}));

import {
  AGENT_CAPS, HEADLESS_FLAGS, RUNAWAY_MS, RUNAWAY_RESTART_MAX, canRunHeadless, headlessFlags,
  liveTurns, releaseTurnSlot, scanForRunaways, scanForStreamRunaways, spawnModeFor, swarmPanes, DEFAULT_SWARM,
  type RunawayPane, type RunawayWatch, type SwarmConfig,
} from "./swarm";
import { markStreamPaneOpen, notePromptSent, registerStreamPane, resetStreamPanes, feedStreamOutput, paneTurnSince } from "./agentStream";
import { resetAgentEvents } from "./agentEvents";
import { injectPrompt } from "./swarmReset";

const INIT = `{"type":"system","subtype":"init","session_id":"s1"}`;
const cfg = (over: Partial<SwarmConfig> = {}): SwarmConfig => ({ ...DEFAULT_SWARM, mission: "m", cwd: "", ...over });

beforeEach(() => {
  writes.length = 0;
  writeFails = false;
  resetStreamPanes();
  resetAgentEvents();
  // Hand back anything a previous test left charged, so the app-global cap
  // never decides the outcome here.
  for (const t of liveTurns()) { const [project, title] = t.split("/"); releaseTurnSlot(project, title); }
});

describe("the command line a headless pane actually runs", () => {
  it("carries every flag the CLI refuses to start without", () => {
    // These are not decoration. VERIFIED on claude 2.1.218:
    //  - without --verbose: "When using --print, --output-format=stream-json
    //    requires --verbose" (and --help does not mention it);
    //  - without --input-format stream-json the process reads ONE prompt and
    //    exits, so the pane is a one-shot instead of a conversation.
    const cmd = swarmPanes("p", "http://brain", cfg({ headless: true }))[0].startupCommand!;
    expect(cmd).toContain("-p ");
    expect(cmd).toContain("--verbose");
    expect(cmd).toContain("--input-format stream-json");
    expect(cmd).toContain("--output-format stream-json");
    expect(HEADLESS_FLAGS.claude.split(/\s+/).every((f) => cmd.split(/\s+/).includes(f))).toBe(true);
  });

  it("puts NO prompt on the line, and parks the brief instead", () => {
    // VERIFIED on the same binary: in stream-json input mode a positional prompt
    // is IGNORED — the process sits on stdin and never starts a turn. A pane
    // launched that way looks alive and is permanently unbriefed.
    const pane = swarmPanes("p", "http://brain", cfg({ headless: true }))[0];
    expect(pane.startupCommand).not.toContain("'");
    expect(pane.pendingPrompt).toContain("You are agent coordinator");
  });

  it("never defers a headless worker to a bare shell", () => {
    // pendingCommand is TYPED into a shell, and a piped pane's shell would then
    // own the CLI's stdin instead of us. Lazy start buys nothing here anyway: a
    // headless CLI blocks on stdin and bills nothing until a message arrives.
    const panes = swarmPanes("p", "http://brain", cfg({ headless: true, lazyWorkers: true, hostDispatch: true, builders: 2 }));
    expect(panes.every((p) => !p.pendingCommand && !!p.startupCommand)).toBe(true);
  });

  it("headless is the DEFAULT for capable agents, and the config flag is the opt-out", () => {
    expect(DEFAULT_SWARM.headless).toBe(true);
    const panes = swarmPanes("p", "http://brain", cfg());
    expect(panes.every((p) => spawnModeFor(p.startupCommand ?? "") === "piped")).toBe(true);
    expect(panes.every((p) => !!p.pendingPrompt)).toBe(true);
  });

  it("leaves every pane exactly as it is today when headless is opted out", () => {
    const off = swarmPanes("p", "http://brain", cfg({ headless: false }));
    // A saved config that predates the flag carries no `headless` key at all;
    // swarmPanes reads the flag off the config it is GIVEN, so absent = off,
    // identical to an explicit false.
    const legacy = swarmPanes("p", "http://brain", cfg({ headless: undefined }));
    expect(off.map((p) => p.startupCommand)).toEqual(legacy.map((p) => p.startupCommand));
    expect(off.every((p) => !(p.startupCommand ?? p.pendingCommand ?? "").includes("stream-json"))).toBe(true);
    expect(off.every((p) => !p.pendingPrompt)).toBe(true);
  });

  it("keeps a CLI with no verified headless support on its terminal", () => {
    // opencode et al are `headless: false` because they were not installed where
    // the capability table was checked — absence of evidence, so no claim.
    expect(AGENT_CAPS.opencode.headless).toBe(false);
    expect(canRunHeadless("opencode")).toBe(false);
    expect(headlessFlags("opencode --prompt")).toBe("");
    const opencode = { coordinator: "opencode", builders: ["opencode"], scout: "opencode", reviewer: "opencode", reviewers: ["opencode"] };
    const panes = swarmPanes("p", "http://brain", cfg({ headless: true, agentCmds: opencode }));
    expect(panes.every((p) => !(p.startupCommand ?? p.pendingCommand ?? "").includes("stream-json"))).toBe(true);
    expect(panes.every((p) => !p.pendingPrompt)).toBe(true);
  });
});

describe("how a pane's spawn mode is decided", () => {
  it("is read off the command line the pane will actually run", () => {
    const headless = swarmPanes("p", "http://brain", cfg({ headless: true }))[0].startupCommand!;
    expect(spawnModeFor(headless)).toBe("piped");
    const tui = swarmPanes("p", "http://brain", cfg({ headless: false }))[0].startupCommand!;
    expect(spawnModeFor(tui)).toBe("pty");
  });

  it("says pty for everything that is not provably a stream agent", () => {
    expect(spawnModeFor("")).toBe("pty");
    expect(spawnModeFor("bash")).toBe("pty");
    expect(spawnModeFor("claude")).toBe("pty");
    expect(spawnModeFor("claude -p 'one shot'")).toBe("pty"); // print, but no stream stdin
    expect(spawnModeFor("opencode -p --input-format stream-json")).toBe("pty"); // not capable
    // A substring must not be mistaken for the flag.
    expect(spawnModeFor("claude --print-diff --input-format stream-json")).toBe("pty");
  });
});

describe("delivering a prompt to a headless pane", () => {
  it("does not wait for the agent to look ready — that would deadlock", async () => {
    // VERIFIED on claude 2.1.218: the CLI emits its `system/init` object only
    // AFTER it has read a first message. A send gated on "the agent is ready"
    // would therefore wait forever for a session that is waiting for the send.
    registerStreamPane("pane", "p", "builder-1");
    markStreamPaneOpen("pane");
    await expect(injectPrompt("p", "pane", "builder-1", "first")).resolves.toBe(true);
    expect(writes).toHaveLength(1);
  });

  it("writes ONE stream-json message and nothing else", async () => {
    // No 300 ms pause, no CR, no rescue Enter: those exist because a TUI input
    // box can eat a line, and a JSON reader cannot.
    registerStreamPane("pane", "p", "builder-1");
    markStreamPaneOpen("pane");
    feedStreamOutput("pane", `${INIT}\n`);
    await expect(injectPrompt("p", "pane", "builder-1", "do it")).resolves.toBe(true);
    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0].data)).toEqual({ type: "user", message: { role: "user", content: "do it" } });
    expect(writes[0].data.endsWith("\n")).toBe(true);
  });

  it("still types at a TUI pane the way it always did", async () => {
    await expect(injectPrompt("p", "tui", "builder-1", "do it")).resolves.toBe(true);
    expect(writes.map((w) => w.data)).toEqual(["do it", "\r", "\r"]);
  });

  it("surfaces a write failure instead of retrying quietly, and hands the slot back", async () => {
    registerStreamPane("pane", "p", "builder-1");
    markStreamPaneOpen("pane");
    writeFails = true;
    await expect(injectPrompt("p", "pane", "builder-1", "do it")).rejects.toThrow("pane is gone");
    expect(liveTurns()).toEqual([]); // the turn never started, so nothing is charged
  });

  it("refuses to write to a pane the host has no session for", async () => {
    // A context reset RESTARTS a headless pane, and pty_open resolves
    // asynchronously — write into that window and the host drops the bytes
    // without a word, so the wake looks delivered and the pane sits silent.
    registerStreamPane("pane", "p", "builder-1"); // headless, but not open yet
    await expect(injectPrompt("p", "pane", "builder-1", "do it")).rejects.toThrow(/no open session/);
    expect(writes).toHaveLength(0);
    expect(liveTurns()).toEqual([]);
  });
});

describe("runaway detection without a tail", () => {
  const pane: RunawayPane = { id: "pane", role: "builder-1", project: "p", command: "claude" };
  const turns = (id: string) => paneTurnSince(id);

  it("measures the CLI's own turn, not how long we have been watching", () => {
    registerStreamPane("pane", "p", "builder-1");
    notePromptSent("pane", 1000);
    const state = new Map<string, RunawayWatch>();
    // A watcher that starts late must not grant a wedged pane a fresh window.
    expect(scanForStreamRunaways([pane], state, 1000 + RUNAWAY_MS - 1, { turnSince: turns })).toEqual([]);
    expect(state.get("pane")?.since).toBe(1000);
    expect(scanForStreamRunaways([pane], state, 1000 + RUNAWAY_MS, { turnSince: turns })).toEqual([pane]);
  });

  it("is not fooled by a quiet turn or by a chatty one", () => {
    // The TUI scan needs a FROZEN tail; a headless agent that spirals emits new
    // JSON objects the whole time, and one that thinks silently emits none.
    registerStreamPane("pane", "p", "builder-1");
    notePromptSent("pane", 1000);
    const state = new Map<string, RunawayWatch>();
    feedStreamOutput("pane", `{"type":"assistant","message":{}}\n`, 2000);
    expect(scanForStreamRunaways([pane], state, 1000 + RUNAWAY_MS, { turnSince: turns })).toEqual([pane]);
  });

  it("clears the streak the moment the turn actually ends", () => {
    registerStreamPane("pane", "p", "builder-1");
    notePromptSent("pane", 1000);
    const state = new Map<string, RunawayWatch>();
    scanForStreamRunaways([pane], state, 2000, { turnSince: turns });
    feedStreamOutput("pane", `{"type":"result","subtype":"success","is_error":false}\n`, 3000);
    expect(scanForStreamRunaways([pane], state, 4000, { turnSince: turns })).toEqual([]);
    expect(state.get("pane")?.since).toBeNull();
  });

  it("does not count a compaction against the turn — and resumes the clock where it ended", () => {
    // The headless shape of the same bug: a compaction happens INSIDE the turn,
    // so the turn stays open across it and "this turn has been open too long"
    // fires on a perfectly healthy agent — then fires again the moment it comes
    // back, because the turn start is still minutes of summarisation old.
    registerStreamPane("pane", "p", "builder-1");
    notePromptSent("pane", 1000);
    const state = new Map<string, RunawayWatch>();
    const paused = new Set(["pane"]);
    for (const now of [2000, RUNAWAY_MS, RUNAWAY_MS * 2]) {
      expect(scanForStreamRunaways([pane], state, now, { turnSince: turns }, undefined, paused)).toEqual([]);
      expect(state.get("pane")?.since).toBeNull(); // no countdown while compacting
    }
    const back = RUNAWAY_MS * 2;
    // Back from compaction, same turn. The clock runs from the resume, so the
    // agent gets its full window instead of being aborted on the next poll.
    expect(scanForStreamRunaways([pane], state, back + 1000, { turnSince: turns })).toEqual([]);
    expect(state.get("pane")?.since).toBe(back);
    expect(scanForStreamRunaways([pane], state, back + RUNAWAY_MS - 1, { turnSince: turns })).toEqual([]);
    expect(scanForStreamRunaways([pane], state, back + RUNAWAY_MS, { turnSince: turns })).toEqual([pane]);
  });

  it("keeps a paused pane's spent restarts — a compaction is not a fresh start", () => {
    registerStreamPane("pane", "p", "builder-1");
    notePromptSent("pane", 1000);
    const state = new Map<string, RunawayWatch>([["pane", { since: 1000, tail: "", restarts: 1 }]]);
    scanForStreamRunaways([pane], state, 2000, { turnSince: turns }, undefined, new Set(["pane"]));
    expect(state.get("pane")?.restarts).toBe(1);
  });

  it("stops restarting a pane after the budget is spent", () => {
    registerStreamPane("pane", "p", "builder-1");
    const state = new Map<string, RunawayWatch>([["pane", { since: 1000, tail: "", restarts: RUNAWAY_RESTART_MAX }]]);
    notePromptSent("pane", 1000);
    expect(scanForStreamRunaways([pane], state, 1000 + RUNAWAY_MS * 5, { turnSince: turns })).toEqual([]);
  });

  it("forgets a pane that is gone", () => {
    const state = new Map<string, RunawayWatch>([["pane", { since: 1000, tail: "", restarts: 0 }]]);
    expect(scanForStreamRunaways([], state, 5000, { turnSince: turns })).toEqual([]);
    expect(state.size).toBe(0);
  });
});

describe("both scanners, wired the way useSwarmRunaway wires them", () => {
  const tui: RunawayPane = { id: "tui", role: "builder-1", project: "p", command: "opencode" };
  const head: RunawayPane = { id: "head", role: "builder-2", project: "p", command: "claude" };
  const POLL_MS = 30_000;

  /** One tick of the hook: TUI panes through the tail scan, headless panes
   *  through the turn scan — each with ITS OWN state map, because every scan
   *  ends by deleting the ids that are not in its own live set. */
  function ticks(count: number, tuiState: Map<string, RunawayWatch>, streamState: Map<string, RunawayWatch>) {
    const hits: RunawayPane[] = [];
    for (let i = 1; i <= count; i++) {
      const now = 1000 + i * POLL_MS;
      hits.push(
        ...scanForRunaways([tui], tuiState, now, { lastOutput: () => now - 1000, tail: () => "frozen tail" }),
        ...scanForStreamRunaways([head], streamState, now, { turnSince: paneTurnSince }),
      );
    }
    return hits;
  }

  it("keeps each detector's streak and stops a headless restart loop at the budget", () => {
    registerStreamPane("head", "p", "builder-2");
    notePromptSent("head", 1000);
    const tuiState = new Map<string, RunawayWatch>();
    const streamState = new Map<string, RunawayWatch>();
    const hits = ticks(40, tuiState, streamState); // 20 min at a 30 s poll — well past RUNAWAY_MS
    // With one shared map the stream scan's prune deleted the TUI entry every
    // tick, so the busy streak never survived and the tail watchdog stopped
    // firing entirely — a regression on the default, non-headless path.
    expect(hits.filter((p) => p.id === "tui").length).toBeGreaterThan(0);
    // And `restarts` has to accumulate, or the budget never caps the loop.
    expect(hits.filter((p) => p.id === "head")).toHaveLength(RUNAWAY_RESTART_MAX);
    expect(streamState.get("head")?.restarts).toBe(RUNAWAY_RESTART_MAX);
  });

  /** A recovery outlasts a poll — abort, up to 30 s waiting for the respawn, a 3 s
   *  settle, then a wait for a turn slot — and the hook drops a recovering pane from
   *  the scanned list for the whole of it. The prune then read "not in this pass" as
   *  "pane is gone" and deleted its entry, so `restarts` came back 0 and
   *  RUNAWAY_RESTART_MAX capped nothing: a wedged pane restarted forever. `keep` is
   *  the fix; this is the loop that used to run away. */
  it("keeps the restart budget across the polls a recovery spans", () => {
    registerStreamPane("head", "p", "builder-2");
    const streamState = new Map<string, RunawayWatch>();
    const all = new Set(["head"]);
    let turn = 1000;
    const hits: RunawayPane[] = [];
    let recovering = 0;
    for (let i = 1; i <= 60; i++) {
      const now = 1000 + i * POLL_MS;
      if (recovering > 0) { // mid-recovery: excluded from the scan, still a live pane
        if (--recovering === 0) turn = now; // respawned, new turn starts now
        scanForStreamRunaways([], streamState, now, { turnSince: () => 0 }, all);
        continue;
      }
      const got = scanForStreamRunaways([head], streamState, now, { turnSince: () => turn }, all);
      if (got.length) { hits.push(...got); recovering = 3; } // ~90 s of polls
    }
    expect(hits).toHaveLength(RUNAWAY_RESTART_MAX);
    expect(streamState.get("head")?.restarts).toBe(RUNAWAY_RESTART_MAX);
  });

  /** `keep` is ONLY the panes left out of a pass on purpose — the ones
   *  mid-recovery. Handing both detectors the union of all live ids made each
   *  refuse to prune the other's entries, and a TAKEOVER flips a live pane from
   *  headless to TUI without changing its id: its stream entry, with its spent
   *  `restarts`, then survived unscanned forever and a pane that went headless
   *  again resumed AT the cap, watchdog silently off. */
  it("prunes the other detector's entry when a pane changes mode", () => {
    const tuiState = new Map<string, RunawayWatch>();
    const streamState = new Map<string, RunawayWatch>();
    const paneId = "flip";
    const pane: RunawayPane = { id: paneId, role: "builder-3", project: "p", command: "claude" };
    // Headless and wedged: it burns its whole restart budget.
    const turn = 1000;
    for (let i = 1; i <= 40; i++) {
      const now = 1000 + i * POLL_MS;
      scanForStreamRunaways([pane], streamState, now, { turnSince: () => turn }, new Set());
    }
    expect(streamState.get(paneId)?.restarts).toBe(RUNAWAY_RESTART_MAX);
    // A human takes it over: same id, now a TUI pane, so only the tail scan sees
    // it and the stream scan is handed a list without it — and no `keep`, because
    // it is not mid-recovery.
    const after = 1000 + 41 * POLL_MS;
    scanForRunaways([pane], tuiState, after, { lastOutput: () => after - 1000, tail: () => "idle" }, new Set());
    scanForStreamRunaways([], streamState, after, { turnSince: () => 0 }, new Set());
    expect(streamState.has(paneId)).toBe(false); // else a later headless respawn starts at the cap
    expect(tuiState.get(paneId)?.restarts).toBe(0);
  });

  it("does not wipe the TUI state when no pane is headless at all", () => {
    // The stream scan runs unconditionally, with an empty pane list in every
    // swarm that has no headless pane — i.e. today's default.
    const tuiState = new Map<string, RunawayWatch>();
    const streamState = new Map<string, RunawayWatch>();
    for (let i = 1; i <= 4; i++) {
      const now = 1000 + i * POLL_MS;
      scanForRunaways([tui], tuiState, now, { lastOutput: () => now - 1000, tail: () => "frozen tail" });
      scanForStreamRunaways([], streamState, now, { turnSince: paneTurnSince });
    }
    expect(tuiState.get("tui")?.since).toBe(1000 + POLL_MS); // the streak still starts at tick 1
  });
});
