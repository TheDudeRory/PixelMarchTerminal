// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let args: Vec<String> = std::env::args().collect();
    // `--host`: run as the detached PTY session host (no GUI). Same exe, so the
    // app stays a single portable binary.
    let is_host = args.iter().any(|a| a == "--host");

    // Portable webview state: WebKitGTK builds its cache/storage path from
    // XDG_DATA_HOME / XDG_CACHE_HOME + the bundle identifier, so a default run
    // creates ~/.local/share/io.pixelmarch.pixelmarch/ that nothing in our code
    // asked for. Point those at <repo>/data/webview instead, BEFORE GTK/WebKit
    // initialise. The host process is the mirror image: it inherits the GUI's
    // redirect, owns no webview, and every PTY shell copies its environment —
    // so it restores the user's original XDG paths instead.
    #[cfg(target_os = "linux")]
    if is_host {
        pixelmarch_lib::restore_inherited_webview_env();
    } else {
        pixelmarch_lib::redirect_webview_state();
    }

    // WebKitGTK 2.52 + the appindicator tray under Wayland dies with "Error 71
    // (Protocol error) dispatching to Wayland display" before the window ever
    // shows. Run through XWayland and skip the DMA-BUF renderer, which is the
    // other half of the crash on Mesa. Must happen before GTK initialises.
    //
    // CONSEQUENCE: X11 or XWayland is REQUIRED — on a pure-Wayland system with
    // no XWayland the app cannot start. Set GDK_BACKEND yourself to override
    // (both are only applied when unset). macros/window.rs and macros/sys.rs are
    // X11-only for the same reason. See docs/linux.md.
    #[cfg(target_os = "linux")]
    {
        if std::env::var_os("GDK_BACKEND").is_none() {
            std::env::set_var("GDK_BACKEND", "x11");
        }
        if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
            std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        }
    }

    if is_host {
        pixelmarch_lib::run_host();
        return;
    }
    // `--await-exit <pid>`: this launch is a self-update relaunch — wait for the
    // previous GUI to fully exit before starting, so we don't race its
    // single-instance lock / host handoff (that left reattached terminals blank).
    if let Some(i) = args.iter().position(|a| a == "--await-exit") {
        if let Some(pid) = args.get(i + 1).and_then(|s| s.parse::<u32>().ok()) {
            pixelmarch_lib::await_previous_exit(pid);
        }
    }
    pixelmarch_lib::run()
}
