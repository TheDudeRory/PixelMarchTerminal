import { getCurrentWebview } from "@tauri-apps/api/webview";
import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";
import * as T from "../lib/layout-tree";
import type { KeepAlive, Keymap, Persisted, Settings, Workspace } from "../lib/persist";
import { newProfile, paneFromProfile, starterProfiles, type PaneProfile, type ShellInfo } from "../lib/profiles";
import { newCliProfile, type CliProfile } from "../lib/cliProfiles";
import { useSwarmTelemetry } from "./swarmTelemetry";
import { ROLE_RE, migratePaneRoles } from "../lib/swarm";
import { setBroadcast as poolSetBroadcast, setScrollbackLimit as poolSetScrollback, setLogging as poolSetLogging, restartTerminal as poolRestart, applyTerminalSettings as poolApplyTermSettings, markRestoredPanes } from "../lib/terminalPool";

export type { Workspace, KeepAlive } from "../lib/persist";
export type { PaneProfile, ShellInfo } from "../lib/profiles";
export type FocusDir = "left" | "right" | "up" | "down";

export interface PaneStatus {
  startedAt: number;
  exit?: { code: number | null; at: number };
}

const DEFAULT_SETTINGS: Settings = {
  scrollbackLimit: 10000,
  notifyThresholdSec: 30,
  theme: "dark",
  fontFamily: 'Cascadia Code, MesloLGS Nerd Font Mono, Hack, Consolas, "Courier New", DejaVu Sans Mono, monospace',
  fontSize: 14,
  uiScale: 1,
  ligatures: false,
  cursorStyle: "block",
  confirmOnClose: true,
  startupWorkspaceId: null,
  gpuAcceleration: true, // WebGL renderer by default (#4); DOM fallback on context loss
  welcomeDismissed: false,
};

/** Default keyboard bindings (action id -> combo). Mirrors the hardcoded
 *  handlers in App.tsx handleKey; the Keybinds settings category edits these
 *  and the central handler is refactored to look them up (task-6). */
export const DEFAULT_KEYMAP: Keymap = {
  palette: "Ctrl+Shift+P",
  settings: "Ctrl+,",
  find: "Ctrl+F",
  help: "Ctrl+/",
  zoomIn: "Ctrl+=",
  zoomOut: "Ctrl+-",
  resetScale: "Ctrl+0",
  splitHorizontal: "Alt+Shift+=",
  splitVertical: "Alt+Shift+-",
  newTab: "Ctrl+Shift+T",
  closePane: "Ctrl+Shift+W",
  zoomPane: "Ctrl+Shift+Z",
  broadcast: "Ctrl+Shift+B",
  bigBrain: "Ctrl+Shift+M",
  equalize: "Ctrl+Alt+0",
  moveFocusLeft: "Ctrl+Alt+Left",
  moveFocusRight: "Ctrl+Alt+Right",
  moveFocusUp: "Ctrl+Alt+Up",
  moveFocusDown: "Ctrl+Alt+Down",
};

/** Push settings into the terminal pool + document theme attribute. */
export function applySettings(s: Settings): void {
  poolSetScrollback(s.scrollbackLimit);
  poolApplyTermSettings({ fontFamily: s.fontFamily, fontSize: s.fontSize, cursorStyle: s.cursorStyle, theme: s.theme, ligatures: s.ligatures, gpu: s.gpuAcceleration });
  if (typeof document !== "undefined") document.documentElement.setAttribute("data-theme", s.theme);
  // Native webview zoom scales the whole UI crisply (incl. terminal canvases).
  // Falls back to CSS zoom when not running under Tauri (plain browser dev).
  const scale = s.uiScale > 0 ? s.uiScale : 1;
  const cssZoom = () => {
    if (typeof document !== "undefined") (document.documentElement.style as any).zoom = String(scale);
  };
  try {
    getCurrentWebview().setZoom(scale).catch(cssZoom);
  } catch {
    cssZoom(); // not under Tauri (plain browser dev)
  }
}

export interface Toast {
  id: string;
  msg: string;
}

const uid = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : Math.random().toString(36).slice(2);

const COLORS = ["#4c8bf5", "#e0a44c", "#5fbf6a", "#c576d6", "#e06c6c", "#46c7c7", "#b48ead"];
const nextColor = (n: number) => COLORS[n % COLORS.length];

