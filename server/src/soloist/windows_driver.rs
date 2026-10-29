//! Optional, administrator-consented driver setup on the independent server only.
//! The fixed vendor package is hash pinned. Windows also validates Authenticode
//! before the vendor installer can request elevation. Driver updates are never implicit.
use super::{Error, ErrorCode};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs::File,
    io::{Read, Write},
    path::Path,
};

#[cfg(target_os = "windows")]
pub(crate) const DOWNLOADS: &str = "https://vb-audio.com/Cable/";
const PACKAGE: &str = "https://download.vb-audio.com/Download_CABLE/VBCABLE_Driver_Pack45.zip";
const PACKAGE_SHA256: &str = "b950e39f01af1d04ea623c8f6d8eb9b6ea5c477c637295fabf20631c85116bfb";
const MAX_ARCHIVE: u64 = 8 * 1024 * 1024;
const MAX_EXPANDED: u64 = 32 * 1024 * 1024;

fn failed(message: &str) -> Error {
    Error::new(ErrorCode::CaptureUnavailable, message)
}

fn trusted(url: &reqwest::Url) -> bool {
    url.scheme() == "https"
        && url.host_str() == Some("download.vb-audio.com")
        && url.port_or_known_default() == Some(443)
        && url.username().is_empty()
        && url.password().is_none()
}

fn validate_package(path: &Path) -> Result<(), Error> {
    let file = File::open(path).map_err(Error::io)?;
    if file.metadata().map_err(Error::io)?.len() > MAX_ARCHIVE {
        return Err(failed(
            "The optional driver archive exceeds its size limit.",
        ));
    }
    let mut hash = Sha256::new();
    std::io::copy(&mut file.take(MAX_ARCHIVE + 1), &mut hash).map_err(Error::io)?;
    if format!("{:x}", hash.finalize()) != PACKAGE_SHA256 {
        return Err(failed(
            "The optional driver archive does not match the verified VB-CABLE package. Nothing was installed.",
        ));
    }
    Ok(())
}

fn extract(source: &Path, directory: &Path) -> Result<(), Error> {
    let mut input = File::open(source).map_err(Error::io)?;
    super::updater::preflight_zip(&mut input)
        .map_err(|_| failed("Invalid driver ZIP metadata."))?;
    let mut archive =
        zip::ZipArchive::new(input).map_err(|_| failed("Invalid driver ZIP archive."))?;
    if archive.len() > 128 {
        return Err(failed("Driver archive has too many entries."));
    }
    let mut names = HashSet::new();
    let mut expanded = 0_u64;
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|_| failed("Invalid driver ZIP entry."))?;
        let name = entry
            .name()
            .map_err(|_| failed("Invalid driver ZIP entry."))?
            .into_owned();
        let mode = entry.unix_mode().unwrap_or(0) & 0o170000;
        let stem = name.split('.').next().unwrap_or("").to_ascii_uppercase();
        let reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
            || (stem.len() == 4
                && (stem.starts_with("COM") || stem.starts_with("LPT"))
                && matches!(stem.as_bytes()[3], b'1'..=b'9'));
        if name.is_empty()
            || name.len() > 128
            || !name.as_bytes()[0].is_ascii_alphanumeric()
            || name.ends_with('.')
            || reserved
            || !name
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"_.-".contains(&c))
            || entry.is_dir()
            || !matches!(mode, 0 | 0o100000)
            || !names.insert(name.to_ascii_lowercase())
        {
            return Err(failed("Unsafe or duplicate path in driver archive."));
        }
        expanded = expanded
            .checked_add(entry.size())
            .filter(|size| *size <= MAX_EXPANDED)
            .ok_or_else(|| failed("Expanded driver package exceeds its size limit."))?;
        let size = entry.size();
        let mut output = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(directory.join(&name))
            .map_err(Error::io)?;
        if std::io::copy(&mut entry.by_ref().take(size + 1), &mut output).map_err(Error::io)?
            != size
        {
            return Err(failed("Incomplete driver ZIP entry."));
        }
        output.flush().map_err(Error::io)?;
    }
    for required in [
        "VBCABLE_Setup_x64.exe",
        "vbMmeCable64_win10.inf",
        "vbaudio_cable64_win10.cat",
        "vbaudio_cable64_win10.sys",
    ] {
        if !directory.join(required).is_file() {
            return Err(failed(
                "Driver archive is missing a required signed-package file.",
            ));
        }
    }
    Ok(())
}

#[cfg(target_os = "windows")]
pub(crate) fn configured() -> bool {
    super::capture::capability().available
}

