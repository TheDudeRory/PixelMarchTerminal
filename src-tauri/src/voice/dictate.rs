//! Dictation formatting — ported verbatim from VoiceMarch `dictate.rs`.
//! Two independent axes: spacing (how phrases join) and punctuation
//! (keep/strip/spoken). Compiled only under the `voice` feature.

use regex::Regex;
use std::sync::LazyLock;

/// Spoken-punctuation table, longest match first, case-insensitive.
static SPOKEN: LazyLock<Vec<(Regex, &'static str)>> = LazyLock::new(|| {
    vec![
        (Regex::new(r"(?i)\bnew paragraph\b").unwrap(), "\n\n"),
        (Regex::new(r"(?i)\b(?:new ?line|newline)\b").unwrap(), "\n"),
        (Regex::new(r"(?i)\bquestion mark\b").unwrap(), "?"),
        (Regex::new(r"(?i)\bexclamation (?:point|mark)\b").unwrap(), "!"),
        (Regex::new(r"(?i)\b(?:full stop|period)\b").unwrap(), "."),
        (Regex::new(r"(?i)\bcomma\b").unwrap(), ","),
        (Regex::new(r"(?i)\bsemicolon\b").unwrap(), ";"),
        (Regex::new(r"(?i)\bcolon\b").unwrap(), ":"),
        (Regex::new(r"(?i)\bopen (?:paren|parenthesis)\b").unwrap(), "("),
        (Regex::new(r"(?i)\bclose (?:paren|parenthesis)\b").unwrap(), ")"),
        (Regex::new(r"(?i)\bhyphen\b").unwrap(), "-"),
    ]
});

static TRAILING: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[\s.,!?;:]+$").unwrap());
static WHISPER_PUNCT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[.,!?;:]").unwrap());
static NO_SPACE_BEFORE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[ \t]+([.,!?;:)\n])").unwrap());
static NO_SPACE_AFTER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"([(\n])[ \t]+").unwrap());
static COLLAPSE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[ \t]{2,}").unwrap());

/// Apply the punctuation mode to a single transcribed phrase.
pub fn apply_punct(text: &str, mode: &str) -> String {
    match mode {
        "strip" => TRAILING.replace(text, "").into_owned(),
        "spoken" => {
            let mut t = WHISPER_PUNCT.replace_all(text, "").into_owned();
            for (rx, sym) in SPOKEN.iter() {
                t = rx.replace_all(&t, *sym).into_owned();
            }
            t = NO_SPACE_BEFORE.replace_all(&t, "$1").into_owned();
            t = NO_SPACE_AFTER.replace_all(&t, "$1").into_owned();
            COLLAPSE
                .replace_all(&t, " ")
                .trim_matches(|c: char| c == ' ' || c == '\t')
                .to_string()
        }
        _ => text.to_string(),
    }
}

/// True when the phrase's leading word is a plain common word whose initial
/// capital is only there because whisper capitalizes the first word of every
/// clip — so it's safe to lower-case when the phrase continues a sentence.
/// Returns false (preserve the capital) for anything whose capitalization is
/// meaningful: the pronoun "I" and its contractions, and acronyms / mixed-case
/// proper nouns (NASA, USA, iPhone, McDonald) that carry a second upper-case
/// letter. Genuine title-case proper nouns like "London" are indistinguishable
/// from an ordinary sentence-initial word and are (unavoidably) still lowered.
fn starts_lowercaseable(piece: &str) -> bool {
    let mut chars = piece.chars();
    match chars.next() {
        // Nothing to lower unless it starts with an upper-case letter.
        Some(c) if c.is_uppercase() => {}
        _ => return false,
    }
    // Leading word = run of letters and apostrophes (straight or curly).
    let word: String = piece
        .chars()
        .take_while(|c| c.is_alphabetic() || *c == '\'' || *c == '\u{2019}')
        .collect();
    // Pronoun "I" / "I'm" / "I'll" / ...
    if word == "I" || word.starts_with("I'") || word.starts_with("I\u{2019}") {
        return false;
    }
    // A second upper-case letter ⇒ acronym or mixed-case proper noun.
    if word.chars().skip(1).any(|c| c.is_uppercase()) {
        return false;
    }
    true
}

