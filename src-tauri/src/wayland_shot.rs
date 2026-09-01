//! Wayland screen capture for Linux.
//!
//! xcap cannot do this on a KDE/Plasma Wayland session. Its Wayland path tries
//! GNOME Shell's private D-Bus API, then the xdg-desktop-portal Screenshot
//! portal once PER MONITOR, then wlroots' `wlr-screencopy` — and on Plasma the
//! first has no service, the second raises one permission dialog per monitor
//! and is given no chance to answer, and the third is a protocol KWin does not
//! implement. The capture ends as `Cannot find required wayland protocol`.
//!
//! Its X11 path is not a fallback either: the app runs as an XWayland client
//! (main.rs forces GDK_BACKEND=x11), and a rootless XWayland root window does
//! not contain Wayland-native windows, so an X11 grab cannot see the desktop.
//!
//! So we capture ourselves, in this order:
//!   1. `org.kde.KWin.ScreenShot2` — KDE only, no dialog, one raw image per
//!      output over a pipe. This is what Spectacle uses.
//!   2. `org.freedesktop.portal.Screenshot` — the portable path (GNOME, KDE,
//!      wlroots). ONE call for the whole desktop, cropped per monitor here, so
//!      a multi-monitor capture cannot raise a dialog per screen. The portal
//!      remembers the grant, so the prompt is a one-time thing.
//!
//! Both return images in the caller's monitor order.

use std::collections::HashMap;
use std::io::Read;
use std::os::fd::IntoRawFd;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::Duration;

use dbus::arg::{
    AppendAll, Iter, IterAppend, OwnedFd, PropMap, ReadAll, RefArg, TypeMismatchError, Variant,
};
use dbus::blocking::Connection;
use dbus::message::{MatchRule, SignalArgs};
use image::RgbaImage;

/// One monitor to capture: its randr/KWin output name (they are the same name
/// on Plasma) and its rect on the virtual desktop, in physical px.
pub struct Target {
    pub name: String,
    pub x: i32,
    pub y: i32,
    pub w: u32,
    pub h: u32,
}

/// True when the session is Wayland, whatever toolkit backend this process
/// itself ended up using. Deliberately the same test xcap makes, so we take
/// over exactly the cases where its capture would have gone down the Wayland
/// path.
pub fn is_wayland_session() -> bool {
    let session = std::env::var("XDG_SESSION_TYPE").unwrap_or_default();
    let display = std::env::var("WAYLAND_DISPLAY").unwrap_or_default();
    session == "wayland" || display.to_lowercase().contains("wayland")
}

/// Capture every target, in order. KWin first (no dialog), portal second.
pub fn capture_monitors(targets: &[Target]) -> Result<Vec<RgbaImage>, String> {
    if targets.is_empty() {
        return Err("no monitor found".into());
    }
    let kwin_err = match kwin_capture_all(targets) {
        Ok(images) => return Ok(images),
        Err(e) => e,
    };
    match portal_capture_all(targets) {
        Ok(images) => Ok(images),
        // Both failed: the KWin error alone would send a GNOME user down the
        // wrong trail, and the portal error alone hides that KDE's fast path
        // was even tried.
        Err(portal_err) => Err(format!(
            "wayland capture failed (KWin: {kwin_err}; portal: {portal_err})"
        )),
    }
}

// ---------------------------------------------------------------------------
// KWin — org.kde.KWin.ScreenShot2
// ---------------------------------------------------------------------------

fn kwin_capture_all(targets: &[Target]) -> Result<Vec<RgbaImage>, String> {
    let conn = Connection::new_session().map_err(|e| e.to_string())?;
    let mut out = Vec::with_capacity(targets.len());
    for t in targets {
        // CaptureScreen takes the output name; CaptureArea is the fallback for
        // when randr and KWin disagree about a name (they match on Plasma, but
        // a mismatch would otherwise fail the whole capture).
        let img = kwin_capture_screen(&conn, &t.name)
            .or_else(|_| kwin_capture_area(&conn, t.x, t.y, t.w, t.h))?;
        out.push(img);
    }
    Ok(out)
}

