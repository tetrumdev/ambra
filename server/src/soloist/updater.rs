//! Server-owned direct downloads. The immutable binaries and manifest are separate from credentials.
use super::{Error, ErrorCode, binary, capture::private_directory, config::Quality, prefs};
use flate2::read::GzDecoder;
use futures_util::StreamExt;
use reqwest::{Client, StatusCode, Url, header};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{File, OpenOptions},
    io::{self, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    time::Duration,
};
use tokio::{io::AsyncWriteExt, process::Command};

const MAX_ARCHIVE: u64 = 128 * 1024 * 1024;
const MAX_EXTRACTED: u64 = 256 * 1024 * 1024;
const MAX_ENTRIES: usize = 10_000;
const DAY: u64 = 86_400;
const MANIFEST: &str = "managed.json";

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
struct Manifest {
    current: Option<String>,
    previous: Option<String>,
    etag: Option<String>,
    last_check: u64,
    last_error: Option<String>,
}
impl Manifest {
    fn load(root: &Path) -> Result<Self, Error> {
        match std::fs::read(root.join(MANIFEST)) {
            Ok(bytes) if bytes.len() <= 16_384 => serde_json::from_slice(&bytes).map_err(|_| {
                failure("Managed Soloist state is invalid; existing binaries remain intact")
            }),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(Self::default()),
            _ => Err(failure("Could not read managed Soloist state")),
        }
    }
    fn save(&self, root: &Path) -> Result<(), Error> {
        crate::server_config::write_private(
            &root.join(MANIFEST),
            &serde_json::to_vec_pretty(self)
                .map_err(|_| failure("Could not encode Soloist state"))?,
        )
        .map_err(Error::storage)
    }
    fn path(&self, root: &Path) -> Option<PathBuf> {
        managed_path(root, self.current.as_deref()?)
    }
    fn conditional_etag(&self, root: &Path) -> Option<&str> {
        // A missing or corrupted local binary must be downloadable even when CDN bytes match.
        let digest = file_digest(&self.path(root)?).ok()?;
        if self.current.as_deref() == Some(digest.as_str()) {
            self.etag.as_deref()
        } else {
            None
        }
    }
}

/// The most recent failed maintenance attempt survives restarts and successful local probes.
pub fn diagnostic(root: &Path) -> Option<Error> {
    Manifest::load(root)
        .ok()?
        .last_error
        .map(|message| failure(&message))
}

fn file_digest(path: &Path) -> Result<String, Error> {
    let mut hash = Sha256::new();
    io::copy(&mut File::open(path).map_err(Error::io)?, &mut hash).map_err(Error::io)?;
    Ok(format!("{:x}", hash.finalize()))
}
fn failure(message: &str) -> Error {
    Error::new(ErrorCode::UpdateFailed, message)
}
fn invalid_archive() -> Error {
    Error::new(
        ErrorCode::InvalidExecutable,
        "Soloist archive is invalid, unsafe, oversized, or missing its unique executable",
    )
}
fn managed_path(root: &Path, digest: &str) -> Option<PathBuf> {
    (digest.len() == 64 && digest.bytes().all(|b| b.is_ascii_hexdigit())).then(|| {
        root.join(digest)
            .join(format!("soloist{}", std::env::consts::EXE_SUFFIX))
    })
}

/// No PATH lookup and no user-configured executable. The manifest is the only installed pointer.
pub fn installed(root: &Path) -> Option<PathBuf> {
    Manifest::load(root).ok()?.path(root)
}

/// Imports a previously configured native executable without modifying the old installation.
/// This does not grant consent for future network access.
pub async fn migrate(root: &Path, source: &Path) -> Result<(PathBuf, binary::Build), Error> {
    private_directory(root)?;
    let _lease = lock(root)?;
    clean_staging(root)?;
    let build = compatible(source).await?;
    let stage = Stage::new(root)?;
    let destination = stage
        .0
        .join(format!("soloist{}", std::env::consts::EXE_SUFFIX));
    let mut output = self::destination(&destination)?;
    let mut input = File::open(source)
        .map_err(Error::io)?
        .take(MAX_EXTRACTED + 1);
    if io::copy(&mut input, &mut output).map_err(Error::io)? > MAX_EXTRACTED {
        return Err(invalid_archive());
    }
    output.sync_all().map_err(Error::io)?;
    drop(output);
    // Revalidate the copied bytes, so a source change cannot bypass promotion validation.
    let copied_build = compatible(&destination).await?;
    if copied_build.version != build.version
        || copied_build.build_timestamp != build.build_timestamp
    {
        return Err(failure("Soloist executable changed during migration"));
    }
    let mut manifest = Manifest::load(root)?;
    let path = promote(root, &destination, &build, None, &mut manifest)?;
    Ok((path, build))
}

struct UpdateLease(File);
impl Drop for UpdateLease {
    fn drop(&mut self) {
        // A concurrent fork may briefly inherit the descriptor before exec closes it.
        // Explicitly unlock when maintenance ends instead of waiting for every copy.
        let _ = self.0.unlock();
    }
}

