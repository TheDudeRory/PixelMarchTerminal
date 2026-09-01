//! Desktop notifications (notify-rust). Extracted verbatim from the former
//! KeyForge macro engine (src/macros/sys.rs), which moved to a separate
//! project; the three lib.rs call sites keep using it.

pub fn notify(title: &str, body: &str) -> Result<(), String> {
    notify_rust::Notification::new()
        .summary(if title.is_empty() { "KeyForge" } else { title })
        .body(body)
        .appname("KeyForge")
        .show()
        .map(|_| ())
        .map_err(|e| e.to_string())
}