fn kwin_capture_screen(conn: &Connection, name: &str) -> Result<RgbaImage, String> {
    kwin_call(conn, "CaptureScreen", |proxy, opts, fd| {
        proxy.method_call("org.kde.KWin.ScreenShot2", "CaptureScreen", (name, opts, fd))
    })
}

fn kwin_capture_area(
    conn: &Connection,
    x: i32,
    y: i32,
    w: u32,
    h: u32,
) -> Result<RgbaImage, String> {
    kwin_call(conn, "CaptureArea", |proxy, opts, fd| {
        proxy.method_call(
            "org.kde.KWin.ScreenShot2",
            "CaptureArea",
            (x, y, w, h, opts, fd),
        )
    })
}

/// Shared plumbing for every ScreenShot2 method: KWin writes the raw image into
/// a pipe we hand it and describes it in the reply.
///
/// The read MUST run on another thread: the image is megabytes, the pipe buffer
/// is 64 KiB, and KWin does not reply until it has written everything — reading
/// after the call would deadlock both processes.
fn kwin_call<F>(conn: &Connection, method: &str, call: F) -> Result<RgbaImage, String>
where
    F: FnOnce(
        &dbus::blocking::Proxy<'_, &Connection>,
        PropMap,
        OwnedFd,
    ) -> Result<(PropMap,), dbus::Error>,
{
    let (read_end, write_end) = nix::unistd::pipe().map_err(|e| e.to_string())?;
    let reader = std::thread::spawn(move || {
        let mut file = std::fs::File::from(read_end);
        let mut buf = Vec::new();
        let _ = file.read_to_end(&mut buf);
        buf
    });

    let proxy = conn.with_proxy(
        "org.kde.KWin",
        "/org/kde/KWin/ScreenShot2",
        Duration::from_secs(15),
    );
    let mut opts: PropMap = HashMap::new();
    opts.insert(
        String::from("include-cursor"),
        Variant(Box::new(false) as Box<dyn RefArg>),
    );
    // The fd is owned by dbus now and closed when the call drops it — that
    // close is what gives the reader its EOF.
    let fd = unsafe { OwnedFd::new(write_end.into_raw_fd()) };
    let reply = call(&proxy, opts, fd);

    let bytes = reader.join().map_err(|_| "screenshot reader panicked")?;
    let (results,) = reply.map_err(|e| format!("{method}: {e}"))?;

    let width = prop_u32(&results, "width").ok_or("KWin reply has no width")?;
    let height = prop_u32(&results, "height").ok_or("KWin reply has no height")?;
    let stride = prop_u32(&results, "stride").ok_or("KWin reply has no stride")?;
    let format = prop_u32(&results, "format").ok_or("KWin reply has no format")?;
    raw_to_rgba(&bytes, width, height, stride, format)
}

fn prop_u32(map: &PropMap, key: &str) -> Option<u32> {
    map.get(key).and_then(|v| v.as_u64()).map(|v| v as u32)
}

/// Turn KWin's raw framebuffer into an RgbaImage.
///
/// `format` is a QImage::Format. Only the 32-bit ones can appear here; the
/// premultiplied variants are treated as opaque because a screen capture has no
/// real transparency, which also sidesteps un-premultiplying.
fn raw_to_rgba(
    bytes: &[u8],
    width: u32,
    height: u32,
    stride: u32,
    format: u32,
) -> Result<RgbaImage, String> {
    let need = stride as usize * height as usize;
    if bytes.len() < need {
        return Err(format!(
            "short screenshot: got {} bytes, need {need}",
            bytes.len()
        ));
    }
    // QImage::Format_RGBA8888 / _Premultiplied / _RGBX8888 are byte-ordered
    // R,G,B,A. Format_RGB32 / _ARGB32 / _ARGB32_Premultiplied are 0xAARRGGBB
    // packed in a u32, which on little-endian lands as B,G,R,A.
    let rgba_order = matches!(format, 17 | 18 | 19);
    let bgra_order = matches!(format, 4 | 5 | 6);
    if !rgba_order && !bgra_order {
        return Err(format!("unsupported KWin image format {format}"));
    }
    let mut out = Vec::with_capacity(width as usize * height as usize * 4);
    for row in 0..height as usize {
        let line = &bytes[row * stride as usize..][..width as usize * 4];
        for px in line.chunks_exact(4) {
            if rgba_order {
                out.extend_from_slice(&[px[0], px[1], px[2], 255]);
            } else {
                out.extend_from_slice(&[px[2], px[1], px[0], 255]);
            }
        }
    }
    RgbaImage::from_raw(width, height, out).ok_or_else(|| "malformed KWin image".into())
}

