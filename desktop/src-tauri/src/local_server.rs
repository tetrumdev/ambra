//! User-initiated server startup. The server owns its tray and outlives this app.
use std::{path::PathBuf, process::{Command, Stdio}};

fn executable() -> PathBuf {
    let name = format!("ambra-server{}", std::env::consts::EXE_SUFFIX);
    if let Some(directory) = std::env::current_exe().ok().and_then(|path| path.parent().map(std::path::Path::to_owned)) {
        let bundled = directory.join(&name);
        if bundled.is_file() { return bundled }
    }
    if let Some(cargo) = std::env::var_os("CARGO_HOME").map(PathBuf::from)
        .or_else(|| std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(|path| PathBuf::from(path).join(".cargo")))
    {
        let installed = cargo.join("bin").join(&name);
        if installed.is_file() { return installed }
    }
    PathBuf::from(name)
}

#[tauri::command]
pub async fn start_local_server() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let mut command = Command::new(executable());
        command.arg("start").stdin(Stdio::null());
        #[cfg(windows)] {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x0800_0000);
        }
        let output = command.output().map_err(|error| format!("Could not start the server: {error}"))?;
        if output.status.success() { Ok(String::from_utf8_lossy(&output.stdout).trim().to_owned()) }
        else { Err(String::from_utf8_lossy(&output.stderr).trim().to_owned()) }
    }).await.map_err(|error| error.to_string())?
}