fn lock(root: &Path) -> Result<UpdateLease, Error> {
    let mut options = OpenOptions::new();
    options.create(true).truncate(false).read(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options.open(root.join("update.lock")).map_err(Error::io)?;
    file.try_lock().map_err(|_| {
        Error::new(
            ErrorCode::Busy,
            "Another server process is maintaining Soloist",
        )
    })?;
    Ok(UpdateLease(file))
}
fn clean_staging(root: &Path) -> Result<(), Error> {
    // The update lease excludes live writers. Reclaim only manager-created directories.
    for entry in std::fs::read_dir(root).map_err(Error::io)? {
        let entry = entry.map_err(Error::io)?;
        let name = entry.file_name();
        let stale = name
            .to_str()
            .and_then(|n| n.strip_prefix(".download-"))
            .is_some_and(|suffix| {
                suffix.len() == 24 && suffix.bytes().all(|b| b.is_ascii_hexdigit())
            });
        if stale && entry.file_type().map_err(Error::io)?.is_dir() {
            std::fs::remove_dir_all(entry.path()).map_err(Error::io)?;
        }
    }
    Ok(())
}

fn armv7_target(target: &str) -> bool {
    ["armv7", "thumbv7", "armv8"]
        .iter()
        .any(|prefix| target.starts_with(prefix))
}
fn archive_name(os: &str, arch: &str) -> Result<&'static str, Error> {
    match (os, arch) {
        ("linux", "x86_64") => Ok("soloist_release_x86_64.tar.gz"),
        ("linux", "aarch64") => Ok("soloist_release_arm64.tar.gz"),
        // Rust's ARMv7 targets expose ARCH=arm; reject pre-v7 ARM targets.
        ("linux", "arm") if cfg!(test) || armv7_target(env!("AMBRA_SERVER_TARGET")) => {
            Ok("soloist_release_arm32.tar.gz")
        }
        ("macos", "aarch64") => Ok("soloist_release_osx_arm64.tar.gz"),
        ("windows", "x86_64") => Ok("soloist_release_windows_x86_64.zip"),
        _ => Err(Error::new(
            ErrorCode::UnsupportedPlatform,
            "No official Soloist archive supports this server platform",
        )),
    }
}
fn trusted(url: &Url) -> bool {
    url.scheme() == "https"
        && url.host_str() == Some("soloist-builds.spotifycdn.com")
        && url.port_or_known_default() == Some(443)
        && url.username().is_empty()
        && url.password().is_none()
}
fn client() -> Result<Client, Error> {
    Client::builder()
        .https_only(true)
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(300))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 5 || !trusted(attempt.url()) {
                attempt.error("Soloist redirect is outside the trusted Spotify CDN")
            } else {
                attempt.follow()
            }
        }))
        .build()
        .map_err(|_| failure("Could not initialize the Soloist HTTPS downloader"))
}

/// Checks the installed executable on every invocation. Network checks are daily and start at day 76.
/// Failed refreshes never change the installed pointer or modify the pairing/key directories.
pub async fn maintain(
    root: &Path,
    consent: bool,
    force: bool,
) -> Result<Option<(PathBuf, binary::Build)>, Error> {
    if !consent && !root.exists() {
        return Ok(None);
    }
    private_directory(root)?;
    let _lease = lock(root)?;
    clean_staging(root)?;
    let result = maintain_locked(root, consent, force).await;
    if let Err(error) = &result
        && let Ok(mut manifest) = Manifest::load(root)
    {
        manifest.last_error = Some(error.message.clone());
        // Preserve the original failure if diagnostics cannot be persisted.
        let _ = manifest.save(root);
    }
    result
}
async fn maintain_locked(
    root: &Path,
    consent: bool,
    force: bool,
) -> Result<Option<(PathBuf, binary::Build)>, Error> {
    let mut manifest = Manifest::load(root)?;
    let mut current = match manifest.path(root) {
        Some(path) => compatible(&path).await.ok().map(|build| (path, build)),
        None => None,
    };
    // A crash or external corruption must not strand a usable previous compatible version.
    if current.is_none()
        && let Some(path) = manifest
            .previous
            .as_deref()
            .and_then(|d| managed_path(root, d))
        && let Ok(build) = compatible(&path).await
    {
        std::mem::swap(&mut manifest.current, &mut manifest.previous);
        manifest.etag = None;
        manifest.save(root)?;
        current = Some((path, build));
    }
    if !consent {
        return Ok(current);
    }
    let at = binary::now();
    if !force && current.as_ref().is_some_and(|(_, b)| !b.needs_refresh(at)) {
        return Ok(current);
    }
    if !force && manifest.last_check != 0 && at.saturating_sub(manifest.last_check) < DAY {
        return current.map(Some).ok_or_else(|| failure(manifest.last_error.as_deref().unwrap_or("Soloist installation is unavailable; last automatic attempt failed, next retry is within 24 hours")));
    }
    let archive = archive_name(std::env::consts::OS, std::env::consts::ARCH)?;
    manifest.last_check = at;
    manifest.save(root)?;
    let url = Url::parse(&format!("https://soloist-builds.spotifycdn.com/{archive}"))
        .map_err(|_| failure("Invalid official Soloist download URL"))?;
    debug_assert!(trusted(&url));
    let mut request = client()?.get(url);
    // Use conditional requests only while the local archive content remains intact.
    if let Some(etag) = manifest.conditional_etag(root) {
        request = request.header(header::IF_NONE_MATCH, etag);
    }
    let response = request.send().await.map_err(|_| {
        failure("Soloist download failed; previous build and pairing are preserved")
    })?;
    install_response(root, archive, response, current, &mut manifest).await
}

