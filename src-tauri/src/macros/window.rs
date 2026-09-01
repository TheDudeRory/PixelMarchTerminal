use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq)]
pub struct WindowInfo {
    pub id: u64,
    pub title: String,
    pub class: String,
    /// executable name, lowercase ("notepad.exe")
    pub process: String,
    pub focused: bool,
    /// x, y, w, h in screen coordinates
    pub rect: (i32, i32, i32, i32),
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MonitorInfo {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TitleMatch {
    Exact,
    #[default]
    Contains,
    Regex,
}

/// How window steps and conditions pick their target window.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "by", rename_all = "snake_case")]
pub enum WindowSelector {
    Focused,
    Title {
        #[serde(default)]
        mode: TitleMatch,
        value: String,
    },
    Process {
        name: String,
    },
    Class {
        name: String,
    },
}

/// ".exe" optional, case-insensitive: "Notepad" matches "notepad.exe".
fn process_matches(win_process: &str, wanted: &str) -> bool {
    let strip = |s: &str| s.trim().trim_end_matches(".exe").to_lowercase();
    strip(win_process) == strip(wanted)
}

pub fn selector_matches(sel: &WindowSelector, win: &WindowInfo) -> bool {
    match sel {
        WindowSelector::Focused => win.focused,
        WindowSelector::Title { mode: TitleMatch::Exact, value } => win.title == *value,
        WindowSelector::Title { mode: TitleMatch::Contains, value } => {
            win.title.to_lowercase().contains(&value.to_lowercase())
        }
        WindowSelector::Title { mode: TitleMatch::Regex, value } => {
            // ponytail: regex compiled per candidate; cache if profiling cares
            regex::Regex::new(value).map(|re| re.is_match(&win.title)).unwrap_or(false)
        }
        WindowSelector::Process { name } => process_matches(&win.process, name),
        WindowSelector::Class { name } => win.class.eq_ignore_ascii_case(name),
    }
}

/// First match wins; list_windows returns top-down z-order, so this is the
/// topmost matching window.
pub fn find_first<'a>(sel: &WindowSelector, windows: &'a [WindowInfo]) -> Option<&'a WindowInfo> {
    windows.iter().find(|w| selector_matches(sel, w))
}

pub fn describe(sel: &WindowSelector) -> String {
    match sel {
        WindowSelector::Focused => "focused window".into(),
        WindowSelector::Title { mode, value } => format!("title {mode:?} {value:?}"),
        WindowSelector::Process { name } => format!("process {name:?}"),
        WindowSelector::Class { name } => format!("class {name:?}"),
    }
}

// -------------------------------------------------------- dimension resolve

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Dim {
    Px(i32),
    /// percent of the window's monitor work area
    Pct(f64),
}

pub fn parse_dim(v: &serde_json::Value) -> Result<Dim, String> {
    if let Some(n) = v.as_f64() {
        return Ok(Dim::Px(n as i32));
    }
    if let Some(s) = v.as_str() {
        if let Some(num) = s.trim().strip_suffix('%') {
            return num
                .trim()
                .parse::<f64>()
                .map(Dim::Pct)
                .map_err(|_| format!("bad percentage: {s:?}"));
        }
        if let Ok(n) = s.trim().parse::<f64>() {
            return Ok(Dim::Px(n as i32));
        }
    }
    Err(format!("expected pixels or \"NN%\", got {v}"))
}

/// Resolve a move/resize request against the window's current rect and its
/// monitor's work area. None = keep current.
pub fn resolve_rect(
    win: (i32, i32, i32, i32),
    mon: &MonitorInfo,
    x: Option<Dim>,
    y: Option<Dim>,
    w: Option<Dim>,
    h: Option<Dim>,
) -> (i32, i32, i32, i32) {
    let pos = |d: Option<Dim>, cur: i32, origin: i32, extent: i32| match d {
        None => cur,
        Some(Dim::Px(v)) => v,
        Some(Dim::Pct(p)) => origin + ((extent as f64) * p / 100.0) as i32,
    };
    let size = |d: Option<Dim>, cur: i32, extent: i32| match d {
        None => cur,
        Some(Dim::Px(v)) => v,
        Some(Dim::Pct(p)) => ((extent as f64) * p / 100.0) as i32,
    };
    (
        pos(x, win.0, mon.x, mon.w),
        pos(y, win.1, mon.y, mon.h),
        size(w, win.2, mon.w).max(50),
        size(h, win.3, mon.h).max(50),
    )
}

