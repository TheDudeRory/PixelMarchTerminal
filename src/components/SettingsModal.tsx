import { type ComponentType, useEffect, useState } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";
import {
  applyUpdate, appVersion, checkUpdate, onUpdateProgress, updateConfigured,
  type UpdateCheck, type UpdateProgressEvent, type UpdAvailable,
} from "../lib/ipc";
import { useLayout, type PaneStatus } from "../stores/layout";
import type { CursorStyle, Theme } from "../lib/persist";
import { cliProfileCommand, type CliProfile } from "../lib/cliProfiles";
import { KNOWN_AGENT_CMDS } from "../lib/swarm";
import { useBackdropClose } from "../lib/useBackdropClose";
import { ACCENT_SELECTED, field, label, overlay, row } from "../lib/uiStyles";
import KeybindsSettings from "./KeybindsSettings";

// ── Category registry ─────────────────────────────────────────────────────────
// Extensible list of setting categories mirroring the ProfileManager left-list /
// right-editor split. Downstream tasks (Keybinds) add a category
// with a single entry here + one component file — no other edits to this file.
export interface SettingsCategory {
  id: string;
  label: string;
  Component: ComponentType;
}

export const SETTINGS_CATEGORIES: SettingsCategory[] = [
  { id: "gui", label: "GUI / Appearance", Component: GuiCategory },
  { id: "shell", label: "Shell / Terminal", Component: ShellCategory },
  { id: "updates", label: "Updates", Component: UpdatesCategory },
  { id: "session", label: "Session", Component: SessionCategory },
  { id: "keybinds", label: "Keybinds", Component: KeybindsSettings },
];

export default function SettingsModal() {
  const open = useLayout((s) => s.settingsOpen);
  const close = useLayout((s) => s.openSettings);
  // Set when something deep-links here; null just leaves the last category
  // selected.
  const wanted = useLayout((s) => s.settingsCategory);
  const [catId, setCatId] = useState<string>(SETTINGS_CATEGORIES[0].id);
  const backdrop = useBackdropClose(() => close(false));

  useEffect(() => {
    if (open && wanted && SETTINGS_CATEGORIES.some((c) => c.id === wanted)) setCatId(wanted);
  }, [open, wanted]);

  if (!open) return null;
  const cat = SETTINGS_CATEGORIES.find((c) => c.id === catId) ?? SETTINGS_CATEGORIES[0];
  const Body = cat.Component;

  return (
    <div style={overlay} {...backdrop}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: 640, maxWidth: "92vw", height: 460, maxHeight: "88vh", display: "flex", background: "var(--panel)", border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden", boxShadow: "0 12px 48px rgba(0,0,0,0.6)" }}>
        {/* category list */}
        <div style={{ width: 190, borderRight: "1px solid var(--border)", display: "flex", flexDirection: "column", background: "var(--panel)" }}>
          <div style={{ padding: "10px 12px", fontSize: 11, fontWeight: 700, letterSpacing: 0.6, color: "var(--muted)", borderBottom: "1px solid var(--border)" }}>SETTINGS</div>
          <div style={{ flex: 1, overflowY: "auto", padding: 4 }}>
            {SETTINGS_CATEGORIES.map((c) => (
              <div key={c.id} onClick={() => setCatId(c.id)}
                style={{ padding: "6px 8px", borderRadius: 5, cursor: "pointer", background: c.id === catId ? ACCENT_SELECTED : "transparent", fontSize: 12.5, color: c.id === catId ? "#fff" : "var(--text)" }}>
                {c.label}
              </div>
            ))}
          </div>
          <button onClick={() => close(false)} style={{ margin: 8, padding: "6px", background: "var(--accent)", color: "#fff", border: "none", borderRadius: 5, cursor: "pointer", fontSize: 12 }}>Done</button>
        </div>

        {/* editor */}
        <div style={{ flex: 1, padding: 16, overflowY: "auto" }}>
          <Body />
        </div>
      </div>
    </div>
  );
}

// ── GUI / Appearance ──────────────────────────────────────────────────────────

