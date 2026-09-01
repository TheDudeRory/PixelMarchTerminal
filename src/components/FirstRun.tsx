import { type CSSProperties, useEffect, useState } from "react";
import { useLayout } from "../stores/layout";
import { useBackdropClose } from "../lib/useBackdropClose";
import { loadState } from "../lib/ipc";
import { overlay } from "../lib/uiStyles";

// One-time welcome for a genuinely fresh install (someone who just unzipped the
// app). It exists because on Linux several features degrade silently when an
// optional package is missing. Everything else the app can explain in place;
// that one costs you a confusing first ten minutes.

/** True when there is no `pixelmarch.json` in the app's data/ folder. `raw` is what the
 *  Rust `load_state` command returned: null = the file does not exist. */
export function stateFileMissing(raw: string | null | undefined): boolean {
  return raw == null || raw.trim() === "";
}

export interface WelcomeInputs {
  /** Startup found no saved layout (layout store's freshProfile). */
  freshProfile: boolean;
  /** The state file really is absent — distinguishes a fresh profile from a
   *  corrupt/unreadable one, which should NOT be greeted as new. */
  fileMissing: boolean;
  /** Persisted "I have seen this" flag from settings. */
  dismissed: boolean | undefined;
}

/** Whether to show the welcome. All three have to agree, so an existing user can
 *  never be greeted as a new one. */
export function shouldWelcome({ freshProfile, fileMissing, dismissed }: WelcomeInputs): boolean {
  return freshProfile && fileMissing && !dismissed;
}

/** Linux is the only platform with the optional-package story below; on Windows
 *  those rows would be nonsense. */
export function isLinux(platform: string | undefined, userAgent: string | undefined): boolean {
  const hay = `${platform ?? ""} ${userAgent ?? ""}`.toLowerCase();
  if (hay.includes("android")) return false;
  return hay.includes("linux") || hay.includes("x11");
}

const card: CSSProperties = {
  background: "var(--panel)",
  border: "1px solid var(--border)",
  borderRadius: 10,
  padding: 22,
  width: 560,
  maxWidth: "92vw",
  maxHeight: "86vh",
  overflowY: "auto",
  boxShadow: "0 12px 48px rgba(0,0,0,0.6)",
};
const h = { margin: "0 0 6px", fontSize: 18, color: "var(--text)" } as CSSProperties;
const sub = { margin: "0 0 16px", fontSize: 12.5, color: "var(--muted)", lineHeight: 1.5 } as CSSProperties;
const sectionTitle: CSSProperties = {
  margin: "0 0 4px", fontSize: 11, fontWeight: 700, letterSpacing: 0.5, color: "var(--muted)",
};
const body: CSSProperties = { margin: 0, fontSize: 12.5, color: "var(--text)", lineHeight: 1.55 };
const dep: CSSProperties = { fontSize: 12, color: "var(--muted)", lineHeight: 1.6 };
const primary: CSSProperties = {
  padding: "6px 14px", background: "var(--accent)", color: "#fff",
  border: "none", borderRadius: 5, cursor: "pointer", fontSize: 12.5,
};

export default function FirstRun() {
  const freshProfile = useLayout((s) => s.freshProfile);
  const dismissed = useLayout((s) => s.settings.welcomeDismissed);
  const updateSettings = useLayout((s) => s.updateSettings);
  // undefined = we have not asked the backend yet.
  const [fileMissing, setFileMissing] = useState<boolean | undefined>(undefined);

  useEffect(() => {
    if (!freshProfile || dismissed) return;
    let alive = true;
    // Confirms the profile is new rather than merely unreadable. Throws in a
    // plain browser (no Tauri), where there is no install to welcome anyone to.
    loadState()
      .then((raw) => { if (alive) setFileMissing(stateFileMissing(raw)); })
      .catch(() => { if (alive) setFileMissing(false); });
    return () => { alive = false; };
  }, [freshProfile, dismissed]);

  const dismiss = () => updateSettings({ welcomeDismissed: true });
  const backdrop = useBackdropClose(dismiss);

  if (!shouldWelcome({ freshProfile, fileMissing: fileMissing === true, dismissed })) return null;

  const linux = typeof navigator === "undefined"
    ? false
    : isLinux(navigator.platform, navigator.userAgent);

  return (
    <div style={overlay} {...backdrop}>
      <div style={card} onClick={(e) => e.stopPropagation()}>
        <h2 style={h}>Welcome to PixelMarch</h2>
        <p style={sub}>
          A multi-workspace terminal manager. Split panes, keep several workspaces
          of terminals alive at once, and drive them with global hotkeys and macros.
          Everything it saves — layout, profiles, settings — lives in
          {" "}<code>data/pixelmarch.json</code> inside the app's own source folder,
          so the whole install stays in one directory you can move or delete.
        </p>

        {linux && (
          <div style={{ marginBottom: 14 }}>
            <div style={sectionTitle}>OPTIONAL LINUX PACKAGES</div>
            <p style={body}>
              PixelMarch runs without these; each one only switches off the feature
              next to it, with an error rather than silence.
            </p>
            <ul style={{ ...dep, margin: "6px 0 0", paddingLeft: 18 }}>
              <li><code>pulseaudio</code> / <code>pactl</code> — per-app volume macros and muting output while dictating</li>
              <li><code>xdotool</code> / <code>libxdo</code> — synthetic keyboard and mouse input from macros</li>
              <li><b>X11 or XWayland</b> — window and pixel macros are X11-only; under Wayland the app already asks for the X11 backend</li>
            </ul>
          </div>
        )}

        <p style={{ ...dep, margin: "0 0 16px" }}>
          Press <b>Ctrl+/</b> any time for the shortcut reference, or{" "}
          <b>Ctrl+,</b> for settings.
        </p>

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button type="button" autoFocus style={primary} onClick={dismiss}>
            Get started
          </button>
        </div>
      </div>
    </div>
  );
}