const now = () => Date.now();

function newWorkspace(name: string, colorIdx: number, pane: T.Pane = T.newPane()): Workspace {
  const g = T.newGroup(pane);
  return { id: uid(), name, color: nextColor(colorIdx), root: g, focusedPaneId: g.activeId, createdAt: now(), lastOpenedAt: now(), keepAlive: "keep" };
}

/** Nearest group in a direction, by rendered geometry (data-group-id rects). */
function spatialNeighbor(fromGroupId: string, dir: FocusDir): string | null {
  const els = [...document.querySelectorAll<HTMLElement>("[data-group-id]")];
  const from = els.find((e) => e.dataset.groupId === fromGroupId);
  if (!from) return null;
  const fr = from.getBoundingClientRect();
  const fx = fr.left + fr.width / 2;
  const fy = fr.top + fr.height / 2;
  let best: { id: string; dist: number } | null = null;
  for (const el of els) {
    const id = el.dataset.groupId!;
    if (id === fromGroupId) continue;
    const r = el.getBoundingClientRect();
    const dx = r.left + r.width / 2 - fx;
    const dy = r.top + r.height / 2 - fy;
    const inDir =
      dir === "left" ? dx < -1 && Math.abs(dx) >= Math.abs(dy) :
      dir === "right" ? dx > 1 && Math.abs(dx) >= Math.abs(dy) :
      dir === "up" ? dy < -1 && Math.abs(dy) >= Math.abs(dx) :
      dy > 1 && Math.abs(dy) >= Math.abs(dx);
    if (!inDir) continue;
    const dist = Math.hypot(dx, dy);
    if (!best || dist < best.dist) best = { id, dist };
  }
  return best?.id ?? null;
}

export interface DragState {
  paneId: string;
  title: string;
  x: number;
  y: number;
  target: T.DropTarget | null;
}

export interface PendingConfirm {
  message: string;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
}

interface LayoutState {
  workspaces: Workspace[];
  activeId: string;
  hydrated: boolean;
  // True when startup found NO saved layout to restore — i.e. a genuinely fresh
  // profile. Set by markHydrated (the branch App.tsx takes when loadPersisted
  // returns null); FirstRun.tsx uses it to show the welcome exactly once.
  freshProfile: boolean;
  sidebarCollapsed: boolean;
  // The newest-screenshot thumb is position:fixed at the bottom-left, i.e. on
  // top of the sidebar's tail. ScreenshotThumb publishes whether it is on
  // screen so the sidebar can keep the SWARMS separator clear of it. Session
  // state — never persisted.
  shotThumbVisible: boolean;

  zoomedGroupId: string | null;
  showHelp: boolean;
  drag: DragState | null;
  unread: Record<string, true>;
  pendingConfirm: PendingConfirm | null;

  // profiles
  profiles: PaneProfile[];
  defaultProfileId: string;
  cliProfiles: CliProfile[];
  detectedShells: ShellInfo[];
  paletteOpen: boolean;
  profileManagerOpen: boolean;

  // power features (M6)
  broadcast: string[];
  searchOpen: boolean;
  logging: Record<string, string>;
  paneStatus: Record<string, PaneStatus>;
  settings: Settings;

  toggleBroadcast(paneId: string): void;
  clearBroadcast(): void;
  openSearch(open: boolean): void;
  markStarted(paneId: string): void;
  markExited(paneId: string, code: number | null): void;
  setLogging(paneId: string, path: string | null): void;
  restartPane(paneId: string): void;
  updateSettings(patch: Partial<Settings>): void;

  // editable keybindings (task-6 consumes; scaffolded here)
  keymap: Keymap;
  setKeybind(action: string, combo: string): void;
  resetKeymap(): void;

