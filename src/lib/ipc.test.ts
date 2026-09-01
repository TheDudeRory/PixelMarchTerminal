import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrainFeed } from "./ipc";

// Every wrapper here is a one-liner over `invoke`/`listen`, so the only thing
// worth testing is the only thing that can be wrong: the command/event NAME and
// the argument SHAPE. Both are contracts with Rust that TypeScript cannot check —
// a typo in a string literal compiles fine and fails at runtime in front of a user.
const calls: Array<{ cmd: string; args: unknown }> = [];
const listens: Array<{ event: string }> = [];
let listenPayload: (e: { payload: unknown }) => void = () => undefined;
/** Per-command canned answers for the feed tests; anything unset answers null,
 *  which is what every other test in this file expects. */
const answers: Record<string, (args: any) => unknown> = {};

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: unknown) => {
    calls.push({ cmd, args });
    return Promise.resolve(answers[cmd] ? answers[cmd](args) : null);
  },
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: (event: string, cb: (e: { payload: unknown }) => void) => {
    listens.push({ event });
    listenPayload = cb;
    return Promise.resolve(() => undefined);
  },
}));

const ipc = await import("./ipc");

beforeEach(() => {
  calls.length = 0;
  listens.length = 0;
  for (const k of Object.keys(answers)) delete answers[k];
});

describe("update ipc wrappers", () => {
  it("uses the command names src-tauri/src/update.rs registers", async () => {
    await ipc.updateConfigured();
    await ipc.appVersion();
    await ipc.checkUpdate();
    expect(calls.map((c) => c.cmd)).toEqual(["update_configured", "app_version", "check_update"]);
    // These three take no arguments — passing an args object to a command that
    // declares none is how a rename silently starts being ignored.
    expect(calls.every((c) => c.args === undefined)).toBe(true);
  });

  // `apply_update` takes NOTHING. The pull is --ff-only onto the branch's own
  // upstream, read from the checkout in Rust — an argument here would be a way
  // for this side to redirect where the machine gets code it then compiles.
  it("invokes apply_update with no arguments at all", async () => {
    await ipc.applyUpdate();
    expect(calls).toEqual([{ cmd: "apply_update", args: undefined }]);
  });

  it("unwraps the update-progress payload for the caller", async () => {
    const seen: unknown[] = [];
    await ipc.onUpdateProgress((p) => seen.push(p));
    expect(listens).toEqual([{ event: "update-progress" }]);
    // The wrapper exists to hand the component a payload, not a Tauri event
    // envelope. A build emits lines, not byte counts — there is no total here
    // and no percentage to be derived from one.
    const p = { step: 4, steps: 4, command: "cargo build --release", line: "   Compiling pixelmarch" };
    listenPayload({ payload: p });
    expect(seen).toEqual([p]);
  });
});

