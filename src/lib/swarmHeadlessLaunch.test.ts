import { beforeEach, describe, expect, it, vi } from "vitest";

// The headless self-run's WIRING (the `--swarm <profile> <prompt>` path,
// task-5) — not the launch itself (swarmLaunch.test.ts covers that): the
// config a CLI request maps to, the hydration wait, the completion watch, and
// the on-complete exit wait. Same reason as the other watcher tests: the real
// modules drag in Tauri IPC and the layout store, and none of that is what is
// under test here — the WIRING of the self-run is.
const m = vi.hoisted(() => ({
  hydrated: false,
  layoutSubs: [] as ((s: { hydrated: boolean }) => void)[],
  feed: undefined as
    | { ready: boolean; keys: string[]; tasks: { status: string }[]; notes: Record<string, { value: string; updated: number }>; at: number }
    | undefined,
  feedCbs: [] as ((f: unknown) => void)[],
  ptyCbs: [] as ((p: { id: string; code: number | null }) => void)[],
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
vi.mock("./ipc", () => ({
  // These tests stop before the launch, so launchSwarm's brain/workspace
  // calls are never reached — only the feed/exit/quit surface matters.
  subscribeBrainFeed: (_project: string, _opts: unknown, cb: (f: unknown) => void) => {
    m.feedCbs.push(cb);
    return () => {
      const i = m.feedCbs.indexOf(cb);
      if (i >= 0) m.feedCbs.splice(i, 1);
    };
  },
  brainFeedNow: () => m.feed,
  onPtyExit: (cb: (p: { id: string; code: number | null }) => void) => {
    m.ptyCbs.push(cb);
    return Promise.resolve(() => {
      const i = m.ptyCbs.indexOf(cb);
      if (i >= 0) m.ptyCbs.splice(i, 1);
    });
  },
  quitApp: async () => {},
  detachQuit: async () => {},
}));
vi.mock("../stores/layout", () => ({
  useLayout: {
    getState: () => ({ hydrated: m.hydrated }),
    subscribe: (cb: (s: { hydrated: boolean }) => void) => {
      m.layoutSubs.push(cb);
      return () => {
        const i = m.layoutSubs.indexOf(cb);
        if (i >= 0) m.layoutSubs.splice(i, 1);
      };
    },
  },
}));

import { headlessSwarmConfig, waitForHydrated, waitForPtyExit, watchMissionDone, type HeadlessSwarmRequest } from "./swarmLaunch";

const REQ: HeadlessSwarmRequest = {
  mission: "Ship the thing",
  cwd: "/tmp/repo",
  agent: "claude --dangerously-skip-permissions",
  ownsHost: true,
};

const feedOf = (
  result: string | undefined,
  tasks: { status: string }[],
): NonNullable<typeof m.feed> => {
  const notes: Record<string, { value: string; updated: number }> = {};
  if (result !== undefined) notes.result = { value: result, updated: 1 };
  return {
    ready: true,
    keys: result !== undefined ? ["result"] : [],
    tasks,
    notes,
    at: 1,
  };
};

const stillPending = async (p: Promise<unknown>) => {
  let resolved = false;
  void p.then(() => {
    resolved = true;
  });
  await new Promise((r) => setTimeout(r, 0));
  return resolved;
};

beforeEach(() => {
  m.hydrated = false;
  m.layoutSubs.length = 0;
  m.feed = undefined;
  m.feedCbs.length = 0;
  m.ptyCbs.length = 0;
});

describe("headlessSwarmConfig — the CLI request -> SwarmConfig mapping", () => {
  it("maps mission, cwd and the agent command onto the dialog's default team", () => {
    const cfg = headlessSwarmConfig(REQ);
    expect(cfg.mission).toBe("Ship the thing");
    expect(cfg.cwd).toBe("/tmp/repo");
    // The default team, untouched: 2 builders, scout, 1 reviewer.
    expect(cfg.builders).toBe(2);
    expect(cfg.scout).toBe(true);
    expect(cfg.reviewers).toBe(1);
    // The launch defaults that make a self-run usable unattended.
    expect(cfg.headless).toBe(true);
    expect(cfg.hostDispatch).toBe(true);
    expect(cfg.lazyWorkers).toBe(true);
    expect(cfg.skipPermissions).toBe(true);
    expect(cfg.onComplete ?? "").toBe("");
    // Every role runs the profile's command.
    expect(cfg.agentCmds).toEqual({
      coordinator: REQ.agent,
      builders: [REQ.agent, REQ.agent],
      scout: REQ.agent,
      reviewer: REQ.agent,
      reviewers: [REQ.agent],
    });
  });
});

describe("watchMissionDone — the completion gate", () => {
  const tick = (feed: NonNullable<typeof m.feed>) => {
    m.feed = feed;
    for (const cb of [...m.feedCbs]) cb(feed);
  };

  // "In flight" is claimed/changes/done/approved (swarm.ts) — done work is
  // still WAITING at the merge gate. The mission completes when a result note
  // exists AND the last task has left the bus (or sits open/blocked).

  it("resolves on a non-empty result once the bus is clear", async () => {
    const p = watchMissionDone("proj");
    tick(feedOf("All done.", []));
    await expect(p).resolves.toBeUndefined();
    // The subscription is released with the promise.
    expect(m.feedCbs).toHaveLength(0);
  });

  it("waits while any task is still in flight, even with a result", async () => {
    const p = watchMissionDone("proj");
    tick(feedOf("Half there.", [{ status: "done" }, { status: "open" }]));
    expect(await stillPending(p)).toBe(false);
    tick(feedOf("All done.", []));
    await expect(p).resolves.toBeUndefined();
  });

  it("ignores an empty result note", async () => {
    const p = watchMissionDone("proj");
    tick(feedOf("   ", []));
    expect(await stillPending(p)).toBe(false);
    tick(feedOf("Done.", []));
    await expect(p).resolves.toBeUndefined();
  });
});

describe("waitForHydrated", () => {
  it("resolves immediately when already hydrated", async () => {
    m.hydrated = true;
    await expect(waitForHydrated(1000)).resolves.toBeUndefined();
    expect(m.layoutSubs).toHaveLength(0);
  });

  it("resolves when the store hydrates later", async () => {
    const p = waitForHydrated(10_000);
    expect(m.layoutSubs).toHaveLength(1);
    for (const cb of [...m.layoutSubs]) cb({ hydrated: true });
    await expect(p).resolves.toBeUndefined();
    expect(m.layoutSubs).toHaveLength(0);
  });

  it("rejects when the layout never hydrates", async () => {
    vi.useFakeTimers();
    try {
      const p = waitForHydrated(1000).then(
        () => "resolved",
        (e: Error) => e.message,
      );
      vi.advanceTimersByTime(1000);
      await expect(p).resolves.toContain("never hydrated");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("waitForPtyExit — the on-complete hook exit wait", () => {
  it("resolves when the named session exits, and ignores other sessions", async () => {
    const p = waitForPtyExit("swarm-oncomplete-proj", 60_000);
    expect(m.ptyCbs).toHaveLength(1);
    m.ptyCbs[0]({ id: "some-other-pane", code: 0 });
    expect(await stillPending(p)).toBe(false);
    m.ptyCbs[0]({ id: "swarm-oncomplete-proj", code: 0 });
    await expect(p).resolves.toBeUndefined();
  });

  it("gives up after the cap so a hanging hook cannot hang the process", async () => {
    vi.useFakeTimers();
    try {
      const p = waitForPtyExit("swarm-oncomplete-proj", 1000).then(() => "cap");
      vi.advanceTimersByTime(1000);
      await expect(p).resolves.toBe("cap");
    } finally {
      vi.useRealTimers();
    }
  });
});
