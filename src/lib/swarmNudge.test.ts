import { beforeEach, describe, expect, it, vi } from "vitest";
// Same reason as the other watcher tests: importing the module pulls the layout
// store -> terminalPool -> xterm, which touches `self` at import time under the
// node env. Nothing below reads a real pane — nudgeAction takes plain values.
vi.mock("./terminalPool", () => ({ lastOutputAt: () => 0, tailText: () => "", restartTerminal: () => {} }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.resolve(null) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => undefined) }));
// The delivery test below watches what injectPrompt actually writes.
const writes: { id: string; data: string }[] = [];
vi.mock("./ipc", () => ({
  ptyWrite: (id: string, data: string) => { writes.push({ id, data }); return Promise.resolve(); },
  brainDelete: () => Promise.resolve(),
  brainFeedNow: () => undefined,
  brainUrl: () => Promise.resolve(""),
  subscribeBrainFeed: () => () => {},
}));

import { NUDGE_COOLDOWN_MS, NUDGE_ERROR_RE, NUDGE_IDLE_MS, NUDGE_MAX, liveTurns, nudgeText, releaseTurnSlot } from "./swarm";
import { nudgeAction, type NudgeEpisode } from "./swarmNudge";
import {
  feedStreamOutput, markStreamPaneOpen, notePromptSent, paneTurnActive, registerStreamPane,
  resetStreamPanes, streamErrorActive, userMessageFrame,
} from "./agentStream";
import { resetAgentEvents } from "./agentEvents";
import { injectPrompt } from "./swarmReset";

const NOW = 1_700_000_000_000;
const ERROR_TAIL = "API Error: 529 Overloaded. This is a server-side issue";

/** A pane that is quiet, showing an API error, with no hook signal and no
 *  episode yet — i.e. the exact case the watcher exists to nudge. */
const act = (over: Partial<Parameters<typeof nudgeAction>[0]> = {}) =>
  nudgeAction({
    tail: ERROR_TAIL,
    lastOutput: NOW - NUDGE_IDLE_MS,
    turn: undefined,
    episode: undefined,
    now: NOW,
    ...over,
  });

const episode = (count: number, agoMs: number): NudgeEpisode => ({ at: NOW - agoMs, count });

describe("nudge policy", () => {
  it("nudges a quiet pane sitting at an API error", () => {
    expect(act()).toBe("nudge");
  });

  it("ends the episode when the error has scrolled away", () => {
    expect(act({ tail: "all tests passed" })).toBe("clear");
    // Even mid-turn, and even with an episode running: no error on screen means
    // there is nothing to resume, and the pane must be nudgeable for the NEXT one.
    expect(act({ tail: "", turn: true, episode: episode(1, 0) })).toBe("clear");
  });

  it("leaves a pane alone until it has been quiet long enough", () => {
    expect(act({ lastOutput: NOW - NUDGE_IDLE_MS + 1 })).toBe("skip");
    expect(act({ lastOutput: 0 })).toBe("skip"); // never produced output — still booting
  });

  // The bug this gate exists for: the agent hit the error, recovered on its own
  // and is now thinking. It paints nothing, the survived error is still on
  // screen, and "continue" would land in a live turn.
  it("never nudges a pane whose own hooks say it is mid-turn", () => {
    expect(act({ turn: true, lastOutput: NOW - NUDGE_IDLE_MS * 10 })).toBe("skip");
  });

  it("keeps nudging when the hooks say the turn is over, or say nothing at all", () => {
    expect(act({ turn: false })).toBe("nudge");
    expect(act({ turn: undefined })).toBe("nudge"); // no hooks — exactly the pre-hook path
  });

  it("respects the cooldown and the per-episode cap", () => {
    expect(act({ episode: episode(1, NUDGE_COOLDOWN_MS - 1) })).toBe("skip");
    expect(act({ episode: episode(1, NUDGE_COOLDOWN_MS) })).toBe("nudge");
    expect(act({ episode: episode(NUDGE_MAX, NUDGE_COOLDOWN_MS * 10) })).toBe("skip");
    expect(act({ episode: episode(NUDGE_MAX - 1, NUDGE_COOLDOWN_MS * 10) })).toBe("nudge");
  });
});

