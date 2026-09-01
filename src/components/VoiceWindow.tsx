import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  onVoicePtt,
  onVoiceCapture,
  onVoiceModel,
  onVoiceTranscript,
  onVoiceDone,
} from "../lib/ipc";
import { VoiceSettingsForm } from "./VoiceSettings";
import "./voice.css";

// The standalone "voice" webview window (rendered when the URL has ?voice=1).
// Pixel-matches VoiceMarch (Z:/SVN/VoiceMarch/src): TWO mutually-exclusive states
// in ONE window that the Rust `set_compact` command resizes between —
//   compact  -> the floating pill bar  (152x72)
//   expanded -> the settings panel     (320x480)
// Capture/STT live in Rust; this window only reflects the voice-* events and
// drives the settings form.

type Phase = "idle" | "listening" | "transcribing";

// The OS window resize lives in Rust (voice/mod.rs `set_compact`): it pins the
// window to the pill/panel size and returns the pill to its saved home spot.
// Swallow the error so a failed resize never blocks the UI from toggling.
const setCompactWindow = (compact: boolean) =>
  invoke("set_compact", { compact }).catch(() => {});

export default function VoiceWindow() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [loading, setLoading] = useState(false);
  const [compact, setCompact] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    // PTT down -> listening (green); up / capture -> transcribing (amber);
    // finished transcript -> idle. Model (re)load toggles the blue spinner ring.
    const uns: Array<Promise<() => void>> = [
      onVoicePtt((edge) => setPhase(edge === "down" ? "listening" : "transcribing")),
      onVoiceCapture(() => setPhase("transcribing")),
      onVoiceModel((st) => setLoading(st === "loading")),
      onVoiceTranscript(() => setPhase("idle")),
      // Terminal path fires voice-transcript (above); the non-terminal paths
      // (type/paste/empty/error) fire voice-done instead. Either resets the pill.
      onVoiceDone(() => setPhase("idle")),
    ];
    return () => { uns.forEach((p) => p.then((u) => u()).catch(() => {})); };
  }, []);

  const openSettings = () => {
    setError("");
    setCompact(false);
    setCompactWindow(false);
  };
  const closeSettings = () => {
    setCompact(true);
    setCompactWindow(true);
  };

  // "!" indicator: idle grey, listening green (pulse), transcribing amber, plus
  // the loading ring layered on when the model is (re)loading.
  const indClass = `pill ind${phase === "listening" ? " listening" : ""}${
    phase === "transcribing" ? " transcribing" : ""
  }${loading ? " loading" : ""}`;

  return (
    <div className="voice-root">
      {compact ? (
        // Compact bar: "!" = PTT status, gear = settings. Drag anywhere but the gear.
        <div className="bar" data-tauri-drag-region>
          <div
            className={indClass}
            data-tauri-drag-region
            role="img"
            aria-label="Dictation status"
            title="Hold the hotkey to dictate"
          >
            !
          </div>
          <button className="pill gear" type="button" aria-label="Settings" title="Settings" onClick={openSettings}>
            ⚙
          </button>
        </div>
      ) : (
        <form
          className="panel"
          onSubmit={(e) => {
            e.preventDefault();
            closeSettings();
          }}
        >
          <div className="panel__head">
            <h1 className="panel__title">Settings</h1>
            <button type="button" className="x-btn" aria-label="Close settings" title="Close" onClick={closeSettings}>
              ✕
            </button>
          </div>

          <VoiceSettingsForm onError={setError} />

          <p className="error" role="alert">{error}</p>
          <div className="row">
            <button type="submit" className="btn-wide primary">Save</button>
            <button type="button" className="btn-wide" onClick={closeSettings}>Close</button>
          </div>
        </form>
      )}
    </div>
  );
}
