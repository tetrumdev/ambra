use std::{
    env, fs, io,
    path::{Path, PathBuf},
};

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

pub fn login_path(filename: &str) -> io::Result<PathBuf> {
    login_path_in(&data_directory(), filename)
}

fn login_path_in(directory: &Path, filename: &str) -> io::Result<PathBuf> {
    let login_directory = directory.join("login-cache");
    fs::create_dir_all(&login_directory)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&login_directory, fs::Permissions::from_mode(0o700))?;
    }

    let destination = login_directory.join(filename);
    if !destination.try_exists()? {
        for old_path in [
            directory.join(filename),
            directory.join(format!(".{filename}")),
        ] {
            if old_path.try_exists()? {
                match fs::rename(&old_path, &destination) {
                    Ok(()) => break,
                    Err(_error) if !old_path.try_exists()? && destination.try_exists()? => break,
                    Err(error) => return Err(error),
                }
            }
        }
    }
    Ok(destination)
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
    use super::{login_path_in, path};
    use std::{
        fs,
        path::PathBuf,
        time::{SystemTime, UNIX_EPOCH},
    };

    #[test]
    fn storage_paths_include_the_requested_filename() {
        assert_eq!(path("session.json").file_name().unwrap(), "session.json");
    }

    #[test]
    fn login_cache_migrates_existing_sessions_and_credentials() {
        let root = temporary_directory();
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("tidal-session.json"), "current session").unwrap();
        fs::write(root.join(".tidal-session.json"), "older session").unwrap();
        fs::write(root.join(".qobuz-session.json"), "older qobuz session").unwrap();
        fs::create_dir(root.join("spotify-cache")).unwrap();
        fs::write(root.join("spotify-cache/credentials.json"), "credentials").unwrap();

        let tidal = login_path_in(&root, "tidal-session.json").unwrap();
        let qobuz = login_path_in(&root, "qobuz-session.json").unwrap();
        let spotify = login_path_in(&root, "spotify-cache").unwrap();
        assert_eq!(fs::read_to_string(tidal).unwrap(), "current session");
        assert_eq!(fs::read_to_string(qobuz).unwrap(), "older qobuz session");
        assert_eq!(
            fs::read_to_string(spotify.join("credentials.json")).unwrap(),
            "credentials"
        );
        assert!(!root.join("tidal-session.json").exists());
        assert!(!root.join("spotify-cache").exists());

        fs::remove_dir_all(root).unwrap();
    }

    fn temporary_directory() -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("ambra-login-cache-{}-{nanos}", std::process::id()))
    }
}
