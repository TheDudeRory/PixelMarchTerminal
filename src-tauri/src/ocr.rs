//! OCR for saved screenshots — read the text out of a shot instead of feeding
//! the image to a model. Windows uses the built-in WinRT engine
//! (`Windows.Media.Ocr`, no install, no extra binary in the portable exe);
//! elsewhere it shells out to `tesseract` if the user has it.
//!
//! Terminal shots need a pre-pass first. OCR engines binarize on *luminance*,
//! and a colored traceback on black (dark red `~~~^^^`, purple `TypeError`) is
//! dim by that measure, so only the white lines survive. `preprocess` rebuilds
//! the image on max-channel brightness — which treats saturated red the same as
//! white — then inverts, stretches contrast and upscales.

use std::path::PathBuf;

/// OCR a PNG on disk, returning the recognized text (may be empty).
pub fn ocr_file(path: &PathBuf) -> Result<String, String> {
    if !path.is_file() {
        return Err(format!("no such file: {}", path.display()));
    }
    let raw = std::fs::read(path).map_err(|e| e.to_string())?;
    ocr_passes(&raw)
}

/// The scales the image is OCR'd at. They are complementary on terminal text:
/// 1x reads long backslash paths the engine mangles once they are enlarged,
/// 2x reads the small code lines 1x smears together. Rows from every pass are
/// merged by vertical position, keeping the fullest reading of each row.
#[cfg(windows)]
const SCALES: &[u32] = &[1, 2, 3];
#[cfg(not(windows))]
const SCALES: &[u32] = &[2];

fn ocr_passes(raw: &[u8]) -> Result<String, String> {
    let mut passes: Vec<Vec<(f32, String)>> = Vec::new();
    let mut last_err = None;
    for &f in SCALES {
        let png = match preprocess(raw, f) {
            Ok(p) => p,
            Err(e) => {
                last_err = Some(e);
                continue;
            }
        };
        match ocr_rows(&png, f as f32) {
            Ok(rows) if !rows.is_empty() => passes.push(rows),
            Ok(_) => {}
            Err(e) => last_err = Some(e),
        }
    }
    if passes.is_empty() {
        // Pre-pass or every scale failed — try the untouched shot before giving up.
        let rows = ocr_rows(raw, 1.0).map_err(|e| last_err.unwrap_or(e))?;
        return Ok(rows_to_text(rows));
    }
    Ok(rows_to_text(merge_passes(passes)))
}

