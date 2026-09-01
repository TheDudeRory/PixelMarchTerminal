//! Voice-To-Text settings — ported from VoiceMarch `settings.rs`, trimmed to the
//! fields PixelMarch exposes. Persisted as `voice-settings.json` NEXT TO THE EXE
//! so the portable folder stays self-contained. `serde(default)` lets an old or
//! partial file fill missing fields from defaults.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(default)]
pub struct VoiceSettings {
    // Master switch. Off means: no PTT hotkey held, no capture, no pill window,
    // no toolbar/tray entry — the rest of this struct still persists so turning
    // it back on restores the user's configuration untouched.
    pub enabled: bool,
    pub ptt_hotkey: String,       // global push-to-talk combo, works unfocused
    pub mic_device: Option<String>,
    pub spacing: String,          // space | newline | none
    pub punctuation: String,      // keep | strip | spoken
    pub whisper_model: String,    // tiny.en | base.en | base.en-q8_0
    pub insertion: String,        // paste | type (OS cursor, VoiceMarch) | terminal (emit event)
    pub always_on_top: bool,
    pub mute_on_ptt: bool,        // mute default output device while PTT held (sysaudio.rs)
    pub start_on_login: bool,     // HKCU..Run entry (VoiceMarch parity)
    pub chirp: bool,              // feedback tone on PTT press/release
    pub chirp_volume: u32,        // 0–100
    // Hands-free advanced fields — parity with VoiceMarch's settings/UI. They are
    // persisted and surfaced in the UI but NOT wired to live VAD (the engine is
    // PTT-only), matching VoiceMarch itself.
    pub mic_sensitivity: f32,     // RMS gate threshold
    pub end_of_speech_ms: u32,    // silence before auto-stop
    // Pill window geometry: saved compact ("home") position + collapsed state, so
    // set_compact can return the pill to where the user left it (VoiceMarch).
    pub window: WindowGeom,
}

/// Persisted position of the voice pill and whether it was left collapsed.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct WindowGeom {
    pub x: Option<i32>,
    pub y: Option<i32>,
    pub collapsed: bool,
}

impl Default for VoiceSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            ptt_hotkey: "F8".into(),
            mic_device: None,
            spacing: "space".into(),
            punctuation: "keep".into(),
            whisper_model: "base.en-q8_0".into(),
            insertion: "paste".into(),
            always_on_top: true,
            mute_on_ptt: false,
            start_on_login: false,
            chirp: true,
            chirp_volume: 50,
            mic_sensitivity: 0.02,
            end_of_speech_ms: 800,
            window: WindowGeom { x: None, y: None, collapsed: true },
        }
    }
}

/// Directory of the running exe — the portable home for settings + GGML models.
/// Reuses the app's `state::state_dir`, falling back to the CWD if it can't be
/// resolved (matches VoiceMarch's forgiving behaviour).
/// The profile directory every voice file lives in (`<repo>/data`).
/// Thin alias over `state::state_dir` so voice has one name for it.
pub fn data_dir() -> PathBuf {
    crate::state::state_dir().unwrap_or_else(|_| PathBuf::from("."))
}

pub fn settings_path() -> PathBuf {
    data_dir().join("voice-settings.json")
}

pub fn load() -> VoiceSettings {
    match std::fs::read_to_string(settings_path()) {
        Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
        Err(_) => VoiceSettings::default(),
    }
}

pub fn save(s: &VoiceSettings) -> std::io::Result<()> {
    let json = serde_json::to_string_pretty(s).expect("voice settings serialize");
    std::fs::write(settings_path(), json)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_and_partial_roundtrip() {
        let s = VoiceSettings::default();
        let j = serde_json::to_string(&s).unwrap();
        let back: VoiceSettings = serde_json::from_str(&j).unwrap();
        assert_eq!(back.ptt_hotkey, "F8");
        assert_eq!(back.punctuation, "keep");
        assert!(back.enabled);

        // a partial file keeps its value and fills the rest from defaults
        let partial: VoiceSettings = serde_json::from_str(r#"{"spacing":"newline"}"#).unwrap();
        assert_eq!(partial.spacing, "newline");
        assert_eq!(partial.whisper_model, "base.en-q8_0");
        assert!(partial.chirp);
        assert_eq!(partial.chirp_volume, 50);
        // A file written before the master switch existed must read back ENABLED:
        // an upgrade may not silently kill dictation.
        assert!(partial.enabled);

        let off: VoiceSettings = serde_json::from_str(r#"{"enabled":false}"#).unwrap();
        assert!(!off.enabled);
        assert_eq!(off.ptt_hotkey, "F8"); // config survives the switch being off
    }
}
