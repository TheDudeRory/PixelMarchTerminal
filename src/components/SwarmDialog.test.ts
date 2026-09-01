import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SWARM, MAX_REVIEWERS, swarmPanes, swarmRoles, type SwarmConfig } from "../lib/swarm";

// The one Tauri command this module calls. Hoisted so each test can decide what
// `hook_settings_path` answers — including answering badly.
const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

// Both components pull in the layout store -> terminalPool -> xterm, which
// touches `self` at import time and dies under vitest's node environment (no
// jsdom in this repo). Stub the pool: none of it runs in these tests.
const noop = () => undefined;
vi.mock("../lib/terminalPool", () => ({
  setBroadcast: noop,
  setScrollbackLimit: noop,
  setLogging: noop,
  restartTerminal: noop,
  applyTerminalSettings: noop,
  markRestoredPanes: noop,
}));

const { swarmTeamSize, SWARM_CATEGORIES, briefRoles, withRoleBrief, briefFileName, hookSettingsPath, headlessRoleCount, untrackedWarning } = await import("./SwarmDialog");
const { roleOptions } = await import("./panes/PaneRoleMenu");

const cfg = (p: Partial<SwarmConfig>): SwarmConfig => ({ ...DEFAULT_SWARM, ...p });

describe("swarmTeamSize", () => {
  it("counts coordinator + builders + scout + every reviewer", () => {
    expect(swarmTeamSize(cfg({ builders: 2, scout: true, reviewers: 3, reviewer: undefined }))).toBe(7);
  });

  it("drops the reviewers when the count is zero", () => {
    expect(swarmTeamSize(cfg({ builders: 1, scout: false, reviewers: 0, reviewer: undefined }))).toBe(2);
  });

  it("still reads a legacy reviewer:false config as no reviewers", () => {
    expect(swarmTeamSize(cfg({ builders: 1, scout: false, reviewers: 2, reviewer: false }))).toBe(2);
  });

  it("clamps the reviewer count to MAX_REVIEWERS", () => {
    const huge = swarmTeamSize(cfg({ builders: 1, scout: false, reviewers: 99, reviewer: undefined }));
    expect(huge).toBe(1 + 1 + MAX_REVIEWERS);
  });
});

// Phase A's last wire: the hook settings path has to reach swarmPanes, or the
// settings file is written and no pane is ever launched with --settings.
describe("hookSettingsPath", () => {
  beforeEach(() => {
    // Sticky by design elsewhere: a background caller picking up a throwing
    // implementation would surface as an unhandled rejection in an unrelated
    // test, so the default is always a benign "".
    invokeMock.mockReset();
    invokeMock.mockResolvedValue("");
  });

  it("asks the Rust side for the path and hands it back", async () => {
    invokeMock.mockResolvedValue("/state/pixelmarch-hooks.json");
    expect(await hookSettingsPath()).toBe("/state/pixelmarch-hooks.json");
    expect(invokeMock).toHaveBeenCalledWith("hook_settings_path");
  });

  it("is asked per launch, never cached — a restarted brain moves port and token", async () => {
    invokeMock.mockResolvedValueOnce("/a.json").mockResolvedValueOnce("/b.json");
    expect(await hookSettingsPath()).toBe("/a.json");
    expect(await hookSettingsPath()).toBe("/b.json");
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });

  it("degrades to '' — an older binary without the command must not fail the launch", async () => {
    invokeMock.mockImplementationOnce(async () => { throw new Error("Unknown command: hook_settings_path"); });
    expect(await hookSettingsPath()).toBe("");
  });

  it("degrades to '' on a non-string answer rather than passing it into the command line", async () => {
    invokeMock.mockResolvedValue(null);
    expect(await hookSettingsPath()).toBe("");
  });

  it("threads into every pane's boot command as --settings, and '' leaves today's command line", async () => {
    const claude = cfg({ agentCmds: { coordinator: "claude", scout: "claude", reviewer: "claude" }, lazyWorkers: false });
    invokeMock.mockResolvedValue("/state/pixelmarch-hooks.json");
    const withHooks = swarmPanes("swarm-x", "http://127.0.0.1:1/t/tok", claude, await hookSettingsPath());
    expect(withHooks.length).toBeGreaterThan(1);
    for (const p of withHooks) expect(p.startupCommand).toContain("--settings '/state/pixelmarch-hooks.json'");

    invokeMock.mockImplementationOnce(async () => { throw new Error("no brain"); });
    const without = swarmPanes("swarm-x", "http://127.0.0.1:1/t/tok", claude, await hookSettingsPath());
    for (const p of without) expect(p.startupCommand).not.toContain("--settings");
  });
});

