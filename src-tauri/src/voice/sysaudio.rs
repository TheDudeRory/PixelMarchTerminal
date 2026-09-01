//! Mute/unmute the default output device while PTT is held, so the mic doesn't
//! pick up whatever's playing (video, music). Opt-in via the `mute_on_ptt`
//! setting. Ported from VoiceMarch `sysaudio.rs`. Windows Core Audio deps are
//! unconditional in Cargo.toml (the macro engine needs them too).

#[cfg(windows)]
mod imp {
    use windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume;
    use windows::Win32::Media::Audio::{eConsole, eRender, IMMDeviceEnumerator, MMDeviceEnumerator};
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_MULTITHREADED,
    };

    /// Core Audio handle to the default render endpoint's mute control.
    /// COM interfaces are !Send — used only from the audio thread.
    pub struct SysAudio {
        endpoint: IAudioEndpointVolume,
    }

    impl SysAudio {
        pub fn new() -> Option<Self> {
            unsafe {
                let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
                let enumerator: IMMDeviceEnumerator =
                    CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).ok()?;
                let device = enumerator.GetDefaultAudioEndpoint(eRender, eConsole).ok()?;
                let endpoint: IAudioEndpointVolume = device.Activate(CLSCTX_ALL, None).ok()?;
                Some(Self { endpoint })
            }
        }

        pub fn is_muted(&self) -> bool {
            unsafe { self.endpoint.GetMute().map(|b| b.as_bool()).unwrap_or(false) }
        }

        pub fn set_muted(&self, mute: bool) {
            unsafe {
                let _ = self.endpoint.SetMute(mute, std::ptr::null());
            }
        }
    }

    /// GetMute/SetMute round-trip report. Returns the text — writing it anywhere
    /// is the caller's decision (see `selftest_if_requested`), so a shipped folder
    /// can never collect a stray dump.
    pub fn selftest() -> String {
        use std::fmt::Write as _;
        let mut out = String::new();
        match SysAudio::new() {
            Some(sa) => {
                let prev = sa.is_muted();
                let _ = writeln!(out, "initial muted: {prev}");
                sa.set_muted(true);
                let _ = writeln!(out, "after set true:  {}", sa.is_muted());
                sa.set_muted(false);
                let _ = writeln!(out, "after set false: {}", sa.is_muted());
                sa.set_muted(prev);
                let _ = writeln!(out, "restored to:     {}", sa.is_muted());
            }
            None => {
                let _ = writeln!(out, "SysAudio::new failed");
            }
        }
        out
    }
}

// pactl shell-out for PulseAudio/PipeWire-pulse. Mutes the default *sink*
// (playback output) while PTT is held — matches the Windows path, which mutes
// the default render device so playback doesn't bleed into the recording.
// Mirrors the shellout style of `macros/audio.rs` pactl_impl. Untested on a
// real Linux session.
#[cfg(not(windows))]
mod imp {
    // Shared with the macro engine's audio manager: one locale-pinned pactl
    // launcher, one probe, one `Mute:` field parser (see macros/audio.rs).
    use crate::macros::audio::pactl_impl::{pactl_command, probe_pactl};
    use crate::macros::audio::parse::parse_mute_field;

    /// Marker that `pactl` was found on PATH at construction time.
    pub struct SysAudio;

    fn pactl(args: &[&str]) -> Option<String> {
        let out = pactl_command().args(args).output().ok()?;
        if !out.status.success() {
            return None;
        }
        Some(String::from_utf8_lossy(&out.stdout).into_owned())
    }

    impl SysAudio {
        pub fn new() -> Option<Self> {
            // Probe pactl once; if it's missing (no PulseAudio/PipeWire) bail so
            // the caller treats mute-on-PTT as unavailable, same as Windows None.
            probe_pactl().ok()?;
            Some(Self)
        }