/// A downloaded candidate becomes current only after archive, identity, version and CLI checks.
async fn install_response(
    root: &Path,
    archive: &str,
    response: reqwest::Response,
    current: Option<(PathBuf, binary::Build)>,
    manifest: &mut Manifest,
) -> Result<Option<(PathBuf, binary::Build)>, Error> {
    if response.status() == StatusCode::NOT_MODIFIED {
        if current.is_some() {
            manifest.last_error = None;
            manifest.save(root)?;
        }
        return current.map(Some).ok_or_else(|| {
            failure("Spotify CDN has no replacement for the unavailable or expired Soloist build")
        });
    }
    if response.status() != StatusCode::OK
        || response
            .content_length()
            .is_some_and(|size| size > MAX_ARCHIVE)
    {
        return Err(failure(
            "Spotify CDN returned an unsuccessful or oversized Soloist archive",
        ));
    }
    let etag = response
        .headers()
        .get(header::ETAG)
        .and_then(|v| v.to_str().ok())
        .filter(|s| s.len() <= 1024)
        .map(str::to_owned);
    let stage = Stage::new(root)?;
    let archive_path = stage.0.join("download");
    save_archive(response, &archive_path, MAX_ARCHIVE).await?;
    let executable = stage
        .0
        .join(format!("soloist{}", std::env::consts::EXE_SUFFIX));
    let source = archive_path.clone();
    let destination = executable.clone();
    let zip = archive.ends_with(".zip");
    tokio::task::spawn_blocking(move || extract(&source, &destination, zip))
        .await
        .map_err(|_| failure("Soloist archive extraction failed"))??;
    let build = compatible(&executable).await?;
    if current
        .as_ref()
        .is_some_and(|(_, old)| build.build_timestamp < old.build_timestamp)
    {
        return Err(failure(
            "Spotify CDN offered an older Soloist build; preserving the current version",
        ));
    }
    let promoted = promote(root, &executable, &build, etag, manifest)?;
    Ok(Some((promoted, build)))
}

/// Writes only a bounded response body. The caller owns its private staging directory.
async fn save_archive(response: reqwest::Response, path: &Path, limit: u64) -> Result<(), Error> {
    if response.content_length().is_some_and(|size| size > limit) {
        return Err(invalid_archive());
    }
    let mut options = tokio::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut file = options.open(path).await.map_err(Error::io)?;
    let mut stream = response.bytes_stream();
    let mut bytes = 0_u64;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| failure("Soloist archive download was interrupted"))?;
        bytes = bytes
            .checked_add(chunk.len() as u64)
            .ok_or_else(invalid_archive)?;
        if bytes > limit {
            return Err(invalid_archive());
        }
        file.write_all(&chunk).await.map_err(Error::io)?;
    }
    file.sync_all().await.map_err(Error::io)?;
    Ok(())
}

async fn compatible(path: &Path) -> Result<binary::Build, Error> {
    let build = binary::inspect(path).await?;
    prefs::render("", &build.version, Quality::Lossless)?;
    let (status, output) = super::process::bounded_output(Command::new(path).arg("--help")).await?;
    let text = std::str::from_utf8(&output).unwrap_or("");
    if !status.success()
        || ![
            "--single-track",
            "--pair",
            "--ws",
            "--data-dir",
            "--cache-dir",
            "--cache-size",
            "--api-key",
            "--device-name",
            "--initial-volume",
        ]
        .iter()
        .all(|flag| {
            text.split_whitespace()
                .any(|word| word.trim_end_matches(',') == *flag)
        })
    {
        return Err(Error::new(
            ErrorCode::UnsupportedVersion,
            "Soloist command-line interface is incompatible; preserving the previous build",
        ));
    }
    Ok(build)
}

fn promote(
    root: &Path,
    executable: &Path,
    _build: &binary::Build,
    etag: Option<String>,
    manifest: &mut Manifest,
) -> Result<PathBuf, Error> {
    let digest = file_digest(executable)?;
    let installed = managed_path(root, &digest).unwrap();
    private_directory(installed.parent().unwrap())?;
    if !installed.exists() || file_digest(&installed)? != digest {
        // Never rewrite a valid mapped executable. Atomic replacement repairs only
        // corrupted bytes; a Windows image lock fails safely without changing the pointer.
        std::fs::rename(executable, &installed).map_err(Error::io)?;
        #[cfg(unix)]
        File::open(installed.parent().unwrap())
            .and_then(|f| f.sync_all())
            .map_err(Error::io)?;
    }
    let mut next = manifest.clone();
    if next.current.as_deref() != Some(&digest) {
        next.previous = next.current.take();
        next.current = Some(digest);
    }
    next.etag = etag;
    next.last_error = None;
    next.save(root)?;
    *manifest = next;
    Ok(installed)
}