// Phase C's equivalent wire. `cfg.headless` was read by swarmPanes from the day
// task-5 landed and set by NOTHING — no dialog control existed, so every Phase C
// pane in the app was unreachable. The toggle is only offered when it would
// actually change a command line, and this proves both halves.
describe("headlessRoleCount", () => {
  it("counts the roles whose CLI can actually be driven as a stream", () => {
    const claude = cfg({ builders: 2, scout: true, reviewers: 1, reviewer: undefined });
    expect(headlessRoleCount(claude)).toBe(swarmTeamSize(claude)); // claude: verified headless
  });

  it("is zero when no configured CLI can — so the switch is never offered as a no-op", () => {
    expect(headlessRoleCount(cfg({
      builders: 1, scout: false, reviewers: 0, reviewer: undefined,
      agentCmds: { coordinator: "codex", builders: ["codex"], scout: "codex", reviewer: "codex", reviewers: [] },
    }))).toBe(0);
  });

  it("counts only the headless-capable half of a mixed team", () => {
    const mixed = cfg({
      builders: 2, scout: false, reviewers: 0, reviewer: undefined,
      agentCmds: { coordinator: "claude", builders: ["claude", "gemini"], scout: "claude", reviewer: "claude", reviewers: [] },
    });
    expect(headlessRoleCount(mixed)).toBe(2); // coordinator + builder-1
  });

  it("turns into real piped panes, and leaves the others exactly as today", async () => {
    const { spawnModeFor } = await import("../lib/swarm");
    const base = cfg({
      builders: 2, scout: false, reviewers: 0, reviewer: undefined, lazyWorkers: false,
      agentCmds: { coordinator: "claude", builders: ["claude", "gemini"], scout: "claude", reviewer: "claude", reviewers: [] },
    });
    const off = swarmPanes("swarm-x", "http://127.0.0.1:1/t/tok", { ...base, headless: false });
    for (const p of off) expect(spawnModeFor(p.startupCommand ?? "")).toBe("pty");

    const on = swarmPanes("swarm-x", "http://127.0.0.1:1/t/tok", { ...base, headless: true });
    const mode = (role: string) => spawnModeFor(on.find((p) => p.role === role)?.startupCommand ?? "");
    expect(mode("coordinator")).toBe("piped");
    expect(mode("builder-1")).toBe("piped");
    expect(mode("builder-2")).toBe("pty"); // gemini has no verified headless mode
  });
});

describe("SWARM_CATEGORIES", () => {
  it("has no behaviour category — those toggles moved into Mission", () => {
    expect(SWARM_CATEGORIES.map((c) => c.id)).toEqual(["mission", "team", "commands"]);
  });

  it("keeps mission first, so launch()'s validation jump lands on a real category", () => {
    expect(SWARM_CATEGORIES[0].id).toBe("mission");
  });
});

describe("briefRoles", () => {
  it("offers every role the config will actually spawn", () => {
    expect(briefRoles(cfg({ builders: 2, scout: true, reviewers: 2, reviewer: undefined })))
      .toEqual(["coordinator", "scout", "builder-1", "builder-2", "reviewer-1", "reviewer-2"]);
  });

  it("drops the scout when it is off and the reviewers when the count is zero", () => {
    expect(briefRoles(cfg({ builders: 1, scout: false, reviewers: 0, reviewer: undefined })))
      .toEqual(["coordinator", "builder-1"]);
  });

  it("reads the reviewer count the way the launch does (legacy boolean included)", () => {
    expect(briefRoles(cfg({ builders: 1, scout: false, reviewers: 2, reviewer: false })))
      .toEqual(["coordinator", "builder-1"]);
    expect(briefRoles(cfg({ builders: 1, scout: false, reviewers: 99, reviewer: undefined })))
      .toHaveLength(2 + MAX_REVIEWERS);
  });

  it("always keeps at least one builder, matching swarmRoles()", () => {
    expect(briefRoles(cfg({ builders: 0, scout: false, reviewers: 0, reviewer: undefined })))
      .toEqual(["coordinator", "builder-1"]);
  });

  it("names roles swarmRoles() actually mints, so no brief can be orphaned", () => {
    const c = cfg({ builders: 2, scout: true, reviewers: 1, reviewer: undefined });
    const minted = swarmRoles("proj", "http://127.0.0.1:8734", c).map((r) => r.name);
    expect([...briefRoles(c)].sort()).toEqual([...minted].sort());
  });
});

