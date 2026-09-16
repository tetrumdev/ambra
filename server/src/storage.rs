use std::{env, fs, path::PathBuf};

pub fn path(filename: &str) -> PathBuf {
    let directory = data_directory();
    if let Err(error) = fs::create_dir_all(&directory) {
        eprintln!(
            "Could not create Ambra data directory {}: {error}",
            directory.display()
        );
    }
    directory.join(filename)
}

fn data_directory() -> PathBuf {
    if let Some(directory) = env::var_os("AMBRA_DATA_DIR").filter(|value| !value.is_empty()) {
        return PathBuf::from(directory);
    }

    if cfg!(debug_assertions) {
        return PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    }

    #[cfg(target_os = "windows")]
    if let Some(directory) = env::var_os("LOCALAPPDATA") {
        return PathBuf::from(directory).join("AMBRA");
    }

    #[cfg(target_os = "macos")]
    if let Some(directory) = env::var_os("HOME") {
        return PathBuf::from(directory)
            .join("Library")
            .join("Application Support")
            .join("com.quantium.ambra");
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

    env::temp_dir().join("ambra")
}

#[cfg(test)]
mod tests {
    use super::path;

    #[test]
    fn storage_paths_include_the_requested_filename() {
        assert_eq!(path("session.json").file_name().unwrap(), "session.json");
    }
}
