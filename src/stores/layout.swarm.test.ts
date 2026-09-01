// "Run concurrent", flipped on a LIVE workspace. The flag used to be write-once
// at swarm launch (SwarmDialog), so a swarm starved behind the app-global turn
// cap by ANOTHER swarm could only be freed by recreating it. These cover the two
// things the strip's chip depends on: the flip lands on the named workspace, and
// it lands on THAT ONE ONLY — a second swarm sharing the cap must not be exempted
// by accident, since that is the swarm holding the slots.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ setZoom: () => Promise.resolve() }) }));
vi.mock("../lib/terminalPool", () => ({
  setBroadcast: () => {},
  setScrollbackLimit: () => {},
  setLogging: () => {},
  restartTerminal: () => {},
  applyTerminalSettings: () => {},
  markRestoredPanes: () => {},
}));

const { useLayout } = await import("./layout");
const T = await import("../lib/layout-tree");

const swarmWorkspace = (name: string) => {
  useLayout.getState().addWorkspaceWithRoot(name, T.newGroup(), name, true, true, ["builder"], false);
  return useLayout.getState().workspaces.find((w) => w.name === name)!;
};

describe("setSwarmConcurrent", () => {
  beforeEach(() => {
    const s = useLayout.getState();
    for (const w of s.workspaces.slice(1)) useLayout.getState().deleteWorkspace(w.id);
  });

  it("flips the flag on the workspace it names and leaves the other swarm under the cap", () => {
    const starved = swarmWorkspace("starved-swarm");
    const hog = swarmWorkspace("hog-swarm");

    useLayout.getState().setSwarmConcurrent(starved.id, true);

    const at = (id: string) => useLayout.getState().workspaces.find((w) => w.id === id)!;
    expect(at(starved.id).swarmConcurrent).toBe(true);
    expect(at(hog.id).swarmConcurrent).toBe(false);
    // Nothing else about the workspace may move — the panes are live agents.
    expect(at(starved.id).root).toBe(starved.root);
    expect(at(starved.id).swarm).toBe("starved-swarm");
  });

  it("turns back off, so a swarm can be put back under the cap", () => {
    const ws = swarmWorkspace("toggling-swarm");
    useLayout.getState().setSwarmConcurrent(ws.id, true);
    useLayout.getState().setSwarmConcurrent(ws.id, false);
    expect(useLayout.getState().workspaces.find((w) => w.id === ws.id)!.swarmConcurrent).toBe(false);
  });
});