/// Monitor containing the window center, else the first.
pub fn monitor_for(win: (i32, i32, i32, i32), monitors: &[MonitorInfo]) -> Option<MonitorInfo> {
    let (cx, cy) = (win.0 + win.2 / 2, win.1 + win.3 / 2);
    monitors
        .iter()
        .find(|m| cx >= m.x && cx < m.x + m.w && cy >= m.y && cy < m.y + m.h)
        .or_else(|| monitors.first())
        .copied()
}

/// ponytail: fresh sysinfo snapshot per check — polls happen at human
/// timescale; keep a cached System only if profiling ever cares.
pub fn process_running(name: &str) -> bool {
    let mut sys = sysinfo::System::new();
    sys.refresh_processes_specifics(
        sysinfo::ProcessesToUpdate::All,
        true,
        sysinfo::ProcessRefreshKind::nothing(),
    );
    sys.processes()
        .values()
        .any(|p| process_matches(&p.name().to_string_lossy(), name))
}

// -------------------------------------------------------------------- trait

pub trait WindowManager: Send + Sync {
    /// Visible top-level windows, top-down z-order.
    fn list_windows(&self) -> Result<Vec<WindowInfo>, String>;
    /// Work areas, sorted left-to-right (stable "monitor N").
    fn monitors(&self) -> Result<Vec<MonitorInfo>, String>;
    fn focus(&self, id: u64) -> Result<(), String>;
    fn move_resize(&self, id: u64, x: i32, y: i32, w: i32, h: i32) -> Result<(), String>;
    fn minimize(&self, id: u64) -> Result<(), String>;
    fn maximize(&self, id: u64) -> Result<(), String>;
    fn restore(&self, id: u64) -> Result<(), String>;
    fn close(&self, id: u64) -> Result<(), String>;
    fn always_on_top(&self, id: u64) -> Result<bool, String>;
    fn set_always_on_top(&self, id: u64, on: bool) -> Result<(), String>;
    /// alpha 0 (invisible) ..= 255 (opaque). Windows-only; others warn.
    fn set_transparency(&self, id: u64, alpha: u8) -> Result<(), String>;
}

#[cfg(windows)]
pub use win_impl::NativeWindowManager;
#[cfg(not(windows))]
pub use stub_impl::NativeWindowManager;

