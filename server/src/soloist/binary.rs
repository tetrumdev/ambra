use std::{
    io::Read,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use serde::Serialize;
use tokio::process::Command;

use super::{Error, ErrorCode, process::bounded_output};

const DAY: u64 = 86_400;
pub const DOWNLOADS: &str =
    "https://developer.spotify.com/documentation/soloist/reference/downloads-and-updates";

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Build {
    pub version: String,
    pub build_timestamp: u64,
    pub expires_at: u64,
    pub refresh_at: u64,
}

impl Build {
    pub fn parse(output: &str) -> Result<Self, Error> {
        let mut words = output.split_whitespace();
        if !words
            .next()
            .is_some_and(|word| word.eq_ignore_ascii_case("soloist"))
        {
            return Err(Error::new(
                ErrorCode::InvalidExecutable,
                "Executable does not identify itself as Spotify Soloist",
            ));
        }
        let version = words
            .next()
            .filter(|v| {
                v.len() <= 64
                    && v.split('.').count() >= 3
                    && v.split('.')
                        .all(|n| !n.is_empty() && n.bytes().all(|c| c.is_ascii_digit()))
            })
            .ok_or_else(|| {
                Error::new(
                    ErrorCode::InvalidExecutable,
                    "Soloist returned an unrecognized version",
                )
            })?
            .to_owned();
        let rest: Vec<_> = words.collect();
        let timestamp = rest.windows(2).find(|pair| pair[0] == "build").and_then(|pair| pair[1].parse::<u64>().ok())
            .filter(|epoch| (1_500_000_000..=4_100_000_000).contains(epoch))
            .ok_or_else(|| Error::new(ErrorCode::InvalidExecutable, "Soloist build timestamp is missing or invalid; install a current official build"))?;
        if timestamp > now() + DAY {
            return Err(Error::new(
                ErrorCode::InvalidExecutable,
                "Soloist build timestamp is in the future; check the server clock",
            ));
        }
        Ok(Self {
            version,
            build_timestamp: timestamp,
            expires_at: timestamp + 90 * DAY,
            refresh_at: timestamp + 76 * DAY,
        })
    }
    pub fn expired(&self, at: u64) -> bool {
        at >= self.expires_at
    }
    pub fn needs_refresh(&self, at: u64) -> bool {
        at >= self.refresh_at
    }
}

pub fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

pub fn supported(os: &str, arch: &str) -> bool {
    matches!(
        (os, arch),
        ("linux", "x86_64" | "aarch64" | "arm") | ("macos", "aarch64") | ("windows", "x86_64")
    )
}

pub fn locate(configured: Option<&Path>) -> Result<PathBuf, Error> {
    if !supported(std::env::consts::OS, std::env::consts::ARCH) {
        return Err(Error::new(
            ErrorCode::UnsupportedPlatform,
            "No official Soloist build supports this operating system and CPU",
        ));
    }
    let path = match configured {
        Some(path) if path.is_absolute() => path.to_owned(),
        Some(_) => {
            return Err(Error::new(
                ErrorCode::InvalidExecutable,
                "Soloist executable path must be absolute",
            ));
        }
        None => std::env::var_os("PATH")
            .and_then(|paths| {
                std::env::split_paths(&paths)
                    .map(|dir| dir.join(format!("soloist{}", std::env::consts::EXE_SUFFIX)))
                    .find(|path| path.is_file())
            })
            .ok_or_else(|| {
                Error::new(
                    ErrorCode::NotInstalled,
                    "Soloist is not installed; download it from Spotify's official downloads page",
                )
            })?,
    };
    path.canonicalize()
        .map_err(|_| Error::new(ErrorCode::NotInstalled, "Soloist executable was not found"))
}

pub fn validate_identity(path: &Path) -> Result<(), Error> {
    let metadata = std::fs::metadata(path).map_err(Error::io)?;
    if !metadata.is_file() || metadata.len() > 256 * 1024 * 1024 {
        return Err(Error::new(
            ErrorCode::InvalidExecutable,
            "Soloist executable is not a regular file of an allowed size",
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = metadata.permissions().mode();
        if mode & 0o111 == 0 || mode & 0o022 != 0 {
            return Err(Error::new(
                ErrorCode::InvalidExecutable,
                "Soloist must be executable and must not be group- or world-writable",
            ));
        }
    }
    let mut header = [0_u8; 64];
    let read = std::fs::File::open(path)
        .map_err(Error::io)?
        .read(&mut header)
        .map_err(Error::io)?;
    let valid = if cfg!(target_os = "linux") {
        let machine = match std::env::consts::ARCH {
            "x86_64" => 62,
            "aarch64" => 183,
            "arm" => 40,
            _ => 0,
        };
        read >= 20
            && &header[..4] == b"\x7fELF"
            && header[5] == 1
            && header[4]
                == if cfg!(target_pointer_width = "64") {
                    2
                } else {
                    1
                }
            && u16::from_le_bytes([header[18], header[19]]) == machine
    } else if cfg!(target_os = "macos") {
        read >= 12
            && header[..4] == [0xcf, 0xfa, 0xed, 0xfe]
            && u32::from_le_bytes(header[4..8].try_into().unwrap()) == 0x0100_000c
    } else if cfg!(target_os = "windows") {
        // Check the PE signature and machine, not only the DOS MZ prefix.
        if read < 64 || &header[..2] != b"MZ" {
            false
        } else {
            use std::io::{Seek, SeekFrom};
            let offset = u32::from_le_bytes(header[60..64].try_into().unwrap());
            let mut file = std::fs::File::open(path).map_err(Error::io)?;
            let mut pe = [0; 6];
            offset < 1024 * 1024
                && file.seek(SeekFrom::Start(offset.into())).is_ok()
                && file.read_exact(&mut pe).is_ok()
                && pe[..4] == [b'P', b'E', 0, 0]
                && pe[4..] == [0x64, 0x86]
        }
    } else {
        false
    };
    if !valid {
        return Err(Error::new(
            ErrorCode::InvalidExecutable,
            "Soloist must be a native executable for this server's operating system and CPU",
        ));
    }
    Ok(())
}

pub async fn inspect(path: &Path) -> Result<Build, Error> {
    inspect_version(path, false).await
}
pub async fn inspect_status(path: &Path) -> Result<Build, Error> {
    inspect_version(path, true).await
}
async fn inspect_version(path: &Path, allow_expired: bool) -> Result<Build, Error> {
    validate_identity(path)?;
    let (status, output) = bounded_output(Command::new(path).arg("--version")).await?;
    if status.code() == Some(10) && !allow_expired {
        return Err(Error::expired());
    }
    if !status.success() && status.code() != Some(10) {
        return Err(Error::new(
            ErrorCode::InvalidExecutable,
            "Soloist --version failed",
        ));
    }
    let parsed = std::str::from_utf8(&output)
        .map_err(|_| Error::new(ErrorCode::InvalidExecutable, "Soloist version is not UTF-8"))
        .and_then(Build::parse);
    let build = if status.code() == Some(10) {
        parsed.map_err(|_| Error::expired())?
    } else {
        parsed?
    };
    if status.code() == Some(10) && !build.expired(now()) {
        return Err(Error::expired());
    }
    if build.expired(now()) && !allow_expired {
        return Err(Error::expired());
    }
    Ok(build)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn version_expiration_and_refresh_boundaries() {
        let build =
            Build::parse("soloist 1.3.7.349 build 1787077868 (20260818) (linux/aarch64)").unwrap();
        assert!(!build.expired(build.expires_at - 1));
        assert!(build.expired(build.expires_at));
        assert!(!build.needs_refresh(build.refresh_at - 1));
        assert!(build.needs_refresh(build.refresh_at));
        assert!(Build::parse("other 1.3.7 build 1787077868").is_err());
        assert!(Build::parse("soloist 1.3.7 build nonsense").is_err());
    }
    #[test]
    fn supported_platforms_are_explicit() {
        for (os, arch) in [
            ("linux", "x86_64"),
            ("linux", "aarch64"),
            ("macos", "aarch64"),
            ("windows", "x86_64"),
        ] {
            assert!(supported(os, arch));
        }
        assert!(!supported("macos", "x86_64"));
        assert!(!supported("linux", "riscv64"));
        assert!(!supported("windows", "aarch64"));
    }
    #[cfg(unix)]
    #[test]
    fn shell_scripts_cannot_impersonate_soloist() {
        use std::os::unix::fs::PermissionsExt;
        let path = std::env::temp_dir().join(format!(
            "ambra-script-{}",
            crate::server_config::random_hex(8)
        ));
        std::fs::write(
            &path,
            b"#!/bin/sh\necho soloist 1.3.7.349 build 1787077868\n",
        )
        .unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        assert!(validate_identity(&path).is_err());
        std::fs::remove_file(path).unwrap();
    }
}
