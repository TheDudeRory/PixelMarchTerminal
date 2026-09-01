// Portable persistence. The Workspace shape lives here (not the store) so this
// module has no import cycle with the store. Backed by pixelmarch.json next to
// the exe via the Rust load_state/save_state commands.
import type { LayoutNode } from "./layout-tree";
import type { PaneProfile } from "./profiles";
import type { CliProfile } from "./cliProfiles";
import { loadState, saveState, backupCorruptState } from "./ipc";

export type KeepAlive = "keep" | "suspend" | "kill";

export interface Workspace {
  id: string;
  name: string;
  color: string;
  root: LayoutNode;
  focusedPaneId: string;
  createdAt: number;
  lastOpenedAt: number;
  keepAlive: KeepAlive;
  swarm?: string; // BigBrain project of the swarm this workspace hosts (<repo>-swarm-<slug>)
  swarmResets?: boolean; // stateless-worker context resets enabled for this swarm (legacy
  // master flag; absent swarmClearRoles, true means "wipe every role" — see clearRolesOf())
  swarmClearRoles?: string[]; // WHICH role kinds get context-wiped (coordinator|scout|builder|reviewer);
  // the per-role context-clear selection the reset watcher honours. Optional keeps SCHEMA=1.
  swarmConcurrent?: boolean; // "run concurrent": lift the turn cap so every role can be mid-turn at once
  swarmDispatch?: boolean; // host-driven dispatch: host wakes idle agent panes when the task bus has work
}

export type Theme = "dark" | "light";
export type CursorStyle = "block" | "bar" | "underline";

/** Editable keyboard bindings: action id -> combo string (e.g. "Ctrl+Shift+P").
 *  Consumed by the central key handler + the Keybinds settings category. */
export type Keymap = Record<string, string>;

export interface Settings {
  scrollbackLimit: number;
  notifyThresholdSec: number;
  theme: Theme;
  fontFamily: string;
  fontSize: number;
  uiScale: number; // whole-interface zoom factor, 1 = 100%
  ligatures: boolean;
  cursorStyle: CursorStyle;
  confirmOnClose: boolean;
  startupWorkspaceId: string | null; // null = restore last active
  gpuAcceleration: boolean; // WebGL renderer (default on); off = reliable DOM renderer for many panes
  welcomeDismissed?: boolean; // first-run overlay closed (FirstRun.tsx); absent = not yet
}

export interface Persisted {
  schemaVersion: number;
  activeId: string;
  sidebarCollapsed: boolean;
  workspaces: Workspace[];
  profiles: PaneProfile[];
  defaultProfileId: string;
  cliProfiles?: CliProfile[]; // AI-agent CLI invocations (schema-safe default [])
  settings?: Settings;
  keymap?: Keymap; // editable keybindings; absent = use defaults
}

export const SCHEMA = 1;

/** schemaVersion 1 is current; future migrations branch here. */
function migrate(data: Persisted): Persisted {
  return data;
}

export async function loadPersisted(): Promise<Persisted | null> {
  let raw: string | null;
  try {
    raw = await loadState();
  } catch {
    return null; // not under Tauri (plain browser) or IO error
  }
  if (!raw) return null;
  try {
    const data = JSON.parse(raw) as Persisted;
    if (data?.schemaVersion !== SCHEMA || !Array.isArray(data.workspaces) || data.workspaces.length === 0) return null;
    return migrate(data);
  } catch {
    // Unparseable: move it aside as pixelmarch.json.corrupt-<ts> and start fresh.
    await backupCorruptState().catch(() => {});
    return null;
  }
}

let timer: ReturnType<typeof setTimeout> | undefined;
/** Debounced save; ignores errors (e.g. when running in a plain browser). */
export function savePersistedDebounced(build: () => Persisted, delay = 400): void {
  clearTimeout(timer);
  timer = setTimeout(() => {
    saveState(JSON.stringify(build())).catch(() => {});
  }, delay);
}