#[cfg(windows)]
mod win_impl {
    use super::{MonitorInfo, WindowInfo, WindowManager};
    use windows::core::BOOL;
    use windows::Win32::Foundation::{CloseHandle, HWND, LPARAM, RECT};
    use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};
    use windows::Win32::Graphics::Gdi::{
        EnumDisplayMonitors, GetMonitorInfoW, HDC, HMONITOR, MONITORINFO,
    };
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        keybd_event, KEYBD_EVENT_FLAGS, KEYEVENTF_KEYUP, VK_MENU,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        GetClassNameW, GetForegroundWindow, GetWindowLongW, GetWindowRect,
        GetWindowTextW, GetWindowThreadProcessId, IsIconic, IsWindowVisible, PostMessageW,
        SetForegroundWindow, SetLayeredWindowAttributes, SetWindowLongW, SetWindowPos,
        ShowWindow, GWL_EXSTYLE, HWND_NOTOPMOST, HWND_TOPMOST, LWA_ALPHA, SWP_NOACTIVATE,
        SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER, SW_MAXIMIZE, SW_MINIMIZE, SW_RESTORE,
        WM_CLOSE, WS_EX_LAYERED, WS_EX_TOPMOST,
    };

    pub struct NativeWindowManager;

    fn hwnd(id: u64) -> HWND {
        HWND(id as isize as *mut core::ffi::c_void)
    }

    fn utf16_to_string(buf: &[u16], len: i32) -> String {
        String::from_utf16_lossy(&buf[..len.max(0) as usize])
    }

    fn process_name(pid: u32) -> String {
        unsafe {
            let Ok(handle) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
                return String::new(); // e.g. elevated process
            };
            let mut buf = [0u16; 1024];
            let mut len = buf.len() as u32;
            let ok = QueryFullProcessImageNameW(
                handle,
                PROCESS_NAME_WIN32,
                windows::core::PWSTR(buf.as_mut_ptr()),
                &mut len,
            )
            .is_ok();
            let _ = CloseHandle(handle);
            if !ok {
                return String::new();
            }
            let path = String::from_utf16_lossy(&buf[..len as usize]);
            path.rsplit(['\\', '/']).next().unwrap_or("").to_lowercase()
        }
    }

    fn cloaked(h: HWND) -> bool {
        unsafe {
            let mut value: u32 = 0;
            DwmGetWindowAttribute(
                h,
                DWMWA_CLOAKED,
                &mut value as *mut u32 as *mut core::ffi::c_void,
                size_of::<u32>() as u32,
            )
            .map(|()| value != 0)
            .unwrap_or(false)
        }
    }

    impl WindowManager for NativeWindowManager {
        fn list_windows(&self) -> Result<Vec<WindowInfo>, String> {
            unsafe extern "system" fn cb(h: HWND, lparam: LPARAM) -> BOOL {
                let out = unsafe { &mut *(lparam.0 as *mut Vec<WindowInfo>) };
                unsafe {
                    if !IsWindowVisible(h).as_bool() || cloaked(h) {
                        return BOOL(1);
                    }
                    let mut buf = [0u16; 512];
                    let len = GetWindowTextW(h, &mut buf);
                    let title = utf16_to_string(&buf, len);
                    if title.is_empty() {
                        return BOOL(1);
                    }
                    let mut buf = [0u16; 256];
                    let len = GetClassNameW(h, &mut buf);
                    let class = utf16_to_string(&buf, len);
                    let mut pid = 0u32;
                    GetWindowThreadProcessId(h, Some(&mut pid));
                    let mut rect = RECT::default();
                    let _ = GetWindowRect(h, &mut rect);
                    out.push(WindowInfo {
                        id: h.0 as isize as u64,
                        title,
                        class,
                        process: process_name(pid),
                        focused: GetForegroundWindow() == h,
                        rect: (
                            rect.left,
                            rect.top,
                            rect.right - rect.left,
                            rect.bottom - rect.top,
                        ),
                    });
                }
                BOOL(1)
            }
            let mut windows: Vec<WindowInfo> = Vec::new();
            unsafe {
                windows::Win32::UI::WindowsAndMessaging::EnumWindows(
                    Some(cb),
                    LPARAM(&mut windows as *mut _ as isize),
                )
                .map_err(|e| e.to_string())?;
            }
            Ok(windows)
        }

        fn monitors(&self) -> Result<Vec<MonitorInfo>, String> {
            unsafe extern "system" fn cb(
                hmon: HMONITOR,
                _hdc: HDC,
                _rect: *mut RECT,
                lparam: LPARAM,
            ) -> BOOL {
                let out = unsafe { &mut *(lparam.0 as *mut Vec<MonitorInfo>) };
                let mut info = MONITORINFO { cbSize: size_of::<MONITORINFO>() as u32, ..Default::default() };
                unsafe {
                    if GetMonitorInfoW(hmon, &mut info).as_bool() {
                        let r = info.rcWork;
                        out.push(MonitorInfo {
                            x: r.left,
                            y: r.top,
                            w: r.right - r.left,
                            h: r.bottom - r.top,
                        });
                    }
                }
                BOOL(1)
            }
            let mut monitors: Vec<MonitorInfo> = Vec::new();
            unsafe {
                let _ = EnumDisplayMonitors(None, None, Some(cb), LPARAM(&mut monitors as *mut _ as isize));
            }
            monitors.sort_by_key(|m| (m.x, m.y));
            if monitors.is_empty() {
                return Err("no monitors reported".into());
            }
            Ok(monitors)
        }

        fn focus(&self, id: u64) -> Result<(), String> {
            unsafe {
                let h = hwnd(id);
                if IsIconic(h).as_bool() {
                    let _ = ShowWindow(h, SW_RESTORE);
                }
                if SetForegroundWindow(h).as_bool() {
                    return Ok(());
                }
                // Alt-key nudge: releases the foreground lock for this thread.
                keybd_event(VK_MENU.0 as u8, 0, KEYBD_EVENT_FLAGS(0), 0);
                keybd_event(VK_MENU.0 as u8, 0, KEYEVENTF_KEYUP, 0);
                if SetForegroundWindow(h).as_bool() {
                    return Ok(());
                }
                Err("SetForegroundWindow refused — if the target runs elevated, a non-elevated KeyForge cannot focus or send input to it".into())
            }
        }

        fn move_resize(&self, id: u64, x: i32, y: i32, w: i32, h: i32) -> Result<(), String> {
            unsafe {
                SetWindowPos(hwnd(id), None, x, y, w, h, SWP_NOZORDER | SWP_NOACTIVATE)
                    .map_err(|e| e.to_string())
            }
        }

        fn minimize(&self, id: u64) -> Result<(), String> {
            let _ = unsafe { ShowWindow(hwnd(id), SW_MINIMIZE) };
            Ok(())
        }

        fn maximize(&self, id: u64) -> Result<(), String> {
            let _ = unsafe { ShowWindow(hwnd(id), SW_MAXIMIZE) };
            Ok(())
        }

        fn restore(&self, id: u64) -> Result<(), String> {
            let _ = unsafe { ShowWindow(hwnd(id), SW_RESTORE) };
            Ok(())
        }

        fn close(&self, id: u64) -> Result<(), String> {
            unsafe {
                PostMessageW(Some(hwnd(id)), WM_CLOSE, Default::default(), Default::default())
                    .map_err(|e| e.to_string())
            }
        }

        fn always_on_top(&self, id: u64) -> Result<bool, String> {
            let ex = unsafe { GetWindowLongW(hwnd(id), GWL_EXSTYLE) };
            Ok((ex as u32 & WS_EX_TOPMOST.0) != 0)
        }

        fn set_always_on_top(&self, id: u64, on: bool) -> Result<(), String> {
            let insert_after = if on { HWND_TOPMOST } else { HWND_NOTOPMOST };
            unsafe {
                SetWindowPos(
                    hwnd(id),
                    Some(insert_after),
                    0,
                    0,
                    0,
                    0,
                    SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
                )
                .map_err(|e| e.to_string())
            }
        }

        fn set_transparency(&self, id: u64, alpha: u8) -> Result<(), String> {
            unsafe {
                let h = hwnd(id);
                let ex = GetWindowLongW(h, GWL_EXSTYLE);
                SetWindowLongW(h, GWL_EXSTYLE, ex | WS_EX_LAYERED.0 as i32);
                SetLayeredWindowAttributes(h, Default::default(), alpha, LWA_ALPHA)
                    .map_err(|e| e.to_string())
            }
        }
    }
}

