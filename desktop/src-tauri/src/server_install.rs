//! Downloads the independent server from this app version's GitHub release and puts the
//! `ambra-server` command on the user's PATH. The app package itself never contains the server.
use serde::Serialize;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use tauri::AppHandle;

const RELEASES: &str = "https://github.com/tetrumdev/ambra/releases/download";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerCommand {
    path: String,
    installed: bool,
    /// False when this platform has no published server build.
    available: bool,
}

/// The release asset name CI uploads for this computer, if there is one.
fn asset_name() -> Option<&'static str> {
    if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        Some("ambra-server-aarch64-apple-darwin")
    } else if cfg!(all(target_os = "macos", target_arch = "x86_64")) {
        Some("ambra-server-x86_64-apple-darwin")
    } else if cfg!(all(target_os = "windows", target_arch = "x86_64")) {
        Some("ambra-server-x86_64-pc-windows-msvc.exe")
    } else {
        None
    }
}

/// A per-user directory, so installing never needs administrator rights.
fn install_dir() -> Result<PathBuf, String> {
    if cfg!(windows) {
        dirs::data_local_dir().map(|dir| dir.join("Ambra").join("bin"))
    } else {
        dirs::home_dir().map(|dir| dir.join(".local").join("bin"))
    }
    .ok_or_else(|| "Could not find this user's home directory".into())
}

fn command_path() -> Result<PathBuf, String> {
    Ok(install_dir()?.join(if cfg!(windows) { "ambra-server.exe" } else { "ambra-server" }))
}

#[tauri::command]
pub fn server_command_status() -> Result<ServerCommand, String> {
    let path = command_path()?;
    Ok(ServerCommand {
        installed: path.is_file(),
        path: path.display().to_string(),
        available: asset_name().is_some(),
    })
}

#[tauri::command]
pub async fn install_server_command(app: AppHandle) -> Result<ServerCommand, String> {
    let asset = asset_name().ok_or("No server build is published for this computer")?;
    let url = format!("{RELEASES}/v{}/{asset}", app.package_info().version);
    tauri::async_runtime::spawn_blocking(move || install(&url))
        .await
        .map_err(|error| error.to_string())??;
    server_command_status()
}

fn install(url: &str) -> Result<(), String> {
    let response = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(300))
        .build()
        .and_then(|client| client.get(url).send())
        .and_then(|response| response.error_for_status())
        .map_err(|error| format!("Could not download the server: {error}"))?;
    let bytes = response.bytes().map_err(|error| format!("Could not download the server: {error}"))?;

    let destination = command_path()?;
    let dir = destination.parent().ok_or("Invalid install directory")?;
    fs::create_dir_all(dir).map_err(|error| format!("Could not create {}: {error}", dir.display()))?;
    let partial = destination.with_extension("download");
    write_executable(&partial, &bytes)?;
    // A running server keeps its old file; Windows only lets a running executable be renamed.
    let previous = destination.with_extension("old");
    let _ = fs::remove_file(&previous);
    if destination.exists() {
        fs::rename(&destination, &previous).map_err(|error| format!("Could not replace the installed server: {error}"))?;
    }
    fs::rename(&partial, &destination).map_err(|error| format!("Could not install the server: {error}"))?;
    let _ = fs::remove_file(&previous);
    add_to_path(dir)
}

fn write_executable(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut file = fs::File::create(path).map_err(|error| format!("Could not write {}: {error}", path.display()))?;
    file.write_all(bytes).and_then(|_| file.sync_all())
        .map_err(|error| format!("Could not write {}: {error}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o755))
            .map_err(|error| format!("Could not make the server executable: {error}"))?;
    }
    Ok(())
}

/// Adds the directory to the user's PATH for terminals opened from now on.
#[cfg(windows)]
fn add_to_path(dir: &Path) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    // SetEnvironmentVariable at User scope also tells running programs that PATH changed.
    let script = "$dir = $env:AMBRA_SERVER_DIR; \
        $path = [Environment]::GetEnvironmentVariable('Path', 'User'); \
        $parts = @($path -split ';' | Where-Object { $_ }); \
        if ($parts -notcontains $dir) { [Environment]::SetEnvironmentVariable('Path', (($parts + $dir) -join ';'), 'User') }";
    let status = std::process::Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .env("AMBRA_SERVER_DIR", dir)
        .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
        .status()
        .map_err(|error| format!("Could not update PATH: {error}"))?;
    status.success().then_some(()).ok_or_else(|| "Could not update PATH".into())
}

/// Adds `~/.local/bin` to the shell profiles a new terminal reads, unless they already mention it.
#[cfg(unix)]
fn add_to_path(_dir: &Path) -> Result<(), String> {
    let home = dirs::home_dir().ok_or("Could not find this user's home directory")?;
    let profiles: &[&str] = if cfg!(target_os = "macos") {
        &[".zprofile", ".bash_profile"]
    } else {
        &[".profile"]
    };
    for (index, name) in profiles.iter().enumerate() {
        let profile = home.join(name);
        // The shell's default profile is created; others are only edited when present.
        if index > 0 && !profile.exists() {
            continue;
        }
        let existing = fs::read_to_string(&profile).unwrap_or_default();
        if existing.contains(".local/bin") {
            continue;
        }
        let separator = if existing.is_empty() || existing.ends_with('\n') { "" } else { "\n" };
        fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&profile)
            .and_then(|mut file| write!(file, "{separator}\n# Added by Ambra for the ambra-server command\nexport PATH=\"$HOME/.local/bin:$PATH\"\n"))
            .map_err(|error| format!("Could not update {}: {error}", profile.display()))?;
    }
    Ok(())
}
