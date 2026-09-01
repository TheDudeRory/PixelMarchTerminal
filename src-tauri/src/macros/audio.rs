#[derive(Debug, Clone, PartialEq)]
pub struct AudioDevice {
    pub id: String,
    pub name: String,
    pub output: bool,
    pub default: bool,
}

/// A per-application audio stream on the default render endpoint (Windows audio
/// session / PulseAudio sink-input). `volume` is 0-100.
#[derive(Debug, Clone, PartialEq)]
pub struct AudioSession {
    pub pid: u32,
    pub name: String,
    pub volume: i32,
    pub muted: bool,
}

pub trait AudioDeviceManager: Send + Sync {
    /// Active render + capture endpoints.
    fn list(&self) -> Result<Vec<AudioDevice>, String>;
    fn set_default(&self, id: &str) -> Result<(), String>;
    /// Master volume by delta percent; returns the new percent.
    fn adjust_master_volume(&self, delta_percent: i32) -> Result<i32, String>;
    /// Master volume to an absolute percent (0-100, clamped); returns the new
    /// percent. Unlike `adjust_master_volume` this does not read the current
    /// level first, so a macro lands on the same volume every run.
    fn set_master_volume(&self, percent: i32) -> Result<i32, String>;
    /// Returns the new mute state.
    fn toggle_mute(&self) -> Result<bool, String>;
    /// Per-application streams playing on the default output.
    fn list_sessions(&self) -> Result<Vec<AudioSession>, String>;
    /// Set one app's volume (0-100) and/or mute. `target` is a PID (numeric) or
    /// a fuzzy application-name match. `None` leaves that facet unchanged.
    fn set_app_volume(
        &self,
        target: &str,
        level: Option<i32>,
        mute: Option<bool>,
    ) -> Result<(), String>;
}

/// Resolve a per-app target: exact PID first, then exact name, then substring.
pub fn match_session<'a>(target: &str, sessions: &'a [AudioSession]) -> Option<&'a AudioSession> {
    let t = target.trim();
    if let Ok(pid) = t.parse::<u32>() {
        if let Some(s) = sessions.iter().find(|s| s.pid == pid) {
            return Some(s);
        }
    }
    let tl = t.to_lowercase();
    sessions
        .iter()
        .find(|s| s.name.to_lowercase() == tl)
        .or_else(|| sessions.iter().find(|s| s.name.to_lowercase().contains(&tl)))
}

/// Devices are stored by name; IDs change across replugs, so re-match fuzzily:
/// exact name → name contains query → query contains name.
pub fn match_device<'a>(
    query: &str,
    devices: &'a [AudioDevice],
    want_output: bool,
) -> Option<&'a AudioDevice> {
    let q = query.trim().to_lowercase();
    let pool = || devices.iter().filter(|d| d.output == want_output);
    pool()
        .find(|d| d.name.to_lowercase() == q)
        .or_else(|| pool().find(|d| d.name.to_lowercase().contains(&q)))
        .or_else(|| pool().find(|d| q.contains(&d.name.to_lowercase())))
}

pub fn device_exists(query: &str, devices: &[AudioDevice]) -> bool {
    match_device(query, devices, true).is_some() || match_device(query, devices, false).is_some()
}

/// True when the best name match (output preferred, then input) is the current
/// default endpoint. Lets a macro branch on which device is selected.
pub fn device_is_default(query: &str, devices: &[AudioDevice]) -> bool {
    match_device(query, devices, true).map(|d| d.default).unwrap_or(false)
        || match_device(query, devices, false).map(|d| d.default).unwrap_or(false)
}

#[cfg(windows)]
pub use win_impl::NativeAudioManager;
#[cfg(not(windows))]
pub use pactl_impl::NativeAudioManager;