// ------------------------------------------------------------- X11 / Linux
//
// EWMH (Extended Window Manager Hints) implementation over x11rb. Talks to the
// running window manager through _NET_* root-window messages and per-window
// properties — the same protocol wmctrl/xdotool use. See the freedesktop EWMH
// spec: https://specifications.freedesktop.org/wm-spec/latest/
//
// WAYLAND CEILING: Wayland clients are sandboxed by design — a client cannot
// enumerate, focus, move, or restyle *other* clients' windows. There is no
// portable protocol for it; compositors expose bespoke ones at best (KWin
// scripting via `kdotool`, wlroots' foreign-toplevel-management for listing
// only, or the org.freedesktop.portal.* desktop portals for narrow actions).
// So under Wayland we fail loudly and honestly rather than pretend. Users who
// need window control on Wayland run an XWayland session or a KWin/kdotool
// bridge; documenting that is the most we can do from inside the process.
#[cfg(not(windows))]
mod stub_impl {
    use super::{MonitorInfo, WindowInfo, WindowManager};
    use x11rb::connection::Connection;
    use x11rb::protocol::xproto::{
        AtomEnum, ClientMessageEvent, ConnectionExt as _, EventMask, PropMode, Window,
    };
    use x11rb::rust_connection::RustConnection;
    use x11rb::wrapper::ConnectionExt as _; // change_property32

    pub struct NativeWindowManager;

    /// Atoms we intern once per connection. EWMH is entirely atom-driven, so
    /// every op resolves these names up front against the running WM.
    struct Atoms {
        client_list_stacking: u32,
        client_list: u32,
        active_window: u32,
        wm_name: u32,
        wm_pid: u32,
        wm_state: u32,
        state_above: u32,
        state_max_vert: u32,
        state_max_horz: u32,
        close_window: u32,
        moveresize_window: u32,
        wm_window_opacity: u32,
        wm_change_state: u32,
    }

    impl Atoms {
        fn intern(conn: &RustConnection) -> Result<Self, String> {
            let get = |name: &str| -> Result<u32, String> {
                conn.intern_atom(false, name.as_bytes())
                    .map_err(|e| format!("intern_atom({name}) request failed: {e}"))?
                    .reply()
                    .map(|r| r.atom)
                    .map_err(|e| format!("intern_atom({name}) failed: {e}"))
            };
            Ok(Atoms {
                client_list_stacking: get("_NET_CLIENT_LIST_STACKING")?,
                client_list: get("_NET_CLIENT_LIST")?,
                active_window: get("_NET_ACTIVE_WINDOW")?,
                wm_name: get("_NET_WM_NAME")?,
                wm_pid: get("_NET_WM_PID")?,
                wm_state: get("_NET_WM_STATE")?,
                state_above: get("_NET_WM_STATE_ABOVE")?,
                state_max_vert: get("_NET_WM_STATE_MAXIMIZED_VERT")?,
                state_max_horz: get("_NET_WM_STATE_MAXIMIZED_HORZ")?,
                close_window: get("_NET_CLOSE_WINDOW")?,
                moveresize_window: get("_NET_MOVERESIZE_WINDOW")?,
                wm_window_opacity: get("_NET_WM_WINDOW_OPACITY")?,
                wm_change_state: get("WM_CHANGE_STATE")?,
            })
        }
    }