// ---------------------------------------------------------------------------
// xdg-desktop-portal — org.freedesktop.portal.Screenshot
// ---------------------------------------------------------------------------

#[derive(Debug)]
struct PortalResponse {
    status: u32,
    results: PropMap,
}

impl AppendAll for PortalResponse {
    fn append(&self, i: &mut IterAppend) {
        RefArg::append(&self.status, i);
        RefArg::append(&self.results, i);
    }
}

impl ReadAll for PortalResponse {
    fn read(i: &mut Iter) -> Result<Self, TypeMismatchError> {
        Ok(PortalResponse {
            status: i.read()?,
            results: i.read()?,
        })
    }
}

impl SignalArgs for PortalResponse {
    const NAME: &'static str = "Response";
    const INTERFACE: &'static str = "org.freedesktop.portal.Request";
}

/// How long to wait for the portal. Long, because the FIRST capture on a fresh
/// profile shows a permission dialog a human has to answer; once granted the
/// portal answers immediately.
const PORTAL_WAIT: Duration = Duration::from_secs(60);

static PORTAL_SEQ: AtomicU32 = AtomicU32::new(0);

/// One portal call for the WHOLE desktop, then crop each monitor out of it.
fn portal_capture_all(targets: &[Target]) -> Result<Vec<RgbaImage>, String> {
    let full = portal_screenshot()?;

    // Virtual-desktop origin: monitor coords can be negative (a screen left of
    // or above the primary), while the portal image always starts at its own
    // top-left.
    let min_x = targets.iter().map(|t| t.x).min().unwrap_or(0);
    let min_y = targets.iter().map(|t| t.y).min().unwrap_or(0);
    let span_w = targets
        .iter()
        .map(|t| t.x - min_x + t.w as i32)
        .max()
        .unwrap_or(0)
        .max(1) as f64;
    let span_h = targets
        .iter()
        .map(|t| t.y - min_y + t.h as i32)
        .max()
        .unwrap_or(0)
        .max(1) as f64;
    // The compositor may hand back a scaled image (HiDPI); rescale the crop
    // rects rather than assuming 1 monitor px == 1 image px.
    let sx = full.width() as f64 / span_w;
    let sy = full.height() as f64 / span_h;

    let mut out = Vec::with_capacity(targets.len());
    for t in targets {
        let x = (((t.x - min_x) as f64) * sx).round() as u32;
        let y = (((t.y - min_y) as f64) * sy).round() as u32;
        let w = ((t.w as f64) * sx).round() as u32;
        let h = ((t.h as f64) * sy).round() as u32;
        // A single-monitor session is the common case and the crop is then the
        // whole image; clamp instead of failing if the rects disagree slightly.
        let x = x.min(full.width().saturating_sub(1));
        let y = y.min(full.height().saturating_sub(1));
        let w = w.min(full.width() - x).max(1);
        let h = h.min(full.height() - y).max(1);
        out.push(image::imageops::crop_imm(&full, x, y, w, h).to_image());
    }
    Ok(out)
}

