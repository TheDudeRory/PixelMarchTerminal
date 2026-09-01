//! Whisper GGML model catalog + installer.
//!
//! The dictation engine needs exactly one file — `ggml-<whisper_model>.bin` next
//! in the profile (see `settings::data_dir`). Nothing ships it: a fresh clone has zero
//! models, and a missing one used to degrade silently (the PTT press recorded,
//! transcription was skipped, the pill went back to idle). This module is the
//! informer/installer that closes that hole:
//!
//! * `model_file_name` / `model_path` — the ONE place the `ggml-{id}.bin` formula
//!   lives. `audio.rs` (load) and `mod.rs` (status) both call it; do not inline a
//!   third copy of the format string.
//! * `voice_models_status` — what is on disk right now, per catalog entry.
//! * `voice_model_download` — fetch from Hugging Face on a background thread,
//!   streaming `voice-model-progress` events; verified against a pinned
//!   size + sha256 and written via `.part` + rename so a half download can never
//!   be mistaken for a model.
//! * `voice_model_import` — native picker (rfd) for a `.bin` the user already
//!   downloaded by hand, copied in under the correct name.
//!
//! Transport posture mirrors `update.rs::guard_url`: HTTPS only, no override, and
//! never install bytes that fail verification. `ureq` + `sha2` + `rfd` are already
//! dependencies — this adds no crates.

use serde::Serialize;
use std::collections::HashSet;
use std::io::Read;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use tauri::{Emitter, State};

use sha2::{Digest, Sha256};

/// A model we know how to fetch and verify. `size` and `sha256` are the upstream
/// values (Hugging Face publishes the sha256 as the LFS etag); they are what make
/// an unattended download safe to install.
pub struct ModelSpec {
    pub id: &'static str,
    pub label: &'static str,
    pub size: u64,
    pub sha256: &'static str,
}

/// The three ids the settings UI offers (VoiceSettings.tsx). Same order.
pub const CATALOG: &[ModelSpec] = &[
    ModelSpec {
        id: "base.en-q8_0",
        label: "base.en q8_0 — accurate, quantized (default)",
        size: 81_781_811,
        sha256: "a4d4a0768075e13cfd7e19df3ae2dbc4a68d37d36a7dad45e8410c9a34f8c87e",
    },
    ModelSpec {
        id: "base.en",
        label: "base.en f16 — most accurate, largest",
        size: 147_964_211,
        sha256: "a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002",
    },
    ModelSpec {
        id: "tiny.en",
        label: "tiny.en — fastest, least accurate",
        size: 77_704_715,
        sha256: "921e4cf8686fdd993dcd081a5da5b6c365bfde1162e72b08d75ac75289920b1f",
    },
];

const BASE_URL: &str = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main";

/// THE model-filename formula. Single source of truth — `audio.rs::ensure_model`
/// and `mod.rs::voice_status` both go through here.
pub fn model_file_name(id: &str) -> String {
    format!("ggml-{id}.bin")
}

/// Absolute path a model must live at: `<repo>/data/ggml-<id>.bin`.
pub fn model_path(id: &str) -> PathBuf {
    super::settings::data_dir().join(model_file_name(id))
}

pub fn spec(id: &str) -> Option<&'static ModelSpec> {
    CATALOG.iter().find(|m| m.id == id)
}

fn download_url(id: &str) -> String {
    format!("{BASE_URL}/{}", model_file_name(id))
}

/// One row of the installer UI.
#[derive(Serialize, Clone)]
pub struct VoiceModelInfo {
    pub id: String,
    pub label: String,
    /// Filename we look for / write, e.g. `ggml-base.en.bin`.
    pub file: String,
    pub present: bool,
    /// Bytes on disk (None when absent).
    pub size_bytes: Option<u64>,
    /// Bytes we expect (None for a model outside the catalog).
    pub expected_size: Option<u64>,
    /// Present AND the right size — i.e. usable, not a truncated leftover.
    pub complete: bool,
    /// Is this the model the settings currently select?
    pub selected: bool,
    /// Empty for a non-catalog model (nothing to download from).
    pub url: String,
}