    struct X11 {
        conn: RustConnection,
        root: Window,
        atoms: Atoms,
    }

    /// Connect to the X server, refusing clearly on Wayland/headless. Mirrors
    /// sys.rs's x11_connect gate so the whole feature reports one ceiling.
    fn connect() -> Result<X11, String> {
        if std::env::var_os("DISPLAY").is_none() {
            if std::env::var_os("WAYLAND_DISPLAY").is_some() {
                return Err("window control needs X11; running under Wayland ($DISPLAY unset). \
                    Wayland forbids clients from managing other windows — run an XWayland \
                    session or a compositor bridge (e.g. kdotool on KWin). Not supported."
                    .into());
            }
            return Err("no X11 display ($DISPLAY unset); window control is X11-only.".into());
        }
        let (conn, screen_num) =
            x11rb::connect(None).map_err(|e| format!("X11 connect failed: {e}"))?;
        let root = conn.setup().roots[screen_num].root;
        let atoms = Atoms::intern(&conn)?;
        Ok(X11 { conn, root, atoms })
    }

    /// Read a property as a list of 32-bit values (window ids, atoms, cardinals).
    fn prop_u32(conn: &RustConnection, win: Window, prop: u32) -> Vec<u32> {
        conn.get_property(false, win, prop, AtomEnum::ANY, 0, u32::MAX)
            .ok()
            .and_then(|c| c.reply().ok())
            .and_then(|r| r.value32().map(|it| it.collect()))
            .unwrap_or_default()
    }

    /// Read a property as raw bytes (string values).
    fn prop_bytes(conn: &RustConnection, win: Window, prop: u32) -> Vec<u8> {
        conn.get_property(false, win, prop, AtomEnum::ANY, 0, u32::MAX)
            .ok()
            .and_then(|c| c.reply().ok())
            .map(|r| r.value)
            .unwrap_or_default()
    }

    /// Window title: _NET_WM_NAME (UTF-8) preferred, WM_NAME (Latin-1) fallback.
    fn window_title(x: &X11, win: Window) -> String {
        let utf8 = prop_bytes(&x.conn, win, x.atoms.wm_name);
        if !utf8.is_empty() {
            return String::from_utf8_lossy(&utf8).into_owned();
        }
        let legacy = prop_bytes(&x.conn, win, AtomEnum::WM_NAME.into());
        String::from_utf8_lossy(&legacy).into_owned()
    }

    /// WM_CLASS is two NUL-terminated strings: instance then class. We want the
    /// class (second), matching how the Windows side reports GetClassNameW.
    fn window_class(x: &X11, win: Window) -> String {
        let raw = prop_bytes(&x.conn, win, AtomEnum::WM_CLASS.into());
        let mut parts = raw.split(|&b| b == 0).filter(|s| !s.is_empty());
        let _instance = parts.next();
        parts
            .next()
            .map(|c| String::from_utf8_lossy(c).into_owned())
            .unwrap_or_default()
    }

    /// Executable name for a window via _NET_WM_PID + /proc/<pid>/comm, lowercased.
    fn window_process(x: &X11, win: Window) -> String {
        let Some(&pid) = prop_u32(&x.conn, win, x.atoms.wm_pid).first() else {
            return String::new();
        };
        std::fs::read_to_string(format!("/proc/{pid}/comm"))
            .map(|s| s.trim().to_lowercase())
            .unwrap_or_default()
    }

    /// Absolute screen rect of a window's client area. get_geometry gives size
    /// but parent-relative coords (the WM reparents into a frame), so we
    /// translate the origin into root coordinates for the true position.
    fn window_rect(x: &X11, win: Window) -> Result<(i32, i32, i32, i32), String> {
        let geo = x
            .conn
            .get_geometry(win)
            .map_err(|e| format!("get_geometry request failed: {e}"))?
            .reply()
            .map_err(|e| format!("get_geometry failed: {e}"))?;
        let t = x
            .conn
            .translate_coordinates(win, x.root, 0, 0)
            .map_err(|e| format!("translate_coordinates request failed: {e}"))?
            .reply()
            .map_err(|e| format!("translate_coordinates failed: {e}"))?;
        Ok((t.dst_x as i32, t.dst_y as i32, geo.width as i32, geo.height as i32))
    }

