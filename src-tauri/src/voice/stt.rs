//! Whisper STT — ported from VoiceMarch `stt.rs`. Offline whisper.cpp via
//! whisper-rs (GGML). Compiled only under the `voice` feature because whisper-rs
//! needs libclang + CMake at build time.

use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

/// A properly cased + punctuated priming sentence. whisper mirrors the style of
/// its initial prompt, so this nudges it toward capitals + punctuation instead
/// of the all-lowercase, unpunctuated output it otherwise defaults to. Honoured
/// even with `no_context = true` (whisper.cpp applies the prompt outside the
/// no_context guard). Override with `VM_INITIAL_PROMPT`; set that env var to an
/// empty string to disable priming entirely. Keep this a fixed static with no
/// NUL byte: `set_initial_prompt` panics on a NUL and leaks the CString per call
/// (`into_raw`), so it must never be built from user audio.
const DEFAULT_INITIAL_PROMPT: &str =
    "Hello. This is a normal sentence, with proper capitalization and punctuation.";

/// Loaded Whisper model + decode settings. Reused across utterances.
pub struct Stt {
    ctx: WhisperContext,
}

impl Stt {
    pub fn load(model_path: &str) -> Result<Self, String> {
        // Route whisper.cpp/GGML's verbose stderr into the (unconfigured) log crate → dropped.
        static LOG_INIT: std::sync::Once = std::sync::Once::new();
        LOG_INIT.call_once(whisper_rs::install_logging_hooks);

        let ctx = WhisperContext::new_with_params(model_path, WhisperContextParameters::default())
            .map_err(|e| format!("load whisper model '{model_path}': {e}"))?;
        Ok(Self { ctx })
    }

    /// Transcribe a 16 kHz mono f32 buffer to text.
    pub fn transcribe(&self, pcm16k: &[f32]) -> Result<String, String> {
        // Pad short clips to 1s — whisper is unreliable on very short audio.
        let audio = pad_to_min(pcm16k, 16_000);

        let mut state = self.ctx.create_state().map_err(|e| e.to_string())?;
        let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
        params.set_language(Some("en"));
        params.set_translate(false);
        params.set_print_special(false);
        params.set_print_progress(false);
        params.set_print_realtime(false);
        params.set_print_timestamps(false);
        params.set_suppress_blank(true);
        params.set_no_speech_thold(0.6);
        let threads = std::env::var("VM_THREADS")
            .ok()
            .and_then(|s| s.parse::<i32>().ok())
            .unwrap_or_else(|| {
                std::thread::available_parallelism()
                    .map(|n| n.get().min(16) as i32)
                    .unwrap_or(4)
            });
        params.set_n_threads(threads);

        // Prime with a cased+punctuated sentence so whisper emits capitals and
        // punctuation. VM_INITIAL_PROMPT overrides it; an empty value disables it.
        let initial_prompt = std::env::var("VM_INITIAL_PROMPT")
            .unwrap_or_else(|_| DEFAULT_INITIAL_PROMPT.to_string());
        if !initial_prompt.is_empty() {
            params.set_initial_prompt(&initial_prompt);
        }

        // Encoder (audio) context. Default = full context: truncating it degrades
        // decoding, and casing + punctuation are the first things lost — the exact
        // bug this fixes. Only truncate when VM_AUDIO_CTX explicitly asks for it
        // (the perf-vs-quality trade-off is then the caller's choice); 0 = full.
        if let Some(audio_ctx) = std::env::var("VM_AUDIO_CTX")
            .ok()
            .and_then(|s| s.parse::<i32>().ok())
        {
            params.set_audio_ctx(audio_ctx);
        }

        state.full(params, &audio).map_err(|e| e.to_string())?;

        let n = state.full_n_segments();
        let mut text = String::new();
        for i in 0..n {
            if let Some(seg) = state.get_segment(i) {
                text.push_str(&seg.to_str_lossy().map_err(|e| e.to_string())?);
            }
        }
        let text = text.trim();
        if is_nonspeech(text) {
            return Ok(String::new());
        }
        Ok(text.to_string())
    }
}

/// True if the whole string is a single bracketed annotation like "[BLANK_AUDIO]".
fn is_nonspeech(t: &str) -> bool {
    t.is_empty()
        || (t.starts_with('[') && t.ends_with(']'))
        || (t.starts_with('(') && t.ends_with(')'))
}

fn pad_to_min(pcm: &[f32], min_len: usize) -> Vec<f32> {
    if pcm.len() >= min_len {
        return pcm.to_vec();
    }
    let mut v = pcm.to_vec();
    v.resize(min_len, 0.0);
    v
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nonspeech_filter() {
        assert!(is_nonspeech(""));
        assert!(is_nonspeech("[BLANK_AUDIO]"));
        assert!(is_nonspeech("(silence)"));
        assert!(!is_nonspeech("hello world"));
        assert!(!is_nonspeech("(aside) real words"));
    }
}
