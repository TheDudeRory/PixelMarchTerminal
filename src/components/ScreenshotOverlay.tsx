// Screenshot plumbing for the main window. Kicks off a capture (each monitor
// saved to its own PNG by the backend) and translates the backend's
// per-file "screenshot-taken" broadcasts into the DOM event ScreenshotThumb
// listens to.
import { useEffect } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { screenshotStart } from "../lib/ipc";
import { useLayout } from "../stores/layout";

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export const SHOT_TAKEN_EVENT = "pixelmarch:screenshot-taken";
export interface ShotTakenDetail { path: string; base64?: string }

export function requestScreenshot() {
  screenshotStart().catch((err) => {
    // Outside Tauri there is nothing to say; a real backend failure has to be
    // visible, or the capture looks like it silently did nothing.
    if (isTauri) useLayout.getState().addToast(`Screenshot failed: ${err}`);
  });
}

export default function ScreenshotBridge() {
  useEffect(() => {
    if (!isTauri) return;
    const unlisten: UnlistenFn[] = [];
    listen<{ path: string }>("screenshot-taken", (e) => {
      window.dispatchEvent(
        new CustomEvent<ShotTakenDetail>(SHOT_TAKEN_EVENT, { detail: { path: e.payload.path } }),
      );
    }).then((u) => unlisten.push(u));
    // The global hotkey captures on its own thread with no reply to await, so
    // its failures arrive as this broadcast instead.
    listen<string>("screenshot-error", (e) => {
      useLayout.getState().addToast(`Screenshot failed: ${e.payload}`);
    }).then((u) => unlisten.push(u));
    return () => unlisten.forEach((u) => u());
  }, []);
  return null;
}