function GuiCategory() {
  const settings = useLayout((s) => s.settings);
  const update = useLayout((s) => s.updateSettings);
  return (
    <>
      <div style={row}>
        <span style={label}>Theme</span>
        <select style={field} value={settings.theme} onChange={(e) => update({ theme: e.target.value as Theme })}>
          <option value="dark">Dark</option>
          <option value="light">Light</option>
        </select>
      </div>
      <div style={row}>
        <span style={label}>Font family</span>
        <input style={{ ...field, width: 240 }} value={settings.fontFamily} onChange={(e) => update({ fontFamily: e.target.value })} />
      </div>
      <div style={row}>
        <span style={label}>Font size</span>
        <input style={{ ...field, width: 70 }} type="number" min={8} max={40} value={settings.fontSize} onChange={(e) => update({ fontSize: Number(e.target.value) || 14 })} />
      </div>
      <div style={row}>
        <span style={label}>Interface scale (%) <span style={{ color: "var(--muted)", fontSize: 10 }}>(zooms the whole UI)</span></span>
        <input style={{ ...field, width: 70 }} type="number" min={50} max={300} step={10} value={Math.round(settings.uiScale * 100)} onChange={(e) => update({ uiScale: Math.min(3, Math.max(0.5, (Number(e.target.value) || 100) / 100)) })} />
      </div>
      <div style={row}>
        <span style={label}>Font ligatures <span style={{ color: "var(--muted)", fontSize: 10 }}>(new terminals)</span></span>
        <input type="checkbox" checked={settings.ligatures} onChange={(e) => update({ ligatures: e.target.checked })} />
      </div>
      <div style={row}>
        <span style={label}>GPU acceleration (WebGL) <span style={{ color: "var(--muted)", fontSize: 10 }}>(faster, but can blank panes on some GPUs; new terminals)</span></span>
        <input type="checkbox" checked={settings.gpuAcceleration} onChange={(e) => update({ gpuAcceleration: e.target.checked })} />
      </div>
      <div style={{ ...row, borderBottom: "none" }}>
        <span style={label}>Cursor style</span>
        <select style={field} value={settings.cursorStyle} onChange={(e) => update({ cursorStyle: e.target.value as CursorStyle })}>
          <option value="block">Block</option>
          <option value="bar">Bar</option>
          <option value="underline">Underline</option>
        </select>
      </div>
    </>
  );
}

// ── Shell / Terminal ──────────────────────────────────────────────────────────