    /// Send a 32-bit EWMH client message to the root window with the
    /// substructure masks WMs listen on.
    fn root_message(x: &X11, win: Window, type_: u32, data: [u32; 5]) -> Result<(), String> {
        let event = ClientMessageEvent::new(32, win, type_, data);
        x.conn
            .send_event(
                false,
                x.root,
                EventMask::SUBSTRUCTURE_NOTIFY | EventMask::SUBSTRUCTURE_REDIRECT,
                event,
            )
            .map_err(|e| format!("send_event failed: {e}"))?;
        x.conn.flush().map_err(|e| format!("flush failed: {e}"))
    }

    /// _NET_WM_STATE add(1)/remove(0)/toggle(2) of up to two state atoms.
    /// source indication = 1 (normal application).
    fn set_state(x: &X11, win: Window, action: u32, a: u32, b: u32) -> Result<(), String> {
        root_message(x, win, x.atoms.wm_state, [action, a, b, 1, 0])
    }

    impl WindowManager for NativeWindowManager {
        fn list_windows(&self) -> Result<Vec<WindowInfo>, String> {
            let x = connect()?;
            // Prefer stacking order (bottom→top) so we can reverse to the
            // top-down z-order the trait promises; fall back to _NET_CLIENT_LIST.
            let mut stacked = true;
            let mut ids = prop_u32(&x.conn, x.root, x.atoms.client_list_stacking);
            if ids.is_empty() {
                stacked = false;
                ids = prop_u32(&x.conn, x.root, x.atoms.client_list);
            }
            if ids.is_empty() {
                return Err("WM exposes neither _NET_CLIENT_LIST_STACKING nor \
                    _NET_CLIENT_LIST — not EWMH-compliant, cannot enumerate windows"
                    .into());
            }
            if stacked {
                ids.reverse(); // stacking is bottom→top; we want top→bottom
            }
            let active = prop_u32(&x.conn, x.root, x.atoms.active_window)
                .first()
                .copied()
                .unwrap_or(0);
            let mut out = Vec::with_capacity(ids.len());
            for win in ids {
                // A window can vanish between listing and query; skip it rather
                // than fail the whole enumeration.
                let Ok(rect) = window_rect(&x, win) else { continue };
                out.push(WindowInfo {
                    id: win as u64,
                    title: window_title(&x, win),
                    class: window_class(&x, win),
                    process: window_process(&x, win),
                    focused: win == active,
                    rect,
                });
            }
            Ok(out)
        }

        fn monitors(&self) -> Result<Vec<MonitorInfo>, String> {
            let x = connect()?;
            // "Screen roots" fallback: report each X screen as one monitor.
            // True per-output work areas need RandR CRTC queries, but the
            // x11rb `randr` feature is not enabled in Cargo.toml (owned by
            // another task, off-limits here). So a multi-head setup sharing one
            // X screen reads as a single large monitor. resolve_rect / percent
            // sizing still work against it; only monitor-N granularity is lost.
            let mut mons: Vec<MonitorInfo> = x
                .conn
                .setup()
                .roots
                .iter()
                .map(|s| MonitorInfo {
                    x: 0,
                    y: 0,
                    w: s.width_in_pixels as i32,
                    h: s.height_in_pixels as i32,
                })
                .collect();
            if mons.is_empty() {
                return Err("no X screens reported".into());
            }
            mons.sort_by_key(|m| (m.x, m.y));
            Ok(mons)
        }

        fn focus(&self, id: u64) -> Result<(), String> {
            let x = connect()?;
            // source=1 (app), timestamp=0 (CurrentTime), requestor=0.
            root_message(&x, id as u32, x.atoms.active_window, [1, 0, 0, 0, 0])
        }

        fn move_resize(&self, id: u64, x_: i32, y: i32, w: i32, h: i32) -> Result<(), String> {
            let x = connect()?;
            // flags: gravity 0 (WM default) | x,y,w,h all supplied (bits 8-11) |
            // source app (bit 12) = 0x1F00. _NET_MOVERESIZE_WINDOW positions the
            // client correctly regardless of frame decorations.
            let flags = (1u32 << 8) | (1 << 9) | (1 << 10) | (1 << 11) | (1 << 12);
            root_message(
                &x,
                id as u32,
                x.atoms.moveresize_window,
                [flags, x_ as u32, y as u32, w as u32, h as u32],
            )
        }

