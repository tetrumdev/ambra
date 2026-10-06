use std::{
    env, fs, io,
    path::{Path, PathBuf},
};

const APP_ID: &str = "com.quantium.ambra";

pub fn config_path(filename: &str) -> PathBuf {
    path_in(config_directory(), filename, "config")
}

pub fn data_path(filename: &str) -> PathBuf {
    path_in(data_directory(), filename, "data")
}

pub fn cache_path(filename: &str) -> PathBuf {
    path_in(cache_directory(), filename, "cache")
}

/// A directory (created on demand) inside the cache root.
pub fn cache_subdirectory(name: &str) -> PathBuf {
    let directory = cache_directory().join(name);
    if let Err(error) = fs::create_dir_all(&directory) {
        eprintln!(
            "Could not create Ambra cache directory {}: {error}",
            directory.display()
        );
    }
    directory
}

pub fn migrate_legacy() {
    // Migration moves files, so an isolated or test run with overridden
    // directories must never pull the real installation's data into them.
    if ["AMBRA_CONFIG_DIR", "AMBRA_DATA_DIR", "AMBRA_CACHE_DIR"]
        .iter()
        .any(|name| configured(name).is_some())
    {
        return;
    }
    let roots = legacy_roots();
    let migrations = [
        (
            config_path("tidal-session.json"),
            vec!["tidal-session.json", ".tidal-session.json"],
        ),
        (
            config_path("qobuz-session.json"),
            vec!["qobuz-session.json", ".qobuz-session.json"],
        ),
        (
            config_path("spotify/credentials.json"),
            vec![
                "spotify-cache/credentials.json",
                ".spotify-cache/credentials.json",
            ],
        ),
        (
            data_path("streaming-library.json"),
            vec!["streaming-library.json", ".streaming-library.json"],
        ),
        (
            data_path("library-track-ids.json"),
            vec!["library-track-ids.json", ".library-track-ids.json"],
        ),
        (
            cache_path("tidal-metadata-cache.json"),
            vec!["tidal-metadata-cache.json", ".tidal-metadata-cache.json"],
        ),
        (
            cache_path("qobuz-metadata-cache.json"),
            vec!["qobuz-metadata-cache.json", ".qobuz-metadata-cache.json"],
        ),
        (
            cache_path("spotify-metadata-cache.json"),
            vec![
                "spotify-metadata-cache.json",
                ".spotify-metadata-cache.json",
            ],
        ),
    ];

    for (target, names) in migrations {
        if target.exists() {
            continue;
        }
        let mut sources = roots
            .iter()
            .flat_map(|root| names.iter().map(move |name| root.join(name)))
            .filter(|source| source.is_file() && source != &target)
            .collect::<Vec<_>>();
        sources.sort_by_key(|source| {
            fs::metadata(source)
                .and_then(|metadata| metadata.modified())
                .ok()
        });
        if let Some(source) = sources.pop()
            && let Err(error) = move_path(&source, &target)
        {
            eprintln!(
                "Could not migrate Ambra data from {} to {}: {error}",
                source.display(),
                target.display()
            );
        }
    }

    let audio_target = cache_path("spotify/audio");
    if !audio_target.exists() {
        let source = roots
            .iter()
            .flat_map(|root| {
                [
                    root.join("spotify-cache/audio"),
                    root.join(".spotify-cache/audio"),
                ]
            })
            .find(|source| source.is_dir() && source != &audio_target);
        if let Some(source) = source
            && let Err(error) = move_path(&source, &audio_target)
        {
            eprintln!(
                "Could not migrate Ambra data from {} to {}: {error}",
                source.display(),
                audio_target.display()
            );
        }
    }
}

fn move_path(source: &Path, target: &Path) -> io::Result<()> {
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::rename(source, target)
}