describe("headless (stream) panes", () => {
  const FAILED = `{"type":"result","subtype":"error_during_execution","is_error":true,"result":"API Error: 529 Overloaded"}\n`;
  const SUCCESS = `{"type":"result","subtype":"success","is_error":false}\n`;

  beforeEach(() => {
    writes.length = 0;
    resetStreamPanes();
    resetAgentEvents();
    // Hand back anything a previous test left charged, so the app-global cap
    // never decides the outcome here.
    for (const t of liveTurns()) { const [project, title] = t.split("/"); releaseTurnSlot(project, title); }
  });

  it("detects the error from the parsed stream, and the policy trusts it over the tail", () => {
    registerStreamPane("h", "p", "builder-1");
    feedStreamOutput("h", FAILED, 1000);
    expect(streamErrorActive("h")).toBe(true);
    // The watcher hands the policy `erroring` and an EMPTY tail for a stream
    // pane — the regex never sees the JSON buffer.
    expect(act({ tail: "", erroring: true })).toBe("nudge");
  });

  it("cannot be faked or hidden by error-shaped text inside the JSON buffer", () => {
    // Regex over this tail would fire — but the parsed channel says the pane is
    // fine, so the episode clears instead of nudging a healthy pane.
    expect(act({ tail: '{"type":"assistant","text":"API Error: 529 Overloaded"}', erroring: false })).toBe("clear");
    // And an error the regex would MISS (nothing matching inside the JSON)
    // still nudges, because detection never depended on the buffer's spelling.
    expect(act({ tail: '{"type":"result"}', erroring: true })).toBe("nudge");
  });

  it("treats a successful turn after the error as the error scrolling away", () => {
    registerStreamPane("h", "p", "builder-1");
    feedStreamOutput("h", FAILED, 1000);
    expect(streamErrorActive("h")).toBe(true);
    notePromptSent("h", 2000); // the nudge (or a wake) went out
    feedStreamOutput("h", SUCCESS, 3000);
    expect(streamErrorActive("h")).toBe(false); // episode over — nudgeable for the NEXT failure
    expect(act({ tail: "", erroring: streamErrorActive("h") })).toBe("clear");
  });

  it("never nudges a stream pane that is mid-turn, even with the error still latest", () => {
    registerStreamPane("h", "p", "builder-1");
    feedStreamOutput("h", FAILED, 1000);
    notePromptSent("h", 2000); // recovery already in flight
    expect(paneTurnActive("h")).toBe(true);
    expect(streamErrorActive("h")).toBe(true);
    expect(act({ tail: "", erroring: true, turn: paneTurnActive("h") })).toBe("skip");
    // A mid-turn stderr diagnostic changes nothing — still hands-off.
    feedStreamOutput("h", `{"type":"pixelmarch_stderr","text":"transient warning"}\n`, 3000);
    expect(act({ tail: "", erroring: streamErrorActive("h"), turn: paneTurnActive("h") })).toBe("skip");
  });

  it("delivers the nudge as ONE stream-json message via the injection funnel", async () => {
    registerStreamPane("h", "p", "builder-1");
    markStreamPaneOpen("h");
    await expect(injectPrompt("p", "h", "builder-1", nudgeText("builder-1"))).resolves.toBe(true);
    // No typed text, no CR dance: the exact frame the stream funnel spells.
    expect(writes).toEqual([{ id: "h", data: userMessageFrame(nudgeText("builder-1")) }]);
    // And the send marked the pane mid-turn, so the next tick cannot double-nudge.
    expect(paneTurnActive("h")).toBe(true);
  });
});

describe("swarm auto-nudge error detection", () => {
  it("matches transient API failure phrases", () => {
    expect("API Error: 529 Overloaded. This is a server-side issue").toMatch(NUDGE_ERROR_RE);
    expect("error: rate limited, retry in 20s").toMatch(NUDGE_ERROR_RE);
    expect("429 Too Many Requests").toMatch(NUDGE_ERROR_RE);
    expect("stream error: unexpected EOF").toMatch(NUDGE_ERROR_RE);
    expect("connection reset by peer").toMatch(NUDGE_ERROR_RE);
  });

  it("ignores innocent output that mentions numbers or errors", () => {
    expect("tests passed in 500 ms").not.toMatch(NUDGE_ERROR_RE);
    expect("HTTP 200 OK — 529 bytes").not.toMatch(NUDGE_ERROR_RE);
    expect("fixed the error handling in parser.ts").not.toMatch(NUDGE_ERROR_RE);
    expect("> git push origin master").not.toMatch(NUDGE_ERROR_RE);
  });
});
