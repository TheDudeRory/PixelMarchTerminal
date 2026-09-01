//! System grab-bag: clipboard, notifications, sound, open-with-default,
//! shell commands, pixel color, time conditions.

use crate::pty::strip_webview_env;
use std::time::Duration;
use tokio_util::sync::CancellationToken;

pub const DEFAULT_SHELL_TIMEOUT_MS: u64 = 30_000;

pub fn clipboard_set(text: &str) -> Result<(), String> {
    arboard::Clipboard::new()
        .and_then(|mut c| c.set_text(text.to_owned()))
        .map_err(|e| e.to_string())
}

pub fn clipboard_get() -> Result<String, String> {
    arboard::Clipboard::new().and_then(|mut c| c.get_text()).map_err(|e| e.to_string())
}

pub fn notify(title: &str, body: &str) -> Result<(), String> {
    notify_rust::Notification::new()
        .summary(if title.is_empty() { "KeyForge" } else { title })
        .body(body)
        .appname("KeyForge")
        .show()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[cfg(windows)]
pub fn play_sound(path: &str) -> Result<(), String> {
    use windows::core::PCWSTR;
    use windows::Win32::Media::Audio::{PlaySoundW, SND_ASYNC, SND_FILENAME, SND_NODEFAULT};
    let wide: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();
    let ok = unsafe {
        PlaySoundW(PCWSTR(wide.as_ptr()), None, SND_FILENAME | SND_ASYNC | SND_NODEFAULT)
    };
    if ok.as_bool() { Ok(()) } else { Err(format!("PlaySound failed for {path:?}")) }
}

#[cfg(not(windows))]
pub fn play_sound(path: &str) -> Result<(), String> {
    // paplay (Pulse/PipeWire) with aplay fallback
    for player in ["paplay", "aplay"] {
        let mut c = std::process::Command::new(player);
        if strip_webview_env(&mut c).arg(path).spawn().is_ok() {
            return Ok(());
        }
    }
    Err("no audio player (tried paplay, aplay)".into())
}

#[cfg(windows)]
pub fn open_path(path: &str) -> Result<(), String> {
    use windows::core::{w, PCWSTR};
    use windows::Win32::UI::Shell::ShellExecuteW;
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
    let wide: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();
    let inst =
        unsafe { ShellExecuteW(None, w!("open"), PCWSTR(wide.as_ptr()), None, None, SW_SHOWNORMAL) };
    // per docs: > 32 means success
    if inst.0 as usize > 32 { Ok(()) } else { Err(format!("shell open failed for {path:?}")) }
}

#[cfg(not(windows))]
pub fn open_path(path: &str) -> Result<(), String> {
    // xdg-open resolves mimeapps.list and applications/ from XDG_DATA_HOME.
    // Leaving ours in place loses the user's file associations entirely.
    let mut c = std::process::Command::new("xdg-open");
    strip_webview_env(&mut c).arg(path).spawn().map(|_| ()).map_err(|e| e.to_string())
}

#[derive(Debug)]
pub struct ShellOutput {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i64,
}

/// Run through the platform shell, capturing output. Killed on timeout or
/// cancellation (kill_on_drop).
pub async fn run_shell(
    command: &str,
    timeout_ms: u64,
    cancel: &CancellationToken,
) -> Result<ShellOutput, String> {
    #[cfg(windows)]
    let mut cmd = {
        let mut c = tokio::process::Command::new("cmd");
        c.args(["/C", command]);
        c
    };
    #[cfg(not(windows))]
    let mut cmd = {
        let mut c = tokio::process::Command::new("sh");
        c.args(["-c", command]);
        c
    };
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    // The user's shell must see the user's XDG dirs, not our webview ones.
    strip_webview_env(&mut cmd);
    let child = cmd
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("cannot start shell: {e}"))?;

    let output = tokio::select! {
        out = child.wait_with_output() => out.map_err(|e| e.to_string())?,
        _ = tokio::time::sleep(Duration::from_millis(timeout_ms)) => {
            return Err(format!("shell command timed out after {timeout_ms} ms"));
        }
        _ = cancel.cancelled() => return Err("cancelled".into()),
    };
    let text = |b: &[u8]| String::from_utf8_lossy(b).trim_end_matches(['\r', '\n']).to_string();
    Ok(ShellOutput {
        stdout: text(&output.stdout),
        stderr: text(&output.stderr),
        exit_code: output.status.code().map(i64::from).unwrap_or(-1),
    })
}

// -------------------------------------------------------------------- pixels

