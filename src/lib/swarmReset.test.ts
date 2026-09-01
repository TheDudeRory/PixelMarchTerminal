import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Same reason as the other watcher tests: the module pulls in the terminal pool
// (xterm touches `self` at import time under the node env). `lastOutputAt` is a
// settable stamp so a test can hold a pane "busy"; `restartTerminal` records the
// restarts — for a headless pane the restart IS the context reset.
let output = 0;
const restarts: string[] = [];
vi.mock("./terminalPool", () => ({
  lastOutputAt: () => output,
  restartTerminal: (id: string) => { restarts.push(id); },
}));
const writes: { id: string; data: string }[] = [];
const statusWrites: { project: string; task: string; status: string; log: string }[] = [];
const chats: { project: string; from: string; to: string; text: string }[] = [];
let cancelWrite: Record<string, unknown> = { ok: true };
// `writeFails` makes the PTY refuse — the only way a wipe can fail on a TUI pane,
// and the case a reclaim must not mistake for a completed one.
let writeFails = false;
// What the brain answers the host's reclaim flip with, and what it was asked.
let flip: { ok: boolean; reason?: string; from?: string; to?: string } = { ok: true, from: "builder-1", to: "builder-2" };
const flips: { project: string; task: string; to: string }[] = [];
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
  brainReclaimTask: (project: string, task: string, to: string) => {
    flips.push({ project, task, to });
    return Promise.resolve(flip);
  },
  // The cancel path's two brain writes: the status flip and the coordinator's
  // heads-up. `cancelWrite` is what the brain answers the flip with.
  brainTaskStatus: (project: string, task: string, status: string, log: string) => {
    statusWrites.push({ project, task, status, log });
    return Promise.resolve(cancelWrite);
  },
  brainChatSend: (project: string, from: string, to: string, text: string) => {
    chats.push({ project, from, to, text });
    return Promise.resolve({ ok: true });
  },
}));
// The layout store drags in the whole app; rebrief only ever calls
// patchPaneAnywhere on it — to PARK a prompt, which is what these record.
const patched: { id: string; patch: { pendingPrompt?: string } }[] = [];
vi.mock("../stores/layout", () => ({
  useLayout: { getState: () => ({ workspaces: [], patchPaneAnywhere: (id: string, patch: { pendingPrompt?: string }) => { patched.push({ id, patch }); } }) },
}));
vi.mock("../stores/swarmTelemetry", () => ({
  useSwarmTelemetry: { getState: () => ({ reportReset: () => {}, reportNudge: () => {} }) },
}));

import { bootPrompt, interruptKey, liveTurns, releaseTurnSlot, resetCommand } from "./swarm";
import { markStreamPaneOpen, registerStreamPane, resetStreamPanes, userMessageFrame } from "./agentStream";
import { resetAgentEvents } from "./agentEvents";
import { cancelTask, clearFences, injectPrompt, isFenced, reclaimScope, rebrief, submitPrompt } from "./swarmReset";

const P = "demo-swarm";
const URL = "http://brain";
const HEADLESS_CMD = "claude --dangerously-skip-permissions -p --verbose --input-format stream-json --output-format stream-json";

beforeEach(() => {
  output = 0;
  restarts.length = 0;
  writes.length = 0;
  patched.length = 0;
  writeFails = false;
  flips.length = 0;
  statusWrites.length = 0;
  chats.length = 0;
  cancelWrite = { ok: true };
  flip = { ok: true, from: "builder-1", to: "builder-2" };
  clearFences();
  resetStreamPanes();
  resetAgentEvents();
  // Hand back anything a previous test left charged, so the app-global cap
  // never decides the outcome here.
  for (const t of liveTurns()) { const [project, title] = t.split("/"); releaseTurnSlot(project, title); }
});

afterEach(() => { vi.useRealTimers(); });

describe("submitPrompt — the TUI sequencing contract", () => {
  it("types the text, then submits with two SEPARATE Enters", async () => {
    // A CR bundled with the text reads as a pasted newline to a TUI input box:
    // the line never submits and the next injection concatenates onto it. The
    // second Enter is the rescue for a prompt left sitting in the box.
    vi.useFakeTimers();
    const done = submitPrompt("tui", "hello");
    await vi.advanceTimersByTimeAsync(0);
    expect(writes.map((w) => w.data)).toEqual(["hello"]); // no CR in the same chunk
    await vi.advanceTimersByTimeAsync(300);
    expect(writes.map((w) => w.data)).toEqual(["hello", "\r"]);
    await vi.advanceTimersByTimeAsync(1000);
    await done;
    expect(writes.map((w) => w.data)).toEqual(["hello", "\r", "\r"]);
    expect(writes.every((w) => w.id === "tui")).toBe(true);
  });
});

