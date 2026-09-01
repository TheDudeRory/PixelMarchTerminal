//! Audio capture + transcription thread — ported from VoiceMarch `audio.rs`.
//! Compiled only under the `voice` feature (pulls cpal + whisper-rs).
//!
//! Trimmed vs VoiceMarch: system-output muting (sysaudio.rs) and OS text
//! insertion (insert.rs) are DEFERRED. A finished transcript is emitted as the
//! `voice-transcript` event instead of typed at the OS cursor; the main window
//! writes it into the focused terminal (see App.tsx). Events are prefixed
//! `voice-` so they don't collide with the terminal manager's own events.

use std::sync::mpsc::{Receiver, Sender};
use std::sync::{Arc, Mutex};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use tauri::Emitter;

use super::settings::VoiceSettings;

/// Target rate Whisper expects.
const TARGET_HZ: u32 = 16_000;

enum AudioCmd {
    Start,
    Stop,
    ReloadModel,
}

/// Owns the audio thread. cpal's `Stream` is `!Send`, so the stream lives on a
/// dedicated thread; this struct (held in Tauri state) only carries the channel.
pub struct AudioEngine {
    tx: Sender<AudioCmd>,
}

impl AudioEngine {
    pub fn spawn<R: tauri::Runtime>(
        app: tauri::AppHandle<R>,
        settings: Arc<Mutex<VoiceSettings>>,
    ) -> Self {
        let (tx, rx) = std::sync::mpsc::channel::<AudioCmd>();
        std::thread::spawn(move || audio_loop(rx, app, settings));
        Self { tx }
    }

    /// PTT down: open the mic and start buffering.
    pub fn start(&self) {
        let _ = self.tx.send(AudioCmd::Start);
    }

    /// PTT up: stop the mic, transcribe, emit `voice-transcript`.
    pub fn stop(&self) {
        let _ = self.tx.send(AudioCmd::Stop);
    }

    /// Settings saved with a different whisper_model: swap it in eagerly.
    pub fn reload_model(&self) {
        let _ = self.tx.send(AudioCmd::ReloadModel);
    }
}