fn info_for(id: &str, selected: &str) -> VoiceModelInfo {
    let spec = spec(id);
    let path = model_path(id);
    let size_bytes = std::fs::metadata(&path).ok().map(|m| m.len());
    let expected_size = spec.map(|s| s.size);
    VoiceModelInfo {
        id: id.to_string(),
        label: spec.map(|s| s.label.to_string()).unwrap_or_else(|| id.to_string()),
        file: model_file_name(id),
        present: size_bytes.is_some(),
        complete: match (size_bytes, expected_size) {
            (Some(got), Some(want)) => got == want,
            // Unknown model: presence is all we can judge.
            (Some(_), None) => true,
            _ => false,
        },
        size_bytes,
        expected_size,
        selected: id == selected,
        url: spec.map(|s| download_url(s.id)).unwrap_or_default(),
    }
}

/// Every catalog model plus (if it isn't one of them) whatever the settings
/// currently select — so a hand-picked custom id still gets a row.
#[tauri::command]
pub fn voice_models_status(state: State<super::VoiceState>) -> Vec<VoiceModelInfo> {
    let selected = state.settings.lock().unwrap().whisper_model.clone();
    let mut out: Vec<VoiceModelInfo> = CATALOG.iter().map(|m| info_for(m.id, &selected)).collect();
    if spec(&selected).is_none() && !selected.trim().is_empty() {
        out.push(info_for(&selected, &selected));
    }
    out
}

/// Progress for one install, broadcast as `voice-model-progress`.
#[derive(Serialize, Clone)]
struct Progress {
    id: String,
    downloaded: u64,
    /// Total bytes when known (the pinned size), else null.
    total: Option<u64>,
    /// start | progress | verifying | done | error
    status: &'static str,
    error: Option<String>,
}

fn emit(app: &tauri::AppHandle, p: Progress) {
    let _ = app.emit("voice-model-progress", p);
}

/// Ids of installs currently running, so a double-click can't have two threads
/// writing the same `.part` file.
fn in_flight() -> &'static Mutex<HashSet<String>> {
    static IN_FLIGHT: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    IN_FLIGHT.get_or_init(|| Mutex::new(HashSet::new()))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Start downloading `id` in the background. Returns as soon as the thread is
/// spawned; everything else arrives as `voice-model-progress` events. Only
/// catalog ids are accepted — an unknown id has no pinned hash to verify against
/// (and would let a caller steer the URL and the written filename).
#[tauri::command]
pub fn voice_model_download(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let spec = spec(&id).ok_or_else(|| format!("unknown model '{id}' — nothing to download"))?;
    {
        let mut live = in_flight().lock().unwrap();
        if !live.insert(id.clone()) {
            return Err(format!("{id} is already downloading"));
        }
    }
    let handle = app.clone();
    std::thread::spawn(move || {
        let result = fetch(&handle, spec);
        in_flight().lock().unwrap().remove(spec.id);
        match result {
            Ok(()) => {
                emit(&handle, Progress {
                    id: spec.id.into(),
                    downloaded: spec.size,
                    total: Some(spec.size),
                    status: "done",
                    error: None,
                });
                model_installed(&handle, spec.id);
            }
            Err(e) => {
                eprintln!("voice: model download failed ({}): {e}", spec.id);
                emit(&handle, Progress {
                    id: spec.id.into(),
                    downloaded: 0,
                    total: Some(spec.size),
                    status: "error",
                    error: Some(e),
                });
            }
        }
    });
    Ok(())
}

/// A model just landed on disk: if it is the one the settings select, tell the
/// audio thread to pick it up so dictation works without a restart.
fn model_installed(app: &tauri::AppHandle, id: &str) {
    let _ = (app, id);
    #[cfg(feature = "voice")]
    {
        use tauri::Manager;
        let selected = app
            .try_state::<super::VoiceState>()
            .map(|s| s.settings.lock().unwrap().whisper_model.clone());
        if selected.as_deref() == Some(id) {
            if let Some(engine) = app.try_state::<super::audio::AudioEngine>() {
                engine.reload_model();
            }
        }
    }
}