describe("the prompt funnel branches on what the pane IS", () => {
  it("hands a stream pane ONE JSON frame and a TUI pane keystrokes", async () => {
    registerStreamPane("h", P, "builder-1");
    markStreamPaneOpen("h");
    await expect(injectPrompt(P, "h", "builder-1", "go")).resolves.toBe(true);
    expect(writes).toEqual([{ id: "h", data: userMessageFrame("go") }]);
    writes.length = 0;
    releaseTurnSlot(P, "builder-1"); // hand the slot back so the cap (1) cannot refuse the TUI send
    vi.useFakeTimers();
    const done = injectPrompt(P, "tui", "builder-2", "go");
    await vi.advanceTimersByTimeAsync(2000);
    await expect(done).resolves.toBe(true);
    expect(writes.map((w) => w.data)).toEqual(["go", "\r", "\r"]);
  });
});

describe("rebrief — the headless reset path", () => {
  it("resets a headless pane by RESTARTING the process — no /clear, no interrupt, no idle wait", async () => {
    // There is no REPL to type /clear into: a fresh context is a fresh session,
    // and a fresh session is a new process. The kill is a real signal, so the
    // mid-turn case needs no interrupt key either.
    registerStreamPane("h", P, "builder-1");
    markStreamPaneOpen("h");
    output = Date.now(); // pane is chattering — a TUI path would idle-wait on this
    await rebrief("h", HEADLESS_CMD, P, URL, "builder-1", false);
    expect(restarts).toEqual(["h"]);
    expect(writes.some((w) => w.data.includes(resetCommand(HEADLESS_CMD)))).toBe(false); // "/clear" never sent
    expect(writes.some((w) => w.data === interruptKey(HEADLESS_CMD))).toBe(false); // ESC never sent
    // Without dispatch the re-brief goes out now, as one stream-json frame.
    expect(writes).toEqual([{ id: "h", data: userMessageFrame(bootPrompt(P, URL, "builder-1")) }]);
    expect(patched).toEqual([]);
  });

  it("parks the re-brief under host dispatch instead of spending a turn on it", async () => {
    registerStreamPane("h", P, "builder-1");
    markStreamPaneOpen("h");
    await rebrief("h", HEADLESS_CMD, P, URL, "builder-1", true);
    expect(restarts).toEqual(["h"]);
    expect(writes).toEqual([]); // nothing sent — the dispatcher types it when work exists
    expect(patched).toEqual([{ id: "h", patch: { pendingPrompt: bootPrompt(P, URL, "builder-1") } }]);
  });

  it("parks the brief when the respawn never comes back, instead of stranding the agent", async () => {
    // The reset note is consumed BEFORE the restart, so if the new session never
    // opens, a thrown write would be swallowed by the watcher and nothing would
    // ever brief the pane again. Parking hands it to the boot-brief/dispatch
    // effects, which deliver the moment the session is open.
    registerStreamPane("h", P, "builder-1"); // headless, but pty_open never resolves
    vi.useFakeTimers();
    const done = rebrief("h", HEADLESS_CMD, P, URL, "builder-1", false);
    await vi.advanceTimersByTimeAsync(31_000); // waitForStreamPane's 30 s cap
    await done;
    expect(restarts).toEqual(["h"]);
    expect(writes).toEqual([]); // a write would have been dropped silently by the host
    expect(patched).toEqual([{ id: "h", patch: { pendingPrompt: bootPrompt(P, URL, "builder-1") } }]);
  });
});

describe("rebrief — the TUI path is unchanged", () => {
  it("wipes with the CLI's reset command and types the brief back in", async () => {
    // NOT registered as a stream pane — this is the classic PTY worker.
    vi.useFakeTimers();
    const done = rebrief("tui", "claude", P, URL, "builder-1", false);
    await vi.advanceTimersByTimeAsync(10_000); // covers both submitPrompt sequences
    await done;
    expect(restarts).toEqual([]); // a TUI reset is never a process restart
    expect(writes.map((w) => w.data)).toEqual([
      resetCommand("claude"), "\r", "\r", // the wipe, submitted like any typed line
      bootPrompt(P, URL, "builder-1"), "\r", "\r", // the re-brief, same contract
    ]);
    expect(patched).toEqual([]); // sent, not parked — nothing else would ever send it
  });
});