fn rows_to_text(rows: Vec<(f32, String)>) -> String {
    rows.into_iter().map(|(_, t)| t).collect::<Vec<_>>().join("
")
}

/// Fold every pass into one set of rows: rows close enough vertically are the
/// same line of text, and the longest reading of it wins (a pass that dropped
/// half a path reads shorter than the one that got it all).
fn merge_passes(mut passes: Vec<Vec<(f32, String)>>) -> Vec<(f32, String)> {
    let mut out = passes.remove(0);
    // Half a line height: derived from the median row spacing so it scales with
    // the font instead of being a magic pixel count.
    let mut gaps: Vec<f32> = out.windows(2).map(|w| (w[1].0 - w[0].0).abs()).collect();
    gaps.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let tol = gaps.get(gaps.len() / 2).copied().unwrap_or(16.0) * 0.5;

    for pass in passes {
        for (y, text) in pass {
            match out
                .iter_mut()
                .filter(|(oy, _)| (oy - y).abs() <= tol)
                .min_by(|(a, _), (b, _)| {
                    (a - y).abs().partial_cmp(&(b - y).abs()).unwrap_or(std::cmp::Ordering::Equal)
                }) {
                Some(row) => {
                    if text.chars().count() > row.1.chars().count() {
                        row.1 = text;
                    }
                }
                None => out.push((y, text)),
            }
        }
    }
    out.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
    out
}

/// Rebuild a screenshot into something an OCR engine reads well: max-channel
/// gray (so colored text keeps its contrast), inverted when the background is
/// dark, contrast-stretched, and 2× upscaled for small console glyphs.
fn preprocess(bytes: &[u8], scale: u32) -> Result<Vec<u8>, String> {
    use image::{GrayImage, Luma};

    let img = image::load_from_memory(bytes)
        .map_err(|e| e.to_string())?
        .to_rgb8();
    let (w, h) = (img.width(), img.height());
    if w == 0 || h == 0 {
        return Err("empty image".into());
    }

    // max(r,g,b), not luminance: pure red is 0.21 luma but 1.0 here, which is
    // what makes the red/purple traceback lines readable at all.
    let mut gray = GrayImage::new(w, h);
    let mut sum: u64 = 0;
    for (x, y, p) in img.enumerate_pixels() {
        let v = p[0].max(p[1]).max(p[2]);
        sum += v as u64;
        gray.put_pixel(x, y, Luma([v]));
    }
    let mean = (sum / (w as u64 * h as u64)) as u8;

    // Engines expect dark ink on light paper; terminals are the opposite.
    if mean < 128 {
        for p in gray.pixels_mut() {
            p.0[0] = 255 - p.0[0];
        }
    }

    // Contrast stretch on the 1st/99th percentiles — plain min/max would be
    // pinned by a single stray pixel and do nothing.
    let mut hist = [0u32; 256];
    for p in gray.pixels() {
        hist[p.0[0] as usize] += 1;
    }
    let total = (w as u64) * (h as u64);
    let cut = (total / 100) as u32;
    let mut lo = 0u8;
    let mut acc = 0u32;
    for (v, &n) in hist.iter().enumerate() {
        acc = acc.saturating_add(n);
        if acc > cut {
            lo = v as u8;
            break;
        }
    }
    let mut hi = 255u8;
    acc = 0;
    for (v, &n) in hist.iter().enumerate().rev() {
        acc = acc.saturating_add(n);
        if acc > cut {
            hi = v as u8;
            break;
        }
    }
    if hi > lo {
        let span = (hi - lo) as f32;
        for p in gray.pixels_mut() {
            let v = p.0[0].clamp(lo, hi) as f32;
            p.0[0] = (((v - lo as f32) / span) * 255.0).round() as u8;
        }
    }

    // Console fonts are thin, so an upscaled pass reads them better — but only
    // up to a point: past ~3600px the engine starts dropping words, and a full
    // 4K monitor shot is already there, so it stays at 1x.
    let scaled = if scale > 1 && w * scale <= 3600 && h * scale <= 3600 {
        image::imageops::resize(
            &gray,
            w * scale,
            h * scale,
            image::imageops::FilterType::Lanczos3,
        )
    } else {
        gray
    };

    let mut out = Vec::new();
    image::DynamicImage::ImageLuma8(scaled)
        .write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png)
        .map_err(|e| e.to_string())?;
    Ok(out)
}

