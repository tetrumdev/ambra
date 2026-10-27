//! Server-only native capture. Every backend targets Soloist, never a system mix.
use super::{Error, ErrorCode};
use serde::Serialize;
use std::path::Path;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capability {
    pub available: bool,
    pub reason: String,
}

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "linux")]
pub use linux::{Capture, capability};
#[cfg(all(test, target_os = "macos"))]
#[path = "linux.rs"]
#[allow(dead_code)]
mod linux_tests;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
pub use macos::{Capture, capability};
#[cfg(target_os = "windows")]
mod windows;
#[cfg(target_os = "windows")]
pub use windows::{Capture, capability};
#[cfg(target_os = "windows")]
pub(crate) use windows::{audio_defaults, configure_driver, driver_present, ensure_platform, restore_audio_defaults};
#[cfg(all(test, not(target_os = "windows")))]
#[path = "windows/pcm.rs"]
mod windows_pcm_tests;

pub fn private_directory(path: &Path) -> Result<(), Error> {
    std::fs::create_dir_all(path).map_err(Error::io)?;
    if std::fs::symlink_metadata(path)
        .map_err(Error::io)?
        .file_type()
        .is_symlink()
    {
        return Err(Error::new(
            ErrorCode::StorageFailed,
            "Soloist private directory cannot be a symlink",
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
            .map_err(Error::io)?;
    }
    Ok(())
}