        fn minimize(&self, id: u64) -> Result<(), String> {
            let x = connect()?;
            // ICCCM WM_CHANGE_STATE → IconicState (3). EWMH has no minimize atom.
            root_message(&x, id as u32, x.atoms.wm_change_state, [3, 0, 0, 0, 0])
        }

        fn maximize(&self, id: u64) -> Result<(), String> {
            let x = connect()?;
            set_state(&x, id as u32, 1, x.atoms.state_max_vert, x.atoms.state_max_horz)
        }

        fn restore(&self, id: u64) -> Result<(), String> {
            let x = connect()?;
            // Un-maximize, then activate to also lift it out of the iconified state.
            set_state(&x, id as u32, 0, x.atoms.state_max_vert, x.atoms.state_max_horz)?;
            root_message(&x, id as u32, x.atoms.active_window, [1, 0, 0, 0, 0])
        }

        fn close(&self, id: u64) -> Result<(), String> {
            let x = connect()?;
            // timestamp=0, source=1 (app).
            root_message(&x, id as u32, x.atoms.close_window, [0, 1, 0, 0, 0])
        }

        fn always_on_top(&self, id: u64) -> Result<bool, String> {
            let x = connect()?;
            let states = prop_u32(&x.conn, id as u32, x.atoms.wm_state);
            Ok(states.contains(&x.atoms.state_above))
        }

        fn set_always_on_top(&self, id: u64, on: bool) -> Result<(), String> {
            let x = connect()?;
            let action = if on { 1 } else { 0 };
            set_state(&x, id as u32, action, x.atoms.state_above, 0)
        }

        fn set_transparency(&self, id: u64, alpha: u8) -> Result<(), String> {
            let x = connect()?;
            // _NET_WM_WINDOW_OPACITY is a CARDINAL where u32::MAX = fully opaque.
            // Requires a running compositor; without one the property is ignored.
            let opacity = ((alpha as u64 * u32::MAX as u64) / 255) as u32;
            x.conn
                .change_property32(
                    PropMode::REPLACE,
                    id as u32,
                    x.atoms.wm_window_opacity,
                    AtomEnum::CARDINAL,
                    &[opacity],
                )
                .map_err(|e| format!("set opacity request failed: {e}"))?;
            x.conn.flush().map_err(|e| format!("flush failed: {e}"))
        }
    }
}

#[cfg(test)]
pub mod test_support {
    use super::*;
    use std::sync::{Arc, Mutex};

    /// Fake backend: fixed window list, records mutations as strings.
    pub struct FakeWm {
        pub windows: Vec<WindowInfo>,
        pub monitors: Vec<MonitorInfo>,
        pub calls: Arc<Mutex<Vec<String>>>,
    }

    pub fn win(id: u64, title: &str, class: &str, process: &str, focused: bool) -> WindowInfo {
        WindowInfo {
            id,
            title: title.into(),
            class: class.into(),
            process: process.into(),
            focused,
            rect: (10, 20, 300, 200),
        }
    }

    impl Default for FakeWm {
        fn default() -> Self {
            FakeWm {
                windows: vec![
                    win(1, "readme.txt - Notepad", "Notepad", "notepad.exe", false),
                    win(2, "KeyForge", "glfw", "keyforge.exe", true),
                ],
                monitors: vec![MonitorInfo { x: 0, y: 0, w: 1920, h: 1080 }],
                calls: Arc::default(),
            }
        }
    }

    impl FakeWm {
        fn record(&self, call: String) -> Result<(), String> {
            self.calls.lock().unwrap().push(call);
            Ok(())
        }
    }