/// Recognize a prepared PNG, returning one entry per row of text: the row's
/// vertical centre in SOURCE pixels (hence `scale`) and the row's text. Source
/// coordinates are what lets rows from different scales be matched up.
#[cfg(windows)]
fn ocr_rows(bytes: &[u8], scale: f32) -> Result<Vec<(f32, String)>, String> {
    use windows::Graphics::Imaging::BitmapDecoder;
    use windows::Media::Ocr::OcrEngine;
    use windows::Storage::Streams::{DataWriter, InMemoryRandomAccessStream};
    use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};

    // WinRT activation needs an initialized apartment; this command runs on a
    // worker thread, so initialize it (S_FALSE = already initialized, fine).
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }

    // windows 0.62 dropped IAsyncOperation::get(); join() is the blocking form.
    let e = |what: &'static str| move |err: windows::core::Error| format!("{what}: {err}");

    // Decode the PNG into a SoftwareBitmap via an in-memory stream.
    let stream = InMemoryRandomAccessStream::new().map_err(e("ocr stream"))?;
    let writer = DataWriter::CreateDataWriter(&stream.GetOutputStreamAt(0).map_err(e("ocr stream"))?)
        .map_err(e("ocr writer"))?;
    writer.WriteBytes(bytes).map_err(e("ocr write"))?;
    writer.StoreAsync().map_err(e("ocr store"))?.join().map_err(e("ocr store"))?;
    writer.FlushAsync().map_err(e("ocr flush"))?.join().map_err(e("ocr flush"))?;
    // Detach so dropping the writer doesn't close the stream we still need.
    let _ = writer.DetachStream().map_err(e("ocr detach"))?;
    stream.Seek(0).map_err(e("ocr seek"))?;

    let decoder = BitmapDecoder::CreateAsync(&stream)
        .map_err(e("ocr decode"))?
        .join()
        .map_err(e("ocr decode"))?;
    let bitmap = decoder
        .GetSoftwareBitmapAsync()
        .map_err(e("ocr bitmap"))?
        .join()
        .map_err(e("ocr bitmap"))?;

    // Engine follows the user's profile languages; falls back to any installed
    // OCR language pack. Missing entirely = no language pack on this machine.
    let engine = OcrEngine::TryCreateFromUserProfileLanguages()
        .map_err(|_| "no OCR language pack installed (Settings → Language → add a language)".to_string())?;
    let result = engine
        .RecognizeAsync(&bitmap)
        .map_err(e("ocr recognize"))?
        .join()
        .map_err(e("ocr recognize"))?;

    // Rebuild the text from word geometry instead of trusting OcrResult: Text()
    // space-joins the whole image into one run, and Lines() comes back in
    // engine order, which on a wrapped traceback interleaves fragments from
    // different rows ("in main" landing after the last line). Group words into
    // rows by vertical overlap, then read each row left to right.
    struct Word {
        top: f32,
        bottom: f32,
        left: f32,
        text: String,
    }
    let mut words: Vec<Word> = Vec::new();
    for line in result.Lines().map_err(e("ocr lines"))? {
        for w in line.Words().map_err(e("ocr words"))? {
            let r = w.BoundingRect().map_err(e("ocr rect"))?;
            words.push(Word {
                top: r.Y,
                bottom: r.Y + r.Height,
                left: r.X,
                text: w.Text().map_err(e("ocr word"))?.to_string(),
            });
        }
    }
    if words.is_empty() {
        return Ok(Vec::new());
    }
    words.sort_by(|a, b| a.top.partial_cmp(&b.top).unwrap_or(std::cmp::Ordering::Equal));

    let mut rows: Vec<Vec<Word>> = Vec::new();
    for w in words {
        // Same row when the word's midline sits inside the row's band — robust
        // to the few-pixel baseline jitter between glyphs of different sizes.
        let mid = (w.top + w.bottom) / 2.0;
        match rows.last_mut() {
            Some(row) if mid < row[0].bottom && mid > row[0].top => row.push(w),
            _ => rows.push(vec![w]),
        }
    }

    let mut out: Vec<(f32, String)> = Vec::new();
    for row in &mut rows {
        row.sort_by(|a, b| a.left.partial_cmp(&b.left).unwrap_or(std::cmp::Ordering::Equal));
        // Back to source pixels so rows from a 1× and a 2× pass line up.
        let y = (row[0].top + row[0].bottom) / 2.0 / scale;
        let line: Vec<&str> = row.iter().map(|w| w.text.as_str()).collect();
        out.push((y, line.join(" ")));
    }
    Ok(out)
}

#[cfg(not(windows))]
fn ocr_rows(bytes: &[u8], _scale: f32) -> Result<Vec<(f32, String)>, String> {
    // No system OCR to lean on: use tesseract when it's installed, and say so
    // plainly when it isn't rather than silently returning nothing. It reads
    // from a file, so the pre-processed copy goes to a temp path.
    let tmp = std::env::temp_dir().join(format!("pixelmarch-ocr-{}.png", std::process::id()));
    std::fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    let mut cmd = std::process::Command::new("tesseract");
    let out = crate::pty::strip_webview_env(&mut cmd)
        .arg(&tmp)
        .arg("stdout")
        .output();
    let _ = std::fs::remove_file(&tmp);
    let out = out.map_err(|e| format!("tesseract not available ({e}) — install it for OCR"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    // tesseract hands back plain text, so the row index stands in for the
    // vertical position the WinRT path measures.
    Ok(String::from_utf8_lossy(&out.stdout)
        .trim_end()
        .lines()
        .enumerate()
        .map(|(i, l)| (i as f32 * 16.0, l.to_string()))
        .collect())
}

#[cfg(test)]
mod tests {
    // Manual check against a real colored-traceback capture:
    //   cargo test ocr_sample -- --ignored --nocapture
    #[test]
    #[ignore]
    fn ocr_sample() {
        let p = std::path::PathBuf::from(
            std::env::var("OCR_SAMPLE").expect("set OCR_SAMPLE=<png path>"),
        );
        // OCR_DUMP=<path.png> also writes out what the engine actually sees.
        if let Ok(dump) = std::env::var("OCR_DUMP") {
            let raw = std::fs::read(&p).unwrap();
            std::fs::write(dump, super::preprocess(&raw, 2).unwrap()).unwrap();
        }
        println!("--- OCR ---\n{}", super::ocr_file(&p).unwrap());
    }
}