fn audio_loop<R: tauri::Runtime>(
    rx: Receiver<AudioCmd>,
    app: tauri::AppHandle<R>,
    settings: Arc<Mutex<VoiceSettings>>,
) {
    let host = cpal::default_host();
    let mut stream: Option<cpal::Stream> = None;
    let capture = Arc::new(Mutex::new(Vec::<f32>::new()));
    let mut in_rate = TARGET_HZ;
    let mut in_ch = 1u16;
    let mut stt: Option<super::stt::Stt> = None; // lazy-loaded on first utterance
    let mut loaded_model = String::new();
    let mut buffer = String::new(); // running dictation text this session
    // Output-mute-while-dictating state (mute_on_ptt). COM handle is !Send, so it
    // lives here on the audio thread; prev_mute restores what the user had.
    let mut sysaudio: Option<super::sysaudio::SysAudio> = None;
    let mut prev_mute = false;

    ensure_model(&app, &settings, &mut stt, &mut loaded_model);

    while let Ok(cmd) = rx.recv() {
        match cmd {
            AudioCmd::ReloadModel => {
                ensure_model(&app, &settings, &mut stt, &mut loaded_model);
            }
            AudioCmd::Start => {
                capture.lock().unwrap().clear();
                let (chirp_on, vol, mute_on) = {
                    let s = settings.lock().unwrap();
                    (s.chirp, s.chirp_volume, s.mute_on_ptt)
                };
                // Order matters: the PTT-down cue goes to the default output, and
                // mute_on_ptt silences exactly that device. Muting first made the
                // cue inaudible (PTT-up still chirped, because Stop unmutes before
                // it plays). So play the tone to completion FIRST, then mute.
                // Only the mute_on_ptt path blocks — without it the cue still
                // overlaps mic-open, so PTT latency is unchanged for everyone else.
                if chirp_on {
                    if mute_on {
                        chirp(1000.0, 50, vol);
                    } else {
                        std::thread::spawn(move || chirp(1000.0, 50, vol));
                    }
                }
                // Mute the default output while the mic is open, so playback doesn't
                // bleed into the recording. Remember the prior state to restore.
                if mute_on {
                    if sysaudio.is_none() {
                        sysaudio = super::sysaudio::SysAudio::new();
                    }
                    if let Some(sa) = &sysaudio {
                        prev_mute = sa.is_muted();
                        sa.set_muted(true);
                    }
                }
                let want = settings.lock().unwrap().mic_device.clone();
                match pick_input_device(&host, want.as_deref()) {
                    Some(device) => match device.default_input_config() {
                        Ok(cfg) => {
                            in_rate = cfg.sample_rate().0;
                            in_ch = cfg.channels();
                            match build_stream(&device, &cfg, capture.clone()) {
                                Ok(s) => {
                                    let _ = s.play();
                                    stream = Some(s);
                                }
                                Err(e) => eprintln!("voice: failed to build input stream: {e}"),
                            }
                        }
                        Err(e) => eprintln!("voice: no input config: {e}"),
                    },
                    None => eprintln!("voice: no input device"),
                }
            }
            AudioCmd::Stop => {
                drop(stream.take()); // dropping the stream stops the mic
                let (chirp_on, vol) = {
                    let s = settings.lock().unwrap();
                    (s.chirp, s.chirp_volume)
                };
                // Restore the output mute state we changed on PTT down.
                if let Some(sa) = &sysaudio {
                    sa.set_muted(prev_mute);
                }
                if chirp_on {
                    std::thread::spawn(move || chirp(600.0, 50, vol));
                }
                let raw = std::mem::take(&mut *capture.lock().unwrap());
                if raw.is_empty() {
                    // Nothing captured: still reset the UI pill (PTT-up set it amber).
                    let _ = app.emit("voice-done", ());
                    continue;
                }
                let mono = downmix(raw, in_ch);
                let pcm = resample_to_16k(&mono, in_rate);
                let n = pcm.len();
                let seconds = n as f32 / TARGET_HZ as f32;
                let _ = app.emit("voice-capture", serde_json::json!({ "samples": n, "seconds": seconds }));

                ensure_model(&app, &settings, &mut stt, &mut loaded_model);
                if let Some(s) = &stt {
                    match s.transcribe(&pcm) {
                        Ok(text) => {
                            let (spacing, punctuation, insertion) = {
                                let s = settings.lock().unwrap();
                                (s.spacing.clone(), s.punctuation.clone(), s.insertion.clone())
                            };
                            let (new_buffer, out) =
                                super::dictate::dictate(&text, &buffer, &spacing, &punctuation);
                            buffer = new_buffer;
                            if !out.is_empty() {
                                // Route by insertion mode. `terminal` keeps the
                                // in-app-only path (main window writes it into the
                                // focused pane, see App.tsx); paste/type inject at the
                                // OS cursor of whatever app is focused (VoiceMarch).
                                // Only one path fires, so nothing double-inserts.
                                match insertion.as_str() {
                                    "type" => super::insert::insert(&out, "type"),
                                    "terminal" => {
                                        let _ = app.emit("voice-transcript", &out);
                                    }
                                    _ => super::insert::insert(&out, "paste"),
                                }
                            }
                        }
                        Err(e) => eprintln!("voice: transcribe failed: {e}"),
                    }
                }
                // Transcription finished on every path (terminal/type/paste/empty-out/
                // error/no-model): reset the UI pill back to idle. Distinct from
                // voice-transcript so the paste/type paths don't double-insert text.
                let _ = app.emit("voice-done", ());
            }
        }
    }
}

/// Load `ggml-{model}.bin` in the profile unless already loaded. Emits
/// `voice-model` loading/ready/error for the UI spinner.
fn ensure_model<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    settings: &Arc<Mutex<VoiceSettings>>,
    stt: &mut Option<super::stt::Stt>,
    loaded_model: &mut String,
) {
    let model_id = settings.lock().unwrap().whisper_model.clone();
    let desired = super::models::model_file_name(&model_id);
    if stt.is_some() && *loaded_model == desired {
        return;
    }
    let path = super::models::model_path(&model_id);
    if !path.exists() {
        eprintln!(
            "voice: model not found: {} (install it from Settings > Voice-To-Text)",
            path.display()
        );
        let _ = app.emit("voice-model", "error");
        return;
    }
    let _ = app.emit("voice-model", "loading");
    match super::stt::Stt::load(&path.to_string_lossy()) {
        Ok(s) => {
            *stt = Some(s);
            *loaded_model = desired;
            let _ = app.emit("voice-model", "ready");
        }
        Err(e) => {
            eprintln!("voice: whisper load failed: {e}");
            let _ = app.emit("voice-model", "error");
        }
    }
}

/// Names of available input devices, for the settings mic picker.
pub fn list_input_devices() -> Vec<String> {
    let host = cpal::default_host();
    match host.input_devices() {
        Ok(devs) => devs.filter_map(|d| d.name().ok()).collect(),
        Err(_) => Vec::new(),
    }
}

fn pick_input_device(host: &cpal::Host, name: Option<&str>) -> Option<cpal::Device> {
    if let Some(name) = name {
        if let Ok(mut devices) = host.input_devices() {
            if let Some(d) = devices.find(|d| d.name().ok().as_deref() == Some(name)) {
                return Some(d);
            }
        }
    }
    host.default_input_device()
}