/// "#RRGGBB" or "RRGGBB"
pub fn parse_color(s: &str) -> Result<(u8, u8, u8), String> {
    let hex = s.trim().trim_start_matches('#');
    if hex.len() != 6 || !hex.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(format!("expected #RRGGBB, got {s:?}"));
    }
    let v = u32::from_str_radix(hex, 16).map_err(|e| e.to_string())?;
    Ok(((v >> 16) as u8, (v >> 8) as u8, v as u8))
}

pub fn color_close(a: (u8, u8, u8), b: (u8, u8, u8), tolerance: u8) -> bool {
    a.0.abs_diff(b.0) <= tolerance && a.1.abs_diff(b.1) <= tolerance && a.2.abs_diff(b.2) <= tolerance
}

#[cfg(windows)]
pub fn pixel_at(x: i32, y: i32) -> Result<(u8, u8, u8), String> {
    use windows::Win32::Graphics::Gdi::{GetDC, GetPixel, ReleaseDC, CLR_INVALID};
    unsafe {
        let dc = GetDC(None);
        let color = GetPixel(dc, x, y);
        let _ = ReleaseDC(None, dc);
        if color.0 == CLR_INVALID {
            return Err(format!("cannot read pixel at ({x}, {y})"));
        }
        let v = color.0;
        Ok(((v & 0xFF) as u8, ((v >> 8) & 0xFF) as u8, ((v >> 16) & 0xFF) as u8))
    }
}

// -------- X11 helpers (Linux/Unix; X11-only, Wayland/headless returns Err) ----

#[cfg(not(windows))]
fn x11_connect() -> Result<(x11rb::rust_connection::RustConnection, usize), String> {
    if std::env::var_os("DISPLAY").is_none() {
        if std::env::var_os("WAYLAND_DISPLAY").is_some() {
            return Err("pixel/cursor queries need X11; running under Wayland ($DISPLAY unset). Not supported.".into());
        }
        return Err("no X11 display ($DISPLAY unset); pixel/cursor queries are X11-only.".into());
    }
    x11rb::connect(None).map_err(|e| format!("X11 connect failed: {e}"))
}

#[cfg(not(windows))]
pub fn pixel_at(x: i32, y: i32) -> Result<(u8, u8, u8), String> {
    use x11rb::connection::Connection;
    use x11rb::protocol::xproto::{ConnectionExt, ImageFormat};

    let (conn, screen_num) = x11_connect()?;
    let screen = &conn.setup().roots[screen_num];
    let root = screen.root;

    let cookie = conn
        .get_image(ImageFormat::Z_PIXMAP, root, x as i16, y as i16, 1, 1, !0u32)
        .map_err(|e| format!("get_image request failed: {e}"))?;
    let reply = cookie
        .reply()
        .map_err(|e| format!("get_image at ({x}, {y}) failed: {e}"))?;
    if reply.data.is_empty() {
        return Err(format!("empty pixel data at ({x}, {y})"));
    }

    // Assemble the pixel as a native-endian u32 from however many bytes the
    // server returned (1..=4 bytes per pixel for a 1x1 Z_PIXMAP).
    let mut pix: u32 = 0;
    for (i, b) in reply.data.iter().take(4).enumerate() {
        pix |= (*b as u32) << (8 * i as u32);
    }

    // Decode via the root visual's channel masks so we don't assume BGRX order.
    let (rm, gm, bm) = visual_masks(&conn, screen.root_visual);
    Ok((
        scale_channel(pix, rm),
        scale_channel(pix, gm),
        scale_channel(pix, bm),
    ))
}

/// Find the RGB bit-masks for a visual id (defaults to 8-8-8 if not found).
#[cfg(not(windows))]
fn visual_masks<C: x11rb::connection::Connection>(conn: &C, visual_id: u32) -> (u32, u32, u32) {
    for screen in &conn.setup().roots {
        for depth in &screen.allowed_depths {
            for v in &depth.visuals {
                if v.visual_id == visual_id {
                    return (v.red_mask, v.green_mask, v.blue_mask);
                }
            }
        }
    }
    (0x00FF0000, 0x0000FF00, 0x000000FF)
}

/// Extract a masked channel from a packed pixel and scale it to 0..=255.
#[cfg(not(windows))]
fn scale_channel(pix: u32, mask: u32) -> u8 {
    if mask == 0 {
        return 0;
    }
    let shift = mask.trailing_zeros();
    let max = mask >> shift;
    let val = (pix & mask) >> shift;
    ((val * 255 + max / 2) / max) as u8
}