// brain-findings 2.2. The incident: a coordinator chatted "please stop" at a
// second builder working the same task; it arrived after that builder had
// started, and the work was done twice. Chat is not a lock — so reassignment is
// ONE host operation with the losing pane fenced across all of it.
describe("cancelTask — the human's stop button on the mission board", () => {
  const owner = { paneId: "h", role: "builder-1", startupCommand: HEADLESS_CMD, dispatch: true };
  const headless = () => { registerStreamPane("h", P, "builder-1"); markStreamPaneOpen("h"); };

  it("fences the owner, cancels on the bus, wipes the pane, and tells the coordinator", async () => {
    headless();
    const out = await cancelTask(P, "task-1", owner, URL, "we shipped it another way");
    expect(out.ok).toBe(true);
    expect(statusWrites).toEqual([{ project: P, task: "task-1", status: "cancelled", log: expect.stringContaining("we shipped it another way") }]);
    expect(restarts).toEqual(["h"]); // the builder is stopped, context and all
    expect(patched).toEqual([{ id: "h", patch: { pendingPrompt: bootPrompt(P, URL, "builder-1") } }]);
    expect(chats).toHaveLength(1);
    expect(chats[0]).toMatchObject({ from: "host", to: "coordinator" });
    expect(chats[0].text).toContain("task-1 was CANCELLED");
    expect(isFenced(P, "builder-1")).toBe(false); // wiped and parked — safe to wake again
  });

  it("fences BEFORE the bus flip — there is no instant where the task is dead and its builder still runs", async () => {
    headless();
    let mid: boolean | null = null;
    cancelWrite = { get ok() { mid = isFenced(P, "builder-1"); return true; } } as never;
    await cancelTask(P, "task-1", owner, URL);
    expect(mid).toBe(true);
  });

  it("changes nothing when the brain refuses the write", async () => {
    headless();
    cancelWrite = { ok: false, reason: "no task task-9" };
    const out = await cancelTask(P, "task-9", owner, URL);
    expect(out).toMatchObject({ ok: false, refused: true, reason: "no task task-9" });
    expect(restarts).toEqual([]); // the pane was never touched
    expect(chats).toEqual([]); // and nobody was told a lie
    expect(isFenced(P, "builder-1")).toBe(false);
  });

  it("HOLDS the fence when the task is cancelled but its pane could not be stopped", async () => {
    // Half-state, and the dangerous direction: the bus says cancelled while the
    // builder is still alive. It stays frozen out of every injection path rather
    // than being woken back onto work the human just killed.
    vi.useFakeTimers();
    writeFails = true; // TUI pane, PTY write throws
    const tui = { paneId: "tui", role: "builder-1", startupCommand: "claude", dispatch: true };
    const done = cancelTask(P, "task-1", tui, URL);
    await vi.advanceTimersByTimeAsync(20_000);
    const out = await done;
    expect(out).toMatchObject({ ok: true, fencedOpen: true });
    expect(statusWrites).toHaveLength(1); // the cancel itself landed
    expect(isFenced(P, "builder-1")).toBe(true);
    expect(await injectPrompt(P, "tui", "builder-1", "go")).toBe(false);
  });

  it("never wipes the coordinator — a cancel is a re-plan, not a restart", async () => {
    registerStreamPane("c", P, "coordinator");
    markStreamPaneOpen("c");
    const out = await cancelTask(P, "task-1", { paneId: "c", role: "coordinator", startupCommand: HEADLESS_CMD, dispatch: true }, URL);
    expect(out.ok).toBe(true);
    expect(statusWrites).toHaveLength(1);
    expect(restarts).toEqual([]); // its context IS the mission plan
    expect(isFenced(P, "coordinator")).toBe(false);
    expect(chats[0].text).not.toContain("was stopped"); // nothing was stopped — and the message must not claim it
    expect(chats[0].text).toContain("task-1 was CANCELLED"); // it is still told what happened
  });

  it("cancels a task nobody owns without a pane to stop", async () => {
    const out = await cancelTask(P, "task-3", undefined, URL);
    expect(out.ok).toBe(true);
    expect(statusWrites).toHaveLength(1);
    expect(restarts).toEqual([]);
    expect(chats).toHaveLength(1);
  });
});

