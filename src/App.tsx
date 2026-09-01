import { useEffect } from "react";
import { shallow } from "zustand/shallow";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { getCurrentWindow } from "@tauri-apps/api/window";
import Sidebar from "./components/Sidebar";
import Toolbar from "./components/Toolbar";
import LayoutView from "./components/layout/LayoutView";
import { HelpOverlay, ConfirmDialog, ScreenshotGalleryOverlay, FirstRunOverlay } from "./components/Overlays";
import Palette from "./components/Palette";
import ProfileManager from "./components/ProfileManager";
import HotkeyManager from "./components/HotkeyManager";
import SettingsModal from "./components/SettingsModal";
import BigBrain from "./components/BigBrain";
import SwarmDialog from "./components/SwarmDialog";
import SwarmChat from "./components/SwarmChat";
import SwarmMission from "./components/SwarmMission";
import SwarmHealthStrip from "./components/SwarmHealthStrip";
import SwarmSummaryGrid, { SwarmSummaryBar } from "./components/SwarmSummaryGrid";
import ScreenshotOverlay from "./components/ScreenshotOverlay";
import ScreenshotThumb from "./components/ScreenshotThumb";
import { BroadcastBanner, SearchBar } from "./components/PowerUI";
import { QuitDialog, Toasts } from "./components/SystemUI";
import { useLayout, activeWorkspace, applySettings } from "./stores/layout";
import { collectPanes, isTerminal } from "./lib/layout-tree";
import { syncTerminals, focusTerminal, setActivityCallback, setStatusCallbacks, setErrorCallback, spawnOptsForPane, paneCount } from "./lib/terminalPool";
import { loadPersisted, savePersistedDebounced, SCHEMA, type Keymap } from "./lib/persist";
import { useSwarmReset } from "./lib/swarmReset";
import { useSwarmDispatch } from "./lib/swarmDispatch";
import { useSwarmNudge } from "./lib/swarmNudge";
import { useSwarmRunaway } from "./lib/swarmRunaway";
import { startTranscriptCapture } from "./components/panes/agentTranscript";
import { detectShells, detachQuit, onVoiceTranscript, ptyWrite } from "./lib/ipc";
import type { ShellInfo } from "./lib/profiles";

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

function zoomBy(delta: number) {
  const s = useLayout.getState();
  s.updateSettings({ uiScale: Math.min(3, Math.max(0.5, Math.round((s.settings.uiScale + delta) * 10) / 10)) });
}

// ── Data-driven keybindings ─────────────────────────────────────────────────
// Each app action maps to a combo string in the persisted `keymap` (defaults in
// layout.ts DEFAULT_KEYMAP; edited by the Keybinds settings category). handleKey
// turns the fired event into a canonical combo and dispatches to the action bound
// to it, so the shortcut table, the editor and the handler share one source.

type LayoutState = ReturnType<typeof useLayout.getState>;

/** Run each action; `e` is the originating event (for preventDefault etc.). */
const KEY_ACTIONS: Record<string, (s: LayoutState, e: KeyboardEvent) => void> = {
  palette: (s, e) => { e.preventDefault(); s.openPalette(!s.paletteOpen); },
  settings: (s, e) => { e.preventDefault(); s.openSettings(!s.settingsOpen); },
  find: (s, e) => { e.preventDefault(); s.openSearch(!s.searchOpen); },
  help: (s, e) => { e.preventDefault(); s.toggleHelp(); },
  // stopPropagation keeps xterm from also sending the keystroke to the pty
  zoomIn: (_s, e) => { e.preventDefault(); e.stopPropagation(); zoomBy(0.1); },
  zoomOut: (_s, e) => { e.preventDefault(); e.stopPropagation(); zoomBy(-0.1); },
  resetScale: (s, e) => { e.preventDefault(); e.stopPropagation(); s.updateSettings({ uiScale: 1 }); },
  splitHorizontal: (s, e) => { e.preventDefault(); s.splitFocused("horizontal"); },
  splitVertical: (s, e) => { e.preventDefault(); s.splitFocused("vertical"); },
  newTab: (s, e) => { e.preventDefault(); s.newTab(); },
  closePane: (s, e) => { e.preventDefault(); s.requestClose(activeWorkspace(s).focusedPaneId); },
  zoomPane: (s, e) => { e.preventDefault(); s.toggleZoom(); },
  broadcast: (s, e) => { e.preventDefault(); s.toggleBroadcast(activeWorkspace(s).focusedPaneId); },
  bigBrain: (s, e) => { e.preventDefault(); s.openBigBrain(!s.bigBrainOpen); },
  equalize: (s, e) => { e.preventDefault(); s.equalizeAll(); },
  moveFocusLeft: (s, e) => { e.preventDefault(); s.moveFocus("left"); },
  moveFocusRight: (s, e) => { e.preventDefault(); s.moveFocus("right"); },
  moveFocusUp: (s, e) => { e.preventDefault(); s.moveFocus("up"); },
  moveFocusDown: (s, e) => { e.preventDefault(); s.moveFocus("down"); },
};