// ── the shared swarm feed ──────────────────────────────────────────────────
// The whole point of the feed is WHAT IT DOES NOT CALL: one poller per project
// instead of one per component, and a note body read once instead of every tick.
// So these tests count IPC calls — that is the behaviour, not an implementation
// detail.
describe("brain feed", () => {
  const store: Record<string, string> = {};
  const seed = (notes: Record<string, string>) => {
    for (const k of Object.keys(store)) delete store[k];
    Object.assign(store, notes);
    answers["brain_keys"] = () => Object.keys(store).sort();
    answers["brain_tasks"] = () => [];
    answers["brain_note"] = (a: { key: string }) => store[a.key] ?? null;
    answers["brain_search"] = () =>
      Object.entries(store).map(([key, value]) => ({ project: "p", key, value, updated: 100, elsewhere: false }));
  };
  const last = (a: BrainFeed[]) => a[a.length - 1];
  const counts = () => calls.reduce<Record<string, number>>((n, c) => ({ ...n, [c.cmd]: (n[c.cmd] ?? 0) + 1 }), {});

  beforeEach(() => {
    vi.useFakeTimers();
    seed({ "chat-human-1": "to: coordinator\nhi", "plan": "the plan", "task-1": "status: open" });
  });
  afterEach(() => { vi.useRealTimers(); });

  it("costs two calls a tick once the bodies it wants are cached", async () => {
    const seen: BrainFeed[] = [];
    const stop = ipc.subscribeBrainFeed("p", { intervalMs: 1000, prefixes: ["chat-"], watch: ["plan"] }, (f) => seen.push(f));
    await vi.advanceTimersByTimeAsync(10);
    // First pass: keys + tasks, the seeding search, and the watched body.
    expect(counts()).toMatchObject({ brain_keys: 1, brain_tasks: 1, brain_search: 1 });
    expect(last(seen).notes["chat-human-1"].value).toBe("to: coordinator\nhi");
    expect(last(seen).notes["plan"].value).toBe("the plan");

    calls.length = 0;
    await vi.advanceTimersByTimeAsync(3000); // three more ticks
    const c = counts();
    expect(c.brain_keys).toBe(3);
    expect(c.brain_tasks).toBe(3);
    // The chat body is cached and the watched body is inside its refresh gap:
    // nothing re-reads either, and no full-store search runs.
    expect(c.brain_note ?? 0).toBe(0);
    expect(c.brain_search ?? 0).toBe(0);
    stop();
  });

  it("reads a NEW note's body once, on the tick its key appears", async () => {
    const stop = ipc.subscribeBrainFeed("p", { intervalMs: 1000, prefixes: ["chat-"] }, () => undefined);
    await vi.advanceTimersByTimeAsync(10);
    calls.length = 0;
    store["chat-coordinator-1"] = "to: human\nreply";
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls.filter((c) => c.cmd === "brain_note").map((c) => (c.args as any).key)).toEqual(["chat-coordinator-1"]);
    calls.length = 0;
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls.some((c) => c.cmd === "brain_note")).toBe(false);
    stop();
  });

  it("serves every subscriber of a project from ONE poller, at the fastest cadence asked for", async () => {
    const a = ipc.subscribeBrainFeed("p", { intervalMs: 5000, tasks: false }, () => undefined);
    const b = ipc.subscribeBrainFeed("p", { intervalMs: 1000 }, () => undefined);
    await vi.advanceTimersByTimeAsync(10);
    calls.length = 0;
    await vi.advanceTimersByTimeAsync(2000);
    expect(counts().brain_keys).toBe(2); // 1000ms, not 5000 and not 2+2
    b();
    calls.length = 0;
    await vi.advanceTimersByTimeAsync(5000); // only the 5s subscriber is left
    expect(counts().brain_keys).toBe(1);
    expect(counts().brain_tasks ?? 0).toBe(0); // nobody wants the task bus now
    a();
  });

  it("stops polling entirely once the last subscriber goes", async () => {
    const stop = ipc.subscribeBrainFeed("p", { intervalMs: 1000 }, () => undefined);
    await vi.advanceTimersByTimeAsync(10);
    stop();
    calls.length = 0;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toEqual([]);
  });

  it("folds our own save and delete into the feed without waiting for a tick", async () => {
    const seen: BrainFeed[] = [];
    const stop = ipc.subscribeBrainFeed("p", { intervalMs: 1000, prefixes: ["chat-"] }, (f) => seen.push(f));
    await vi.advanceTimersByTimeAsync(10);
    calls.length = 0;
    await ipc.brainSave("p", "chat-human-2", "to: coordinator\nsecond");
    expect(last(seen).notes["chat-human-2"].value).toBe("to: coordinator\nsecond");
    expect(calls.filter((c) => c.cmd === "brain_note")).toEqual([]); // no read-back
    // A consumed note must disappear from the KEYS too — swarmReset would
    // otherwise re-run the wipe it just finished on the very next tick.
    await ipc.brainDelete("p", "chat-human-2");
    expect(last(seen).keys).not.toContain("chat-human-2");
    expect(last(seen).notes["chat-human-2"]).toBeUndefined();
    stop();
  });

  it("does not let an in-flight tick resurrect a note deleted mid-tick", async () => {
    const seen: BrainFeed[] = [];
    store["reset-builder-1"] = "ready";
    const stop = ipc.subscribeBrainFeed("p", { intervalMs: 1000, prefixes: ["reset-"] }, (f) => seen.push(f));
    await vi.advanceTimersByTimeAsync(10);
    expect(last(seen).keys).toContain("reset-builder-1");

    // Hold the next tick's key read open, consume the note while that tick is in
    // flight, then let the tick finish with the key list it read BEFORE the
    // delete. The tick must not win: swarmReset would see a reset- key whose note
    // it has already acted on and re-brief the pane a second time.
    let release: (v: string[]) => void = () => undefined;
    answers["brain_keys"] = () => new Promise<string[]>((r) => { release = r; });
    await vi.advanceTimersByTimeAsync(1000);
    await ipc.brainDelete("p", "reset-builder-1");
    delete store["reset-builder-1"];
    release(["chat-human-1", "plan", "reset-builder-1", "task-1"]);
    await vi.advanceTimersByTimeAsync(10);
    expect(last(seen).keys).not.toContain("reset-builder-1");
    expect(last(seen).notes["reset-builder-1"]).toBeUndefined();
    stop();
  });

  it("keeps a message saved mid-tick, instead of dropping it for a round", async () => {
    const seen: BrainFeed[] = [];
    const stop = ipc.subscribeBrainFeed("p", { intervalMs: 1000, prefixes: ["chat-"] }, (f) => seen.push(f));
    await vi.advanceTimersByTimeAsync(10);
    let release: (v: string[]) => void = () => undefined;
    answers["brain_keys"] = () => new Promise<string[]>((r) => { release = r; });
    await vi.advanceTimersByTimeAsync(1000);
    await ipc.brainSave("p", "chat-human-2", "to: coordinator\nsecond");
    release(["chat-human-1", "plan", "task-1"]); // read before the save landed
    await vi.advanceTimersByTimeAsync(10);
    expect(last(seen).keys).toContain("chat-human-2");
    expect(last(seen).notes["chat-human-2"].value).toBe("to: coordinator\nsecond");
    stop();
  });

  it("does not cache an EMPTY brain URL — the URL file may not be written yet", async () => {
    // "" is not a fact about the process: run_host writes the URL file after it
    // binds, so an early ask legitimately answers "". Caching it would break the
    // agent briefs, swarmReset and swarmRunaway for the whole session.
    vi.resetModules();
    const fresh = await import("./ipc");
    answers["brain_url"] = () => "";
    calls.length = 0;
    expect(await fresh.brainUrl()).toBe("");
    answers["brain_url"] = () => "http://127.0.0.1:8734/t/live";
    expect(await fresh.brainUrl()).toBe("http://127.0.0.1:8734/t/live");
    expect(await fresh.brainUrl()).toBe("http://127.0.0.1:8734/t/live"); // now cached
    expect(calls.filter((c) => c.cmd === "brain_url").length).toBe(2);
  });

  it("asks the brain for its URL once, however many watchers want it", async () => {
    answers["brain_url"] = () => "http://127.0.0.1:8734/t/tok";
    calls.length = 0;
    expect(await ipc.brainUrl()).toBe("http://127.0.0.1:8734/t/tok");
    expect(await ipc.brainUrl()).toBe("http://127.0.0.1:8734/t/tok");
    expect(calls.filter((c) => c.cmd === "brain_url").length).toBe(1);
  });
});