/// Pure `pactl` output parsers. Compiled on every platform (Windows included) so
/// the fixture tests run on the build host — only the shell-out around them is
/// Linux-only. Every parser assumes the caller ran pactl under `LC_ALL=C`
/// (see `pactl_command`): pactl translates BOTH field labels and values, so
/// `Mute: yes` becomes `Stumm: ja` on a German desktop and any substring match
/// on "yes" silently reports "not muted" forever.
pub mod parse {
    /// One `pactl list sink-inputs` block: the per-app playback stream. `index`
    /// is pactl's stable handle (used by set-sink-input-*); `pid`/`name` come from
    /// the `application.process.id` / `application.name` properties.
    #[derive(Debug, Clone, PartialEq)]
    pub struct SinkInput {
        pub index: u32,
        pub pid: u32,
        pub name: String,
        pub volume: i32,
        pub muted: bool,
    }

    /// `Mute: yes|no` as a FIELD, not a substring: a device called
    /// "keyestudio USB Audio" contains "yes" and used to read as muted.
    /// `None` = no recognisable Mute line (localised output, or none at all) —
    /// callers must treat that as unknown rather than guessing.
    pub fn parse_mute_field(text: &str) -> Option<bool> {
        text.lines().find_map(|line| {
            let rest = line.trim().strip_prefix("Mute:")?;
            match rest.trim() {
                "yes" => Some(true),
                "no" => Some(false),
                _ => None,
            }
        })
    }

    /// First `NN%` token on the first `Volume:` line. pactl prints one
    /// per channel ("front-left: 42598 / 65% / -8.13 dB, front-right: ..."),
    /// all equal in practice.
    pub fn parse_volume_percent(text: &str) -> Option<i32> {
        let line = text.lines().find(|l| l.trim_start().starts_with("Volume:"))?;
        line.split_whitespace().find_map(|tok| {
            tok.trim_end_matches(',').strip_suffix('%')?.parse::<i32>().ok()
        })
    }

    /// Parse long-form `pactl list sinks|sources` into (id, friendly) pairs.
    /// Blocks start at a column-0 header (`Sink #N` / `Source #N`); the first
    /// indented `Name:` in a block is the id and the first `Description:` is the
    /// friendly label (missing description falls back to the name).
    pub fn parse_devices(list_long: &str) -> Vec<(String, String)> {
        let mut out = Vec::new();
        let mut name: Option<String> = None;
        let mut desc: Option<String> = None;
        let mut flush = |name: &mut Option<String>, desc: &mut Option<String>| {
            if let Some(n) = name.take() {
                let friendly = desc.take().unwrap_or_else(|| n.clone());
                out.push((n, friendly));
            }
            *desc = None;
        };
        for line in list_long.lines() {
            let is_header = !line.is_empty() && !line.starts_with(char::is_whitespace);
            if is_header {
                flush(&mut name, &mut desc);
                continue;
            }
            let t = line.trim();
            if name.is_none() {
                if let Some(rest) = t.strip_prefix("Name:") {
                    name = Some(rest.trim().to_string());
                    continue;
                }
            }
            if desc.is_none() {
                if let Some(rest) = t.strip_prefix("Description:") {
                    desc = Some(rest.trim().to_string());
                }
            }
        }
        flush(&mut name, &mut desc);
        out
    }

    /// Parse `pactl list sink-inputs`. Blocks start at a column-0 `Sink Input #N`
    /// header; the first `Volume:` percentage, the `Mute:` flag, and the
    /// `application.name` / `application.process.id` properties fill the record.
    pub fn parse_sink_inputs(list_long: &str) -> Vec<SinkInput> {
        let mut out = Vec::new();
        let mut cur: Option<SinkInput> = None;
        let mut have_volume = false;
        let flush = |out: &mut Vec<SinkInput>, cur: &mut Option<SinkInput>, have_volume: &mut bool| {
            if let Some(si) = cur.take() {
                out.push(si);
            }
            *have_volume = false;
        };
        for line in list_long.lines() {
            if let Some(rest) = line.strip_prefix("Sink Input #") {
                flush(&mut out, &mut cur, &mut have_volume);
                cur = Some(SinkInput {
                    index: rest.trim().parse().unwrap_or(0),
                    pid: 0,
                    name: String::new(),
                    volume: 0,
                    muted: false,
                });
                continue;
            }
            let Some(si) = cur.as_mut() else { continue };
            let t = line.trim();
            if t.starts_with("Mute:") {
                // Unrecognisable (localised) value leaves the previous default.
                if let Some(m) = parse_mute_field(t) {
                    si.muted = m;
                }
            } else if !have_volume && t.starts_with("Volume:") {
                if let Some(pct) = parse_volume_percent(t) {
                    si.volume = pct;
                }
                have_volume = true;
            } else if let Some(rest) = t.strip_prefix("application.name = ") {
                si.name = rest.trim().trim_matches('"').to_string();
            } else if let Some(rest) = t.strip_prefix("application.process.id = ") {
                si.pid = rest.trim().trim_matches('"').parse().unwrap_or(0);
            } else if si.name.is_empty() {
                if let Some(rest) = t.strip_prefix("media.name = ") {
                    si.name = rest.trim().trim_matches('"').to_string();
                }
            }
        }
        flush(&mut out, &mut cur, &mut have_volume);
        for si in &mut out {
            if si.name.is_empty() {
                si.name = format!("sink-input {}", si.index);
            }
        }
        out
    }
}