#[cfg(windows)]
pub fn cursor_pos() -> Result<(i32, i32), String> {
    use windows::Win32::Foundation::POINT;
    use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;
    let mut p = POINT::default();
    unsafe { GetCursorPos(&mut p).map_err(|e| e.to_string())? };
    Ok((p.x, p.y))
}

#[cfg(not(windows))]
pub fn cursor_pos() -> Result<(i32, i32), String> {
    use x11rb::connection::Connection;
    use x11rb::protocol::xproto::ConnectionExt;

    let (conn, screen_num) = x11_connect()?;
    let root = conn.setup().roots[screen_num].root;
    let reply = conn
        .query_pointer(root)
        .map_err(|e| format!("query_pointer request failed: {e}"))?
        .reply()
        .map_err(|e| format!("query_pointer failed: {e}"))?;
    Ok((reply.root_x as i32, reply.root_y as i32))
}

// ---------------------------------------------------------------------- time

fn parse_hhmm(s: &str) -> Result<chrono::NaiveTime, String> {
    chrono::NaiveTime::parse_from_str(s.trim(), "%H:%M").map_err(|e| format!("bad time {s:?}: {e}"))
}

/// Inclusive start, exclusive end; overnight ranges (22:00–06:00) wrap.
pub fn time_between(now: chrono::NaiveTime, start: &str, end: &str) -> Result<bool, String> {
    let (start, end) = (parse_hhmm(start)?, parse_hhmm(end)?);
    Ok(if start <= end { now >= start && now < end } else { now >= start || now < end })
}

pub fn day_matches(day: chrono::Weekday, days: &[String]) -> bool {
    days.iter().any(|d| {
        matches!(
            (d.trim().to_lowercase().get(..3), day),
            (Some("mon"), chrono::Weekday::Mon)
                | (Some("tue"), chrono::Weekday::Tue)
                | (Some("wed"), chrono::Weekday::Wed)
                | (Some("thu"), chrono::Weekday::Thu)
                | (Some("fri"), chrono::Weekday::Fri)
                | (Some("sat"), chrono::Weekday::Sat)
                | (Some("sun"), chrono::Weekday::Sun)
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveTime;

    fn t(s: &str) -> NaiveTime {
        NaiveTime::parse_from_str(s, "%H:%M").unwrap()
    }

    #[test]
    fn time_ranges() {
        assert!(time_between(t("10:30"), "09:00", "17:00").unwrap());
        assert!(!time_between(t("17:00"), "09:00", "17:00").unwrap());
        // overnight wrap
        assert!(time_between(t("23:30"), "22:00", "06:00").unwrap());
        assert!(time_between(t("05:59"), "22:00", "06:00").unwrap());
        assert!(!time_between(t("12:00"), "22:00", "06:00").unwrap());
        assert!(time_between(t("00:00"), "0:00", "23:59").unwrap());
        assert!(time_between(t("00:00"), "24:00", "23:59").is_err());
    }

    #[test]
    fn days() {
        use chrono::Weekday::*;
        assert!(day_matches(Mon, &["mon".into(), "fri".into()]));
        assert!(day_matches(Fri, &["Friday".into()]));
        assert!(!day_matches(Sat, &["mon".into()]));
    }

    #[test]
    fn colors() {
        assert_eq!(parse_color("#FF8000").unwrap(), (255, 128, 0));
        assert_eq!(parse_color("ff8000").unwrap(), (255, 128, 0));
        assert!(parse_color("#FF80").is_err());
        assert!(color_close((10, 20, 30), (12, 18, 30), 2));
        assert!(!color_close((10, 20, 30), (14, 20, 30), 2));
    }

    #[tokio::test]
    async fn shell_captures_output() {
        let cancel = tokio_util::sync::CancellationToken::new();
        let out = run_shell("echo m6-shell-works", 10_000, &cancel).await.unwrap();
        assert_eq!(out.stdout, "m6-shell-works");
        assert_eq!(out.exit_code, 0);
        let fail = run_shell("exit 3", 10_000, &cancel).await.unwrap();
        assert_eq!(fail.exit_code, 3);
    }

    #[tokio::test(start_paused = true)]
    async fn shell_timeout() {
        let cancel = tokio_util::sync::CancellationToken::new();
        // 'timeout' cmdlet chatter aside, ping loops forever enough
        let err = run_shell("ping -n 30 127.0.0.1", 200, &cancel).await.unwrap_err();
        assert!(err.contains("timed out"));
    }
}