  // settings window / quit / toasts (M7)
  settingsOpen: boolean;
  // Category the Settings modal should open on (null = keep whatever it showed
  // last). Lets another surface deep-link into a category.
  settingsCategory: string | null;
  hotkeysOpen: boolean; // Global Hotkeys menu (task-4)
  bigBrainOpen: boolean;
  galleryOpen: boolean; // screenshot gallery overlay
  swarmOpen: boolean;
  swarmMissionOpen: boolean;
  // Which SwarmChat tab is showing: the durable human<->coordinator channel or
  // the agent<->agent chatter. Held in the store so it survives a workspace
  // switch and a chat-bar remount within a session.
  swarmChatTab: "coordinator" | "agents";
  // Swarm summary grid instead of the terminal layout. Session-only (never
  // persisted): it is a view mode, and a restart that came up showing cards
  // rather than the terminals would read as "my panes are gone". Open means
  // LayoutView is UNMOUNTED — that is the point, since a detached pane div is
  // what lets terminalPool demote every pane to the headless tier.
  swarmSummaryOpen: boolean;
  quitOpen: boolean;
  toasts: Toast[];
  openSettings(open: boolean, category?: string): void;
  openHotkeys(open: boolean): void;
  openBigBrain(open: boolean): void;
  openGallery(open: boolean): void;
  openSwarm(open: boolean): void;
  toggleSwarmMission(): void;
  setSwarmChatTab(tab: "coordinator" | "agents"): void;
  openSwarmSummary(open: boolean): void;
  setQuitOpen(open: boolean): void;
  addToast(msg: string): void;
  removeToast(id: string): void;

  setDetectedShells(shells: ShellInfo[]): void;
  ensureProfiles(shells: ShellInfo[]): void;
  addProfile(): string;
  updateProfile(id: string, patch: Partial<PaneProfile>): void;
  deleteProfile(id: string): void;
  setDefaultProfile(id: string): void;
  reorderProfile(fromId: string, toId: string): void;
  addCliProfile(): string;
  updateCliProfile(id: string, patch: Partial<CliProfile>): void;
  deleteCliProfile(id: string): void;
  openPalette(open: boolean): void;
  openProfileManager(open: boolean): void;

  // layout (active workspace)
  focusPane(paneId: string): void;
  focusGroup(groupId: string): void;
  splitFocused(direction: T.Direction, profileId?: string): void;
  newTab(profileId?: string): void;
  /** Open a prebuilt pane as a tab beside the focused one. For panes the profile
   *  system cannot express — a one-off launch whose command is composed at click
   *  time (BigBrain's drift audit), where patching after newTab() would be too
   *  late: the pane spawns with the startupCommand it was created with. */
  openPaneTab(pane: T.Pane): void;
  selectTab(groupId: string, paneId: string): void;
  patchPane(paneId: string, patch: Partial<T.Pane>): void;
  /** Patch a pane in whichever workspace holds it — background swarm workspaces
   *  included (patchPane only reaches the active one). */
  patchPaneAnywhere(paneId: string, patch: Partial<T.Pane>): void;
  /** Assign or clear a pane's swarm role. Empty/undefined clears it (the pane
   *  becomes a human's shell again — uncounted by the turn budget, invisible to
   *  dispatch); anything ROLE_RE rejects is ignored, because a bogus role reads
   *  as "no role" everywhere downstream and would silently do nothing. Reaches
   *  background workspaces too: swarm panes are usually not the active one. */
  setPaneRole(paneId: string, role: string | undefined): void;
  requestClose(paneId: string): void;
  closePane(paneId: string): void;
  toggleZoom(): void;
  setZoom(groupId: string | null): void;
  equalizeAll(): void;
  setRatio(splitId: string, ratio: number): void;
  moveFocus(dir: FocusDir): void;
  applyPreset(id: T.PresetId): void;

  // drag
  startDrag(paneId: string, x: number, y: number): void;
  updateDrag(x: number, y: number, target: T.DropTarget | null): void;
  endDrag(): void;

  setShotThumbVisible(v: boolean): void;

  // workspaces
  switchWorkspace(id: string): void;
  addWorkspace(): void;
  /** Push a workspace with a prebuilt layout tree (swarm launch) and switch to it. */
  addWorkspaceWithRoot(name: string, root: T.LayoutNode, swarm?: string, swarmResets?: boolean, swarmDispatch?: boolean, swarmClearRoles?: string[], swarmConcurrent?: boolean): void;
  renameWorkspace(id: string, name: string): void;
  setWorkspaceColor(id: string, color: string): void;
  setKeepAlive(id: string, mode: KeepAlive): void;
  /** "Run concurrent" for a LIVE swarm workspace. Only ever set at launch before
   *  (SwarmDialog), so a swarm starved behind the app-global turn cap by ANOTHER
   *  swarm could not be freed without recreating it. swarmDispatch re-reads the
   *  flag every tick, so the flip takes effect on the next poll. */
  setSwarmConcurrent(id: string, on: boolean): void;
  duplicateWorkspace(id: string): void;
  requestDeleteWorkspace(id: string): void;
  deleteWorkspace(id: string): void;
  reorderWorkspace(fromId: string, toId: string): void;

