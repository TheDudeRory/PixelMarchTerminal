use crate::macros::model::{MouseButton, ScrollDirection};
use std::sync::Mutex;

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Dir {
    Press,
    Release,
    Click,
}

/// OS input injection. enigo covers both target OSes; the trait exists so the
/// executor and held-input tracking are testable against a recording fake.
pub trait InputSimulator: Send {
    fn key(&mut self, key: enigo::Key, dir: Dir) -> Result<(), String>;
    fn text(&mut self, text: &str) -> Result<(), String>;
    fn button(&mut self, button: MouseButton, dir: Dir) -> Result<(), String>;
    fn move_mouse(&mut self, x: i32, y: i32, relative: bool) -> Result<(), String>;
    fn scroll(&mut self, direction: ScrollDirection, amount: i32) -> Result<(), String>;
}

// ------------------------------------------------------------------ parsing

/// One key token ("Ctrl", "F5", "K", "MediaPlayPause") → enigo key. Tokens match
/// what the capture widget and the key picker emit (src/lib/keys.ts);
/// case-insensitive. Spellings are chosen so the same token also parses on the
/// global-hotkey side, which lets one picker serve both.
pub fn parse_key_token(token: &str) -> Result<enigo::Key, String> {
    use enigo::Key::*;
    let t = token.trim();
    if t.chars().count() == 1 {
        // Letters lowercase: uppercase Unicode implies Shift on some platforms.
        return Ok(Unicode(t.chars().next().unwrap().to_ascii_lowercase()));
    }
    Ok(match t.to_uppercase().as_str() {
        "CTRL" | "CONTROL" => Control,
        "ALT" | "OPTION" => Alt,
        "SHIFT" => Shift,
        "SUPER" | "WIN" | "CMD" | "COMMAND" | "META" => Meta,
        "ENTER" | "RETURN" => Return,
        "SPACE" => Space,
        "TAB" => Tab,
        "ESCAPE" | "ESC" => Escape,
        "BACKSPACE" => Backspace,
        "DELETE" | "DEL" => Delete,
        "INSERT" => Insert,
        "HOME" => Home,
        "END" => End,
        "PAGEUP" => PageUp,
        "PAGEDOWN" => PageDown,
        "UP" | "ARROWUP" => UpArrow,
        "DOWN" | "ARROWDOWN" => DownArrow,
        "LEFT" | "ARROWLEFT" => LeftArrow,
        "RIGHT" | "ARROWRIGHT" => RightArrow,
        "CAPSLOCK" => CapsLock,
        "NUMLOCK" => Numlock,
        "PAUSE" | "PAUSEBREAK" => Pause,
        "PRINTSCREEN" | "PRINTSCR" => PrintScr,
        #[cfg(target_os = "windows")]
        "SCROLLLOCK" => Scroll,
        #[cfg(all(unix, not(target_os = "macos")))]
        "SCROLLLOCK" => ScrollLock,
        "F1" => F1, "F2" => F2, "F3" => F3, "F4" => F4, "F5" => F5, "F6" => F6,
        "F7" => F7, "F8" => F8, "F9" => F9, "F10" => F10, "F11" => F11, "F12" => F12,
        "F13" => F13, "F14" => F14, "F15" => F15, "F16" => F16, "F17" => F17, "F18" => F18,
        "F19" => F19, "F20" => F20, "F21" => F21, "F22" => F22, "F23" => F23, "F24" => F24,
        // Media / volume keys: the reason the picker exists — most keyboards
        // cannot generate these, so they can never be recorded.
        "MEDIAPLAYPAUSE" | "PLAYPAUSE" => MediaPlayPause,
        "MEDIASTOP" => MediaStop,
        "MEDIATRACKNEXT" | "MEDIANEXTTRACK" | "NEXTTRACK" => MediaNextTrack,
        "MEDIATRACKPREV" | "MEDIATRACKPREVIOUS" | "MEDIAPREVTRACK" | "PREVTRACK" => MediaPrevTrack,
        "AUDIOVOLUMEUP" | "VOLUMEUP" => VolumeUp,
        "AUDIOVOLUMEDOWN" | "VOLUMEDOWN" => VolumeDown,
        "AUDIOVOLUMEMUTE" | "VOLUMEMUTE" => VolumeMute,
        // Numpad — distinct from the number row, and only reachable via the
        // picker when NumLock is off or the board has no numpad at all.
        "NUMPAD0" | "NUM0" => Numpad0,
        "NUMPAD1" | "NUM1" => Numpad1,
        "NUMPAD2" | "NUM2" => Numpad2,
        "NUMPAD3" | "NUM3" => Numpad3,
        "NUMPAD4" | "NUM4" => Numpad4,
        "NUMPAD5" | "NUM5" => Numpad5,
        "NUMPAD6" | "NUM6" => Numpad6,
        "NUMPAD7" | "NUM7" => Numpad7,
        "NUMPAD8" | "NUM8" => Numpad8,
        "NUMPAD9" | "NUM9" => Numpad9,
        "NUMPADADD" | "NUMADD" | "NUMPADPLUS" => Add,
        "NUMPADSUBTRACT" | "NUMSUBTRACT" => Subtract,
        "NUMPADMULTIPLY" | "NUMMULTIPLY" => Multiply,
        "NUMPADDIVIDE" | "NUMDIVIDE" => Divide,
        "NUMPADDECIMAL" | "NUMDECIMAL" => Decimal,
        // enigo has no separate numpad Enter; the OS treats both as Return.
        "NUMPADENTER" | "NUMENTER" => Return,
        "PLUS" => Unicode('+'),
        "MINUS" => Unicode('-'),
        "PERIOD" => Unicode('.'),
        "COMMA" => Unicode(','),
        "SLASH" => Unicode('/'),
        "BACKSLASH" => Unicode('\\'),
        "SEMICOLON" => Unicode(';'),
        "QUOTE" => Unicode('\''),
        "EQUAL" | "EQUALS" => Unicode('='),
        "BRACKETLEFT" | "OPENBRACKET" => Unicode('['),
        "BRACKETRIGHT" | "CLOSEBRACKET" => Unicode(']'),
        "BACKQUOTE" | "BACKTICK" => Unicode('`'),
        other => return Err(format!("unknown key: {other}")),
    })
}