describe("withRoleBrief", () => {
  const md = { path: "/tmp/coordinator.md", body: "# be terse" };

  it("adds an entry to an absent map without mutating anything", () => {
    expect(withRoleBrief(undefined, "coordinator", md)).toEqual({ coordinator: md });
  });

  it("leaves the other roles alone", () => {
    const before = { scout: md };
    const after = withRoleBrief(before, "builder-1", md);
    expect(after).toEqual({ scout: md, "builder-1": md });
    expect(before).toEqual({ scout: md });
  });

  it("deletes the entry on clear, so cleared and never-picked are the same state", () => {
    expect(withRoleBrief({ coordinator: md }, "coordinator", null)).toEqual({});
  });

  it("clearing a role that has no brief is a no-op", () => {
    expect(withRoleBrief({ scout: md }, "coordinator", null)).toEqual({ scout: md });
  });
});

describe("briefFileName", () => {
  it("shows the filename of a posix path", () => {
    expect(briefFileName("/home/me/briefs/reviewer.md")).toBe("reviewer.md");
  });

  it("shows the filename of a windows path", () => {
    expect(briefFileName("C:\\briefs\\coordinator.md")).toBe("coordinator.md");
  });

  it("passes a bare filename through", () => {
    expect(briefFileName("scout.md")).toBe("scout.md");
  });
});

const pane = (id: string, role?: string) => ({ id, title: id, role }) as never;

describe("roleOptions", () => {
  it("offers the canonical roles and marks the free ones", () => {
    const opts = roleOptions([pane("p1")], "p1");
    expect(opts.map((o) => o.role)).toContain("coordinator");
    expect(opts.filter((o) => o.role.startsWith("reviewer-"))).toHaveLength(MAX_REVIEWERS);
    expect(opts.every((o) => !o.taken)).toBe(true);
  });

  it("marks a role held by another pane as taken", () => {
    const opts = roleOptions([pane("p1"), pane("p2", "coordinator")], "p1");
    expect(opts.find((o) => o.role === "coordinator")?.taken).toBe(true);
    expect(opts.find((o) => o.role === "builder-1")?.taken).toBe(false);
  });

  it("does not mark the edited pane's own role as taken", () => {
    const opts = roleOptions([pane("p1", "builder-2")], "p1");
    expect(opts.find((o) => o.role === "builder-2")?.taken).toBe(false);
  });

  it("keeps a non-canonical role in the list so it is never offered as free", () => {
    // Bare "reviewer" is what pre-multi-reviewer workspaces carry.
    const opts = roleOptions([pane("p1"), pane("p2", "reviewer")], "p1");
    expect(opts.find((o) => o.role === "reviewer")?.taken).toBe(true);
  });

  it("ignores a pane whose role is not a real role", () => {
    const opts = roleOptions([pane("p1"), pane("p2", "Terminal 3")], "p1");
    expect(opts.some((o) => o.role === "Terminal 3")).toBe(false);
  });
});

describe("untrackedWarning", () => {
  it("names the files, because a count alone is a sentence people dismiss", () => {
    const msg = untrackedWarning(["src/admin/Users.tsx", "src/dashboard/Panel.tsx"]);
    expect(msg).toContain("src/admin/Users.tsx");
    expect(msg).toContain("src/dashboard/Panel.tsx");
    expect(msg).toContain("2 untracked files");
  });

  it("says WHY it matters — the worktree is checked out from a commit", () => {
    expect(untrackedWarning(["a.ts"])).toContain("COMMIT");
  });

  it("reads correctly for a single file", () => {
    const msg = untrackedWarning(["a.ts"]);
    expect(msg).toContain("1 untracked file in the repo root (a.ts)");
    expect(msg).not.toContain("untracked files");
  });

  it("caps the list rather than printing a whole tree into the footer", () => {
    const msg = untrackedWarning(["a", "b", "c", "d", "e", "f", "g", "h"]);
    expect(msg).toContain("+2 more");
    expect(msg).not.toContain(", g");
  });
});