/// Stream the model to `<final>.part`, hashing as we go, then verify size +
/// sha256 and rename into place. A failure leaves the `.part` removed and any
/// previously installed model untouched.
fn fetch(app: &tauri::AppHandle, spec: &'static ModelSpec) -> Result<(), String> {
    let url = download_url(spec.id);
    guard_url(&url)?;
    let final_path = model_path(spec.id);
    let part = final_path.with_extension("bin.part");

    emit(app, Progress {
        id: spec.id.into(),
        downloaded: 0,
        total: Some(spec.size),
        status: "start",
        error: None,
    });

    let resp = ureq::get(&url).call().map_err(|e| e.to_string())?;
    let mut reader = resp.into_reader();

    let _ = std::fs::remove_file(&part); // stale leftover from an aborted run
    let mut out = std::fs::File::create(&part)
        .map_err(|e| format!("create {}: {e}", part.display()))?;
    let outcome = (|| -> Result<(), String> {
        use std::io::Write;
        let mut hasher = Sha256::new();
        let mut buf = vec![0u8; 256 * 1024];
        let mut done: u64 = 0;
        let mut last = std::time::Instant::now();
        loop {
            let n = reader.read(&mut buf).map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            // Refuse to keep writing past the pinned size — a wrong (or hostile)
            // body must not fill the disk before the hash check can reject it.
            done += n as u64;
            if done > spec.size {
                return Err(format!(
                    "download is larger than the expected {} bytes — refusing it",
                    spec.size
                ));
            }
            hasher.update(&buf[..n]);
            out.write_all(&buf[..n]).map_err(|e| e.to_string())?;
            if last.elapsed() >= std::time::Duration::from_millis(250) {
                last = std::time::Instant::now();
                emit(app, Progress {
                    id: spec.id.into(),
                    downloaded: done,
                    total: Some(spec.size),
                    status: "progress",
                    error: None,
                });
            }
        }
        out.sync_all().map_err(|e| e.to_string())?;
        if done != spec.size {
            return Err(format!("incomplete download: got {done} bytes, expected {}", spec.size));
        }
        emit(app, Progress {
            id: spec.id.into(),
            downloaded: done,
            total: Some(spec.size),
            status: "verifying",
            error: None,
        });
        let got = hex(&hasher.finalize());
        if !got.eq_ignore_ascii_case(spec.sha256) {
            return Err(format!("sha256 mismatch: expected {}, got {got}", spec.sha256));
        }
        Ok(())
    })();
    drop(out);

    if let Err(e) = outcome {
        let _ = std::fs::remove_file(&part);
        return Err(e);
    }
    std::fs::rename(&part, &final_path)
        .map_err(|e| format!("install {}: {e}", final_path.display()))?;
    Ok(())
}

/// HTTPS only. Unlike `update.rs` there is no loopback or env-var escape hatch —
/// the model URL is a compile-time constant, so anything else is a bug.
fn guard_url(url: &str) -> Result<(), String> {
    if url.trim().to_ascii_lowercase().starts_with("https://") {
        Ok(())
    } else {
        Err(format!("refusing non-HTTPS model URL: {url}"))
    }
}

/// An id is interpolated straight into a filename, so keep it to a plain token —
/// no separators, no `..`, nothing that could escape the exe directory.
fn safe_id(id: &str) -> bool {
    !id.is_empty()
        && !id.contains("..")
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
}

/// A whisper.cpp GGML file starts with the 32-bit magic 0x67676d6c, i.e. the
/// bytes "lmgg" little-endian (older exports wrote it big-endian, "ggml"). Cheap
/// guard so importing the wrong file fails here instead of deep inside whisper.
fn looks_like_ggml(path: &std::path::Path) -> Result<(), String> {
    let mut f = std::fs::File::open(path).map_err(|e| format!("open {}: {e}", path.display()))?;
    let mut magic = [0u8; 4];
    f.read_exact(&mut magic)
        .map_err(|_| "file is too small to be a GGML model".to_string())?;
    if &magic == b"lmgg" || &magic == b"ggml" {
        Ok(())
    } else {
        Err("that file is not a GGML whisper model (bad magic)".into())
    }
}