        pub fn is_muted(&self) -> bool {
            // `get-sink-mute @DEFAULT_SINK@` prints e.g. "Mute: yes". Unknown
            // (unparseable) reads as not-muted, matching the Windows fallback.
            pactl(&["get-sink-mute", "@DEFAULT_SINK@"])
                .and_then(|s| parse_mute_field(&s))
                .unwrap_or(false)
        }

        pub fn set_muted(&self, mute: bool) {
            let arg = if mute { "1" } else { "0" };
            let _ = pactl(&["set-sink-mute", "@DEFAULT_SINK@", arg]);
        }
    }

    /// Same round-trip diagnostic as the Windows path; returns the report rather
    /// than writing it (see `selftest_if_requested`).
    pub fn selftest() -> String {
        use std::fmt::Write as _;
        let mut out = String::new();
        if let Err(e) = probe_pactl() {
            let _ = writeln!(out, "pactl probe failed: {e}");
        }
        match SysAudio::new() {
            Some(sa) => {
                let prev = sa.is_muted();
                let _ = writeln!(out, "initial muted: {prev}");
                sa.set_muted(true);
                let _ = writeln!(out, "after set true:  {}", sa.is_muted());
                sa.set_muted(false);
                let _ = writeln!(out, "after set false: {}", sa.is_muted());
                sa.set_muted(prev);
                let _ = writeln!(out, "restored to:     {}", sa.is_muted());
            }
            None => {
                let _ = writeln!(out, "SysAudio::new failed");
            }
        }
        out
    }
}

pub use imp::SysAudio;
#[allow(unused_imports)]
pub use imp::selftest;

/// Env var that asks for the mute diagnostic. `VM_MUTE_SELFTEST` is the
/// VoiceMarch-era name, kept working.
const SELFTEST_VARS: [&str; 2] = ["PIXELMARCH_MUTE_SELFTEST", "VM_MUTE_SELFTEST"];

fn selftest_requested<F: Fn(&str) -> Option<String>>(get: F) -> bool {
    SELFTEST_VARS.iter().any(|v| get(v).as_deref() == Some("1"))
}

/// Run the mute round-trip ONLY when explicitly asked for
/// (`PIXELMARCH_MUTE_SELFTEST=1`), and put the report in `logs/`, never beside
/// the exe.
///
/// It used to `fs::write` `mute_selftest.txt` into the portable folder — the same
/// folder a user unzips. A diagnostic nobody asked for must not leave litter in
/// an install, so the trigger is explicit and the destination is the log dir that
/// already exists for exactly this kind of output. Returns true if it ran.
#[allow(dead_code)]
pub fn selftest_if_requested() -> bool {
    if !selftest_requested(|v| std::env::var(v).ok()) {
        return false;
    }
    let report = selftest();
    match crate::state::logs_dir() {
        // logs_dir() creates the directory on demand; still nothing is written
        // unless the operator asked for the self-test.
        Ok(dir) => {
            let _ = std::fs::write(std::path::Path::new(&dir).join("mute-selftest.txt"), &report);
        }
        Err(e) => eprintln!("mute self-test: no logs dir ({e})"),
    }
    eprint!("{report}");
    true
}

#[cfg(test)]
mod tests {
    use super::selftest_requested;

    #[test]
    fn the_diagnostic_is_off_unless_explicitly_asked_for() {
        assert!(!selftest_requested(|_| None));
        assert!(!selftest_requested(|_| Some("0".into())));
        // "set to anything" is not enough — it must be exactly 1, like every
        // other flag in this codebase (update.rs env_flag).
        assert!(!selftest_requested(|_| Some("true".into())));
    }

    #[test]
    fn both_the_current_and_the_voicemarch_era_name_work() {
        assert!(selftest_requested(|v| (v == "PIXELMARCH_MUTE_SELFTEST").then(|| "1".into())));
        assert!(selftest_requested(|v| (v == "VM_MUTE_SELFTEST").then(|| "1".into())));
    }
}
