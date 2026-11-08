//! Carries the app's files over when its bundle identifier changes.
//!
//! The operating system keys every app folder (settings, library, DSP presets, pairing,
//! the download vault key, the webview's storage) by the bundle identifier. Renaming
//! `com.quantium.ambra` to `com.tetrum.ambra` would otherwise start every user over
//! with empty folders. This runs once, before the webview or anything else opens those
//! folders.
use std::{
    collections::BTreeSet,
    fs,
    io,
    path::{Path, PathBuf},
};

const PREVIOUS_IDENTIFIERS: &[&str] = &["com.quantium.ambra"];
const MARKER: &str = ".identifier-migrated";
/// Files a fresh install had already created are kept here, never deleted.
const DISPLACED: &str = "replaced-by-identifier-migration";

/// Every base folder Tauri derives app folders from (data, local data, config, cache).
fn bases() -> BTreeSet<PathBuf> {
    [dirs::data_dir(), dirs::data_local_dir(), dirs::config_dir(), dirs::cache_dir()]
        .into_iter()
        .flatten()
        .collect()
}

pub fn migrate(identifier: &str) {
    if std::env::var_os("AMBRA_DATA_DIR").is_some_and(|value| !value.is_empty()) {
        return;
    }
    for base in bases() {
        for previous in PREVIOUS_IDENTIFIERS.iter().filter(|previous| **previous != identifier) {
            if let Err(error) = migrate_folder(&base.join(previous), &base.join(identifier)) {
                eprintln!("Could not move {previous} files in {}: {error}", base.display());
            }
        }
    }
}

fn migrate_folder(old: &Path, new: &Path) -> io::Result<()> {
    if !old.is_dir() || new.join(MARKER).exists() {
        return Ok(());
    }
    if !new.exists() {
        // The usual upgrade: one rename moves everything at once.
        fs::rename(old, new)?;
    } else {
        // The new identifier already ran (for example a build from before this migration
        // existed), so its folder holds only what a fresh start created. The user's real
        // data wins; the fresh files are set aside rather than deleted.
        let displaced = new.join(DISPLACED);
        for entry in fs::read_dir(old)? {
            let entry = entry?;
            let target = new.join(entry.file_name());
            if target.exists() {
                fs::create_dir_all(&displaced)?;
                let aside = displaced.join(entry.file_name());
                if aside.exists() {
                    remove(&aside)?;
                }
                fs::rename(&target, &aside)?;
            }
            fs::rename(entry.path(), &target)?;
        }
        let _ = fs::remove_dir(old);
    }
    fs::write(new.join(MARKER), old.display().to_string())
}

fn remove(path: &Path) -> io::Result<()> {
    if path.is_dir() { fs::remove_dir_all(path) } else { fs::remove_file(path) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn moves_old_folder_and_sets_fresh_files_aside_once() {
        let root = std::env::temp_dir().join(format!("ambra-identifier-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let (old, new) = (root.join("old"), root.join("new"));

        // A plain upgrade renames the whole folder.
        fs::create_dir_all(old.join("client")).unwrap();
        fs::write(old.join("client/audio-settings.json"), "presets").unwrap();
        migrate_folder(&old, &new).unwrap();
        assert!(!old.exists());
        assert_eq!(fs::read_to_string(new.join("client/audio-settings.json")).unwrap(), "presets");

        // A fresh folder from an earlier run: the old data replaces it, the fresh files are kept aside.
        fs::remove_dir_all(&root).unwrap();
        fs::create_dir_all(old.join("client")).unwrap();
        fs::write(old.join("client/audio-settings.json"), "presets").unwrap();
        fs::write(old.join("window-bounds.json"), "old bounds").unwrap();
        fs::create_dir_all(new.join("client")).unwrap();
        fs::write(new.join("client/audio-settings.json"), "empty").unwrap();
        fs::write(new.join("hsts-storage.sqlite"), "fresh only").unwrap();
        migrate_folder(&old, &new).unwrap();
        assert_eq!(fs::read_to_string(new.join("client/audio-settings.json")).unwrap(), "presets");
        assert_eq!(fs::read_to_string(new.join("window-bounds.json")).unwrap(), "old bounds");
        assert_eq!(fs::read_to_string(new.join("hsts-storage.sqlite")).unwrap(), "fresh only");
        assert_eq!(fs::read_to_string(new.join(DISPLACED).join("client/audio-settings.json")).unwrap(), "empty");
        assert!(!old.exists());

        // Only once: a folder that reappears under the old name is left alone.
        fs::create_dir_all(&old).unwrap();
        fs::write(old.join("later.json"), "x").unwrap();
        migrate_folder(&old, &new).unwrap();
        assert!(!new.join("later.json").exists());
        fs::remove_dir_all(&root).unwrap();
    }
}