/// "Ctrl+Shift+T" → [Control, Shift, Unicode('t')]
pub fn parse_combo(combo: &str) -> Result<Vec<enigo::Key>, String> {
    let keys: Vec<enigo::Key> = combo
        .split('+')
        .filter(|s| !s.trim().is_empty())
        .map(parse_key_token)
        .collect::<Result<_, _>>()?;
    if keys.is_empty() {
        return Err(format!("empty key combo: {combo:?}"));
    }
    Ok(keys)
}

// -------------------------------------------------------------------- enigo

pub struct EnigoSimulator(enigo::Enigo);

impl EnigoSimulator {
    pub fn new() -> Result<Self, String> {
        enigo::Enigo::new(&enigo::Settings::default())
            .map(Self)
            .map_err(|e| e.to_string())
    }
}

fn enigo_dir(dir: Dir) -> enigo::Direction {
    match dir {
        Dir::Press => enigo::Direction::Press,
        Dir::Release => enigo::Direction::Release,
        Dir::Click => enigo::Direction::Click,
    }
}

fn enigo_button(button: MouseButton) -> enigo::Button {
    match button {
        MouseButton::Left => enigo::Button::Left,
        MouseButton::Right => enigo::Button::Right,
        MouseButton::Middle => enigo::Button::Middle,
    }
}

impl InputSimulator for EnigoSimulator {
    fn key(&mut self, key: enigo::Key, dir: Dir) -> Result<(), String> {
        enigo::Keyboard::key(&mut self.0, key, enigo_dir(dir)).map_err(|e| e.to_string())
    }

    fn text(&mut self, text: &str) -> Result<(), String> {
        enigo::Keyboard::text(&mut self.0, text).map_err(|e| e.to_string())
    }