fn build_stream(
    device: &cpal::Device,
    cfg: &cpal::SupportedStreamConfig,
    buf: Arc<Mutex<Vec<f32>>>,
) -> Result<cpal::Stream, cpal::BuildStreamError> {
    let config: cpal::StreamConfig = cfg.config();
    let err_fn = |e| eprintln!("voice: audio stream error: {e}");
    match cfg.sample_format() {
        cpal::SampleFormat::F32 => device.build_input_stream(
            &config,
            move |data: &[f32], _: &cpal::InputCallbackInfo| {
                buf.lock().unwrap().extend_from_slice(data);
            },
            err_fn,
            None,
        ),
        cpal::SampleFormat::I16 => device.build_input_stream(
            &config,
            move |data: &[i16], _: &cpal::InputCallbackInfo| {
                let mut b = buf.lock().unwrap();
                b.extend(data.iter().map(|&s| s as f32 / 32768.0));
            },
            err_fn,
            None,
        ),
        cpal::SampleFormat::U16 => device.build_input_stream(
            &config,
            move |data: &[u16], _: &cpal::InputCallbackInfo| {
                let mut b = buf.lock().unwrap();
                b.extend(data.iter().map(|&s| (s as f32 - 32768.0) / 32768.0));
            },
            err_fn,
            None,
        ),
        other => {
            eprintln!("voice: unsupported sample format {other:?}");
            Err(cpal::BuildStreamError::StreamConfigNotSupported)
        }
    }
}

/// Interleaved multi-channel -> mono by averaging channels.
fn downmix(interleaved: Vec<f32>, channels: u16) -> Vec<f32> {
    if channels <= 1 {
        return interleaved;
    }
    let ch = channels as usize;
    interleaved
        .chunks(ch)
        .map(|frame| frame.iter().copied().sum::<f32>() / ch as f32)
        .collect()
}

/// Box/area resample to 16 kHz: average the input window mapping to each output
/// sample. Cheap anti-alias for 44.1/48k -> 16k speech.
fn resample_to_16k(input: &[f32], from_hz: u32) -> Vec<f32> {
    if from_hz == TARGET_HZ || input.is_empty() {
        return input.to_vec();
    }
    let ratio = from_hz as f64 / TARGET_HZ as f64;
    let out_len = (input.len() as f64 / ratio).floor() as usize;
    let mut out = Vec::with_capacity(out_len);
    for i in 0..out_len {
        let start = (i as f64 * ratio) as usize;
        let end = (((i + 1) as f64 * ratio) as usize)
            .min(input.len())
            .max(start + 1);
        let slice = &input[start..end];
        out.push(slice.iter().copied().sum::<f32>() / slice.len() as f32);
    }
    out
}

/// PTT feedback tone (down = 1000 Hz, up = 600 Hz). Blocks until played —
/// callers spawn it. `vol` is 0–100, squared so the slider feels linear.
fn chirp(hz: f32, ms: u32, vol: u32) {
    if vol == 0 {
        return;
    }
    let Some(device) = cpal::default_host().default_output_device() else { return };
    let Ok(cfg) = device.default_output_config() else { return };
    if cfg.sample_format() != cpal::SampleFormat::F32 {
        return;
    }
    let rate = cfg.sample_rate().0 as f32;
    let channels = cfg.channels() as usize;
    let total = (rate * ms as f32 / 1000.0) as u64;
    let fade = ((rate * 0.005) as u64).max(1);
    let amp = 0.5 * (vol.min(100) as f32 / 100.0).powi(2);
    let mut n = 0u64;
    let stream = device.build_output_stream(
        &cfg.config(),
        move |data: &mut [f32], _: &cpal::OutputCallbackInfo| {
            for frame in data.chunks_mut(channels) {
                let env = if n >= total {
                    0.0
                } else {
                    (n as f32 / fade as f32).min((total - n) as f32 / fade as f32).min(1.0)
                };
                let s = amp * env * (std::f32::consts::TAU * hz * n as f32 / rate).sin();
                frame.fill(s);
                n += 1;
            }
        },
        |e| eprintln!("voice: chirp stream error: {e}"),
        None,
    );
    if let Ok(s) = stream {
        let _ = s.play();
        std::thread::sleep(std::time::Duration::from_millis(ms as u64 + 60));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn downmix_stereo_averages() {
        assert_eq!(downmix(vec![1.0, 3.0, 0.0, 2.0], 2), vec![2.0, 1.0]);
    }

    #[test]
    fn downmix_mono_passthrough() {
        let m = vec![0.5, -0.5];
        assert_eq!(downmix(m.clone(), 1), m);
    }

    #[test]
    fn resample_48k_to_16k_thirds_length() {
        let input = vec![0.0f32; 4800];
        assert_eq!(resample_to_16k(&input, 48000).len(), 1600);
    }

    #[test]
    fn resample_passthrough_when_already_16k() {
        let input = vec![0.1f32; 100];
        assert_eq!(resample_to_16k(&input, 16_000), input);
    }
}
