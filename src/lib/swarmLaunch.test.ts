import { beforeEach, describe, expect, it, vi } from "vitest";

// The whole brain/workspace side of the launch, recorded in call order — every
// note write and every repo touch — plus the knobs each test turns (which
// untracked files the repo has, what the config-file commands answer, what the
// brain URL is). Same reason as the other watcher tests: the real modules drag
// in Tauri IPC and the layout store, and none of that is what is under test
// here — the WIRING of the launch is.
const m = vi.hoisted(() => ({
  rec: {
    brainSave: [] as { project: string; key: string; value: string }[],
    ensureGitRepo: [] as string[],
    sweep: [] as { cwd: string; live: boolean }[],
    reclaim: [] as string[],
    guardInstall: [] as string[],
    register: [] as { project: string; roles: string[] }[],
    mcpConfig: [] as { url: string; project: string; role: string }[],
    addWorkspace: [] as { name: string; root: unknown; swarm: unknown; resets: unknown; dispatch: unknown; clearRoles: unknown; concurrent: unknown }[],
    summary: [] as boolean[],
    toasts: [] as string[],
  },
  brainUrl: "",
  gitPrep: "",
  untrackedFiles: [] as string[],
  hookPath: "",
  mcpPath: "",
  workspaces: [] as unknown[],
  invokeMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: m.invokeMock }));
vi.mock("./ipc", () => ({
  brainUrl: () => Promise.resolve(m.brainUrl),
  brainSave: (project: string, key: string, value: string) => {
    m.rec.brainSave.push({ project, key, value });
    return Promise.resolve();
  },
  ensureGitRepo: (cwd: string) => {
    m.rec.ensureGitRepo.push(cwd);
    return Promise.resolve(m.gitPrep);
  },
  swarmUntracked: () => Promise.resolve({ ok: true, untracked: m.untrackedFiles.length > 0, files: [...m.untrackedFiles] }),
  // No live swarm on this repo: locked false, so the launch reclaims and sweeps.
  swarmGuardProbe: () => Promise.resolve({ ok: true, locked: false, live: false, ours: false }),
  swarmReclaim: (cwd: string) => {
    m.rec.reclaim.push(cwd);
    return Promise.resolve({ ok: true, cleared: [] });
  },
  swarmWorktreeSweep: (cwd: string, live: boolean) => {
    m.rec.sweep.push({ cwd, live });
    return Promise.resolve({ ok: true, swept: [], kept: [] });
  },
  swarmGuardInstall: (cwd: string) => {
    m.rec.guardInstall.push(cwd);
    return Promise.resolve({ ok: true });
  },
  // One token-carrying URL per role — the identity the briefs and panes must
  // thread through.
  swarmRegisterAgents: (project: string, roles: string[]) => {
    m.rec.register.push({ project, roles });
    return Promise.resolve(Object.fromEntries(roles.map((r) => [r, `http://127.0.0.1:8734/t/${r}`])));
  },
  swarmMcpConfig: (url: string, project: string, role: string) => {
    m.rec.mcpConfig.push({ url, project, role });
    return Promise.resolve("/tmp/mcp.json");
  },
}));
vi.mock("../stores/layout", () => ({
  useLayout: {
    getState: () => ({
      workspaces: m.workspaces,
      addWorkspaceWithRoot: (name: string, root: unknown, swarm?: string, swarmResets?: boolean, swarmDispatch?: boolean, swarmClearRoles?: string[], swarmConcurrent?: boolean) => {
        m.rec.addWorkspace.push({ name, root, swarm, resets: swarmResets, dispatch: swarmDispatch, clearRoles: swarmClearRoles, concurrent: swarmConcurrent });
      },
      openSwarmSummary: (open: boolean) => {
        m.rec.summary.push(open);
      },
      addToast: (msg: string) => {
        m.rec.toasts.push(msg);
      },
    }),
  },
}));

import { collectPanes, isTerminal, type LayoutNode } from "./layout-tree";
import { DEFAULT_SWARM, parentProject, protocolNotes, type SwarmConfig } from "./swarm";
import { launchSwarm, untrackedSignature, UntrackedFilesError } from "./swarmLaunch";

const REPO = "/tmp/swarm-repo";
const URL = "http://127.0.0.1:8734/t/sess";
// The team DEFAULT_SWARM spawns (2 builders, scout, 1 reviewer) — the same
// names swarmRoles() mints, in ITS order (builders before scout).
const ROLES = ["coordinator", "builder-1", "builder-2", "scout", "reviewer-1"];

const cfg = (p: Partial<SwarmConfig> = {}): SwarmConfig => ({ ...DEFAULT_SWARM, mission: "Ship the thing", cwd: REPO, ...p });
const note = (key: string) => m.rec.brainSave.find((c) => c.key === key);
const projectOf = () => m.rec.brainSave[0]?.project ?? "";

beforeEach(() => {
  for (const k of Object.keys(m.rec) as (keyof typeof m.rec)[]) m.rec[k].length = 0;
  m.brainUrl = URL;
  m.gitPrep = "";
  m.untrackedFiles.length = 0;
  m.hookPath = "";
  m.mcpPath = "";
  m.workspaces.length = 0;
  m.invokeMock.mockReset();
  m.invokeMock.mockImplementation((cmd: string) => Promise.resolve(cmd === "hook_settings_path" ? m.hookPath : m.mcpPath));
});