/// Ask the portal for one screenshot of the desktop and decode it.
fn portal_screenshot() -> Result<RgbaImage, String> {
    let conn = Connection::new_session().map_err(|e| e.to_string())?;

    // A token unique per call. xcap hardcodes "1234", which collides with any
    // other request in flight from this connection.
    let seq = PORTAL_SEQ.fetch_add(1, Ordering::Relaxed);
    let token = format!("pixelmarch_{}_{seq}", std::process::id());
    let unique = conn
        .unique_name()
        .trim_start_matches(':')
        .replace('.', "_")
        .to_string();
    let request_path = format!("/org/freedesktop/portal/desktop/request/{unique}/{token}");

    // Match the OUR-request path only, so a screenshot request from another app
    // on this bus cannot be mistaken for ours.
    let mut rule = MatchRule::new_signal("org.freedesktop.portal.Request", "Response");
    rule.path = Some(request_path.clone().into());

    let answer: std::sync::Arc<std::sync::Mutex<Option<(u32, String)>>> = Default::default();
    let sink = answer.clone();
    conn.add_match(rule, move |r: PortalResponse, _, _| {
        let uri = r
            .results
            .get("uri")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string();
        if let Ok(mut slot) = sink.lock() {
            *slot = Some((r.status, uri));
        }
        true
    })
    .map_err(|e| e.to_string())?;

    let proxy = conn.with_proxy(
        "org.freedesktop.portal.Desktop",
        "/org/freedesktop/portal/desktop",
        Duration::from_secs(15),
    );
    let mut options: PropMap = HashMap::new();
    options.insert(
        String::from("handle_token"),
        Variant(Box::new(token) as Box<dyn RefArg>),
    );
    // interactive=false: we do our own region select in the snip overlay, and
    // the compositor's picker would fight it.
    options.insert(
        String::from("interactive"),
        Variant(Box::new(false) as Box<dyn RefArg>),
    );
    let (handle,): (dbus::Path,) = proxy
        .method_call(
            "org.freedesktop.portal.Screenshot",
            "Screenshot",
            ("", options),
        )
        .map_err(|e| e.to_string())?;
    if *handle != *request_path {
        // Older portals ignore handle_token and pick their own path. Nothing to
        // do but say so: the Response would never reach our match rule.
        return Err(format!(
            "portal returned an unexpected request handle {handle} (expected {request_path})"
        ));
    }

    let deadline = std::time::Instant::now() + PORTAL_WAIT;
    let (status, uri) = loop {
        conn.process(Duration::from_millis(200))
            .map_err(|e| e.to_string())?;
        if let Some(got) = answer.lock().map_err(|_| "portal answer lock")?.clone() {
            break got;
        }
        if std::time::Instant::now() >= deadline {
            return Err("portal screenshot timed out (permission dialog unanswered?)".into());
        }
    };
    if status == 1 {
        return Err("portal screenshot cancelled".into());
    }
    if status != 0 {
        // Status 2 is the portal's catch-all "it went wrong", with the reason
        // only in the backend's own log — and one real cause is mundane enough
        // to name: a package upgrade leaves the RUNNING xdg-desktop-portal-kde
        // pointing at a deleted binary, KWin's caller check reads
        // /proc/<pid>/exe, sees the " (deleted)" suffix and refuses it. Every
        // screenshot then fails until the portal is restarted.
        return Err(format!(
            "portal screenshot failed (status {status}); check `journalctl --user -t \
             xdg-desktop-portal-kde`, and if it logs NoAuthorized restart it with \
             `systemctl --user restart plasma-xdg-desktop-portal-kde.service`"
        ));
    }
    let path = uri
        .strip_prefix("file://")
        .ok_or_else(|| format!("portal returned a non-file uri: {uri}"))?;
    let path = percent_decode(path);

    let img = image::open(&path).map_err(|e| format!("{path}: {e}"))?;
    // The portal writes into its own temp dir and hands ownership to us.
    let _ = std::fs::remove_file(&path);
    Ok(img.to_rgba8())
}