/** The printable/named key token for a combo, from the physical `code` so it is
 *  layout-independent (matches DEFAULT_KEYMAP tokens: letters, digits, arrows,
 *  and the punctuation used by zoom/split/settings/help). */
function comboKeyToken(e: KeyboardEvent): string | null {
  const c = e.code;
  if (c.startsWith("Key")) return c.slice(3);       // KeyP -> P
  if (c.startsWith("Digit")) return c.slice(5);     // Digit0 -> 0
  if (c.startsWith("Arrow")) return c.slice(5);     // ArrowLeft -> Left
  if (c.startsWith("Numpad")) {
    const n = c.slice(6);
    if (/^\d$/.test(n)) return n;                   // Numpad0 -> 0
    if (n === "Add") return "=";
    if (n === "Subtract") return "-";
    return null;
  }
  return ({ Comma: ",", Slash: "/", Equal: "=", Minus: "-" } as Record<string, string>)[c] ?? null;
}

/** Canonical combo for an event, modifiers ordered Ctrl+Alt+Shift+<key>. */
export function eventToCombo(e: KeyboardEvent): string | null {
  const key = comboKeyToken(e);
  if (!key) return null;
  const parts: string[] = [];
  if (e.ctrlKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  parts.push(key);
  return parts.join("+");
}

/** Normalize a stored combo to the same canonical order, so an edited keymap
 *  (e.g. "Shift+Ctrl+P", "Cmd+…") still matches what eventToCombo produces. */
export function normalizeCombo(combo: string): string {
  const parts = combo.split("+");
  const key = parts.pop() ?? "";
  const mods = new Set(parts.map((m) => m.trim().toLowerCase()));
  const out: string[] = [];
  if (mods.has("ctrl") || mods.has("control") || mods.has("cmd") || mods.has("cmdorctrl") || mods.has("command")) out.push("Ctrl");
  if (mods.has("alt") || mods.has("option")) out.push("Alt");
  if (mods.has("shift")) out.push("Shift");
  out.push(key);
  return out.join("+");
}

/** combo -> action, rebuilt only when the keymap object itself changes.
 *  handleKey used to normalizeCombo() every binding on every keystroke — ~20
 *  string splits and Set allocations per character, on the hottest path in the
 *  app. The keymap changes when the user edits a binding, so caching on its
 *  identity is exact, not just a heuristic. */
let comboCache: { keymap: Keymap; map: Map<string, string> } | null = null;
function comboLookup(keymap: Keymap): Map<string, string> {
  if (comboCache?.keymap === keymap) return comboCache.map;
  const map = new Map<string, string>();
  for (const [action, bound] of Object.entries(keymap)) {
    if (KEY_ACTIONS[action]) map.set(normalizeCombo(bound), action);
  }
  comboCache = { keymap, map };
  return map;
}

function handleKey(e: KeyboardEvent) {
  const s = useLayout.getState();
  const { ctrlKey: ctrl, altKey: alt, shiftKey: shift } = e;

  // Hotkey manager toggle is not part of the editable keymap yet (no default
  // entry to edit); kept hardcoded until it's added to DEFAULT_KEYMAP.
  if (ctrl && alt && !shift && e.code === "KeyH") return e.preventDefault(), s.openHotkeys(!s.hotkeysOpen);

  const combo = eventToCombo(e);
  if (combo) {
    const action = comboLookup(s.keymap).get(combo);
    if (action) return KEY_ACTIONS[action](s, e);
  }

  if (e.key === "Escape") {
    if (s.searchOpen) s.openSearch(false);
    if (s.paletteOpen) s.openPalette(false);
    if (s.profileManagerOpen) s.openProfileManager(false);
    if (s.hotkeysOpen) s.openHotkeys(false);
    if (s.settingsOpen) s.openSettings(false);
    if (s.bigBrainOpen) s.openBigBrain(false);
    if (s.quitOpen) s.setQuitOpen(false);
    if (s.showHelp) s.toggleHelp(false);
    if (s.pendingConfirm) s.cancelConfirm();
    // eat the key so xterm doesn't forward Escape to the pty when it only meant "unzoom"
    if (s.zoomedGroupId) { e.preventDefault(); e.stopPropagation(); s.setZoom(null); }
  }
}

async function notifyExit(title: string, code: number | null) {
  try {
    let granted = await isPermissionGranted();
    if (!granted) granted = (await requestPermission()) === "granted";
    if (granted) sendNotification({ title: "PixelMarch", body: `${title} exited${code != null ? ` (code ${code})` : ""}` });
  } catch {
    /* no Tauri / denied */
  }
}

export default function App() {
  const workspaces = useLayout((s) => s.workspaces);
  const activeId = useLayout((s) => s.activeId);
  const root = useLayout((s) => activeWorkspace(s).root);
  const focusedPaneId = useLayout((s) => activeWorkspace(s).focusedPaneId);
  // The grid only exists for swarm workspaces; without this guard, switching to
  // a plain workspace with the summary still open would render nothing at all
  // (SwarmSummaryGrid bails) and the user would stare at an empty pane area.
  const summaryOpen = useLayout((s) => s.swarmSummaryOpen && !!s.workspaces.find((w) => w.id === s.activeId)?.swarm);

  useEffect(() => {
    setActivityCallback((paneIds) => useLayout.getState().markActivity(paneIds));
    setStatusCallbacks(
      (paneId) => useLayout.getState().markStarted(paneId),
      (paneId, code) => {
        const s = useLayout.getState();
        const st = s.paneStatus[paneId];
        s.markExited(paneId, code);
        if (st && Date.now() - st.startedAt >= s.settings.notifyThresholdSec * 1000) {
          const title = collectPanes(activeWorkspace(s).root).find((p) => p.id === paneId)?.title
            ?? s.workspaces.flatMap((w) => collectPanes(w.root)).find((p) => p.id === paneId)?.title
            ?? "A pane";
          notifyExit(title, code);
        }
      },
    );
    if (isTauri) setErrorCallback((_id, msg) => useLayout.getState().addToast(`Terminal failed to start: ${msg}`));
    const persist = () => {
      const s = useLayout.getState();
      if (!s.hydrated) return;
      savePersistedDebounced(() => ({
        schemaVersion: SCHEMA,
        activeId: s.activeId,
        sidebarCollapsed: s.sidebarCollapsed,
        workspaces: s.workspaces,
        profiles: s.profiles,
        defaultProfileId: s.defaultProfileId,
        cliProfiles: s.cliProfiles,
        settings: s.settings,
      }));
    };
    (async () => {
      const p = await loadPersisted();
      if (p) useLayout.getState().hydrate(p);
      else useLayout.getState().markHydrated();
      const st = useLayout.getState();
      applySettings(st.settings);
      // Honor a fixed startup workspace if one is configured and still exists.
      const sw = st.settings.startupWorkspaceId;
      if (sw && st.workspaces.some((w) => w.id === sw)) st.switchWorkspace(sw);
      let shells: ShellInfo[] = [];
      try {
        shells = await detectShells();
      } catch {
        /* plain browser / no Tauri */
      }
      useLayout.getState().setDetectedShells(shells);
      useLayout.getState().ensureProfiles(shells);
      persist();
    })();
    const unsub = useLayout.subscribe(
      (s) => [s.workspaces, s.activeId, s.sidebarCollapsed, s.profiles, s.defaultProfileId, s.cliProfiles, s.settings] as const,
      persist,
      { equalityFn: shallow },
    );
    return unsub;
  }, []);

  useEffect(() => {
    window.addEventListener("keydown", handleKey, true);
    // Ctrl+wheel zoom (also fired by trackpad pinch). passive:false so we can
    // preventDefault; capture+stopPropagation so xterm doesn't scroll instead.
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      e.stopPropagation();
      zoomBy(e.deltaY < 0 ? 0.1 : -0.1);
    };
    window.addEventListener("wheel", onWheel, { capture: true, passive: false });
    return () => {
      window.removeEventListener("keydown", handleKey, true);
      window.removeEventListener("wheel", onWheel, true);
    };
  }, []);

  // Graceful shutdown: confirm before quitting while terminals are running.
  useEffect(() => {
    if (!isTauri) return;
    let unlisten: (() => void) | undefined;
    getCurrentWindow()
      .onCloseRequested((e) => {
        const s = useLayout.getState();
        e.preventDefault(); // we own shutdown: either confirm, or quit via Rust
        // Default close = detach: the host keeps the terminals running so the
        // next launch reattaches. Full teardown is the dialog's explicit choice.
        if (s.settings.confirmOnClose && paneCount() > 0) s.setQuitOpen(true);
        else detachQuit();
      })
      .then((u) => (unlisten = u));
    return () => unlisten?.();
  }, []);

  // Keep terminals alive across workspace switches; substitute ${workspaceName}.
  useEffect(() => {
    const alive = workspaces.flatMap((w) =>
      w.id === activeId || w.keepAlive !== "kill"
        ? collectPanes(w.root).filter(isTerminal).map((p) => ({ id: p.id, ...spawnOptsForPane(p, w.name, w.swarm ?? "") }))
        : [],
    );
    syncTerminals(alive);
    // summaryOpen is a dependency on purpose. Opening the grid UNMOUNTS
    // LayoutView, which detaches every pane div — but the pool only sweeps for
    // detached panes when something calls into it, so without this re-sync the
    // panes would stay on the full tier (renderers alive, WebGL held) until the
    // next unrelated layout change. Re-running sync schedules that sweep, which
    // is what actually drops them all to headless. Closing it re-syncs too,
    // harmlessly: syncTerminals is a reconcile, so an unchanged pane set is a
    // no-op beyond the sweep.
  }, [workspaces, activeId, summaryOpen]);

  useEffect(() => {
    focusTerminal(focusedPaneId);
  }, [focusedPaneId]);

  useEffect(() => {
    useLayout.getState().clearVisibleUnread();
  }, [activeId, root]);

  // Voice-To-Text: a finished dictation transcript (from the voice window) is
  // written into the focused terminal's pty — dictation lands in the host
  // terminal instead of at the OS cursor.
  useEffect(() => {
    if (!isTauri) return;
    let unlisten: (() => void) | undefined;
    onVoiceTranscript((text) => {
      if (!text) return;
      const s = useLayout.getState();
      const pane = activeWorkspace(s).focusedPaneId;
      if (pane) ptyWrite(pane, text).catch(() => {});
    }).then((u) => (unlisten = u));
    return () => unlisten?.();
  }, []);

  // Headless panes: capture their transcript from the moment they SPAWN, and
  // forget it when they stop being headless. Doing it here rather than in the
  // pane view is the point — a transcript that only starts when a human looks at
  // it shows an empty run for a pane that has been working for an hour, and the
  // swarm grid has nothing to show for a headless worker but raw stream-json.
  useEffect(() => startTranscriptCapture(), []);

  // Swarm stateless-worker resets: consume reset-<role> notes, wipe + re-brief panes.
  useSwarmReset();
  useSwarmDispatch();
  useSwarmNudge();
  useSwarmRunaway();

  return (
    <div style={{ position: "fixed", inset: 0, background: "var(--bg)", display: "flex", flexDirection: "row" }}>
      <Sidebar />
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
        <Toolbar />
        <BroadcastBanner />
        <SwarmHealthStrip />
        <SwarmSummaryBar />
        <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "row" }}>
          <div style={{ flex: 1, minWidth: 0, position: "relative", padding: 6 }}>
            {/* Either the terminals or the summary grid — never both. The grid
                is only worth anything because LayoutView is gone while it is up:
                a mounted pane div keeps its full renderer alive. */}
            {summaryOpen ? <SwarmSummaryGrid /> : <LayoutView />}
            <SearchBar />
          </div>
          <SwarmMission />
        </div>
        <SwarmChat />
      </div>
      <FirstRunOverlay />
      <HelpOverlay />
      <ScreenshotGalleryOverlay />
      <ConfirmDialog />
      <Palette />
      <ProfileManager />
      <HotkeyManager />
      <SettingsModal />
      <BigBrain />
      <SwarmDialog />
      <QuitDialog />
      <ScreenshotThumb />
      <ScreenshotOverlay />
      <Toasts />
    </div>
  );
}