/// Format `text` and join it onto the running `buffer`.
/// Returns (new_buffer, out) where `out` is exactly what should be emitted.
pub fn dictate(text: &str, buffer: &str, spacing: &str, punctuation: &str) -> (String, String) {
    let mut piece = apply_punct(text.trim(), punctuation);
    if piece.is_empty() {
        return (buffer.to_string(), String::new());
    }

    if (punctuation == "strip" || punctuation == "spoken") && !buffer.is_empty() {
        let tail = buffer.trim_end();
        if let Some(last) = tail.chars().last() {
            // Only de-capitalize when this phrase genuinely continues a sentence
            // (previous phrase didn't end one) AND its leading word is a common
            // word — never the pronoun "I", its contractions, or an acronym /
            // mixed-case proper noun, whose capitals are meaningful.
            if !".!?\n".contains(last) && starts_lowercaseable(&piece) {
                let mut chars = piece.chars();
                let f = chars.next().unwrap();
                piece = f.to_lowercase().collect::<String>() + chars.as_str();
            }
        }
    }

    let sep = if buffer.is_empty() || piece.starts_with('\n') || buffer.ends_with('\n') {
        ""
    } else if spacing == "newline" {
        "\n"
    } else if spacing == "none" {
        ""
    } else {
        " "
    };

    let out = format!("{sep}{piece}");
    (format!("{buffer}{out}"), out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn punct_keep_is_verbatim() {
        assert_eq!(apply_punct("Hello, world.", "keep"), "Hello, world.");
    }

    #[test]
    fn punct_strip_drops_trailing() {
        assert_eq!(apply_punct("hello, world.", "strip"), "hello, world");
        assert_eq!(apply_punct("yes?", "strip"), "yes");
    }

    #[test]
    fn punct_spoken_converts_words() {
        assert_eq!(apply_punct("hello comma world period", "spoken"), "hello, world.");
        assert_eq!(apply_punct("open paren hi close paren", "spoken"), "(hi)");
        assert_eq!(apply_punct("line one new line line two", "spoken"), "line one\nline two");
    }

    #[test]
    fn join_spacing_and_lowercasing() {
        assert_eq!(dictate("Hello", "", "space", "keep"), ("Hello".into(), "Hello".into()));
        assert_eq!(
            dictate("World", "Hello", "space", "keep"),
            ("Hello World".into(), " World".into())
        );
        assert_eq!(
            dictate("World", "hello", "space", "strip"),
            ("hello world".into(), " world".into())
        );
        let (_buf, out) = dictate("new line", "Hello", "space", "spoken");
        assert_eq!(out, "\n");
    }

    #[test]
    fn continuation_lowercases_common_words() {
        // Ordinary word continuing a sentence gets de-capitalized (strip/spoken).
        assert_eq!(dictate("World", "hello", "space", "strip").1, " world");
        assert_eq!(dictate("Then", "we ran", "space", "spoken").1, " then");
    }

    #[test]
    fn continuation_preserves_meaningful_capitals() {
        // Pronoun "I" and its contractions survive.
        assert_eq!(dictate("I", "yes", "space", "strip").1, " I");
        assert_eq!(dictate("I'm here", "yes", "space", "strip").1, " I'm here");
        // Acronyms / mixed-case proper nouns survive.
        assert_eq!(dictate("NASA", "joined", "space", "strip").1, " NASA");
        assert_eq!(dictate("iPhone", "an", "space", "spoken").1, " iPhone");
    }

    #[test]
    fn keep_mode_never_lowercases() {
        // Default "keep" mode leaves capitals fully intact.
        assert_eq!(dictate("World", "hello", "space", "keep").1, " World");
    }

    #[test]
    fn sentence_boundary_keeps_capital() {
        // Previous phrase ended a sentence → next phrase stays capitalized.
        assert_eq!(dictate("World", "hello.", "space", "strip").1, " World");
    }

    #[test]
    fn lowercaseable_classifier() {
        assert!(starts_lowercaseable("World"));
        assert!(starts_lowercaseable("Then"));
        assert!(!starts_lowercaseable("I"));
        assert!(!starts_lowercaseable("I'm"));
        assert!(!starts_lowercaseable("NASA"));
        assert!(!starts_lowercaseable("iPhone"));
        assert!(!starts_lowercaseable("lower")); // already lowercase
    }
}