/// Percent-decode a file URI path. The portal encodes spaces and non-ASCII in
/// the temp file name, so `file:///tmp/My%20Shot.png` must not be opened
/// literally.
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok();
            if let Some(byte) = hex.and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(byte);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_escaped_path_and_leaves_plain_one_alone() {
        assert_eq!(percent_decode("/tmp/My%20Shot.png"), "/tmp/My Shot.png");
        assert_eq!(percent_decode("/tmp/shot.png"), "/tmp/shot.png");
        // A stray % that is not an escape must survive rather than eat the name.
        assert_eq!(percent_decode("/tmp/100%.png"), "/tmp/100%.png");
    }

    /// Packed-u32 formats reach us little-endian, so the byte order is BGRA and
    /// reading it as RGBA would silently swap every screenshot's red and blue.
    #[test]
    fn bgra_and_rgba_formats_decode_to_the_same_pixel() {
        let bgra = raw_to_rgba(&[10, 20, 30, 40], 1, 1, 4, 6).unwrap();
        assert_eq!(bgra.get_pixel(0, 0).0, [30, 20, 10, 255]);
        let rgba = raw_to_rgba(&[30, 20, 10, 40], 1, 1, 4, 17).unwrap();
        assert_eq!(rgba.get_pixel(0, 0).0, [30, 20, 10, 255]);
    }

    /// Stride is padding, not width: honouring it is what keeps a padded
    /// framebuffer from shearing diagonally.
    #[test]
    fn skips_row_padding() {
        // 1x2, 4 px of payload per row but a 12-byte stride.
        let bytes = vec![
            1, 2, 3, 4, 9, 9, 9, 9, 9, 9, 9, 9, // row 0 + padding
            5, 6, 7, 8, 9, 9, 9, 9, 9, 9, 9, 9, // row 1 + padding
        ];
        let img = raw_to_rgba(&bytes, 1, 2, 12, 17).unwrap();
        assert_eq!(img.get_pixel(0, 0).0, [1, 2, 3, 255]);
        assert_eq!(img.get_pixel(0, 1).0, [5, 6, 7, 255]);
    }

    #[test]
    fn refuses_a_truncated_buffer_instead_of_reading_past_it() {
        assert!(raw_to_rgba(&[1, 2, 3], 1, 1, 4, 17).is_err());
    }

    #[test]
    fn refuses_an_unknown_qimage_format() {
        assert!(raw_to_rgba(&[1, 2, 3, 4], 1, 1, 4, 3).is_err());
    }

    /// Live smoke test against the real compositor: only a session bus, a
    /// running compositor and a human's screen can prove this path, so it is
    /// #[ignore]d and run by hand:
    ///   cargo test --lib wayland_shot -- --ignored --nocapture
    /// It writes one PNG per monitor into the system temp dir and prints them.
    #[test]
    #[ignore]
    fn captures_this_desktop_for_real() {
        assert!(is_wayland_session(), "not a Wayland session — nothing to prove");
        let monitors = xcap::Monitor::all().expect("monitor enumeration");
        let targets: Vec<Target> = monitors
            .iter()
            .map(|m| Target {
                name: m.name().unwrap_or_default(),
                x: m.x().unwrap_or(0),
                y: m.y().unwrap_or(0),
                w: m.width().unwrap_or(0),
                h: m.height().unwrap_or(0),
            })
            .collect();
        let images = capture_monitors(&targets).expect("capture");
        assert_eq!(images.len(), targets.len());
        for (t, img) in targets.iter().zip(&images) {
            println!("{} {}x{} -> {}x{}", t.name, t.w, t.h, img.width(), img.height());
            assert!(img.width() > 0 && img.height() > 0);
            // An all-one-colour image is what a wrong-backend capture returns
            // (black root window), so it must not pass as a screenshot.
            let first = img.get_pixel(0, 0);
            assert!(
                img.pixels().any(|p| p != first),
                "{} came back as a single flat colour",
                t.name
            );
            let out = std::env::temp_dir().join(format!("pixelmarch-smoke-{}.png", t.name));
            img.save(&out).expect("save");
            println!("wrote {}", out.display());
        }
    }
}