#[cfg(target_os = "windows")]
pub(crate) async fn install() -> Result<String, Error> {
    use std::{path::PathBuf, process::Stdio, time::Duration};
    use tokio::process::Command;
    super::capture::ensure_platform()?;
    if super::capture::driver_present() {
        super::capture::configure_driver()?;
        return Ok("Configured the server's VB-CABLE stereo endpoint at 44,100 Hz and disabled Listen monitoring. Physical audio defaults are unchanged.".into());
    }
    let root = crate::storage::data_path("soloist/windows-driver");
    super::capture::private_directory(&root)?;
    let lease = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(root.join("setup.lock"))
        .map_err(Error::io)?;
    lease
        .try_lock()
        .map_err(|_| failed("Another server CLI is already installing the optional driver."))?;
    let stage = root.join(format!("setup-{}", crate::server_config::random_hex(12)));
    std::fs::create_dir(&stage).map_err(Error::io)?;
    super::capture::private_directory(&stage)?;
    struct Stage(PathBuf);
    impl Drop for Stage {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    let _stage = Stage(stage.clone());
    let client = reqwest::Client::builder()
        .https_only(true)
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(120))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 3 || !trusted(attempt.url()) {
                attempt.error("Untrusted driver download redirect")
            } else {
                attempt.follow()
            }
        }))
        .build()
        .map_err(|_| failed("Could not initialize the optional driver downloader."))?;
    let response = client
        .get(PACKAGE)
        .send()
        .await
        .map_err(|_| failed("Optional driver download failed. Spotify continues at High."))?;
    if response.status() != reqwest::StatusCode::OK {
        return Err(failed("Driver vendor returned an unsuccessful response."));
    }
    let archive = stage.join("driver.zip");
    super::updater::save_archive(response, &archive, MAX_ARCHIVE).await
        .map_err(|_| failed("Optional driver download was interrupted or exceeded its size limit. Spotify continues at High."))?;
    validate_package(&archive)?;
    extract(&archive, &stage)?;
    let system = std::env::var_os("SystemRoot")
        .ok_or_else(|| failed("Windows system directory is unavailable."))?;
    let powershell = PathBuf::from(system).join("System32/WindowsPowerShell/v1.0/powershell.exe");
    // This interactive installer belongs to the CLI, not the server's playback tasks.
    // Wait for it to exit before removing its verified staging files.
    let defaults = super::capture::audio_defaults()?;
    let result = Command::new(powershell)
        .args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            include_str!("windows_driver/setup.ps1"),
        ])
        .env(
            "AMBRA_SOLOIST_DRIVER_SETUP",
            stage.join("VBCABLE_Setup_x64.exe"),
        )
        .env(
            "AMBRA_SOLOIST_DRIVER_CATALOG",
            stage.join("vbaudio_cable64_win10.cat"),
        )
        .stdin(Stdio::null())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .status()
        .await;
    // Some driver installers select their new endpoint as the system default.
    // Restore only defaults changed to this cable; respect concurrent physical-device changes.
    super::capture::restore_audio_defaults(&defaults)?;
    let status = result.map_err(|_| {
        failed("Could not launch Windows signature validation and the optional driver installer.")
    })?;
    if !status.success() {
        return Err(failed(
            "Driver signature validation or installation failed or was cancelled. Spotify continues at High.",
        ));
    }
    if super::capture::driver_present() {
        super::capture::configure_driver()?;
        Ok("Optional server driver installed and configured. Reboot this server to finish driver installation, then check `ambra-server spotify status`.".into())
    } else {
        Ok("Driver installer completed. Reboot this server, then run `ambra-server spotify soloist driver setup` to configure the available driver. Spotify uses High until capture is ready.".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn driver_download_rejects_untrusted_urls_and_modified_package() {
        assert!(trusted(&reqwest::Url::parse(PACKAGE).unwrap()));
        for url in [
            "http://download.vb-audio.com/driver.zip",
            "https://download.vb-audio.com.evil.test/driver.zip",
            "https://download.vb-audio.com:444/driver.zip",
            "https://user@download.vb-audio.com/driver.zip",
        ] {
            assert!(!trusted(&reqwest::Url::parse(url).unwrap()));
        }
        let root = super::super::tests::directory();
        let archive = root.join("modified.zip");
        std::fs::write(&archive, b"unverified installer").unwrap();
        assert!(validate_package(&archive).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn driver_extraction_rejects_unsafe_paths() {
        use zip::{ZipWriter, write::SimpleFileOptions};
        for name in [
            "../escape",
            "/absolute",
            "C:evil",
            "..\\escape",
            "sub/installer",
            "NUL.exe",
            "con",
            "LPT1.txt",
            "COM9.exe",
            "installer.",
            "installer ",
            "",
        ] {
            let root = super::super::tests::directory();
            let archive = root.join("bad.zip");
            let mut writer = ZipWriter::new(File::create(&archive).unwrap());
            writer
                .start_file(name, SimpleFileOptions::default())
                .unwrap();
            writer.write_all(b"not executable").unwrap();
            writer.finish().unwrap();
            assert!(extract(&archive, &root).is_err());
            std::fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn driver_extraction_rejects_links_duplicates_and_oversized_expansion() {
        use zip::{ZipWriter, write::SimpleFileOptions};
        for kind in ["link", "duplicate", "oversize"] {
            let root = super::super::tests::directory();
            let archive = root.join("bad.zip");
            let mut writer = ZipWriter::new(File::create(&archive).unwrap());
            match kind {
                "link" => {
                    writer
                        .add_symlink("link.exe", "outside", SimpleFileOptions::default())
                        .unwrap();
                }
                "duplicate" => {
                    for name in ["setup.exe", "SETUP.EXE"] {
                        writer
                            .start_file(name, SimpleFileOptions::default())
                            .unwrap();
                        writer.write_all(b"duplicate").unwrap();
                    }
                }
                _ => {
                    writer
                        .start_file(
                            "large.exe",
                            SimpleFileOptions::default()
                                .compression_method(zip::CompressionMethod::Deflated),
                        )
                        .unwrap();
                    std::io::copy(&mut std::io::repeat(0).take(MAX_EXPANDED + 1), &mut writer)
                        .unwrap();
                }
            }
            writer.finish().unwrap();
            assert!(extract(&archive, &root).is_err(), "{kind}");
            std::fs::remove_dir_all(root).unwrap();
        }
    }
}