struct Stage(PathBuf);
impl Stage {
    fn new(root: &Path) -> Result<Self, Error> {
        let path = root.join(format!(
            ".download-{}",
            crate::server_config::random_hex(12)
        ));
        std::fs::create_dir(&path).map_err(Error::io)?;
        private_directory(&path)?;
        Ok(Self(path))
    }
}
impl Drop for Stage {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn safe_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 1024
        && !name.starts_with('/')
        && !name.starts_with('\\')
        && !name.contains('\\')
        && !name.contains(':')
        && !name.contains('\0')
        && !name.split('/').any(|part| part == "..")
}
fn target_name(name: &str, zip: bool) -> bool {
    name.rsplit('/').next() == Some(if zip { "soloist.exe" } else { "soloist" })
}
fn destination(path: &Path) -> Result<File, Error> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o700);
    }
    options.open(path).map_err(Error::io)
}
fn copy_member(reader: &mut impl Read, target: Option<&mut File>, size: u64) -> Result<(), Error> {
    let count = match target {
        Some(file) => io::copy(&mut reader.take(size + 1), file),
        None => io::copy(&mut reader.take(size + 1), &mut io::sink()),
    }
    .map_err(|_| invalid_archive())?;
    if count != size {
        return Err(invalid_archive());
    }
    Ok(())
}
fn preflight_zip(file: &mut File) -> Result<(), Error> {
    // Bound metadata before ZipArchive allocates its central directory. Official releases
    // do not need ZIP64, multi-disk archives, or trailing data; reject those formats.
    let length = file.metadata().map_err(Error::io)?.len();
    let tail_size = length.min(65_535 + 22) as usize;
    file.seek(SeekFrom::End(-(tail_size as i64)))
        .map_err(Error::io)?;
    let mut tail = vec![0; tail_size];
    file.read_exact(&mut tail).map_err(Error::io)?;
    let eocd = (0..tail.len().saturating_sub(21))
        .rev()
        .find(|&i| {
            tail[i..i + 4] == *b"PK\x05\x06"
                && i + 22 + u16::from_le_bytes([tail[i + 20], tail[i + 21]]) as usize == tail.len()
        })
        .ok_or_else(invalid_archive)?;
    if eocd >= 20 && tail[eocd - 20..eocd - 16] == *b"PK\x06\x07" {
        return Err(invalid_archive());
    }
    let record = &tail[eocd..];
    let u16_at = |i| u16::from_le_bytes([record[i], record[i + 1]]);
    let u32_at = |i| u32::from_le_bytes([record[i], record[i + 1], record[i + 2], record[i + 3]]);
    let entries = u16_at(10);
    let directory_size = u32_at(12) as u64;
    let directory_offset = u32_at(16) as u64;
    if u16_at(4) != 0
        || u16_at(6) != 0
        || u16_at(8) != entries
        || entries as usize > MAX_ENTRIES
        || directory_size > 16 * 1024 * 1024
        || directory_offset
            .checked_add(directory_size)
            .is_none_or(|end| end > length - tail_size as u64 + eocd as u64)
    {
        return Err(invalid_archive());
    }
    file.seek(SeekFrom::Start(0)).map_err(Error::io)?;
    Ok(())
}

