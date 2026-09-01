import { beforeEach, describe, expect, it, vi } from "vitest";
// agentEvents imports lib/ipc for brainUrl, which imports the Tauri API — stub it
// the way ipc.test.ts does so the module loads in the node test env. Every test
// below drives the store through ingestAgentEvents (the pure half), so no HTTP
// and no Tauri call is ever made.
vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.resolve(null) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => undefined) }));

import { COMPACT_MAX_MS, agentEventsCursor, compacting, ingestAgentEvents, lastPromptAcceptedAt, lastSessionStartAt, lastTurnEndAt, recordAgentEvent, resetAgentEvents, turnActive, type AgentEvent } from "./agentEvents";
import { AGENT_CAPS, WAKE_MISS_MAX, agentCaps, hasHooks, hookSettingsFlag, wakeDue, type WakeState } from "./swarm";

const P = "demo-swarm";
const MS = 1_700_000_000_000; // a millisecond stamp — anything under 1e12 is read as seconds
const ev = (seq: number, role: string, event: string, at = MS): AgentEvent => ({ seq, role, event, at });

beforeEach(() => resetAgentEvents());

// CONTEXT COMPACTION. The `PreCompact` hook is the only signal that separates
// "this agent is summarising its own context" from "this agent is wedged", and
// the runaway watchdog was reading the first as the second and spending its
// restart budget on it.
describe("compaction window", () => {
  it("opens on the compacting event and is not a turn boundary", () => {
    ingestAgentEvents(P, { events: [ev(1, "builder-1", "prompt-submitted", MS), ev(2, "builder-1", "compacting", MS + 1000)], seq: 2 });
    expect(compacting(P, "builder-1", MS + 2000)).toBe(true);
    expect(turnActive(P, "builder-1")).toBe(true); // the turn it interrupts is still open
  });

  it("closes on the next event from that role — including the session-start compaction itself fires", () => {
    ingestAgentEvents(P, { events: [ev(1, "builder-1", "compacting", MS)], seq: 1 });
    expect(compacting(P, "builder-1", MS + 1000)).toBe(true);
    ingestAgentEvents(P, { events: [ev(2, "builder-1", "session-start", MS + 5000)], seq: 2 });
    expect(compacting(P, "builder-1", MS + 6000)).toBe(false);
  });

  it("expires, so a compaction that never comes back cannot switch the watchdog off forever", () => {
    ingestAgentEvents(P, { events: [ev(1, "builder-1", "compacting", MS)], seq: 1 });
    expect(compacting(P, "builder-1", MS + COMPACT_MAX_MS - 1)).toBe(true);
    expect(compacting(P, "builder-1", MS + COMPACT_MAX_MS)).toBe(false);
  });

  it("answers false for a role that has never compacted, and keeps roles apart", () => {
    ingestAgentEvents(P, { events: [ev(1, "builder-1", "compacting", MS)], seq: 1 });
    expect(compacting(P, "builder-2", MS + 1000)).toBe(false);
    expect(compacting("no-such-swarm", "builder-1", MS + 1000)).toBe(false);
  });

  it("takes the same event off the local channel (recordAgentEvent), monotonically", () => {
    recordAgentEvent(P, "builder-1", "compacting", MS + 1000);
    expect(compacting(P, "builder-1", MS + 2000)).toBe(true);
    recordAgentEvent(P, "builder-1", "compacting", MS); // a stale arrival must not move it back
    expect(compacting(P, "builder-1", MS + 1000 + COMPACT_MAX_MS - 1)).toBe(true);
  });
});