describe("launchSwarm — the shared launch (dialog and headless CLI both call it)", () => {
  it("writes the mission, one brief per role, the protocol notes and on-complete — all to the same fresh project", async () => {
    await launchSwarm(cfg());
    const project = projectOf();
    expect(project).toMatch(new RegExp(`^${parentProject(REPO)}-swarm-ship-the-thing-[0-9a-f]{4}$`));
    expect(m.rec.brainSave[0]).toEqual({ project, key: "mission", value: "Ship the thing" });
    for (const name of ROLES) {
      const n = note(`role-${name}`);
      expect(n?.project).toBe(project);
      expect(n?.value?.length).toBeGreaterThan(0);
    }
    // The per-role identity is threaded into the briefs: the role's own
    // token-carrying URL, not the session one the launch started with.
    expect(note("role-coordinator")?.value).toContain("http://127.0.0.1:8734/t/coordinator");
    // The situational protocol sections, exactly what protocolNotes() computes
    // for this launch (no resets, host dispatch on, not solo — 2 builders).
    for (const p of protocolNotes(project, URL, parentProject(REPO), false, true, false)) {
      expect(note(p.key)).toEqual({ project, key: p.key, value: p.body });
    }
    // Written unconditionally: an empty body means "no hook".
    expect(note("on-complete")).toEqual({ project, key: "on-complete", value: "" });
    expect(new Set(m.rec.brainSave.map((c) => c.project))).toEqual(new Set([project]));
  });

  it("registers every role as an agent and writes a per-role MCP config", async () => {
    m.mcpPath = "/tmp/mcp.json";
    await launchSwarm(cfg());
    const project = projectOf();
    expect(m.rec.register).toEqual([{ project, roles: ROLES }]);
    expect(m.rec.mcpConfig.map((c) => [c.project, c.role, c.url])).toEqual(
      ROLES.map((r) => [project, r, `http://127.0.0.1:8734/t/${r}`]),
    );
    // The same config path lands on every pane's command line (claude is
    // MCP-capable), so the briefs' tool wording and the panes agree.
    const panes = collectPanes(m.rec.addWorkspace[0].root as LayoutNode).filter(isTerminal);
    expect(panes).toHaveLength(ROLES.length);
    for (const p of panes) expect(p.startupCommand ?? "").toContain("--mcp-config '/tmp/mcp.json'");
  });

  it("prepares the repo, opens the grid workspace with the swarm flags, and toasts the launch", async () => {
    m.gitPrep = "initialized";
    await launchSwarm(cfg());
    const project = projectOf();
    expect(m.rec.ensureGitRepo).toEqual([REPO]);
    expect(m.rec.sweep).toEqual([{ cwd: REPO, live: false }]);
    expect(m.rec.guardInstall).toEqual([REPO]);
    const w = m.rec.addWorkspace[0];
    expect([w.name, w.swarm, w.resets, w.dispatch, w.clearRoles, w.concurrent]).toEqual([project, project, false, true, [], false]);
    expect(m.rec.summary).toEqual([true]);
    expect(m.rec.toasts).toContain(`Swarm ${project} launched — 5 agents (initialized)`);
  });

  it("ships the onComplete commands verbatim as the on-complete note", async () => {
    await launchSwarm(cfg({ onComplete: "npm test\necho done" }));
    expect(note("on-complete")?.value).toBe("npm test\necho done");
  });

  it("fails clean, before writing anything, when the brain is not running", async () => {
    m.brainUrl = "";
    await expect(launchSwarm(cfg())).rejects.toThrow(/BigBrain is not running/);
    expect(m.rec.brainSave).toEqual([]);
    expect(m.rec.ensureGitRepo).toEqual([]);
    expect(m.rec.addWorkspace).toEqual([]);
  });

  it("refuses a config without a mission or a working directory", async () => {
    await expect(launchSwarm(cfg({ mission: "   " }))).rejects.toThrow(/Mission and working directory/);
    await expect(launchSwarm(cfg({ cwd: "  " }))).rejects.toThrow(/Mission and working directory/);
    expect(m.rec.brainSave).toEqual([]);
  });
});

describe("the untracked-root-files gate", () => {
  it("stops with UntrackedFilesError (nothing written) until the exact set is acked", async () => {
    m.untrackedFiles = ["b.ts", "a.ts"];
    let err: unknown;
    try {
      await launchSwarm(cfg());
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(UntrackedFilesError);
    expect((err as UntrackedFilesError).files).toEqual(["b.ts", "a.ts"]);
    // The message IS the warning, so a caller can just surface it.
    expect((err as Error).message).toContain("2 untracked files");
    expect((err as Error).message).toContain("a.ts");
    expect((err as Error).message).toContain("b.ts");
    // The gate fires before the sweep and before any note: relaunch is free.
    expect(m.rec.brainSave).toEqual([]);
    expect(m.rec.sweep).toEqual([]);

    const sig = untrackedSignature(["b.ts", "a.ts"]);
    expect(sig).toBe("a.ts|b.ts");
    // Acked: the same set passes and the launch completes.
    await launchSwarm(cfg(), { ackUntracked: sig });
    expect(note("mission")).toBeTruthy();

    // Commit one of the files and the warning comes back for what is still
    // untracked — the case a one-shot "already warned" flag gets wrong.
    m.untrackedFiles = ["a.ts"];
    await expect(launchSwarm(cfg(), { ackUntracked: sig })).rejects.toThrowError(UntrackedFilesError);
  });
});