fn extract(source: &Path, dest: &Path, zip: bool) -> Result<(), Error> {
    if std::fs::metadata(source).map_err(Error::io)?.len() > MAX_ARCHIVE {
        return Err(invalid_archive());
    }
    let mut output = destination(dest)?;
    let mut found = false;
    let mut total = 0_u64;
    if zip {
        let mut input = File::open(source).map_err(Error::io)?;
        preflight_zip(&mut input)?;
        let mut archive = zip::ZipArchive::new(input).map_err(|_| invalid_archive())?;
        if archive.len() > MAX_ENTRIES {
            return Err(invalid_archive());
        }
        for index in 0..archive.len() {
            let mut member = archive.by_index(index).map_err(|_| invalid_archive())?;
            let name = member.name().to_owned();
            let mode = member.unix_mode().unwrap_or(0) & 0o170000;
            if !safe_name(&name)
                || !matches!(mode, 0 | 0o100000 | 0o040000)
                || (mode == 0o040000 && !member.is_dir())
                || (mode == 0o100000 && member.is_dir())
            {
                return Err(invalid_archive());
            }
            let size = member.size();
            total = total.checked_add(size).ok_or_else(invalid_archive)?;
            if total > MAX_EXTRACTED {
                return Err(invalid_archive());
            }
            if member.is_dir() {
                if size != 0 {
                    return Err(invalid_archive());
                }
                continue;
            }
            let selected = target_name(&name, true);
            if selected && found {
                return Err(invalid_archive());
            }
            copy_member(&mut member, selected.then_some(&mut output), size)?;
            found |= selected;
        }
    } else {
        let mut archive = tar::Archive::new(GzDecoder::new(File::open(source).map_err(Error::io)?));
        let entries = archive.entries().map_err(|_| invalid_archive())?.raw(true);
        for (index, member) in entries.enumerate() {
            if index >= MAX_ENTRIES {
                return Err(invalid_archive());
            }
            let mut member = member.map_err(|_| invalid_archive())?;
            let name =
                String::from_utf8(member.path_bytes().to_vec()).map_err(|_| invalid_archive())?;
            let kind = member.header().entry_type();
            if !safe_name(&name) || !(kind.is_file() || kind.is_dir()) {
                return Err(invalid_archive());
            }
            let size = member.size();
            total = total.checked_add(size).ok_or_else(invalid_archive)?;
            if total > MAX_EXTRACTED {
                return Err(invalid_archive());
            }
            if kind.is_dir() {
                if size != 0 {
                    return Err(invalid_archive());
                }
                continue;
            }
            let selected = target_name(&name, false);
            if selected && found {
                return Err(invalid_archive());
            }
            copy_member(&mut member, selected.then_some(&mut output), size)?;
            found |= selected;
        }
    }
    if !found {
        return Err(invalid_archive());
    }
    output.flush().map_err(Error::io)?;
    output.sync_all().map_err(Error::io)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn root() -> Stage {
        let root = std::env::temp_dir().join(format!(
            "ambra-updater-test-{}",
            crate::server_config::random_hex(8)
        ));
        std::fs::create_dir(&root).unwrap();
        Stage(root)
    }
    fn build() -> binary::Build {
        binary::Build::parse(&format!("soloist 1.3.7.349 build {}", binary::now() - DAY)).unwrap()
    }
    #[test]
    fn arm_architecture_uses_target_isa_instead_of_absent_cfg_features() {
        assert!(armv7_target("armv7-unknown-linux-gnueabihf"));
        assert!(armv7_target("thumbv7neon-unknown-linux-gnueabihf"));
        assert!(!armv7_target("arm-unknown-linux-gnueabihf"));
        assert!(!armv7_target("aarch64-unknown-linux-gnu"));
    }

    #[test]
    fn official_archives_and_trust_boundaries() {
        for (os, arch, suffix) in [
            ("linux", "x86_64", "x86_64.tar.gz"),
            ("linux", "arm", "arm32.tar.gz"),
            ("linux", "aarch64", "arm64.tar.gz"),
            ("macos", "aarch64", "osx_arm64.tar.gz"),
            ("windows", "x86_64", "windows_x86_64.zip"),
        ] {
            assert!(archive_name(os, arch).unwrap().ends_with(suffix));
        }
        assert!(archive_name("macos", "x86_64").is_err());
        assert!(archive_name("windows", "aarch64").is_err());
        assert!(trusted(
            &Url::parse("https://soloist-builds.spotifycdn.com/file").unwrap()
        ));
        for url in [
            "http://soloist-builds.spotifycdn.com/file",
            "https://soloist-builds.spotifycdn.com.evil.test/file",
            "https://user@soloist-builds.spotifycdn.com/file",
            "https://soloist-builds.spotifycdn.com:444/file",
            "https://127.0.0.1/file",
        ] {
            assert!(!trusted(&Url::parse(url).unwrap()));
        }
    }
    #[test]
    fn archive_names_reject_traversal_and_windows_paths() {
        for name in [
            "../soloist",
            "x/../soloist",
            "/soloist",
            "C:/soloist",
            "x\\soloist",
            "\\server\\soloist",
            "",
        ] {
            assert!(!safe_name(name), "{name}");
        }
        assert!(safe_name("./release/soloist"));
        assert!(managed_path(Path::new("/tmp"), "../evil").is_none());
    }
    fn tar_file(path: &Path, members: &[(&str, &[u8], tar::EntryType)]) {
        let encoder =
            flate2::write::GzEncoder::new(File::create(path).unwrap(), flate2::Compression::fast());
        let mut archive = tar::Builder::new(encoder);
        for (name, data, kind) in members {
            let mut header = tar::Header::new_gnu();
            header.set_size(data.len() as u64);
            header.set_mode(0o777);
            header.set_entry_type(*kind);
            if kind.is_symlink() {
                header.set_link_name("/etc/passwd").unwrap();
            }
            header.set_cksum();
            archive.append_data(&mut header, name, *data).unwrap();
        }
        archive.into_inner().unwrap().finish().unwrap();
    }
    #[test]
    fn tar_extraction_is_fixed_destination_and_rejects_duplicate_or_links() {
        let root = root();
        let archive = root.0.join("release.tar.gz");
        let dest = root.0.join("output");
        tar_file(
            &archive,
            &[
                ("release/soloist", b"binary", tar::EntryType::Regular),
                ("release/LICENSE", b"license", tar::EntryType::Regular),
            ],
        );
        extract(&archive, &dest, false).unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), b"binary");
        assert!(!root.0.join("release").exists());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&dest).unwrap().permissions().mode() & 0o777,
                0o700
            );
        }
        std::fs::remove_file(&dest).unwrap();
        tar_file(
            &archive,
            &[
                ("soloist", b"a", tar::EntryType::Regular),
                ("sub/soloist", b"b", tar::EntryType::Regular),
            ],
        );
        assert!(extract(&archive, &dest, false).is_err());
        std::fs::remove_file(&dest).unwrap();
        tar_file(&archive, &[("soloist", b"", tar::EntryType::Symlink)]);
        assert!(extract(&archive, &dest, false).is_err());
    }
    #[test]
    fn zip_extraction_rejects_duplicates_and_traversal() {
        use zip::write::SimpleFileOptions;
        let root = root();
        let archive = root.0.join("release.zip");
        for members in [
            vec!["release/soloist.exe", "LICENSE"],
            vec!["soloist.exe", "sub/soloist.exe"],
            vec!["../soloist.exe"],
        ] {
            let mut writer = zip::ZipWriter::new(File::create(&archive).unwrap());
            for name in &members {
                writer
                    .start_file(*name, SimpleFileOptions::default())
                    .unwrap();
                writer.write_all(b"data").unwrap();
            }
            writer.finish().unwrap();
            let dest = root.0.join("output");
            assert_eq!(
                extract(&archive, &dest, true).is_ok(),
                members[0] == "release/soloist.exe"
            );
            std::fs::remove_file(dest).unwrap();
        }
    }
    #[tokio::test]
    async fn no_consent_never_creates_install_or_downloads() {
        let root = root();
        let dir = root.0.join("absent");
        assert!(maintain(&dir, false, true).await.unwrap().is_none());
        assert!(!dir.exists());
    }
    #[test]
    fn etags_never_prevent_repairing_missing_or_corrupted_local_builds() {
        let root = root();
        let mut manifest = Manifest::default();
        let source = root.0.join("source");
        std::fs::write(&source, b"original").unwrap();
        let path = promote(
            &root.0,
            &source,
            &build(),
            Some("etag".into()),
            &mut manifest,
        )
        .unwrap();
        assert_eq!(manifest.conditional_etag(&root.0), Some("etag"));
        std::fs::write(&path, b"corrupted").unwrap();
        assert_eq!(manifest.conditional_etag(&root.0), None);
        std::fs::write(&source, b"original").unwrap();
        assert_eq!(
            promote(
                &root.0,
                &source,
                &build(),
                Some("etag".into()),
                &mut manifest
            )
            .unwrap(),
            path
        );
        assert_eq!(std::fs::read(&path).unwrap(), b"original");
        assert_eq!(manifest.conditional_etag(&root.0), Some("etag"));
        std::fs::remove_file(&path).unwrap();
        assert_eq!(manifest.conditional_etag(&root.0), None);
    }
    #[test]
    fn atomic_promotion_keeps_previous_and_never_touches_credentials() {
        let root = root();
        let mut manifest = Manifest::default();
        let stage = root.0.join("stage");
        std::fs::write(&stage, b"first").unwrap();
        let first = promote(
            &root.0,
            &stage,
            &build(),
            Some("etag1".into()),
            &mut manifest,
        )
        .unwrap();
        std::fs::write(&stage, b"second").unwrap();
        let second = promote(
            &root.0,
            &stage,
            &build(),
            Some("etag2".into()),
            &mut manifest,
        )
        .unwrap();
        assert_ne!(first, second);
        assert!(first.exists());
        assert!(second.exists());
        assert_eq!(
            managed_path(&root.0, manifest.previous.as_deref().unwrap()).unwrap(),
            first
        );
        assert_eq!(installed(&root.0).unwrap(), second);
        assert_eq!(
            Manifest::load(&root.0).unwrap().etag.as_deref(),
            Some("etag2")
        );
        assert_eq!(std::fs::read(&first).unwrap(), b"first");
    }
    #[test]
    fn interrupted_staging_is_removed_without_changing_pointer() {
        let root = root();
        let path;
        {
            let stage = Stage::new(&root.0).unwrap();
            path = stage.0.clone();
            std::fs::write(path.join("partial"), b"partial").unwrap();
        }
        assert!(!path.exists());
        assert!(installed(&root.0).is_none());
    }
    #[cfg(unix)]
    fn native(root: &Path, name: &str, version: &str, age: u64, exit: i32, flags: bool) -> PathBuf {
        let source = root.join(format!("{name}.c"));
        let path = root.join(name);
        let help = if flags {
            "--single-track --pair --ws --data-dir --cache-dir --cache-size --api-key --device-name --initial-volume"
        } else {
            // A renamed option must not satisfy the silent-start compatibility check.
            "--single-track --pair --ws --data-dir --cache-dir --cache-size --api-key --device-name --initial-volume-obsolete"
        };
        std::fs::write(&source, format!(r#"
#include <stdio.h>
#include <string.h>
int main(int argc, char **argv) {{
  if(argc>1 && !strcmp(argv[1],"--version")) {{ puts("soloist {version} build {}"); return {exit}; }}
  if(argc>1 && !strcmp(argv[1],"--help")) {{ puts("{help}"); return 0; }}
  return 1;
}}
"#, binary::now() - age)).unwrap();
        let status = std::process::Command::new("cc")
            .arg(&source)
            .arg("-o")
            .arg(&path)
            .status()
            .unwrap();
        assert!(status.success());
        path
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn migration_preserves_source_pairing_and_requires_no_network_consent() {
        let root = root();
        let install = root.0.join("managed");
        let source = native(&root.0, "legacy", "1.3.7.349", DAY, 0, true);
        let pairing = root.0.join("session-key");
        std::fs::write(&pairing, b"opaque-session-key").unwrap();
        let (path, _) = migrate(&install, &source).await.unwrap();
        assert!(source.exists());
        assert!(path.exists());
        assert_ne!(source, path);
        assert_eq!(std::fs::read(pairing).unwrap(), b"opaque-session-key");
        let selected = maintain(&install, false, false).await.unwrap().unwrap();
        assert_eq!(selected.0, path);
        // A fresh managed build skips the CDN entirely even with consent.
        assert_eq!(
            maintain(&install, true, false).await.unwrap().unwrap().0,
            path
        );
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn incompatible_expired_and_cli_changed_binaries_never_promote() {
        let root = root();
        let install = root.0.join("managed");
        for (name, version, age, exit, flags, code) in [
            (
                "unknown",
                "1.4.0.1",
                DAY,
                0,
                true,
                ErrorCode::UnsupportedVersion,
            ),
            (
                "changed",
                "1.3.7.349",
                DAY,
                0,
                false,
                ErrorCode::UnsupportedVersion,
            ),
            (
                "expired",
                "1.3.7.349",
                91 * DAY,
                0,
                true,
                ErrorCode::Expired,
            ),
            ("exit10", "1.3.7.349", DAY, 10, true, ErrorCode::Expired),
        ] {
            let source = native(&root.0, name, version, age, exit, flags);
            assert_eq!(migrate(&install, &source).await.unwrap_err().code, code);
            assert!(installed(&install).is_none());
            assert!(source.exists());
        }
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn corrupted_current_build_rolls_back_to_compatible_previous() {
        let root = root();
        let install = root.0.join("managed");
        let first = native(&root.0, "first", "1.3.7.348", 2 * DAY, 0, true);
        let second = native(&root.0, "second", "1.3.10.20", DAY, 0, true);
        let (old, _) = migrate(&install, &first).await.unwrap();
        let (new, _) = migrate(&install, &second).await.unwrap();
        std::fs::write(&new, b"corrupt").unwrap();
        assert_eq!(
            maintain(&install, true, false).await.unwrap().unwrap().0,
            old
        );
        assert_eq!(installed(&install).unwrap(), old);
    }
    #[tokio::test]
    async fn failed_first_download_is_throttled_until_daily_retry() {
        let root = root();
        Manifest {
            last_check: binary::now(),
            ..Default::default()
        }
        .save(&root.0)
        .unwrap();
        let error = maintain(&root.0, true, false).await.unwrap_err();
        assert_eq!(error.code, ErrorCode::UpdateFailed);
        assert!(error.message.contains("within 24 hours"));
    }
    #[test]
    fn malformed_archives_and_missing_binary_fail_closed() {
        let root = root();
        let archive = root.0.join("archive");
        let dest = root.0.join("out");
        std::fs::write(&archive, b"not an archive").unwrap();
        assert!(extract(&archive, &dest, false).is_err());
        std::fs::remove_file(&dest).unwrap();
        assert!(extract(&archive, &dest, true).is_err());
        std::fs::remove_file(&dest).unwrap();
        tar_file(&archive, &[("README", b"docs", tar::EntryType::Regular)]);
        assert!(extract(&archive, &dest, false).is_err());
    }
    #[tokio::test]
    async fn failure_diagnostics_survive_local_probes_and_restart() {
        let root = root();
        Manifest {
            last_check: binary::now(),
            last_error: Some("Soloist archive download was interrupted".into()),
            ..Default::default()
        }
        .save(&root.0)
        .unwrap();
        let error = maintain(&root.0, true, false).await.unwrap_err();
        assert_eq!(error.message, "Soloist archive download was interrupted");
        assert_eq!(diagnostic(&root.0).unwrap().message, error.message);
        assert!(maintain(&root.0, false, false).await.unwrap().is_none());
        assert_eq!(diagnostic(&root.0).unwrap().message, error.message);
    }
    #[test]
    fn zip_metadata_allocation_is_bounded_before_parser_construction() {
        let root = root();
        let path = root.0.join("bad.zip");
        let mut header = [0_u8; 22];
        header[..4].copy_from_slice(b"PK\x05\x06");
        header[8..10].copy_from_slice(&u16::MAX.to_le_bytes());
        header[10..12].copy_from_slice(&u16::MAX.to_le_bytes());
        std::fs::write(&path, header).unwrap();
        assert!(preflight_zip(&mut File::open(&path).unwrap()).is_err());
    }
    #[test]
    fn abandoned_staging_cleanup_preserves_unrelated_directories() {
        let root = root();
        let stale = root.0.join(".download-0123456789abcdef01234567");
        let unrelated = root.0.join(".download-not-managed");
        std::fs::create_dir(&stale).unwrap();
        std::fs::create_dir(&unrelated).unwrap();
        std::fs::write(stale.join("partial"), b"partial").unwrap();
        clean_staging(&root.0).unwrap();
        assert!(!stale.exists());
        assert!(unrelated.exists());
    }
    async fn http_response(raw: &[u8]) -> reqwest::Response {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let raw = raw.to_vec();
        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0; 4096];
            assert!(socket.read(&mut request).await.unwrap() > 0);
            socket.write_all(&raw).await.unwrap();
            socket.shutdown().await.unwrap();
        });
        reqwest::get(format!("http://{address}/archive"))
            .await
            .unwrap()
    }
    #[tokio::test]
    async fn bounded_download_accepts_complete_body_and_rejects_interruption_and_oversize() {
        let root = root();
        let good =
            http_response(b"HTTP/1.1 200 OK\r\nContent-Length: 4\r\nConnection: close\r\n\r\ndata")
                .await;
        let path = root.0.join("good");
        save_archive(good, &path, 8).await.unwrap();
        assert_eq!(std::fs::read(path).unwrap(), b"data");
        let oversized = http_response(
            b"HTTP/1.1 200 OK\r\nContent-Length: 9\r\nConnection: close\r\n\r\n123456789",
        )
        .await;
        let path = root.0.join("oversized");
        assert!(save_archive(oversized, &path, 8).await.is_err());
        assert!(!path.exists());
        let chunked=http_response(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n9\r\n123456789\r\n0\r\n\r\n").await;
        assert!(
            save_archive(chunked, &root.0.join("chunked"), 8)
                .await
                .is_err()
        );
        let truncated =
            http_response(b"HTTP/1.1 200 OK\r\nContent-Length: 8\r\nConnection: close\r\n\r\ndata")
                .await;
        assert_eq!(
            save_archive(truncated, &root.0.join("partial"), 8)
                .await
                .unwrap_err()
                .code,
            ErrorCode::UpdateFailed
        );
    }
    #[tokio::test]
    async fn concurrent_updater_fails_before_network() {
        let root = root();
        let lease = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(root.0.join("update.lock"))
            .unwrap();
        lease.try_lock().unwrap();
        assert_eq!(
            maintain(&root.0, true, true).await.unwrap_err().code,
            ErrorCode::Busy
        );
    }

    #[test]
    fn maintenance_releases_lease_even_with_an_inherited_descriptor() {
        let root = root();
        let lease = lock(&root.0).unwrap();
        let inherited = lease.0.try_clone().unwrap();
        assert!(lock(&root.0).is_err());
        drop(lease);
        let _next = lock(&root.0).unwrap();
        drop(inherited);
    }

    #[cfg(unix)]
    async fn archive_response(root: &Path, binary: &Path, zip: bool) -> reqwest::Response {
        let archive = root.join("test-archive");
        let data = std::fs::read(binary).unwrap();
        if zip {
            let mut writer = zip::ZipWriter::new(File::create(&archive).unwrap());
            writer
                .start_file(
                    "release/soloist.exe",
                    zip::write::SimpleFileOptions::default(),
                )
                .unwrap();
            writer.write_all(&data).unwrap();
            writer.finish().unwrap();
        } else {
            tar_file(
                &archive,
                &[("release/soloist", &data, tar::EntryType::Regular)],
            );
        }
        let body = std::fs::read(archive).unwrap();
        let mut response = format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nETag: \"candidate\"\r\nConnection: close\r\n\r\n", body.len()).into_bytes();
        response.extend(body);
        http_response(&response).await
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn downloaded_tar_and_zip_install_upgrade_and_configure_current_family() {
        // Exercise the production response pipeline for Unix and Windows archive layouts.
        // Executables target the test host so identity and CLI validation actually run.
        for zip in [false, true] {
            let root = root();
            let install = root.0.join("managed");
            private_directory(&install).unwrap();
            let session = root.0.join("session");
            let user = session.join("settings/Users/fixture-user/prefs");
            crate::server_config::write_private(
                &user,
                b"session.opaque=keep\naudio.normalize_v2=true\n",
            )
            .unwrap();
            let key = root.0.join("api-key");
            std::fs::write(&key, b"personal-key-preserved").unwrap();
            let archive = if zip { "release.zip" } else { "release.tar.gz" };
            let legacy = native(&root.0, "legacy", "1.3.7.349", 77 * DAY, 0, true);
            let latest = native(&root.0, "latest", "1.3.10.20", DAY, 0, true);
            let mut manifest = Manifest::default();
            let old = install_response(
                &install,
                archive,
                archive_response(&root.0, &legacy, zip).await,
                None,
                &mut manifest,
            )
            .await
            .unwrap()
            .unwrap();
            let current = install_response(
                &install,
                archive,
                archive_response(&root.0, &latest, zip).await,
                Some(old.clone()),
                &mut manifest,
            )
            .await
            .unwrap()
            .unwrap();
            assert_eq!(current.1.version, "1.3.10.20");
            assert_ne!(current.0, old.0);
            assert!(old.0.exists());
            assert_eq!(installed(&install), Some(current.0.clone()));
            assert_eq!(
                managed_path(&install, manifest.previous.as_deref().unwrap()),
                Some(old.0)
            );
            assert_eq!(manifest.etag.as_deref(), Some("\"candidate\""));
            assert_eq!(std::fs::read(&key).unwrap(), b"personal-key-preserved");
            assert_eq!(
                std::fs::read_to_string(&user).unwrap(),
                "session.opaque=keep\naudio.normalize_v2=true\n"
            );

            prefs::write(&session, &current.1.version, Quality::Lossless).unwrap();
            for path in [session.join("settings/prefs"), user] {
                let text = std::fs::read_to_string(path).unwrap();
                assert!(text.contains("audio.play_bitrate_enumeration=5\n"));
                assert!(text.contains("audio.play_bitrate_non_metered_enumeration=5\n"));
                assert!(text.contains("audio.normalize_v2=false\n"));
            }
            assert!(
                std::fs::read_to_string(session.join("settings/Users/fixture-user/prefs"))
                    .unwrap()
                    .contains("session.opaque=keep\n")
            );
            assert_eq!(
                maintain(&install, false, false).await.unwrap().unwrap().0,
                current.0
            );

            for (name, version, age, flags, code) in [
                (
                    "unknown",
                    "1.3.11.1",
                    0,
                    true,
                    ErrorCode::UnsupportedVersion,
                ),
                (
                    "changed",
                    "1.3.10.21",
                    0,
                    false,
                    ErrorCode::UnsupportedVersion,
                ),
                ("older", "1.3.10.20", 2 * DAY, true, ErrorCode::UpdateFailed),
                ("expired", "1.3.10.20", 91 * DAY, true, ErrorCode::Expired),
            ] {
                let candidate = native(&root.0, name, version, age, 0, flags);
                let error = install_response(
                    &install,
                    archive,
                    archive_response(&root.0, &candidate, zip).await,
                    Some(current.clone()),
                    &mut manifest,
                )
                .await
                .unwrap_err();
                assert_eq!(error.code, code, "{name}");
                assert_eq!(installed(&install), Some(current.0.clone()));
                assert!(old.1.needs_refresh(binary::now()));
                assert_eq!(std::fs::read(&key).unwrap(), b"personal-key-preserved");
            }
            assert!(std::fs::read_dir(&install).unwrap().all(|entry| {
                !entry
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".download-")
            }));
        }
    }

    #[tokio::test]
    #[ignore = "Downloads the current official Soloist archive; requires network and a supported native host"]
    async fn official_cdn_installs_and_rechecks_without_credentials() {
        let root = root();
        let installed = maintain(&root.0, true, false).await.unwrap().unwrap();
        assert!(!installed.1.expired(binary::now()));
        prefs::render("", &installed.1.version, Quality::Lossless).unwrap();
        let rechecked = maintain(&root.0, true, true).await.unwrap().unwrap();
        assert_eq!(rechecked.0, installed.0);
        assert!(!root.0.join("session").exists());
    }
}