describe("agent event ingest", () => {
  it("advances the cursor past every event it accepted", () => {
    expect(agentEventsCursor(P)).toBe(0);
    ingestAgentEvents(P, { events: [ev(1, "builder-1", "session-start"), ev(2, "builder-1", "prompt-submitted")], seq: 2 });
    expect(agentEventsCursor(P)).toBe(2);
  });

  it("takes the page's seq even when the page carries no events (ring dropped them)", () => {
    ingestAgentEvents(P, { events: [], seq: 47 });
    expect(agentEventsCursor(P)).toBe(47);
  });

  it("never replays: a re-delivered page cannot move a turn boundary back", () => {
    const page = { events: [ev(1, "builder-1", "prompt-submitted", MS + 1000), ev(2, "builder-1", "turn-end", MS + 2000)], seq: 2 };
    ingestAgentEvents(P, page);
    ingestAgentEvents(P, { events: [ev(3, "builder-1", "prompt-submitted", MS + 3000)], seq: 3 });
    expect(turnActive(P, "builder-1")).toBe(true);
    ingestAgentEvents(P, page); // the whole first page again — stale seqs
    expect(turnActive(P, "builder-1")).toBe(true); // still mid-turn, not "ended at 2000"
    expect(lastPromptAcceptedAt(P, "builder-1")).toBe(MS + 3000);
    expect(agentEventsCursor(P)).toBe(3); // and the cursor never goes backwards
  });

  it("drops an unknown event kind instead of guessing what it means", () => {
    ingestAgentEvents(P, { events: [ev(1, "builder-1", "prompt-submitted"), ev(2, "builder-1", "pre-tool-use")], seq: 2 });
    expect(turnActive(P, "builder-1")).toBe(true);
    expect(agentEventsCursor(P)).toBe(2);
  });

  it("keeps roles apart and answers 'unknown' for a project or role it has never seen", () => {
    ingestAgentEvents(P, { events: [ev(1, "builder-1", "prompt-submitted")], seq: 1 });
    expect(turnActive(P, "builder-1")).toBe(true);
    expect(turnActive(P, "builder-2")).toBeUndefined();
    expect(turnActive("no-such-swarm", "builder-1")).toBeUndefined();
    expect(lastTurnEndAt("no-such-swarm", "builder-1")).toBe(0);
    expect(agentEventsCursor("no-such-swarm")).toBe(0);
  });

  it("reports unknown until a turn boundary is seen — session-start alone says nothing", () => {
    ingestAgentEvents(P, { events: [ev(1, "coordinator", "session-start", MS + 500), ev(2, "coordinator", "notification", MS + 600)], seq: 2 });
    expect(turnActive(P, "coordinator")).toBeUndefined();
    expect(lastSessionStartAt(P, "coordinator")).toBe(MS + 500);
    ingestAgentEvents(P, { events: [ev(3, "coordinator", "turn-end", MS + 900)], seq: 3 });
    expect(turnActive(P, "coordinator")).toBe(false);
    expect(lastTurnEndAt(P, "coordinator")).toBe(MS + 900);
  });

  it("normalizes a seconds stamp to milliseconds so it compares with Date.now()", () => {
    ingestAgentEvents(P, { events: [{ seq: 1, role: "scout", event: "turn-end", at: 1_700_000_000 }], seq: 1 });
    expect(lastTurnEndAt(P, "scout")).toBe(1_700_000_000_000);
  });

  it("recovers from a restarted ring instead of freezing the role forever", () => {
    ingestAgentEvents(P, { events: [ev(1, "builder-1", "prompt-submitted", MS)], seq: 9 });
    expect(turnActive(P, "builder-1")).toBe(true);
    // The brain restarts: the ring numbers from 0 again, so every page now reads
    // below our cursor and the no-replay rule would drop it — leaving builder-1
    // stuck mid-turn (and its pane deaf to every wake) for the rest of the run.
    ingestAgentEvents(P, { events: [], seq: 0 }); // one low page — could be a duplicate
    expect(agentEventsCursor(P)).toBe(9);
    ingestAgentEvents(P, { events: [ev(1, "builder-1", "turn-end", MS + 1000)], seq: 1 });
    expect(agentEventsCursor(P)).toBe(1);
    expect(turnActive(P, "builder-1")).toBe(false);
  });

  it("treats a single below-cursor page as a duplicate, not a restart", () => {
    const page = { events: [ev(1, "builder-1", "prompt-submitted", MS)], seq: 1 };
    ingestAgentEvents(P, page);
    ingestAgentEvents(P, { events: [ev(2, "builder-1", "turn-end", MS + 500)], seq: 2 });
    ingestAgentEvents(P, page); // re-delivered older response
    expect(agentEventsCursor(P)).toBe(2);
    expect(turnActive(P, "builder-1")).toBe(false);
    // …and a fresh page in the current numbering clears the suspicion.
    ingestAgentEvents(P, { events: [ev(3, "builder-1", "prompt-submitted", MS + 900)], seq: 3 });
    ingestAgentEvents(P, page);
    expect(agentEventsCursor(P)).toBe(3);
    expect(turnActive(P, "builder-1")).toBe(true);
  });

  it("forgets a project on reset (a closed swarm leaves nothing behind)", () => {
    ingestAgentEvents(P, { events: [ev(1, "builder-1", "turn-end")], seq: 1 });
    resetAgentEvents(P);
    expect(agentEventsCursor(P)).toBe(0);
    expect(turnActive(P, "builder-1")).toBeUndefined();
  });
});