#[cfg(windows)]
mod win_impl {
    // IPolicyConfig::SetDefaultEndpoint is a COM vtable slot — its name must
    // match the interface exactly, so snake_case does not apply here.
    #![allow(non_snake_case)]
    use super::{match_session, AudioDevice, AudioDeviceManager, AudioSession};
    use windows::core::{interface, Interface, IUnknown, IUnknown_Vtbl, GUID, HRESULT, PCWSTR, PWSTR};
    use windows::Win32::Foundation::{CloseHandle, PROPERTYKEY};
    use windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume;
    use windows::Win32::Media::Audio::{
        eCapture, eCommunications, eConsole, eMultimedia, eRender, ERole, IAudioSessionControl2,
        IAudioSessionManager2, IMMDevice, IMMDeviceEnumerator, ISimpleAudioVolume, MMDeviceEnumerator,
        DEVICE_STATE_ACTIVE,
    };
    use windows::Win32::System::Com::StructuredStorage::PropVariantToStringAlloc;
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoTaskMemFree, CLSCTX_ALL, COINIT_MULTITHREADED,
        STGM_READ,
    };
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };

    const PKEY_DEVICE_FRIENDLYNAME: PROPERTYKEY = PROPERTYKEY {
        fmtid: GUID::from_u128(0xa45c254e_df1c_4efd_8020_67d146a850e0),
        pid: 14,
    };
    const CLSID_POLICY_CONFIG: GUID = GUID::from_u128(0x870af99c_171d_4f9e_af0d_e63df40c2bc9);

    /// Undocumented but stable-since-Vista interface used by every audio
    /// switcher; only SetDefaultEndpoint is called, earlier slots are padding.
    #[interface("f8679f50-850a-41cf-9c72-430f290290c8")]
    unsafe trait IPolicyConfig: IUnknown {
        unsafe fn slot_get_mix_format(&self) -> HRESULT;
        unsafe fn slot_get_device_format(&self) -> HRESULT;
        unsafe fn slot_reset_device_format(&self) -> HRESULT;
        unsafe fn slot_set_device_format(&self) -> HRESULT;
        unsafe fn slot_get_processing_period(&self) -> HRESULT;
        unsafe fn slot_set_processing_period(&self) -> HRESULT;
        unsafe fn slot_get_share_mode(&self) -> HRESULT;
        unsafe fn slot_set_share_mode(&self) -> HRESULT;
        unsafe fn slot_get_property_value(&self) -> HRESULT;
        unsafe fn slot_set_property_value(&self) -> HRESULT;
        // COM vtable slot — must match the interface name exactly, not snake_case.
        unsafe fn SetDefaultEndpoint(&self, device_id: PCWSTR, role: ERole) -> HRESULT;
    }

    pub struct NativeAudioManager;

    fn estr<E: std::fmt::Display>(e: E) -> String {
        e.to_string()
    }

    fn com_init() {
        // S_FALSE / RPC_E_CHANGED_MODE are fine — some thread already did it.
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        }
    }

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    unsafe fn device_id(dev: &IMMDevice) -> Result<String, String> {
        unsafe {
            let p = dev.GetId().map_err(estr)?;
            let s = p.to_string().map_err(estr)?;
            CoTaskMemFree(Some(p.0 as _));
            Ok(s)
        }
    }

    unsafe fn friendly_name(dev: &IMMDevice) -> Result<String, String> {
        unsafe {
            let store = dev.OpenPropertyStore(STGM_READ).map_err(estr)?;
            let value = store.GetValue(&PKEY_DEVICE_FRIENDLYNAME).map_err(estr)?;
            let p = PropVariantToStringAlloc(&value).map_err(estr)?;
            let s = p.to_string().map_err(estr)?;
            CoTaskMemFree(Some(p.0 as _));
            Ok(s)
        }
    }

    fn enumerator() -> Result<IMMDeviceEnumerator, String> {
        com_init();
        unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).map_err(estr) }
    }

    fn default_volume_endpoint() -> Result<IAudioEndpointVolume, String> {
        unsafe {
            let device = enumerator()?
                .GetDefaultAudioEndpoint(eRender, eConsole)
                .map_err(estr)?;
            device.Activate::<IAudioEndpointVolume>(CLSCTX_ALL, None).map_err(estr)
        }
    }

    /// Best-effort app label for a session's owning process: the exe file stem,
    /// falling back to "pid N" (or "System Sounds" for the pid-0 system session).
    unsafe fn process_name(pid: u32) -> String {
        if pid == 0 {
            return "System Sounds".into();
        }
        unsafe {
            let handle = match OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) {
                Ok(h) => h,
                Err(_) => return format!("pid {pid}"),
            };
            let mut buf = [0u16; 260];
            let mut len = buf.len() as u32;
            let ok = QueryFullProcessImageNameW(
                handle,
                PROCESS_NAME_WIN32,
                PWSTR(buf.as_mut_ptr()),
                &mut len,
            )
            .is_ok();
            let _ = CloseHandle(handle);
            if ok {
                let full = String::from_utf16_lossy(&buf[..len as usize]);
                let base = full.rsplit(['\\', '/']).next().unwrap_or(&full);
                return base.strip_suffix(".exe").unwrap_or(base).to_string();
            }
            format!("pid {pid}")
        }
    }

    /// Enumerate the render endpoint's audio sessions as
    /// (ISimpleAudioVolume, pid, app name). The volume handle is kept so callers
    /// can both read and mutate without re-walking the enumerator.
    unsafe fn collect_sessions() -> Result<Vec<(ISimpleAudioVolume, u32, String)>, String> {
        unsafe {
            let device = enumerator()?
                .GetDefaultAudioEndpoint(eRender, eConsole)
                .map_err(estr)?;
            let mgr: IAudioSessionManager2 =
                device.Activate(CLSCTX_ALL, None).map_err(estr)?;
            let sessions = mgr.GetSessionEnumerator().map_err(estr)?;
            let count = sessions.GetCount().map_err(estr)?;
            let mut out = Vec::new();
            for i in 0..count {
                let ctrl = sessions.GetSession(i).map_err(estr)?;
                let ctrl2: IAudioSessionControl2 = ctrl.cast().map_err(estr)?;
                let pid = ctrl2.GetProcessId().unwrap_or(0);
                let vol: ISimpleAudioVolume = ctrl2.cast().map_err(estr)?;
                out.push((vol, pid, process_name(pid)));
            }
            Ok(out)
        }
    }

    impl AudioDeviceManager for NativeAudioManager {
        fn list(&self) -> Result<Vec<AudioDevice>, String> {
            let enumerator = enumerator()?;
            let mut out = Vec::new();
            unsafe {
                for (flow, output) in [(eRender, true), (eCapture, false)] {
                    let default_id = enumerator
                        .GetDefaultAudioEndpoint(flow, eConsole)
                        .ok()
                        .and_then(|d| device_id(&d).ok());
                    let coll = enumerator
                        .EnumAudioEndpoints(flow, DEVICE_STATE_ACTIVE)
                        .map_err(estr)?;
                    for i in 0..coll.GetCount().map_err(estr)? {
                        let dev = coll.Item(i).map_err(estr)?;
                        let id = device_id(&dev)?;
                        let name = friendly_name(&dev).unwrap_or_else(|_| id.clone());
                        out.push(AudioDevice {
                            default: default_id.as_deref() == Some(id.as_str()),
                            id,
                            name,
                            output,
                        });
                    }
                }
            }
            Ok(out)
        }

        fn set_default(&self, id: &str) -> Result<(), String> {
            com_init();
            unsafe {
                let policy: IPolicyConfig =
                    CoCreateInstance(&CLSID_POLICY_CONFIG, None, CLSCTX_ALL).map_err(estr)?;
                let id = wide(id);
                for role in [eConsole, eMultimedia, eCommunications] {
                    policy
                        .SetDefaultEndpoint(PCWSTR(id.as_ptr()), role)
                        .ok()
                        .map_err(estr)?;
                }
            }
            Ok(())
        }

        fn adjust_master_volume(&self, delta_percent: i32) -> Result<i32, String> {
            unsafe {
                let vol = default_volume_endpoint()?;
                let current = vol.GetMasterVolumeLevelScalar().map_err(estr)?;
                let new = (current + delta_percent as f32 / 100.0).clamp(0.0, 1.0);
                vol.SetMasterVolumeLevelScalar(new, std::ptr::null()).map_err(estr)?;
                Ok((new * 100.0).round() as i32)
            }
        }

        fn set_master_volume(&self, percent: i32) -> Result<i32, String> {
            unsafe {
                let pct = percent.clamp(0, 100);
                let vol = default_volume_endpoint()?;
                vol.SetMasterVolumeLevelScalar(pct as f32 / 100.0, std::ptr::null()).map_err(estr)?;
                Ok(pct)
            }
        }

        fn toggle_mute(&self) -> Result<bool, String> {
            unsafe {
                let vol = default_volume_endpoint()?;
                let muted = vol.GetMute().map_err(estr)?.as_bool();
                vol.SetMute(!muted, std::ptr::null()).map_err(estr)?;
                Ok(!muted)
            }
        }

        fn list_sessions(&self) -> Result<Vec<AudioSession>, String> {
            unsafe {
                let mut out = Vec::new();
                for (vol, pid, name) in collect_sessions()? {
                    let level = vol.GetMasterVolume().map_err(estr)?;
                    let muted = vol.GetMute().map_err(estr)?.as_bool();
                    out.push(AudioSession {
                        pid,
                        name,
                        volume: (level * 100.0).round() as i32,
                        muted,
                    });
                }
                Ok(out)
            }
        }

        fn set_app_volume(
            &self,
            target: &str,
            level: Option<i32>,
            mute: Option<bool>,
        ) -> Result<(), String> {
            unsafe {
                let collected = collect_sessions()?;
                // Reuse the shared matcher over lightweight snapshots, then apply
                // to the live ISimpleAudioVolume at the matched index.
                let snapshot: Vec<AudioSession> = collected
                    .iter()
                    .map(|(_, pid, name)| AudioSession {
                        pid: *pid,
                        name: name.clone(),
                        volume: 0,
                        muted: false,
                    })
                    .collect();
                let matched = match_session(target, &snapshot)
                    .ok_or_else(|| format!("no audio session matches {target:?}"))?;
                let idx = snapshot.iter().position(|s| std::ptr::eq(s, matched)).unwrap();
                let vol = &collected[idx].0;
                if let Some(pct) = level {
                    let scalar = (pct as f32 / 100.0).clamp(0.0, 1.0);
                    vol.SetMasterVolume(scalar, std::ptr::null()).map_err(estr)?;
                }
                if let Some(m) = mute {
                    vol.SetMute(m, std::ptr::null()).map_err(estr)?;
                }
                Ok(())
            }
        }
    }
}

