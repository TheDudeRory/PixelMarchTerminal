//! Desktop notifications (notify-rust). Extracted from the former KeyForge
//! project, which moved to a separate repository; the three lib.rs call sites
//! keep using it.

pub fn notify(title: &str, body: &str) -> Result<(), String> {
    notify_rust::Notification::new()
        .summary(if title.is_empty() { "PixelMarch" } else { title })
        .body(body)
        .appname("PixelMarch")
        .show()
        .map(|_| ())
        .map_err(|e| e.to_string())
}