describe("reclaimScope — taking a task off a builder is atomic", () => {
  const loser = { paneId: "h", role: "builder-1", startupCommand: HEADLESS_CMD, dispatch: true };
  const headless = () => { registerStreamPane("h", P, "builder-1"); markStreamPaneOpen("h"); };

  it("fences, flips the owner, wipes the pane, then lets it work again", async () => {
    headless();
    const out = await reclaimScope(P, "task-1", "builder-2", loser, URL);
    expect(out.ok).toBe(true);
    expect(flips).toEqual([{ project: P, task: "task-1", to: "builder-2" }]);
    expect(restarts).toEqual(["h"]); // the losing pane's context is gone
    expect(patched).toEqual([{ id: "h", patch: { pendingPrompt: bootPrompt(P, URL, "builder-1") } }]);
    // Fence lifted only now — the pane is wiped and parked, so a wake is safe.
    expect(isFenced(P, "builder-1")).toBe(false);
    expect(await injectPrompt(P, "h", "builder-1", "go")).toBe(true);
  });

  it("refuses every injection into the losing pane while the reclaim is in flight", async () => {
    headless();
    let mid: boolean | null = null;
    // The flip is where the window used to be: the bus says the task is someone
    // else's, and nothing has stopped the old owner yet. Sampling the fence as
    // the flip is answered is the only way to assert there is no such instant.
    flip = { get ok() { mid = isFenced(P, "builder-1"); return true; }, from: "builder-1", to: "builder-2" } as never;
    await reclaimScope(P, "task-1", "builder-2", loser, URL);
    expect(mid).toBe(true); // fenced BEFORE the owner flipped, not after
  });

  it("changes nothing at all when the brain refuses the flip", async () => {
    headless();
    flip = { ok: false, reason: "not reclaimable" };
    const out = await reclaimScope(P, "task-1", "builder-2", loser, URL);
    expect(out).toMatchObject({ ok: false, refused: true, reason: "not reclaimable" });
    expect(restarts).toEqual([]); // the pane was never touched
    expect(isFenced(P, "builder-1")).toBe(false); // …and it is free to keep working
    expect(await injectPrompt(P, "h", "builder-1", "go")).toBe(true);
  });

  it("HOLDS the fence when the flip landed but the pane could not be wiped", async () => {
    // The dangerous half-state: the task is builder-2's now, so builder-1 must
    // not take another turn — even though the wipe failed. It stays frozen out
    // and the caller retries; the alternative is the duplicate work all over.
    vi.useFakeTimers();
    writeFails = true; // TUI pane, PTY write throws
    const tui = { paneId: "tui", role: "builder-1", startupCommand: "claude", dispatch: true };
    const done = reclaimScope(P, "task-1", "builder-2", tui, URL);
    await vi.advanceTimersByTimeAsync(20_000);
    const out = await done;
    expect(out).toMatchObject({ ok: false, fencedOpen: true });
    expect(isFenced(P, "builder-1")).toBe(true);
    expect(await injectPrompt(P, "tui", "builder-1", "go")).toBe(false); // no turn, no edits
  });

  it("aborts the losing turn instead of waiting it out — that turn IS the work being taken", async () => {
    // A TUI pane mid-turn. The polite path gives it up to 60 s to finish, which
    // here means 60 s more of editing a scope it has already lost.
    vi.useFakeTimers();
    output = Date.now(); // still painting
    const tui = { paneId: "tui", role: "builder-1", startupCommand: "claude", dispatch: true };
    const done = reclaimScope(P, "task-1", "builder-2", tui, URL);
    await vi.advanceTimersByTimeAsync(500);
    expect(writes.map((w) => w.data)).toEqual([interruptKey("claude")]); // first thing sent
    await vi.advanceTimersByTimeAsync(20_000);
    await done;
    expect(writes.map((w) => w.data)).toEqual([
      interruptKey("claude"),
      resetCommand("claude"), "\r", "\r", // then the ordinary wipe
    ]);
    expect(patched).toEqual([{ id: "tui", patch: { pendingPrompt: bootPrompt(P, URL, "builder-1") } }]);
  });

  it("still flips the owner when the losing builder's pane is gone", async () => {
    const out = await reclaimScope(P, "task-1", "", undefined, URL);
    expect(out.ok).toBe(true);
    expect(flips).toEqual([{ project: P, task: "task-1", to: "" }]);
    expect(restarts).toEqual([]);
  });
});