fn legacy_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Some(directory) = configured("AMBRA_LEGACY_DATA_DIR") {
        roots.push(directory);
    }

    #[cfg(debug_assertions)]
    roots.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")));

    #[cfg(target_os = "windows")]
    if let Some(directory) = env::var_os("LOCALAPPDATA") {
        roots.push(PathBuf::from(directory).join("AMBRA"));
    }

    #[cfg(target_os = "macos")]
    if let Some(directory) = env::var_os("HOME") {
        roots.push(
            PathBuf::from(directory)
                .join("Library/Application Support")
                .join(APP_ID),
        );
    }

    roots.sort();
    roots.dedup();
    roots
}

fn path_in(directory: PathBuf, filename: &str, kind: &str) -> PathBuf {
    let path = directory.join(filename);
    let parent = path.parent().unwrap_or(&directory);
    if let Err(error) = fs::create_dir_all(parent) {
        eprintln!(
            "Could not create Ambra {kind} directory {}: {error}",
            parent.display()
        );
    }
    path
}

fn configured(name: &str) -> Option<PathBuf> {
    env::var_os(name)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

fn config_directory() -> PathBuf {
    if let Some(directory) = configured("AMBRA_CONFIG_DIR") {
        return directory;
    }

    #[cfg(target_os = "windows")]
    if let Some(directory) = env::var_os("APPDATA") {
        return PathBuf::from(directory).join(APP_ID).join("config");
    }

    #[cfg(target_os = "macos")]
    if let Some(directory) = env::var_os("HOME") {
        return PathBuf::from(directory)
            .join("Library/Application Support")
            .join(APP_ID)
            .join("config");
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        if let Some(directory) = env::var_os("XDG_CONFIG_HOME") {
            return PathBuf::from(directory).join("ambra");
        }
        if let Some(directory) = env::var_os("HOME") {
            return PathBuf::from(directory).join(".config/ambra");
        }
    }

    env::temp_dir().join("ambra/config")
}

fn data_directory() -> PathBuf {
    if let Some(directory) = configured("AMBRA_DATA_DIR") {
        return directory;
    }

    #[cfg(target_os = "windows")]
    if let Some(directory) = env::var_os("APPDATA") {
        return PathBuf::from(directory).join(APP_ID).join("data");
    }

    #[cfg(target_os = "macos")]
    if let Some(directory) = env::var_os("HOME") {
        return PathBuf::from(directory)
            .join("Library/Application Support")
            .join(APP_ID)
            .join("data");
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        if let Some(directory) = env::var_os("XDG_DATA_HOME") {
            return PathBuf::from(directory).join("ambra");
        }
        if let Some(directory) = env::var_os("HOME") {
            return PathBuf::from(directory).join(".local/share/ambra");
        }
    }

    env::temp_dir().join("ambra/data")
}

fn cache_directory() -> PathBuf {
    if let Some(directory) = configured("AMBRA_CACHE_DIR") {
        return directory;
    }

    #[cfg(target_os = "windows")]
    if let Some(directory) = env::var_os("LOCALAPPDATA") {
        return PathBuf::from(directory).join(APP_ID).join("cache");
    }

    #[cfg(target_os = "macos")]
    if let Some(directory) = env::var_os("HOME") {
        return PathBuf::from(directory)
            .join("Library/Caches")
            .join(APP_ID)
            .join("server");
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        if let Some(directory) = env::var_os("XDG_CACHE_HOME") {
            return PathBuf::from(directory).join("ambra");
        }
        if let Some(directory) = env::var_os("HOME") {
            return PathBuf::from(directory).join(".cache/ambra");
        }
    }

    env::temp_dir().join("ambra/cache")
}

#[cfg(test)]
mod tests {
    use super::{cache_path, config_path, data_path};

    #[test]
    fn storage_kinds_use_distinct_directories() {
        let config = config_path("session.json");
        let data = data_path("library.json");
        let cache = cache_path("metadata.json");

        assert_ne!(config.parent(), data.parent());
        assert_ne!(data.parent(), cache.parent());
        assert_ne!(config.parent(), cache.parent());
    }
}