    impl WindowManager for FakeWm {
        fn list_windows(&self) -> Result<Vec<WindowInfo>, String> {
            Ok(self.windows.clone())
        }
        fn monitors(&self) -> Result<Vec<MonitorInfo>, String> {
            Ok(self.monitors.clone())
        }
        fn focus(&self, id: u64) -> Result<(), String> {
            self.record(format!("focus {id}"))
        }
        fn move_resize(&self, id: u64, x: i32, y: i32, w: i32, h: i32) -> Result<(), String> {
            self.record(format!("move_resize {id} {x},{y} {w}x{h}"))
        }
        fn minimize(&self, id: u64) -> Result<(), String> {
            self.record(format!("minimize {id}"))
        }
        fn maximize(&self, id: u64) -> Result<(), String> {
            self.record(format!("maximize {id}"))
        }
        fn restore(&self, id: u64) -> Result<(), String> {
            self.record(format!("restore {id}"))
        }
        fn close(&self, id: u64) -> Result<(), String> {
            self.record(format!("close {id}"))
        }
        fn always_on_top(&self, _: u64) -> Result<bool, String> {
            Ok(false)
        }
        fn set_always_on_top(&self, id: u64, on: bool) -> Result<(), String> {
            self.record(format!("set_always_on_top {id} {on}"))
        }
        fn set_transparency(&self, id: u64, alpha: u8) -> Result<(), String> {
            self.record(format!("set_transparency {id} {alpha}"))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::win;
    use super::*;

    fn windows() -> Vec<WindowInfo> {
        vec![
            win(1, "readme.txt - Notepad", "Notepad", "notepad.exe", false),
            win(2, "Mozilla Firefox", "MozillaWindowClass", "firefox.exe", true),
            win(3, "notes - Notepad", "Notepad", "notepad.exe", false),
        ]
    }

    #[test]
    fn selector_matching() {
        let wins = windows();
        let first = |sel: &WindowSelector| find_first(sel, &wins).map(|w| w.id);

        assert_eq!(first(&WindowSelector::Focused), Some(2));
        assert_eq!(
            first(&WindowSelector::Title { mode: TitleMatch::Contains, value: "NOTEPAD".into() }),
            Some(1) // topmost match wins
        );
        assert_eq!(
            first(&WindowSelector::Title { mode: TitleMatch::Exact, value: "notes - Notepad".into() }),
            Some(3)
        );
        assert_eq!(
            first(&WindowSelector::Title { mode: TitleMatch::Regex, value: r"^notes.*Notepad$".into() }),
            Some(3)
        );
        assert_eq!(first(&WindowSelector::Process { name: "Notepad".into() }), Some(1));
        assert_eq!(first(&WindowSelector::Process { name: "firefox.exe".into() }), Some(2));
        assert_eq!(first(&WindowSelector::Class { name: "mozillawindowclass".into() }), Some(2));
        assert_eq!(first(&WindowSelector::Process { name: "ghost".into() }), None);
        // invalid regex matches nothing rather than erroring the whole list
        assert_eq!(
            first(&WindowSelector::Title { mode: TitleMatch::Regex, value: "(".into() }),
            None
        );
    }

    #[test]
    fn selector_serde() {
        let sel: WindowSelector =
            serde_json::from_str(r#"{"by": "title", "value": "Notepad"}"#).unwrap();
        assert_eq!(sel, WindowSelector::Title { mode: TitleMatch::Contains, value: "Notepad".into() });
        let sel: WindowSelector = serde_json::from_str(r#"{"by": "focused"}"#).unwrap();
        assert_eq!(sel, WindowSelector::Focused);
    }

    #[test]
    fn dims_and_rect_resolution() {
        assert_eq!(parse_dim(&serde_json::json!(120)).unwrap(), Dim::Px(120));
        assert_eq!(parse_dim(&serde_json::json!("25%")).unwrap(), Dim::Pct(25.0));
        assert_eq!(parse_dim(&serde_json::json!("120")).unwrap(), Dim::Px(120));
        assert!(parse_dim(&serde_json::json!(true)).is_err());

        let mon = MonitorInfo { x: 1920, y: 0, w: 1000, h: 800 };
        let rect = resolve_rect(
            (5, 6, 7, 8),
            &mon,
            Some(Dim::Pct(10.0)),
            Some(Dim::Px(50)),
            Some(Dim::Pct(50.0)),
            None,
        );
        // x: monitor origin + 10% of width; w: 50% of width; h kept (min-clamped)
        assert_eq!(rect, (2020, 50, 500, 50));
    }

    #[test]
    fn monitor_containment() {
        let mons = [
            MonitorInfo { x: 0, y: 0, w: 1920, h: 1080 },
            MonitorInfo { x: 1920, y: 0, w: 1920, h: 1080 },
        ];
        assert_eq!(monitor_for((2000, 100, 400, 300), &mons), Some(mons[1]));
        assert_eq!(monitor_for((100, 100, 400, 300), &mons), Some(mons[0]));
        // off-screen falls back to first
        assert_eq!(monitor_for((-5000, -5000, 10, 10), &mons), Some(mons[0]));
    }
}