function ShellCategory() {
  const settings = useLayout((s) => s.settings);
  const update = useLayout((s) => s.updateSettings);
  const profiles = useLayout((s) => s.profiles);
  const defaultProfileId = useLayout((s) => s.defaultProfileId);
  const setDefaultProfile = useLayout((s) => s.setDefaultProfile);
  return (
    <>
      <div style={row}>
        <span style={label}>Default profile (shell)</span>
        <select style={field} value={defaultProfileId} onChange={(e) => setDefaultProfile(e.target.value)}>
          {profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </div>
      <div style={row}>
        <span style={label}>Scrollback limit (lines)</span>
        <input style={{ ...field, width: 90 }} type="number" min={100} max={200000} step={1000} value={settings.scrollbackLimit} onChange={(e) => update({ scrollbackLimit: Number(e.target.value) || 10000 })} />
      </div>
      <div style={row}>
        <span style={label}>Confirm before closing a pane</span>
        <input type="checkbox" checked={settings.confirmOnClose} onChange={(e) => update({ confirmOnClose: e.target.checked })} />
      </div>
      <div style={{ ...row, borderBottom: "none" }}>
        <span style={label}>Notify on exit after (seconds)</span>
        <input style={{ ...field, width: 70 }} type="number" min={0} max={3600} value={settings.notifyThresholdSec} onChange={(e) => update({ notifyThresholdSec: Number(e.target.value) || 30 })} />
      </div>
      <div style={{ marginTop: 14, paddingTop: 8, borderTop: "1px solid var(--border)" }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", marginBottom: 4 }}>CLI profiles</div>
        <CliProfiles />
      </div>
    </>
  );
}

// ── Updates ───────────────────────────────────────────────────────────────────

/**
 * What the user is running, for the Software update section. Nothing anywhere
 * in the app used to show this, so after an update there was no way to confirm
 * it had worked and no way to tell support what you were on. Null while the
 * backend has not answered yet (and if it never does): say nothing rather than
 * print a guess about the very thing that is meant to be authoritative.
 */
export function versionLabel(version: string | null | undefined): string {
  const v = String(version ?? "").trim().replace(/^v/i, "");
  return v ? `Version ${v}` : "";
}

/**
 * Shown from the click until the first `update-progress` event lands. An update
 * is a pull and a full rebuild, so it is minutes, not the seconds a download
 * used to be — say that up front rather than let the first long silence read as
 * a hang.
 */
export const INSTALL_MESSAGE =
  "Updating — pulling and rebuilding from source. This takes a few minutes, and the app restarts itself when it's done.";

/**
 * `update-progress` from src-tauri/src/update.rs. Declared with the wrapper in
 * src/lib/ipc.ts; re-exported here because the formatters below are this
 * screen's and take it as their argument.
 */
export type { UpdateProgressEvent };

/**
 * The line under "Software update" while the rebuild runs.
 *
 * There is no percentage anywhere in this, and there is not meant to be: a
 * build has no total to divide by, so `step of steps` plus the command's own
 * latest line is the whole of what is actually known. The old download bar
 * could be honest because a download has a Content-Length; inventing the same
 * shape here would be inventing the number behind it.
 */
export function buildProgressMessage(p: UpdateProgressEvent | null | undefined): string {
  if (!p) return INSTALL_MESSAGE;
  const head = `Step ${p.step} of ${p.steps} — ${p.command}`;
  const line = String(p.line ?? "").trim();
  return line ? `${head}: ${line}` : head;
}

/**
 * What `check_update` answers (src-tauri/src/update.rs, `UpdateCheck`).
 * Declared with the wrapper in src/lib/ipc.ts; re-exported for
 * `updateCheckMessage`.
 */
export type { UpdateCheck };

/**
 * Turn a check result into the line under "Software update". Pure, so every
 * outcome is testable without rendering. An answer we don't understand is NOT
 * reported as "up to date" — a check that never happened must never read as a
 * clean bill of health.
 */
export function updateCheckMessage(res: UpdateCheck | null | undefined): string {
  switch (res?.status) {
    case "available": return "";
    case "upToDate": return "You're up to date.";
    // git's own diagnostics, passed through: they name the branch, the remote or
    // the missing tool, and nothing this screen could write would be more useful.
    case "blocked": return `Can't update from here — ${res.reason}`;
    default: return "The updater sent a reply this build doesn't understand — pull and rebuild from a terminal.";
  }
}

/**
 * The offer itself: what is coming and from where. The remote is named because
 * an update BUILDS what it pulls — whoever can push to it runs code here, and
 * that is worth showing next to the button rather than burying in a doc.
 */
export function updateOfferLabel(info: UpdAvailable | null | undefined): string {
  if (!info) return "";
  const commits = `${info.behind} commit${info.behind === 1 ? "" : "s"} from ${info.upstream}`;
  const v = String(info.version ?? "").trim();
  return v ? `v${v} available — ${commits}` : `Update available — ${commits}`;
}

/**
 * Uncommitted work is the normal state of a checkout someone is editing, so
 * this is a heads-up, not a refusal: `git pull --ff-only` fails only when the
 * incoming commits touch a file that was modified locally, and when it does it
 * stops without changing anything.
 */
export function dirtyTreeWarning(info: UpdAvailable | null | undefined): string {
  if (!info?.dirty) return "";
  return "You have uncommitted changes. The pull stops without touching them if it would overwrite one.";
}

/**
 * How many terminal sessions the update is about to kill. A pane gets a
 * `paneStatus` entry the moment its shell starts and loses it when the pane is
 * closed (stores/layout.ts closePane), so "started, still in the layout, has not
 * exited" is exactly the set of live shells — knowable in the frontend, with no
 * backend round-trip. That matters: a warning shown to someone with nothing open
 * is noise, and noise is how warnings stop being read.
 */
export function liveSessionCount(paneStatus: Record<string, PaneStatus> | null | undefined): number {
  return Object.values(paneStatus ?? {}).filter((st) => st && !st.exit).length;
}

/**
 * The cost of updating, in the words of what actually happens to the user's work.
 * Since task-18 a self-update stops and restarts the terminal host, so every shell
 * — a child of that host — dies with it. Reopening used to appear to reattach
 * everything; now the pane comes back with a fresh shell. Empty when nothing is
 * running, because then there is no cost to consent to.
 */
export function terminalCostWarning(live: number): string {
  if (live < 1) return "";
  const what = live === 1 ? "Your 1 open terminal session" : `Your ${live} open terminal sessions`;
  const it = live === 1 ? "it" : "them";
  return `${what} will be closed by the update: any command running in ${it} is stopped, and the scrollback is lost. Finish or detach anything you care about first.`;
}

/**
 * The Install button's click, as a state machine, so the ORDER is testable without
 * rendering: with live sessions the first click can only ask, never download. With
 * nothing running it installs straight away — the update is good and we are not
 * here to add friction to it, only to stop it costing someone work silently.
 */
export function nextInstallStep(confirming: boolean, live: number): "confirm" | "install" {
  return !confirming && live > 0 ? "confirm" : "install";
}

/** Install button label — names the cost on the confirming click, not just "OK". */
export function installButtonLabel(confirming: boolean, live: number): string {
  if (!confirming || live < 1) return "Install & restart";
  return live === 1 ? "Close 1 session & install" : `Close ${live} sessions & install`;
}

function UpdatesCategory() {
  const [upd, setUpd] = useState<UpdAvailable | null>(null);
  const [updMsg, setUpdMsg] = useState("");
  // A checkout with no upstream has nothing to pull from. Say so instead of
  // offering a button that can only fail (undefined = still asking).
  const [configured, setConfigured] = useState<boolean | undefined>(undefined);
  const [version, setVersion] = useState<string | null>(null);
  // Null until the rebuild starts (and again once it fails) — the step line only
  // exists while there is a command actually running behind it.
  const [progress, setProgress] = useState<UpdateProgressEvent | null>(null);
  // True between the first Install click and the second, only ever entered when
  // there are sessions to lose. Reset by Check, so a new offer never inherits a
  // half-given consent.
  const [confirming, setConfirming] = useState(false);
  const live = useLayout((s) => liveSessionCount(s.paneStatus));

  useEffect(() => {
    updateConfigured().then(setConfigured).catch(() => setConfigured(true));
    appVersion().then(setVersion).catch(() => setVersion(null));
  }, []);

  // Named apart from the ipc wrapper it calls: this one also drives the screen.
  async function checkForUpdate() {
    setUpdMsg("Checking…");
    setUpd(null);
    setConfirming(false);
    try {
      const res = await checkUpdate();
      setUpd(res?.status === "available" ? res.info : null);
      setUpdMsg(updateCheckMessage(res));
    } catch (e) { setUpdMsg(`Check failed: ${e}`); }
  }
  async function installUpdate() {
    // The button only renders with an offer in hand; this keeps that true for the
    // type checker rather than starting a build off a stale screen.
    if (!upd) return;
    // Nothing is pulled until the cost has been shown AND accepted. The warning is
    // already on screen next to this button; this click is the consent for it.
    if (nextInstallStep(confirming, live) === "confirm") {
      setConfirming(true);
      return;
    }
    setConfirming(false);
    setUpdMsg(INSTALL_MESSAGE);
    setProgress(null);
    // Subscribe BEFORE invoking: `apply_update` starts the pull the moment it is
    // called and emits its first event immediately, so a listener attached after
    // the await would miss the start.
    let unlisten: UnlistenFn | undefined;
    try {
      unlisten = await onUpdateProgress(setProgress);
    } catch { /* no progress events; the static message stays, which is still true */ }
    try {
      await applyUpdate();
    } catch (e) {
      // A failure ends the run, so drop the step line — leaving it mid-build next
      // to an error reads as "still going".
      setProgress(null);
      // Nothing was restarted and nothing was replaced: the build runs before
      // anything destructive, so say so rather than leave the user wondering
      // what state their install is in.
      setUpdMsg(`Update failed — nothing was changed, and your terminals are still running.\n${e}`);
    } finally {
      unlisten?.();
    }
  }

  return (
    <>
      <div style={{ ...row, borderBottom: "none" }}>
        <span style={label}>
          Software update
          {versionLabel(version) && (
            <span style={{ color: "var(--text)", fontSize: 11, display: "block" }}>{versionLabel(version)}</span>
          )}
          {configured === false && (
            <span style={{ color: "var(--muted)", fontSize: 10, display: "block" }}>
              This checkout has no upstream branch — set one with <code>git branch --set-upstream-to origin/master</code>.
            </span>
          )}
          {(progress ? buildProgressMessage(progress) : updMsg) && (
            <span style={{ color: "var(--muted)", fontSize: 10, display: "block", whiteSpace: "pre-wrap" }}>
              {progress ? buildProgressMessage(progress) : updMsg}
            </span>
          )}
          {progress && (
            // A build has no total, so there is no fraction to fill. The track
            // holds a sliding indeterminate block — the one honest bar available.
            <span style={{ display: "block", width: 260, maxWidth: "100%", height: 4, marginTop: 5, borderRadius: 2, background: "var(--border)", overflow: "hidden" }}>
              <span style={{ display: "block", height: "100%", width: "35%", background: "var(--accent)", animation: "pm-indeterminate 1.1s ease-in-out infinite" }} />
            </span>
          )}
          {upd && <span style={{ color: "var(--text)", fontSize: 11, display: "block" }}>{updateOfferLabel(upd)}</span>}
          {upd && upd.notes.length > 0 && (
            <span style={{ color: "var(--muted)", fontSize: 10, display: "block", marginTop: 2 }}>
              {upd.notes.map((n) => <span key={n} style={{ display: "block" }}>· {n}</span>)}
            </span>
          )}
          {/* Rendered with the offer, BEFORE anything is pulled — the whole point
              is that the user reads this while the choice is still open, not in a
              toast after their build died. */}
          {upd && !progress && dirtyTreeWarning(upd) && (
            <span style={{ color: "var(--warn, #e0a44c)", fontSize: 11, display: "block", marginTop: 4 }}>
              {dirtyTreeWarning(upd)}
            </span>
          )}
          {upd && !progress && terminalCostWarning(live) && (
            <span style={{ color: "var(--warn, #e0a44c)", fontSize: 11, display: "block", marginTop: 4 }}>
              {terminalCostWarning(live)}
            </span>
          )}
        </span>
        <div style={{ display: "flex", gap: 8 }}>
          {confirming
            ? <button onClick={() => setConfirming(false)} style={{ ...field, cursor: "pointer" }}>Not now</button>
            : <button onClick={checkForUpdate} disabled={configured === false} style={{ ...field, cursor: configured === false ? "not-allowed" : "pointer", opacity: configured === false ? 0.5 : 1 }}>Check</button>}
          {upd && <button onClick={installUpdate} style={{ ...field, cursor: "pointer", background: "var(--accent)", color: "#fff", borderColor: "var(--accent)" }}>{installButtonLabel(confirming, live)}</button>}
        </div>
      </div>

      <p style={{ marginTop: 14, fontSize: 11, color: "var(--muted)" }}>
        Telemetry: <b>none</b>. PixelMarch phones home only when you click <b>Check</b> above (never automatically),
        and then only to the git remote this checkout already tracks.
        Settings, workspaces and profiles live in <code>data/pixelmarch.json</code> inside the checkout.
      </p>
    </>
  );
}

// ── Session ───────────────────────────────────────────────────────────────────

function SessionCategory() {
  const settings = useLayout((s) => s.settings);
  const update = useLayout((s) => s.updateSettings);
  const workspaces = useLayout((s) => s.workspaces);
  return (
    <div style={{ ...row, borderBottom: "none" }}>
      <span style={label}>Startup workspace</span>
      <select style={field} value={settings.startupWorkspaceId ?? ""} onChange={(e) => update({ startupWorkspaceId: e.target.value || null })}>
        <option value="">Last active</option>
        {workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
      </select>
    </div>
  );
}

// ── CLI profiles: named agent-CLI invocations (binary + model + extra args) ──

function CliProfiles() {
  const cliProfiles = useLayout((s) => s.cliProfiles);
  const add = useLayout((s) => s.addCliProfile);
  const update = useLayout((s) => s.updateCliProfile);
  const del = useLayout((s) => s.deleteCliProfile);
  const [editingId, setEditingId] = useState<string | null>(null);

  return (
    <>
      <p style={{ margin: "4px 0 8px", fontSize: 11, color: "var(--muted)" }}>
        A CLI profile is an AI-agent command line — client, model and extra flags — usable as a
        pane startup command or a swarm role command.
      </p>
      {cliProfiles.length === 0 && (
        <p style={{ fontSize: 12, color: "var(--muted)", padding: "8px 0" }}>No CLI profiles yet.</p>
      )}
      {cliProfiles.map((p) => (
        editingId === p.id
          ? <CliProfileEditor key={p.id} profile={p} update={update} onClose={() => setEditingId(null)} />
          : (
            <div key={p.id} style={row}>
              <span style={{ minWidth: 0 }}>
                <span style={{ fontSize: 12.5, color: "var(--text)", display: "block" }}>{p.name}</span>
                <code style={{ fontSize: 11, color: "var(--muted)", display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{cliProfileCommand(p)}</code>
              </span>
              <span style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                <button onClick={() => setEditingId(p.id)} style={{ ...field, cursor: "pointer" }}>Edit</button>
                <button onClick={() => del(p.id)} style={{ ...field, cursor: "pointer", color: "#e06c6c" }}>Delete</button>
              </span>
            </div>
          )
      ))}
      <div style={{ display: "flex", justifyContent: "flex-start", marginTop: 10 }}>
        <button onClick={() => setEditingId(add())} style={{ ...field, cursor: "pointer" }}>+ Add CLI profile</button>
      </div>
    </>
  );
}

function CliProfileEditor({ profile, update, onClose }: {
  profile: CliProfile;
  update: (id: string, patch: Partial<CliProfile>) => void;
  onClose: () => void;
}) {
  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: 6, padding: "6px 10px", margin: "6px 0", background: "var(--panel-2)" }}>
      <div style={row}>
        <span style={label}>Name</span>
        <input style={{ ...field, width: 200 }} value={profile.name} onChange={(e) => update(profile.id, { name: e.target.value })} />
      </div>
      <div style={row}>
        <span style={label}>Command</span>
        <input style={{ ...field, width: 200 }} list="cli-profile-cmds" value={profile.command} onChange={(e) => update(profile.id, { command: e.target.value })} />
        <datalist id="cli-profile-cmds">
          {KNOWN_AGENT_CMDS.map((c) => <option key={c} value={c} />)}
        </datalist>
      </div>
      <div style={row}>
        <span style={label}>Model <span style={{ color: "var(--muted)", fontSize: 10 }}>(optional, added via the CLI's model flag)</span></span>
        <input style={{ ...field, width: 200 }} placeholder="e.g. claude-opus-4-8" value={profile.model ?? ""} onChange={(e) => update(profile.id, { model: e.target.value })} />
      </div>
      <div style={row}>
        <span style={label}>Extra args <span style={{ color: "var(--muted)", fontSize: 10 }}>(optional)</span></span>
        <input style={{ ...field, width: 200 }} value={profile.extraArgs ?? ""} onChange={(e) => update(profile.id, { extraArgs: e.target.value })} />
      </div>
      <div style={{ ...row, borderBottom: "none" }}>
        <code style={{ fontSize: 11, color: "var(--muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{cliProfileCommand(profile)}</code>
        <button onClick={onClose} style={{ ...field, cursor: "pointer", flexShrink: 0 }}>Close</button>
      </div>
    </div>
  );
}