describe("agent capability table", () => {
  it("claims hooks/mcp/headless only for the CLI they were verified on", () => {
    expect(AGENT_CAPS.claude).toEqual({ hooks: true, mcp: true, headless: true });
    for (const bin of ["codex", "gemini", "opencode", "aider"]) expect(AGENT_CAPS[bin]).toEqual({ hooks: false, mcp: false, headless: false });
  });

  it("resolves through the command line, and an unknown binary claims nothing", () => {
    expect(agentCaps("claude --dangerously-skip-permissions")).toEqual({ hooks: true, mcp: true, headless: true });
    expect(hasHooks("CLAUDE.EXE --model x")).toBe(true);
    expect(hasHooks("opencode --prompt")).toBe(false);
    expect(agentCaps("some-other-agent")).toEqual({ hooks: false, mcp: false, headless: false });
    expect(hasHooks("")).toBe(false);
  });

  it("appends --settings only for a hook CLI with a real path, and quotes it", () => {
    expect(hookSettingsFlag("claude", "/home/a b/.pixelmarch/hooks.json")).toBe("--settings '/home/a b/.pixelmarch/hooks.json'");
    expect(hookSettingsFlag("claude", "")).toBe(""); // host cannot install hooks — today's command line
    expect(hookSettingsFlag("opencode", "/tmp/hooks.json")).toBe(""); // no hooks — never point it at one
    expect(hookSettingsFlag("claude", "/tmp/it's/hooks.json")).toBe(""); // unquotable — refuse, don't split the command
  });
});

describe("hook-capable panes skip the wake miss counter", () => {
  const SIG = "task-1:open";
  const state = (over: Partial<WakeState> = {}): WakeState => ({ sig: SIG, at: 0, misses: 0, ...over });

  it("does not retry-at-once on an unconfirmed wake when the CLI confirms delivery itself", () => {
    // Same state, same clock: the TUI pane retries immediately (it cannot know
    // whether the keystrokes landed), the hook pane waits out its normal gap
    // because UserPromptSubmit is what proves delivery there.
    expect(wakeDue(state({ misses: 1 }), SIG, 1000, true)).toBe(true);
    expect(wakeDue(state({ misses: 1 }), SIG, 1000, true, true)).toBe(false);
    expect(wakeDue(state({ misses: WAKE_MISS_MAX - 1 }), SIG, 1000, false, true)).toBe(false);
  });

  it("still wakes a hook pane for new work and on the heartbeat gap", () => {
    expect(wakeDue(undefined, SIG, 1000, false, true)).toBe(true);
    expect(wakeDue(state(), "task-9:open", 1000, false, true)).toBe(true);
    expect(wakeDue(state({ misses: 1 }), SIG, 999_999, false, true)).toBe(true);
  });

  it("leaves the default (no flag) exactly as it was — non-hook panes are untouched", () => {
    expect(wakeDue(state({ misses: 1 }), SIG, 1000, false)).toBe(wakeDue(state({ misses: 1 }), SIG, 1000, false, false));
  });
});