/// ponytail: untested-on-this-box pactl shell-out (PulseAudio/PipeWire-pulse).
/// The internal `Name:` stays the stable id (survives replug, used by set-default);
/// the human-facing `Description:` becomes the display name, falling back to the
/// name when a device has none.
#[cfg(not(windows))]
pub mod pactl_impl {
    use super::parse::{parse_devices, parse_mute_field, parse_sink_inputs, parse_volume_percent};
    use super::{match_session, AudioDevice, AudioDeviceManager, AudioSession};
    use std::process::Command;

    pub struct NativeAudioManager;

    /// Every pactl invocation goes through this: `LC_ALL=C` pins field labels AND
    /// values to English, otherwise a translated `Mute: ja` / `Beschreibung:`
    /// silently defeats every parser in `super::parse`.
    pub fn pactl_command() -> Command {
        let mut cmd = Command::new("pactl");
        cmd.env("LC_ALL", "C").env("LC_MESSAGES", "C").env("LANG", "C");
        // Single choke point for every pactl spawn, so the webview's XDG
        // redirect never reaches it (see pty::strip_webview_env).
        crate::pty::strip_webview_env(&mut cmd);
        cmd
    }

    /// Is pactl actually installed? Distinguishes "not on PATH" (no
    /// PulseAudio/PipeWire-pulse) from "present but failing", so the UI can say
    /// which. Call before assuming any of the audio API works.
    pub fn probe_pactl() -> Result<(), String> {
        match pactl_command().arg("--version").output() {
            Ok(out) if out.status.success() => Ok(()),
            Ok(out) => Err(format!(
                "pactl found but `pactl --version` failed: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            )),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Err(
                "pactl not found on PATH - install pulseaudio-utils (PulseAudio or \
                 PipeWire-pulse) for audio control"
                    .into(),
            ),
            Err(e) => Err(format!("pactl unavailable: {e}")),
        }
    }

    fn pactl(args: &[&str]) -> Result<String, String> {
        let out = pactl_command().args(args).output().map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                probe_pactl().unwrap_err()
            } else {
                format!("pactl unavailable: {e}")
            }
        })?;
        if !out.status.success() {
            return Err(format!("pactl {:?}: {}", args, String::from_utf8_lossy(&out.stderr)));
        }
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    }

    impl AudioDeviceManager for NativeAudioManager {
        fn list(&self) -> Result<Vec<AudioDevice>, String> {
            let mut out = Vec::new();
            for (kind, output, default_cmd) in
                [("sinks", true, "get-default-sink"), ("sources", false, "get-default-source")]
            {
                let default = pactl(&[default_cmd]).map(|s| s.trim().to_string()).unwrap_or_default();
                for (id, friendly) in parse_devices(&pactl(&["list", kind])?) {
                    out.push(AudioDevice {
                        default: id == default,
                        id,
                        name: friendly,
                        output,
                    });
                }
            }
            Ok(out)
        }

        fn set_default(&self, id: &str) -> Result<(), String> {
            let sinks = pactl(&["list", "short", "sinks"])?;
            let cmd = if sinks.lines().any(|l| l.split('\t').nth(1) == Some(id)) {
                "set-default-sink"
            } else {
                "set-default-source"
            };
            pactl(&[cmd, id]).map(|_| ())
        }

        fn adjust_master_volume(&self, delta_percent: i32) -> Result<i32, String> {
            let sign = if delta_percent >= 0 { "+" } else { "-" };
            pactl(&["set-sink-volume", "@DEFAULT_SINK@", &format!("{sign}{}%", delta_percent.abs())])?;
            let text = pactl(&["get-sink-volume", "@DEFAULT_SINK@"])?;
            parse_volume_percent(&text).ok_or_else(|| format!("cannot parse volume from {text:?}"))
        }

        fn set_master_volume(&self, percent: i32) -> Result<i32, String> {
            // Bare `NN%` is absolute; only a leading +/- makes pactl treat it as
            // a delta (see adjust_master_volume above).
            let pct = percent.clamp(0, 100);
            pactl(&["set-sink-volume", "@DEFAULT_SINK@", &format!("{pct}%")])?;
            let text = pactl(&["get-sink-volume", "@DEFAULT_SINK@"])?;
            parse_volume_percent(&text).ok_or_else(|| format!("cannot parse volume from {text:?}"))
        }

        fn toggle_mute(&self) -> Result<bool, String> {
            pactl(&["set-sink-mute", "@DEFAULT_SINK@", "toggle"])?;
            let text = pactl(&["get-sink-mute", "@DEFAULT_SINK@"])?;
            parse_mute_field(&text).ok_or_else(|| format!("cannot parse mute state from {text:?}"))
        }

        fn list_sessions(&self) -> Result<Vec<AudioSession>, String> {
            Ok(parse_sink_inputs(&pactl(&["list", "sink-inputs"])?)
                .into_iter()
                .map(|si| AudioSession { pid: si.pid, name: si.name, volume: si.volume, muted: si.muted })
                .collect())
        }

        fn set_app_volume(
            &self,
            target: &str,
            level: Option<i32>,
            mute: Option<bool>,
        ) -> Result<(), String> {
            let inputs = parse_sink_inputs(&pactl(&["list", "sink-inputs"])?);
            let sessions: Vec<AudioSession> = inputs
                .iter()
                .map(|si| AudioSession { pid: si.pid, name: si.name.clone(), volume: si.volume, muted: si.muted })
                .collect();
            let matched = match_session(target, &sessions)
                .ok_or_else(|| format!("no audio session matches {target:?}"))?;
            let idx = sessions.iter().position(|s| std::ptr::eq(s, matched)).unwrap();
            let sink_input = inputs[idx].index.to_string();
            if let Some(pct) = level {
                let pct = pct.clamp(0, 100);
                pactl(&["set-sink-input-volume", &sink_input, &format!("{pct}%")])?;
            }
            if let Some(m) = mute {
                pactl(&["set-sink-input-mute", &sink_input, if m { "1" } else { "0" }])?;
            }
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dev(name: &str, output: bool, default: bool) -> AudioDevice {
        AudioDevice { id: format!("id-{name}"), name: name.into(), output, default }
    }

    #[test]
    fn fuzzy_matching() {
        let devices = vec![
            dev("Speakers (Realtek(R) Audio)", true, true),
            dev("LG ULTRAWIDE (NVIDIA High Definition Audio)", true, false),
            dev("Microphone (USB Audio)", false, true),
        ];
        // exact beats contains
        assert_eq!(
            match_device("Speakers (Realtek(R) Audio)", &devices, true).unwrap().id,
            "id-Speakers (Realtek(R) Audio)"
        );
        // substring, case-insensitive
        assert_eq!(match_device("ultrawide", &devices, true).unwrap().name.contains("LG"), true);
        // query contains device name (stored a longer label than current name)
        let short = vec![dev("Speakers", true, true)];
        assert!(match_device("Speakers (High Definition)", &short, true).is_some());
        // direction respected
        assert!(match_device("ultrawide", &devices, false).is_none());
        assert!(device_exists("usb audio", &devices));
        assert!(!device_exists("bluetooth", &devices));
    }

    #[test]
    fn is_default() {
        let devices = vec![
            dev("Speakers (Realtek)", true, true),
            dev("Headphones (USB)", true, false),
            dev("Microphone (USB)", false, true),
        ];
        assert!(device_is_default("speakers", &devices));
        assert!(!device_is_default("headphones", &devices));
        // input endpoint default counts too
        assert!(device_is_default("microphone", &devices));
        assert!(!device_is_default("nonexistent", &devices));
    }
}

// Parser tests run on EVERY platform: the parsers are pure and platform-free,
// only the shell-out around them is Linux-only (finding 4.5 - the Linux path is
// never executed on the build host).
#[cfg(test)]
mod pactl_tests {
    use super::parse::{parse_devices, parse_mute_field, parse_sink_inputs, parse_volume_percent, SinkInput};

    #[test]
    fn parses_name_and_description() {
        let out = "\
Sink #0
\tState: RUNNING
\tName: alsa_output.pci-0000_00_1f.3.analog-stereo
\tDescription: Built-in Audio Analog Stereo
\tDriver: PipeWire
Sink #1
\tName: bluez_output.AA_BB.1
\tDescription: WH-1000XM4
";
        let got = parse_devices(out);
        assert_eq!(
            got,
            vec![
                (
                    "alsa_output.pci-0000_00_1f.3.analog-stereo".to_string(),
                    "Built-in Audio Analog Stereo".to_string()
                ),
                ("bluez_output.AA_BB.1".to_string(), "WH-1000XM4".to_string()),
            ]
        );
    }

    #[test]
    fn missing_description_falls_back_to_name() {
        let out = "Source #7\n\tName: alsa_input.usb-mic\n\tDriver: PipeWire\n";
        assert_eq!(
            parse_devices(out),
            vec![("alsa_input.usb-mic".to_string(), "alsa_input.usb-mic".to_string())]
        );
    }

    #[test]
    fn empty_input_yields_nothing() {
        assert!(parse_devices("").is_empty());
    }

    #[test]
    fn parses_sink_inputs() {
        let out = "\
Sink Input #42
\tDriver: PipeWire
\tMute: no
\tVolume: front-left: 42598 / 65% / -8.13 dB,   front-right: 42598 / 65% / -8.13 dB
\t        balance 0.00
\tProperties:
\t\tapplication.name = \"Firefox\"
\t\tapplication.process.id = \"1234\"
Sink Input #43
\tMute: yes
\tVolume: mono: 32768 / 50% / -18.06 dB
\tProperties:
\t\tmedia.name = \"Playback\"
";
        let got = parse_sink_inputs(out);
        assert_eq!(got.len(), 2);
        assert_eq!(got[0], SinkInput { index: 42, pid: 1234, name: "Firefox".into(), volume: 65, muted: false });
        // no application.name → falls back to media.name; muted parsed
        assert_eq!(got[1].index, 43);
        assert_eq!(got[1].name, "Playback");
        assert_eq!(got[1].volume, 50);
        assert!(got[1].muted);
    }

    #[test]
    fn sink_input_without_name_falls_back_to_index() {
        let out = "Sink Input #7\n\tMute: no\n\tVolume: mono: 65536 / 100% / 0.00 dB\n";
        let got = parse_sink_inputs(out);
        assert_eq!(got[0].name, "sink-input 7");
        assert_eq!(got[0].volume, 100);
    }

    #[test]
    fn mute_is_a_field_not_a_substring() {
        assert_eq!(parse_mute_field("Mute: yes\n"), Some(true));
        assert_eq!(parse_mute_field("Mute: no\n"), Some(false));
        // Regression: contains("yes") called this muted because the device name
        // contains the letters "yes" ("ke-yes-tudio").
        let out = "Description: keyestudio USB Audio\nMute: no\n";
        assert_eq!(parse_mute_field(out), Some(false));
        // No Mute line at all, or a value we do not recognise => unknown, never
        // a silent `false`.
        assert_eq!(parse_mute_field("Volume: 50%\n"), None);
        assert_eq!(parse_mute_field("Mute: ja\n"), None);
    }

    #[test]
    fn volume_percent_takes_the_first_channel() {
        let line = "Volume: front-left: 42598 / 65% / -8.13 dB,   front-right: 42598 / 65% / -8.13 dB";
        assert_eq!(parse_volume_percent(line), Some(65));
        assert_eq!(parse_volume_percent("\tVolume: mono: 0 / 0% / -inf dB"), Some(0));
        assert_eq!(parse_volume_percent("Mute: no"), None);
    }

    // German `pactl list sinks` (LANG=de_DE.UTF-8): labels AND values are
    // translated. This is what the code sees WITHOUT the LC_ALL=C forced by
    // `pactl_command` - the description is lost (falls back to the id) and the
    // mute state reads as unknown. Both are the *safe* failure; the old
    // substring matcher instead returned confident nonsense.
    #[test]
    fn non_english_pactl_output_degrades_safely() {
        let out = "\
Senke #0
\tStatus: RUNNING
\tName: alsa_output.pci-0000_00_1f.3.analog-stereo
\tBeschreibung: Eingebaute Audio Analog Stereo
\tStumm: nein
";
        assert_eq!(
            parse_devices(out),
            vec![(
                "alsa_output.pci-0000_00_1f.3.analog-stereo".to_string(),
                "alsa_output.pci-0000_00_1f.3.analog-stereo".to_string()
            )]
        );
        assert_eq!(parse_mute_field(out), None);
    }
}
