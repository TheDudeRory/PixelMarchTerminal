//! OS-cursor text insertion — ported verbatim from VoiceMarch `insert.rs`.
//! `paste` (default) is instant and Unicode-safe; `type` is a per-key fallback
//! for apps that block clipboard paste. Used to drop a finished transcript at the
//! focused app's caret (honouring the `insertion` setting) instead of only the
//! host terminal. Deps (enigo + arboard) are unconditional in Cargo.toml.

use enigo::{Direction, Enigo, Key, Keyboard, Settings};

/// Insert text at the OS cursor of the focused app.
pub fn insert(text: &str, mode: &str) {
    if text.is_empty() {
        return;
    }
    if mode == "type" {
        type_text(text);
    } else {
        paste(text);
    }
}

fn paste(text: &str) {
    // Set the clipboard, remembering the previous contents to restore.
    let previous = match arboard::Clipboard::new() {
        Ok(mut cb) => {
            let prev = cb.get_text().ok();
            if let Err(e) = cb.set_text(text.to_owned()) {
                eprintln!("voice: clipboard set failed: {e}");
                return;
            }
            prev
        }
        Err(e) => {
            eprintln!("voice: clipboard open failed: {e}");
            return;
        }
    };

    // Ctrl+V into the focused window.
    match Enigo::new(&Settings::default()) {
        Ok(mut enigo) => {
            let _ = enigo.key(Key::Control, Direction::Press);
            let _ = enigo.key(Key::Unicode('v'), Direction::Click);
            let _ = enigo.key(Key::Control, Direction::Release);
        }
        Err(e) => eprintln!("voice: input backend failed: {e}"),
    }

    // Restore the user's clipboard once the paste has been consumed.
    if let Some(prev) = previous {
        std::thread::sleep(std::time::Duration::from_millis(120));
        if let Ok(mut cb) = arboard::Clipboard::new() {
            let _ = cb.set_text(prev);
        }
    }
}

fn type_text(text: &str) {
    let Ok(mut enigo) = Enigo::new(&Settings::default()) else {
        return;
    };
    // Type char-by-char with a small gap instead of enigo.text(), which fires the
    // whole string in one zero-delay SendInput burst — some apps (VS Code/Chromium,
    // Notepad) receive those synthetic WM_CHARs out of order ("How" -> "wHo"). A
    // per-key gap serializes delivery. VM_TYPE_DELAY_MS tunes it (raise if an app
    // still reorders; 0 to disable).
    let delay = std::env::var("VM_TYPE_DELAY_MS")
        .ok()
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(2);
    for ch in text.chars() {
        // Newlines/tabs become real keystrokes. Other chars go through text() (one
        // char = one SendInput), NOT key(Key::Unicode): the latter maps via
        // VkKeyScan and drops Shift, so capitals come out lowercase. text() injects
        // the raw codepoint and keeps case.
        let mut buf = [0u8; 4];
        let _ = match ch {
            '\n' => enigo.key(Key::Return, Direction::Click),
            '\t' => enigo.key(Key::Tab, Direction::Click),
            _ => enigo.text(ch.encode_utf8(&mut buf)),
        };
        if delay > 0 {
            std::thread::sleep(std::time::Duration::from_millis(delay));
        }
    }
}
