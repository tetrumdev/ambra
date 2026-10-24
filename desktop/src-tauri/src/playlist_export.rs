//! Saves an exported playlist to the Downloads folder and shows it selected in Finder or Explorer.
use std::{
    fs::OpenOptions,
    io::{ErrorKind, Write},
    path::{Path, PathBuf},
};
use tauri::Manager;

const MAX_EXPORT_BYTES: usize = 64 * 1024 * 1024;
const MAX_NAME_CHARS: usize = 120;

/// A file name every platform accepts, made from the playlist's name.
fn file_stem(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| if c.is_control() || r#"<>:"/\|?*"#.contains(c) { ' ' } else { c })
        .collect();
    let stem: String = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    let stem: String = stem.chars().take(MAX_NAME_CHARS).collect();
    // Windows drops trailing dots and spaces, and reserves device names like CON and COM1.
    let stem = stem.trim_end_matches(['.', ' ']).to_string();
    let reserved = {
        let base = stem.split('.').next().unwrap_or("").to_ascii_uppercase();
        matches!(base.as_str(), "CON" | "PRN" | "AUX" | "NUL")
            || ((base.starts_with("COM") || base.starts_with("LPT"))
                && base.len() == 4
                && base.as_bytes()[3].is_ascii_digit())
    };
    match stem {
        stem if stem.is_empty() => "Playlist".into(),
        stem if reserved => format!("{stem} playlist"),
        stem => stem,
    }
}

/// Writes to `<stem>.csv`, or `<stem> (2).csv` and so on, never replacing an earlier export.
fn write_new(directory: &Path, stem: &str, bytes: &[u8]) -> Result<PathBuf, String> {
    for attempt in 1..=999 {
        let name = if attempt == 1 {
            format!("{stem}.csv")
        } else {
            format!("{stem} ({attempt}).csv")
        };
        let path = directory.join(name);
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(mut file) => {
                file.write_all(bytes)
                    .and_then(|()| file.sync_all())
                    .map_err(|error| format!("Could not write the playlist file: {error}"))?;
                return Ok(path);
            }
            Err(error) if error.kind() == ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("Could not create the playlist file: {error}")),
        }
    }
    Err("Too many exports of this playlist already exist in Downloads".into())
}

#[tauri::command]
pub async fn export_playlist_csv(
    app: tauri::AppHandle,
    name: String,
    csv: String,
) -> Result<String, String> {
    if csv.len() > MAX_EXPORT_BYTES {
        return Err("This playlist is too large to export".into());
    }
    let paths = app.path();
    let directory = paths
        .download_dir()
        .or_else(|_| paths.document_dir())
        .or_else(|_| paths.home_dir())
        .map_err(|error| format!("Could not find your Downloads folder: {error}"))?;
    let stem = file_stem(&name);
    let path = tauri::async_runtime::spawn_blocking(move || {
        std::fs::create_dir_all(&directory)
            .map_err(|error| format!("Could not open your Downloads folder: {error}"))?;
        write_new(&directory, &stem, csv.as_bytes())
    })
    .await
    .map_err(|error| format!("Could not export the playlist: {error}"))??;
    tauri_plugin_opener::reveal_item_in_dir(&path)
        .map_err(|error| format!("Saved to {}, but could not show it: {error}", path.display()))?;
    Ok(path.display().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_become_safe_file_names() {
        assert_eq!(file_stem("Road Trip: 2024/25"), "Road Trip 2024 25");
        assert_eq!(file_stem("  ...  "), "Playlist");
        assert_eq!(file_stem("Late night..."), "Late night");
        assert_eq!(file_stem("con"), "con playlist");
        assert_eq!(file_stem("COM1.mix"), "COM1.mix playlist");
        assert_eq!(file_stem("Compilation"), "Compilation");
        assert_eq!(file_stem(&"a".repeat(300)).len(), MAX_NAME_CHARS);
    }

    #[test]
    fn exports_never_replace_each_other() {
        let directory = std::env::temp_dir().join(format!("ambra-export-{}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        let first = write_new(&directory, "Mix", b"one").unwrap();
        let second = write_new(&directory, "Mix", b"two").unwrap();
        assert_eq!(first.file_name().unwrap(), "Mix.csv");
        assert_eq!(second.file_name().unwrap(), "Mix (2).csv");
        assert_eq!(std::fs::read(&first).unwrap(), b"one");
        std::fs::remove_dir_all(&directory).unwrap();
    }
}