    fn button(&mut self, button: MouseButton, dir: Dir) -> Result<(), String> {
        enigo::Mouse::button(&mut self.0, enigo_button(button), enigo_dir(dir))
            .map_err(|e| e.to_string())
    }

    fn move_mouse(&mut self, x: i32, y: i32, relative: bool) -> Result<(), String> {
        let coord = if relative { enigo::Coordinate::Rel } else { enigo::Coordinate::Abs };
        enigo::Mouse::move_mouse(&mut self.0, x, y, coord).map_err(|e| e.to_string())
    }

    fn scroll(&mut self, direction: ScrollDirection, amount: i32) -> Result<(), String> {
        let (len, axis) = match direction {
            ScrollDirection::Up => (-amount, enigo::Axis::Vertical),
            ScrollDirection::Down => (amount, enigo::Axis::Vertical),
            ScrollDirection::Left => (-amount, enigo::Axis::Horizontal),
            ScrollDirection::Right => (amount, enigo::Axis::Horizontal),
        };
        enigo::Mouse::scroll(&mut self.0, len, axis).map_err(|e| e.to_string())
    }
}

// ------------------------------------------------------- held-input tracking

// Only keys are tracked: buttons are always pressed+released atomically under a
// single sim lock (click/drag), so they can never be left held across e-stop.
#[derive(Debug, Clone, Copy, PartialEq)]
enum Held {
    Key(enigo::Key),
}

/// Serializes all injection through one lock and tracks held keys/buttons so
/// the emergency stop can release them — a macro that dies holding Ctrl must
/// not leave the machine unusable.
pub struct Inputs {
    sim: Mutex<Result<Box<dyn InputSimulator>, String>>,
    held: Mutex<Vec<Held>>,
}

impl Inputs {
    pub fn new() -> Inputs {
        let sim = EnigoSimulator::new().map(|s| Box::new(s) as Box<dyn InputSimulator>);
        if let Err(e) = &sim {
            tracing::error!(error = e, "input simulator unavailable; input steps will fail");
        }
        Inputs { sim: Mutex::new(sim), held: Mutex::new(Vec::new()) }
    }

    pub fn with_backend(sim: Box<dyn InputSimulator>) -> Inputs {
        Inputs { sim: Mutex::new(Ok(sim)), held: Mutex::new(Vec::new()) }
    }

    fn with_sim<R>(
        &self,
        f: impl FnOnce(&mut dyn InputSimulator) -> Result<R, String>,
    ) -> Result<R, String> {
        match &mut *self.sim.lock().unwrap() {
            Ok(sim) => f(sim.as_mut()),
            Err(e) => Err(format!("input simulator unavailable: {e}")),
        }
    }

    /// Press every key in order, release in reverse — atomic under the lock,
    /// so a concurrent emergency stop can never observe a half-sent combo.
    pub fn send_combo(&self, combo: &str) -> Result<(), String> {
        let keys = parse_combo(combo)?;
        self.with_sim(|sim| {
            let mut pressed: Vec<enigo::Key> = Vec::new();
            let mut result = Ok(());
            for key in &keys {
                if let Err(e) = sim.key(*key, Dir::Press) {
                    result = Err(e);
                    break;
                }
                pressed.push(*key);
            }
            for key in pressed.iter().rev() {
                if let (Err(e), Ok(())) = (sim.key(*key, Dir::Release), &result) {
                    result = Err(e);
                }
            }
            result
        })
    }

    pub fn hold_key(&self, token: &str) -> Result<(), String> {
        let key = parse_key_token(token)?;
        self.with_sim(|sim| sim.key(key, Dir::Press))?;
        self.held.lock().unwrap().push(Held::Key(key));
        Ok(())
    }

    pub fn release_key(&self, token: &str) -> Result<(), String> {
        let key = parse_key_token(token)?;
        self.with_sim(|sim| sim.key(key, Dir::Release))?;
        let mut held = self.held.lock().unwrap();
        if let Some(pos) = held.iter().rposition(|h| *h == Held::Key(key)) {
            held.remove(pos);
        }
        Ok(())
    }

