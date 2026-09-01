use serde::{de::DeserializeOwned, Serialize};
use std::path::Path;

/// Load a JSON file, falling back to `T::default()` (and writing the file back,
/// which also creates it on first run). A corrupt file is preserved as
/// `<file>.json.bak` instead of being overwritten — never destroy user data.
pub fn load_or_create<T>(path: &Path, migrate: fn(T) -> T) -> T
where
    T: Serialize + DeserializeOwned + Default,
{
    let value = match std::fs::read_to_string(path) {
        Ok(text) => match serde_json::from_str::<T>(&text) {
            Ok(v) => migrate(v),
            Err(e) => {
                let bak = path.with_extension("json.bak");
                tracing::error!(path = %path.display(), error = %e, backup = %bak.display(), "corrupt JSON, using defaults");
                let _ = std::fs::rename(path, &bak);
                T::default()
            }
        },
        Err(_) => T::default(),
    };
    save(path, &value);
    value
}

/// Pretty-printed JSON; struct field order gives stable key ordering for clean diffs.
pub fn save<T: Serialize>(path: &Path, value: &T) {
    let json = serde_json::to_string_pretty(value).expect("value always serializes");
    if let Err(e) = std::fs::write(path, json) {
        tracing::error!(path = %path.display(), error = %e, "failed to save");
    }
}

#[cfg(test)]
mod tests {
    use serde::{Deserialize, Serialize};

    // KeyForge's original test used its `settings::Settings`; that type is
    // UI-coupled and was not ported, so we use an equivalent local stand-in to
    // exercise the same corrupt-file-backup behaviour.
    #[derive(Serialize, Deserialize, Default, PartialEq, Debug)]
    struct Settings {
        schema_version: u32,
        theme: String,
    }

    #[test]
    fn corrupt_file_backed_up_not_overwritten() {
        let dir = std::env::temp_dir().join(format!("keyforge_test_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("settings.json");
        std::fs::write(&path, "{ not json").unwrap();

        let s: Settings = super::load_or_create(&path, |v| v);
        assert_eq!(s, Settings::default());
        assert_eq!(std::fs::read_to_string(dir.join("settings.json.bak")).unwrap(), "{ not json");
        // and the file was rewritten with valid defaults
        assert!(serde_json::from_str::<Settings>(&std::fs::read_to_string(&path).unwrap()).is_ok());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