  // activity
  /** Batched: terminalPool hands over one frame's worth of active pane ids. */
  markActivity(paneIds: string[]): void;
  clearVisibleUnread(): void;

  // confirm + ui
  askConfirm(cfg: PendingConfirm): void;
  resolveConfirm(): void;
  cancelConfirm(): void;
  toggleHelp(force?: boolean): void;
  toggleSidebar(): void;

  // persistence
  hydrate(p: Persisted): void;
  markHydrated(): void;
}

const getActive = (s: LayoutState): Workspace => s.workspaces.find((w) => w.id === s.activeId) ?? s.workspaces[0];
const patchActive = (s: LayoutState, fn: (ws: Workspace) => Partial<Workspace>) => ({
  workspaces: s.workspaces.map((w) => (w.id === s.activeId ? { ...w, ...fn(w) } : w)),
});

/** Build a pane from a profile (given id, else the default), or a plain shell. */
const makePane = (s: LayoutState, profileId?: string): T.Pane => {
  const p = s.profiles.find((x) => x.id === (profileId ?? s.defaultProfileId));
  return p ? paneFromProfile(p) : T.newPane();
};

const first = newWorkspace("Workspace 1", 0);

export const useLayout = create<LayoutState>()(subscribeWithSelector((set, get) => ({
  workspaces: [first],
  activeId: first.id,
  hydrated: false,
  freshProfile: false,
  sidebarCollapsed: false,
  shotThumbVisible: false,
  zoomedGroupId: null,
  showHelp: false,
  drag: null,
  unread: {},
  pendingConfirm: null,
  profiles: [],
  defaultProfileId: "",
  cliProfiles: [],
  detectedShells: [],
  paletteOpen: false,
  profileManagerOpen: false,

  broadcast: [],
  searchOpen: false,
  logging: {},
  paneStatus: {},
  settings: DEFAULT_SETTINGS,
  keymap: DEFAULT_KEYMAP,
  settingsOpen: false,
  settingsCategory: null,
  hotkeysOpen: false,
  bigBrainOpen: false,
  galleryOpen: false,
  swarmOpen: false,
  // Mission panel visible by default — it only renders on a swarm workspace
  // (SwarmMission returns null without one), so on a plain workspace this costs
  // nothing, and a freshly launched swarm shows its task board immediately.
  swarmMissionOpen: true,
  // Open on the durable human channel — the tab a human actually converses in.
  swarmChatTab: "coordinator",
  swarmSummaryOpen: false,
  quitOpen: false,
  toasts: [],

  openSettings: (open, category) => set({ settingsOpen: open, settingsCategory: open ? category ?? null : null }),
  openHotkeys: (open) => set({ hotkeysOpen: open }),
  setKeybind: (action, combo) => set((s) => ({ keymap: { ...s.keymap, [action]: combo } })),
  resetKeymap: () => set({ keymap: DEFAULT_KEYMAP }),
  openBigBrain: (open) => set({ bigBrainOpen: open }),
  openGallery: (open) => set({ galleryOpen: open }),
  openSwarm: (open) => set({ swarmOpen: open }),
  toggleSwarmMission: () => set((s) => ({ swarmMissionOpen: !s.swarmMissionOpen })),
  setSwarmChatTab: (tab) => set({ swarmChatTab: tab }),
  openSwarmSummary: (open) => set({ swarmSummaryOpen: open }),
  setQuitOpen: (open) => set({ quitOpen: open }),
  addToast: (msg) => set((s) => ({ toasts: [...s.toasts, { id: uid(), msg }] })),
  removeToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

  toggleBroadcast: (paneId) =>
    set((s) => {
      const broadcast = s.broadcast.includes(paneId) ? s.broadcast.filter((x) => x !== paneId) : [...s.broadcast, paneId];
      poolSetBroadcast(broadcast);
      return { broadcast };
    }),

  clearBroadcast: () => { poolSetBroadcast([]); set({ broadcast: [] }); },

  openSearch: (open) => set({ searchOpen: open }),

  markStarted: (paneId) => set((s) => ({ paneStatus: { ...s.paneStatus, [paneId]: { startedAt: now() } } })),

  markExited: (paneId, code) =>
    set((s) => {
      const st = s.paneStatus[paneId];
      if (!st) return {};
      return { paneStatus: { ...s.paneStatus, [paneId]: { ...st, exit: { code, at: now() } } } };
    }),

  setLogging: (paneId, path) =>
    set((s) => {
      poolSetLogging(paneId, path);
      const logging = { ...s.logging };
      if (path) logging[paneId] = path;
      else delete logging[paneId];
      return { logging };
    }),

  restartPane: (paneId) => {
    set((s) => ({ paneStatus: { ...s.paneStatus, [paneId]: { startedAt: now() } } }));
    poolRestart(paneId);
  },

  updateSettings: (patch) =>
    set((s) => {
      const settings = { ...s.settings, ...patch };
      applySettings(settings);
      return { settings };
    }),

  setDetectedShells: (shells) => set({ detectedShells: shells }),

  ensureProfiles: (shells) =>
    set((s) => {
      if (s.profiles.length === 0) {
        const seeded = starterProfiles(shells);
        return { profiles: seeded, defaultProfileId: seeded[0]?.id ?? "" };
      }
      // Back-fill the monitor profile for installs seeded before it existed.
      if (!s.profiles.some((p) => p.kind === "monitor")) {
        return { profiles: [...s.profiles, newProfile({ name: "System Monitor", kind: "monitor", color: "#46c7c7" })] };
      }
      return {};
    }),

  addProfile: () => {
    const p = newProfile({ shellPath: get().detectedShells[0]?.path, args: get().detectedShells[0]?.args });
    set((s) => ({ profiles: [...s.profiles, p] }));
    return p.id;
  },

  updateProfile: (id, patch) => set((s) => ({ profiles: s.profiles.map((p) => (p.id === id ? { ...p, ...patch } : p)) })),

  deleteProfile: (id) =>
    set((s) => {
      const profiles = s.profiles.filter((p) => p.id !== id);
      const defaultProfileId = s.defaultProfileId === id ? profiles[0]?.id ?? "" : s.defaultProfileId;
      return { profiles, defaultProfileId };
    }),

  setDefaultProfile: (id) => set({ defaultProfileId: id }),

  reorderProfile: (fromId, toId) =>
    set((s) => {
      if (fromId === toId) return {};
      const from = s.profiles.findIndex((p) => p.id === fromId);
      const to = s.profiles.findIndex((p) => p.id === toId);
      if (from < 0 || to < 0) return {};
      const arr = [...s.profiles];
      const [moved] = arr.splice(from, 1);
      arr.splice(to, 0, moved);
      return { profiles: arr };
    }),

  addCliProfile: () => {
    const p = newCliProfile();
    set((s) => ({ cliProfiles: [...s.cliProfiles, p] }));
    return p.id;
  },

  updateCliProfile: (id, patch) => set((s) => ({ cliProfiles: s.cliProfiles.map((p) => (p.id === id ? { ...p, ...patch } : p)) })),

  deleteCliProfile: (id) => set((s) => ({ cliProfiles: s.cliProfiles.filter((p) => p.id !== id) })),

  openPalette: (open) => set({ paletteOpen: open }),
  openProfileManager: (open) => set({ profileManagerOpen: open }),

  focusPane: (paneId) => set((s) => patchActive(s, () => ({ focusedPaneId: paneId }))),

  focusGroup: (groupId) =>
    set((s) => {
      const grp = T.collectGroups(getActive(s).root).find((x) => x.id === groupId);
      return grp ? patchActive(s, () => ({ focusedPaneId: grp.activeId })) : {};
    }),

  splitFocused: (direction, profileId) =>
    set((s) => {
      const ws = getActive(s);
      const gid = T.groupOfPane(ws.root, ws.focusedPaneId)?.id;
      if (!gid) return {};
      const { root, newPaneId } = T.splitGroup(ws.root, gid, direction, false, T.newGroup(makePane(s, profileId)));
      return { ...patchActive(s, () => ({ root, focusedPaneId: newPaneId })), zoomedGroupId: null };
    }),

  newTab: (profileId) =>
    set((s) => {
      const ws = getActive(s);
      const gid = T.groupOfPane(ws.root, ws.focusedPaneId)?.id;
      if (!gid) return {};
      const { root, paneId } = T.addTab(ws.root, gid, makePane(s, profileId));
      return patchActive(s, () => ({ root, focusedPaneId: paneId }));
    }),

  openPaneTab: (pane) =>
    set((s) => {
      const ws = getActive(s);
      // Focus can point at a pane that is gone (a closed swarm role, a restored
      // workspace) — falling back to the first group means the launch still
      // lands somewhere visible instead of silently doing nothing.
      const gid = T.groupOfPane(ws.root, ws.focusedPaneId)?.id ?? T.collectGroups(ws.root)[0]?.id;
      if (!gid) return {};
      const { root, paneId } = T.addTab(ws.root, gid, pane);
      return patchActive(s, () => ({ root, focusedPaneId: paneId }));
    }),

  selectTab: (groupId, paneId) =>
    set((s) => patchActive(s, (ws) => ({ root: T.setActiveTab(ws.root, groupId, paneId), focusedPaneId: paneId }))),

  patchPane: (paneId, patch) => set((s) => patchActive(s, (ws) => ({ root: T.updatePane(ws.root, paneId, patch) }))),

  patchPaneAnywhere: (paneId, patch) =>
    set((s) => ({ workspaces: s.workspaces.map((w) => ({ ...w, root: T.updatePane(w.root, paneId, patch) })) })),

  setPaneRole: (paneId, role) => {
    const next = (role ?? "").trim();
    if (next && !ROLE_RE.test(next)) return;
    // undefined and not "" — paneRole() would shrug either off, but persist
    // drops an undefined key, so a cleared pane stops carrying a dead field.
    set((s) => ({ workspaces: s.workspaces.map((w) => ({ ...w, root: T.updatePane(w.root, paneId, { role: next || undefined }) })) }));
  },

  requestClose: (paneId) => {
    const s = get();
    if (T.collectPanes(getActive(s).root).length <= 1) return;
    if (!s.settings.confirmOnClose) {
      s.closePane(paneId);
      return;
    }
    s.askConfirm({
      message: "Close this pane? Its running process will be terminated.",
      confirmLabel: "Close pane",
      danger: true,
      onConfirm: () => s.closePane(paneId),
    });
  },

  closePane: (paneId) =>
    set((s) => {
      const next = T.closePane(getActive(s).root, paneId);
      if (!next) return {};
      const panes = T.collectPanes(next);
      const broadcast = s.broadcast.filter((x) => x !== paneId);
      if (broadcast.length !== s.broadcast.length) poolSetBroadcast(broadcast);
      const logging = { ...s.logging };
      const paneStatus = { ...s.paneStatus };
      delete logging[paneId];
      delete paneStatus[paneId];
      return {
        ...patchActive(s, (ws) => ({
          root: next,
          focusedPaneId: panes.some((p) => p.id === ws.focusedPaneId) ? ws.focusedPaneId : panes[0].id,
        })),
        zoomedGroupId: null,
        broadcast,
        logging,
        paneStatus,
      };
    }),

  toggleZoom: () =>
    set((s) => {
      const ws = getActive(s);
      return { zoomedGroupId: s.zoomedGroupId ? null : T.groupOfPane(ws.root, ws.focusedPaneId)?.id ?? null };
    }),

  setZoom: (groupId) => set({ zoomedGroupId: groupId }),

  equalizeAll: () => set((s) => patchActive(s, (ws) => ({ root: T.equalize(ws.root) }))),

  setRatio: (splitId, ratio) => set((s) => patchActive(s, (ws) => ({ root: T.setRatio(ws.root, splitId, ratio) }))),

  moveFocus: (dir) =>
    set((s) => {
      const ws = getActive(s);
      const gid = T.groupOfPane(ws.root, ws.focusedPaneId)?.id;
      if (!gid) return {};
      const nextGid = spatialNeighbor(gid, dir);
      if (!nextGid) return {};
      const grp = T.collectGroups(ws.root).find((x) => x.id === nextGid);
      return grp ? patchActive(s, () => ({ focusedPaneId: grp.activeId })) : {};
    }),

  applyPreset: (id) =>
    set((s) => {
      const root = T.applyPreset(getActive(s).root, id, () => makePane(s));
      const panes = T.collectPanes(root);
      return {
        ...patchActive(s, (ws) => ({ root, focusedPaneId: panes.some((p) => p.id === ws.focusedPaneId) ? ws.focusedPaneId : panes[0].id })),
        zoomedGroupId: null,
      };
    }),

  startDrag: (paneId, x, y) =>
    set((s) => ({ drag: { paneId, title: T.collectPanes(getActive(s).root).find((p) => p.id === paneId)?.title ?? "", x, y, target: null } })),

  updateDrag: (x, y, target) => set((s) => (s.drag ? { drag: { ...s.drag, x, y, target } } : {})),

  endDrag: () =>
    set((s) => {
      const d = s.drag;
      if (!d?.target) return { drag: null };
      return { ...patchActive(s, (ws) => ({ root: T.dropPane(ws.root, d.paneId, d.target!), focusedPaneId: d.paneId })), drag: null, zoomedGroupId: null };
    }),

  switchWorkspace: (id) =>
    set((s) => ({ activeId: id, zoomedGroupId: null, workspaces: s.workspaces.map((w) => (w.id === id ? { ...w, lastOpenedAt: now() } : w)) })),

  addWorkspace: () =>
    set((s) => {
      const ws = newWorkspace(`Workspace ${s.workspaces.length + 1}`, s.workspaces.length, makePane(s));
      return { workspaces: [...s.workspaces, ws], activeId: ws.id, zoomedGroupId: null };
    }),

  addWorkspaceWithRoot: (name, root, swarm, swarmResets, swarmDispatch, swarmClearRoles, swarmConcurrent) =>
    set((s) => {
      const ws: Workspace = {
        id: uid(), name, color: nextColor(s.workspaces.length), root,
        focusedPaneId: T.collectPanes(root)[0].id,
        createdAt: now(), lastOpenedAt: now(), keepAlive: "keep", swarm, swarmResets, swarmDispatch,
        swarmClearRoles, swarmConcurrent,
      };
      return { workspaces: [...s.workspaces, ws], activeId: ws.id, zoomedGroupId: null };
    }),

  renameWorkspace: (id, name) => set((s) => ({ workspaces: s.workspaces.map((w) => (w.id === id ? { ...w, name } : w)) })),

  setWorkspaceColor: (id, color) => set((s) => ({ workspaces: s.workspaces.map((w) => (w.id === id ? { ...w, color } : w)) })),

  setKeepAlive: (id, mode) => set((s) => ({ workspaces: s.workspaces.map((w) => (w.id === id ? { ...w, keepAlive: mode } : w)) })),

  setSwarmConcurrent: (id, on) =>
    set((s) => ({ workspaces: s.workspaces.map((w) => (w.id === id ? { ...w, swarmConcurrent: on } : w)) })),

  duplicateWorkspace: (id) =>
    set((s) => {
      const src = s.workspaces.find((w) => w.id === id);
      if (!src) return {};
      const { node, map } = T.remapIds(src.root);
      const ws: Workspace = {
        id: uid(), name: `${src.name} copy`, color: src.color, root: node,
        focusedPaneId: map[src.focusedPaneId] ?? T.collectPanes(node)[0].id,
        createdAt: now(), lastOpenedAt: now(), keepAlive: src.keepAlive,
      };
      const idx = s.workspaces.findIndex((w) => w.id === id);
      return { workspaces: [...s.workspaces.slice(0, idx + 1), ws, ...s.workspaces.slice(idx + 1)], activeId: ws.id, zoomedGroupId: null };
    }),

  requestDeleteWorkspace: (id) => {
    if (get().workspaces.length <= 1) return;
    const ws = get().workspaces.find((w) => w.id === id);
    get().askConfirm({
      message: `Delete "${ws?.name}"? Its ${T.collectPanes(ws!.root).length} terminal(s) will be terminated.`,
      confirmLabel: "Delete workspace",
      danger: true,
      onConfirm: () => get().deleteWorkspace(id),
    });
  },

  deleteWorkspace: (id) => {
    const gone = get().workspaces.find((w) => w.id === id);
    set((s) => {
      if (s.workspaces.length <= 1) return {};
      const idx = s.workspaces.findIndex((w) => w.id === id);
      const workspaces = s.workspaces.filter((w) => w.id !== id);
      const activeId = s.activeId === id ? workspaces[Math.max(0, idx - 1)].id : s.activeId;
      return { workspaces, activeId, zoomedGroupId: null };
    });
    // Its cooldown mirror outlives the panes otherwise — the telemetry store is
    // keyed by workspace id, not by pane id, so nothing else would ever evict it.
    // The turn-budget mirror is per swarm PROJECT, so it only goes when the last
    // workspace on that project does.
    const swarm = gone?.swarm;
    if (gone && swarm) {
      const lastOne = !get().workspaces.some((w) => w.swarm === swarm);
      useSwarmTelemetry.getState().dropWorkspace(gone.id, lastOne ? swarm : undefined);
    }
  },

  reorderWorkspace: (fromId, toId) =>
    set((s) => {
      if (fromId === toId) return {};
      const from = s.workspaces.findIndex((w) => w.id === fromId);
      const to = s.workspaces.findIndex((w) => w.id === toId);
      if (from < 0 || to < 0) return {};
      const arr = [...s.workspaces];
      const [moved] = arr.splice(from, 1);
      arr.splice(to, 0, moved);
      return { workspaces: arr };
    }),

  // Called at most once per animation frame, with every pane that produced
  // output during that frame (terminalPool coalesces; this used to run once per
  // PTY chunk, i.e. thousands of times a second under a swarm flood).
  //
  // The ORDER of the work matters as much as the batching. zustand notifies
  // every subscriber on any set() — including one whose updater returns {} —
  // so the "did anything actually change" test has to happen before set(), and
  // before the layout-tree walk that is the expensive part. get() gives us both
  // for free: an already-unread pane costs one property lookup and nothing else.
  markActivity: (paneIds) => {
    const s = get();
    let unread: Record<string, true> | null = null;
    for (const paneId of paneIds) {
      if (s.unread[paneId] || unread?.[paneId]) continue; // already marked -> no walk, no set, no notify
      const ws = s.workspaces.find((w) => T.groupOfPane(w.root, paneId));
      if (!ws) continue;
      const grp = T.groupOfPane(ws.root, paneId)!;
      if (ws.id === s.activeId && grp.activeId === paneId) continue; // visible -> not unread
      (unread ??= { ...s.unread })[paneId] = true;
    }
    if (unread) set({ unread });
  },

  clearVisibleUnread: () =>
    set((s) => {
      const ws = getActive(s);
      if (!ws) return {};
      const visible = new Set(T.collectGroups(ws.root).map((g) => g.activeId));
      const unread = { ...s.unread };
      let changed = false;
      for (const id of visible) if (unread[id]) { delete unread[id]; changed = true; }
      return changed ? { unread } : {};
    }),

  askConfirm: (cfg) => set({ pendingConfirm: cfg }),
  resolveConfirm: () => { const c = get().pendingConfirm; set({ pendingConfirm: null }); c?.onConfirm(); },
  cancelConfirm: () => set({ pendingConfirm: null }),
  toggleHelp: (force) => set((s) => ({ showHelp: force ?? !s.showHelp })),
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  setShotThumbVisible: (v) => set((s) => (s.shotThumbVisible === v ? s : { shotThumbVisible: v })),

  hydrate: (p) => {
    // Restored panes are subject to their "On restore" restartPolicy; panes
    // created later this session always run their startup command.
    markRestoredPanes(p.workspaces.flatMap((w) => T.collectPanes(w.root).map((pane) => pane.id)));
    set({
      // Layouts saved before pane.role existed carry the role in the title —
      // adopt it once here so every swarm watcher can stop parsing titles.
      workspaces: migratePaneRoles(p.workspaces),
      activeId: p.activeId,
      sidebarCollapsed: p.sidebarCollapsed ?? false,
      profiles: p.profiles ?? [],
      defaultProfileId: p.defaultProfileId ?? "",
      cliProfiles: p.cliProfiles ?? [],
      settings: { ...DEFAULT_SETTINGS, ...(p.settings ?? {}) },
      keymap: { ...DEFAULT_KEYMAP, ...(p.keymap ?? {}) },
      hydrated: true,
      freshProfile: false,
    });
  },
  // Only reached when there was nothing to restore — see freshProfile above.
  markHydrated: () => set({ hydrated: true, freshProfile: true }),
})));

export const activeWorkspace = getActive;

// Dev-only handle for manual/automated testing in a plain browser (stripped from prod).
if (import.meta.env?.DEV && typeof window !== "undefined") {
  (window as unknown as { __layout: typeof useLayout }).__layout = useLayout;
}