    pub fn type_text(&self, text: &str) -> Result<(), String> {
        self.with_sim(|sim| sim.text(text))
    }

    pub fn click(&self, button: MouseButton, double: bool) -> Result<(), String> {
        self.with_sim(|sim| {
            sim.button(button, Dir::Click)?;
            if double {
                sim.button(button, Dir::Click)?;
            }
            Ok(())
        })
    }

    pub fn mouse_move(&self, x: i32, y: i32, relative: bool) -> Result<(), String> {
        self.with_sim(|sim| sim.move_mouse(x, y, relative))
    }

    pub fn drag(&self, from: (i32, i32), to: (i32, i32), button: MouseButton) -> Result<(), String> {
        self.with_sim(|sim| {
            sim.move_mouse(from.0, from.1, false)?;
            sim.button(button, Dir::Press)?;
            let result = sim.move_mouse(to.0, to.1, false);
            let released = sim.button(button, Dir::Release);
            result.and(released)
        })
    }

    pub fn scroll(&self, direction: ScrollDirection, amount: i32) -> Result<(), String> {
        self.with_sim(|sim| sim.scroll(direction, amount))
    }

    /// Emergency-stop hook: best-effort release of everything held, newest first.
    pub fn release_all(&self) -> usize {
        let held: Vec<Held> = {
            let mut held = self.held.lock().unwrap();
            held.drain(..).rev().collect()
        };
        if held.is_empty() {
            return 0;
        }
        let count = held.len();
        let _ = self.with_sim(|sim| {
            for h in held {
                let Held::Key(key) = h;
                let result = sim.key(key, Dir::Release);
                if let Err(e) = result {
                    tracing::error!(held = ?h, error = e, "failed to release held input");
                }
            }
            Ok(())
        });
        tracing::warn!(count, "released held inputs");
        count
    }
}

#[cfg(test)]
pub mod test_support {
    use super::*;
    use std::sync::{Arc, Mutex};

    /// Records every injection as a readable string.
    #[derive(Default)]
    pub struct RecordingSim(pub Arc<Mutex<Vec<String>>>);

    impl RecordingSim {
        pub fn new() -> (Box<dyn InputSimulator>, Arc<Mutex<Vec<String>>>) {
            let events: Arc<Mutex<Vec<String>>> = Arc::default();
            (Box::new(RecordingSim(Arc::clone(&events))), events)
        }
    }