/// Native picker for a `.bin` the user downloaded by hand; copies it in as
/// `ggml-<id>.bin`. Returns the installed filename, or None if they cancelled.
#[tauri::command]
pub async fn voice_model_import(app: tauri::AppHandle, id: String) -> Result<Option<String>, String> {
    // Not restricted to the catalog (a hand-picked custom model deserves a
    // Browse button too), but the id becomes a filename, so keep it a plain token.
    if !safe_id(&id) {
        return Err(format!("unsafe model id '{id}'"));
    }
    let picked = rfd::AsyncFileDialog::new()
        .set_title(format!("Choose the {} model file", model_file_name(&id)))
        .add_filter("GGML model", &["bin"])
        .pick_file()
        .await;
    let Some(picked) = picked else { return Ok(None) };
    let src = picked.path().to_path_buf();

    let target = model_path(&id);
    let file = model_file_name(&id);
    let handle = app.clone();
    let id2 = id.clone();
    // 80–150 MB copy: off the async runtime's thread.
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        if src == target {
            return Ok(()); // already the installed file; nothing to do
        }
        looks_like_ggml(&src)?;
        let part = target.with_extension("bin.part");
        let _ = std::fs::remove_file(&part);
        std::fs::copy(&src, &part).map_err(|e| format!("copy {}: {e}", src.display()))?;
        std::fs::rename(&part, &target).map_err(|e| {
            let _ = std::fs::remove_file(&part);
            format!("install {}: {e}", target.display())
        })?;
        model_installed(&handle, &id2);
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(Some(file))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_name_is_the_one_formula() {
        assert_eq!(model_file_name("base.en-q8_0"), "ggml-base.en-q8_0.bin");
        assert!(model_path("tiny.en").ends_with("ggml-tiny.en.bin"));
    }

    #[test]
    fn catalog_covers_the_three_ui_ids_with_pinned_hashes() {
        for id in ["base.en-q8_0", "base.en", "tiny.en"] {
            let s = spec(id).expect("catalog entry");
            assert_eq!(s.sha256.len(), 64, "{id} needs a full sha256");
            assert!(s.size > 1_000_000, "{id} size looks wrong");
            assert!(download_url(id).starts_with("https://"));
            assert!(guard_url(&download_url(id)).is_ok());
        }
        assert!(spec("large-v3").is_none());
    }

    #[test]
    fn only_https_is_accepted() {
        assert!(guard_url("http://huggingface.co/x.bin").is_err());
        assert!(guard_url("http://127.0.0.1/x.bin").is_err()); // no loopback escape here
        assert!(guard_url("file:///etc/passwd").is_err());
        assert!(guard_url("https://huggingface.co/x.bin").is_ok());
    }

    #[test]
    fn ids_that_could_escape_the_data_dir_are_rejected() {
        assert!(safe_id("base.en-q8_0"));
        assert!(safe_id("tiny.en"));
        assert!(!safe_id(""));
        assert!(!safe_id("../../etc/passwd"));
        assert!(!safe_id(".."));
        assert!(!safe_id("a/b"));
        assert!(!safe_id("a\\b"));
        assert!(!safe_id("C:model"));
    }

    #[test]
    fn magic_check_rejects_a_non_model() {
        let dir = std::env::temp_dir().join("pixelmarch-model-magic-test");
        let _ = std::fs::create_dir_all(&dir);
        let bad = dir.join("bad.bin");
        std::fs::write(&bad, b"not a model at all").unwrap();
        assert!(looks_like_ggml(&bad).is_err());
        let good = dir.join("good.bin");
        std::fs::write(&good, b"lmggrest-of-the-file").unwrap();
        assert!(looks_like_ggml(&good).is_ok());
        let tiny = dir.join("tiny.bin");
        std::fs::write(&tiny, b"ab").unwrap();
        assert!(looks_like_ggml(&tiny).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