    impl InputSimulator for RecordingSim {
        fn key(&mut self, key: enigo::Key, dir: Dir) -> Result<(), String> {
            self.0.lock().unwrap().push(format!("key {key:?} {dir:?}"));
            Ok(())
        }
        fn text(&mut self, text: &str) -> Result<(), String> {
            self.0.lock().unwrap().push(format!("text {text:?}"));
            Ok(())
        }
        fn button(&mut self, button: MouseButton, dir: Dir) -> Result<(), String> {
            self.0.lock().unwrap().push(format!("button {button:?} {dir:?}"));
            Ok(())
        }
        fn move_mouse(&mut self, x: i32, y: i32, relative: bool) -> Result<(), String> {
            let kind = if relative { "rel" } else { "abs" };
            self.0.lock().unwrap().push(format!("move {kind} {x},{y}"));
            Ok(())
        }
        fn scroll(&mut self, direction: ScrollDirection, amount: i32) -> Result<(), String> {
            self.0.lock().unwrap().push(format!("scroll {direction:?} {amount}"));
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::RecordingSim;
    use super::*;
    use enigo::Key;

    #[test]
    fn parse_combos() {
        assert_eq!(
            parse_combo("Ctrl+Shift+T").unwrap(),
            vec![Key::Control, Key::Shift, Key::Unicode('t')]
        );
        assert_eq!(parse_combo("F5").unwrap(), vec![Key::F5]);
        assert_eq!(parse_combo("ctrl+alt+End").unwrap(), vec![Key::Control, Key::Alt, Key::End]);
        assert_eq!(parse_key_token("Minus").unwrap(), Key::Unicode('-'));
        assert!(parse_combo("Ctrl+Wibble").is_err());
        assert!(parse_combo("").is_err());
    }

    // Every token the picker (src/lib/keys.ts) can emit must parse here, or the
    // step fails only once the user runs it.
    #[test]
    fn parses_picker_only_tokens() {
        assert_eq!(parse_key_token("MediaPlayPause").unwrap(), Key::MediaPlayPause);
        assert_eq!(parse_key_token("MediaTrackNext").unwrap(), Key::MediaNextTrack);
        assert_eq!(parse_key_token("MediaTrackPrev").unwrap(), Key::MediaPrevTrack);
        assert_eq!(parse_key_token("MediaStop").unwrap(), Key::MediaStop);
        assert_eq!(parse_key_token("AudioVolumeUp").unwrap(), Key::VolumeUp);
        assert_eq!(parse_key_token("AudioVolumeDown").unwrap(), Key::VolumeDown);
        assert_eq!(parse_key_token("AudioVolumeMute").unwrap(), Key::VolumeMute);
        assert_eq!(parse_key_token("F13").unwrap(), Key::F13);
        assert_eq!(parse_key_token("F24").unwrap(), Key::F24);
        assert_eq!(parse_key_token("Numpad7").unwrap(), Key::Numpad7);
        assert_eq!(parse_key_token("NumpadAdd").unwrap(), Key::Add);
        assert_eq!(parse_key_token("NumpadEnter").unwrap(), Key::Return);
        assert_eq!(parse_key_token("PrintScreen").unwrap(), Key::PrintScr);
        assert_eq!(parse_key_token("NumLock").unwrap(), Key::Numlock);
        assert_eq!(parse_key_token("Pause").unwrap(), Key::Pause);
        assert!(parse_key_token("ScrollLock").is_ok());
        // combos too: a modifier plus a key nothing on the board can press
        assert_eq!(
            parse_combo("Ctrl+MediaPlayPause").unwrap(),
            vec![Key::Control, Key::MediaPlayPause]
        );
        assert!(parse_combo("").is_err());
    }

    #[test]
    fn combo_presses_in_order_releases_reversed() {
        let (sim, events) = RecordingSim::new();
        let inputs = Inputs::with_backend(sim);
        inputs.send_combo("Ctrl+Shift+T").unwrap();
        assert_eq!(
            *events.lock().unwrap(),
            vec![
                "key Control Press",
                "key Shift Press",
                "key Unicode('t') Press",
                "key Unicode('t') Release",
                "key Shift Release",
                "key Control Release",
            ]
        );
        // combos are balanced — nothing left held
        assert_eq!(inputs.release_all(), 0);
    }

    #[test]
    fn held_inputs_released_newest_first() {
        let (sim, events) = RecordingSim::new();
        let inputs = Inputs::with_backend(sim);
        inputs.hold_key("Shift").unwrap();
        inputs.hold_key("Ctrl").unwrap();
        inputs.hold_key("A").unwrap();
        inputs.release_key("Ctrl").unwrap();
        assert_eq!(inputs.release_all(), 2);
        let events = events.lock().unwrap();
        let tail: Vec<&str> = events.iter().rev().take(2).map(|s| s.as_str()).collect();
        // release_all releases 'a' then Shift (newest first); Ctrl already released
        assert_eq!(tail, vec!["key Shift Release", "key Unicode('a') Release"]);
        assert_eq!(inputs.release_all(), 0);
    }

    #[test]
    fn drag_sequence() {
        let (sim, events) = RecordingSim::new();
        let inputs = Inputs::with_backend(sim);
        inputs.drag((10, 20), (30, 40), MouseButton::Left).unwrap();
        assert_eq!(
            *events.lock().unwrap(),
            vec!["move abs 10,20", "button Left Press", "move abs 30,40", "button Left Release"]
        );
    }
}
