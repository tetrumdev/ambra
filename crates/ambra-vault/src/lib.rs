//! Encrypted storage for downloaded audio.
//!
//! Downloads are kept encrypted at rest so the files in the download folder are not plain
//! audio that can be copied out and played elsewhere. Each file is split into 64 KiB chunks
//! sealed with XChaCha20-Poly1305, so a player can seek anywhere by decrypting only the
//! chunks it reads. The key is random per installation and kept in a separate file.
//!
//! This is protection at rest, not DRM: anyone with this installation's key file and the
//! source code can decrypt its downloads. It stops a casual copy of the download folder,
//! not a determined owner of the machine.
//!
//! File layout:
//!
//! ```text
//! header (32 bytes): "AMBRAVLT" | version u8 | 3 reserved | chunk size u32 LE | nonce prefix [16]
//! chunk 0 .. n:      ciphertext | 16-byte tag
//! ```
//!
//! Chunk `i` uses the nonce `prefix || i (u64 LE)` and authenticates the header plus a final
//! flag, so chunks can't be reordered, swapped between files, or truncated at a boundary.
//! Every chunk but the last holds exactly `chunk size` bytes; the last holds fewer.

use std::{
    fs::{self, File, OpenOptions},
    io::{self, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

use chacha20poly1305::{
    KeyInit, XChaCha20Poly1305, XNonce,
    aead::{Aead, Payload},
};
use serde::{Deserialize, Serialize};

const MAGIC: &[u8; 8] = b"AMBRAVLT";
const VERSION: u8 = 1;
const HEADER_LEN: u64 = 32;
const TAG_LEN: usize = 16;
pub const CHUNK_LEN: usize = 64 * 1024;
const FILE_EXTENSION: &str = "avlt";

/// A 256-bit key for this installation's downloads.
#[derive(Clone)]
pub struct Key([u8; 32]);

impl Key {
    /// Reads the key at `path`, creating a random one (readable by this user only) if absent.
    pub fn load_or_create(path: &Path) -> io::Result<Self> {
        match fs::read(path) {
            Ok(bytes) if bytes.len() == 32 => {
                let mut key = [0; 32];
                key.copy_from_slice(&bytes);
                return Ok(Self(key));
            }
            Ok(_) => return Err(io::Error::new(io::ErrorKind::InvalidData, format!("{} is not a download key", path.display()))),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
        let mut key = [0; 32];
        getrandom::fill(&mut key).map_err(|error| io::Error::other(error.to_string()))?;
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let temporary = path.with_extension("tmp");
        write_private(&temporary, &key)?;
        fs::rename(&temporary, path)?;
        Ok(Self(key))
    }

    #[cfg(test)]
    fn fixed(byte: u8) -> Self {
        Self([byte; 32])
    }

    fn cipher(&self) -> XChaCha20Poly1305 {
        XChaCha20Poly1305::new((&self.0).into())
    }
}

fn write_private(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let mut options = OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(bytes)?;
    file.sync_all()
}

fn nonce(prefix: &[u8; 16], index: u64) -> XNonce {
    let mut nonce = [0; 24];
    nonce[..16].copy_from_slice(prefix);
    nonce[16..].copy_from_slice(&index.to_le_bytes());
    nonce.into()
}

fn aad(header: &[u8; HEADER_LEN as usize], last: bool) -> [u8; HEADER_LEN as usize + 1] {
    let mut aad = [0; HEADER_LEN as usize + 1];
    aad[..HEADER_LEN as usize].copy_from_slice(header);
    aad[HEADER_LEN as usize] = u8::from(last);
    aad
}

fn invalid(message: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message.into())
}

/// Encrypts everything written to it. Call [`Writer::finish`]; a dropped writer leaves an
/// incomplete file that [`Reader`] refuses.
pub struct Writer<W: Write> {
    inner: W,
    cipher: XChaCha20Poly1305,
    header: [u8; HEADER_LEN as usize],
    prefix: [u8; 16],
    buffer: Vec<u8>,
    index: u64,
    plaintext_len: u64,
}

impl<W: Write> Writer<W> {
    pub fn new(mut inner: W, key: &Key) -> io::Result<Self> {
        let mut prefix = [0; 16];
        getrandom::fill(&mut prefix).map_err(|error| io::Error::other(error.to_string()))?;
        let mut header = [0; HEADER_LEN as usize];
        header[..8].copy_from_slice(MAGIC);
        header[8] = VERSION;
        header[12..16].copy_from_slice(&(CHUNK_LEN as u32).to_le_bytes());
        header[16..].copy_from_slice(&prefix);
        inner.write_all(&header)?;
        Ok(Self { inner, cipher: key.cipher(), header, prefix, buffer: Vec::with_capacity(CHUNK_LEN * 2), index: 0, plaintext_len: 0 })
    }

    fn seal(&mut self, length: usize, last: bool) -> io::Result<()> {
        let aad = aad(&self.header, last);
        let sealed = self
            .cipher
            .encrypt(&nonce(&self.prefix, self.index), Payload { msg: &self.buffer[..length], aad: &aad })
            .map_err(|_| io::Error::other("Could not encrypt a download chunk"))?;
        self.inner.write_all(&sealed)?;
        self.buffer.drain(..length);
        self.index += 1;
        Ok(())
    }

    /// Plaintext bytes written so far.
    pub fn len(&self) -> u64 {
        self.plaintext_len
    }

    pub fn is_empty(&self) -> bool {
        self.plaintext_len == 0
    }

    /// Seals the final chunk and returns the inner writer, flushed.
    pub fn finish(mut self) -> io::Result<W> {
        // The last chunk must be shorter than a full one, so its length marks the end.
        if self.buffer.len() == CHUNK_LEN {
            self.seal(CHUNK_LEN, false)?;
        }
        let remaining = self.buffer.len();
        self.seal(remaining, true)?;
        self.inner.flush()?;
        Ok(self.inner)
    }
}

impl<W: Write> Write for Writer<W> {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        // At most one byte past a chunk is buffered, so large writes never pile up here.
        let taken = bytes.len().min(CHUNK_LEN + 1 - self.buffer.len());
        self.buffer.extend_from_slice(&bytes[..taken]);
        self.plaintext_len += taken as u64;
        // Strictly more than a chunk: what's left at the end is then at most one chunk.
        if self.buffer.len() > CHUNK_LEN {
            self.seal(CHUNK_LEN, false)?;
        }
        Ok(taken)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

/// Decrypts a vault file, with random access.
pub struct Reader<R: Read + Seek> {
    inner: R,
    cipher: XChaCha20Poly1305,
    header: [u8; HEADER_LEN as usize],
    prefix: [u8; 16],
    chunk_len: usize,
    chunk_count: u64,
    plaintext_len: u64,
    position: u64,
    /// The decrypted chunk, by index.
    cached: Option<(u64, Vec<u8>)>,
}

impl<R: Read + Seek> Reader<R> {
    pub fn new(mut inner: R, key: &Key) -> io::Result<Self> {
        let file_len = inner.seek(SeekFrom::End(0))?;
        inner.seek(SeekFrom::Start(0))?;
        let mut header = [0; HEADER_LEN as usize];
        inner.read_exact(&mut header).map_err(|_| invalid("The download is not an AMBRA vault file"))?;
        if &header[..8] != MAGIC {
            return Err(invalid("The download is not an AMBRA vault file"));
        }
        if header[8] != VERSION {
            return Err(invalid(format!("Unsupported download format version {}", header[8])));
        }
        let chunk_len = u32::from_le_bytes(header[12..16].try_into().unwrap()) as usize;
        if chunk_len == 0 || chunk_len > 16 * 1024 * 1024 {
            return Err(invalid("The download has an invalid chunk size"));
        }
        let mut prefix = [0; 16];
        prefix.copy_from_slice(&header[16..]);
        let body = file_len - HEADER_LEN;
        let sealed = (chunk_len + TAG_LEN) as u64;
        let full_chunks = body / sealed;
        let remainder = body % sealed;
        if remainder < TAG_LEN as u64 {
            return Err(invalid("The download is incomplete"));
        }
        Ok(Self {
            inner,
            cipher: key.cipher(),
            header,
            prefix,
            chunk_len,
            chunk_count: full_chunks + 1,
            plaintext_len: full_chunks * chunk_len as u64 + remainder - TAG_LEN as u64,
            position: 0,
            cached: None,
        })
    }

    /// The decrypted length.
    pub fn len(&self) -> u64 {
        self.plaintext_len
    }

    pub fn is_empty(&self) -> bool {
        self.plaintext_len == 0
    }

    fn load(&mut self, index: u64) -> io::Result<&[u8]> {
        if self.cached.as_ref().is_none_or(|(cached, _)| *cached != index) {
            let last = index + 1 == self.chunk_count;
            let sealed_len = (self.chunk_len + TAG_LEN) as u64;
            let length = if last {
                (self.plaintext_len - index * self.chunk_len as u64) as usize + TAG_LEN
            } else {
                sealed_len as usize
            };
            self.inner.seek(SeekFrom::Start(HEADER_LEN + index * sealed_len))?;
            let mut sealed = vec![0; length];
            self.inner.read_exact(&mut sealed)?;
            let aad = aad(&self.header, last);
            let plain = self
                .cipher
                .decrypt(&nonce(&self.prefix, index), Payload { msg: &sealed, aad: &aad })
                .map_err(|_| invalid("The download is damaged or belongs to another installation"))?;
            self.cached = Some((index, plain));
        }
        Ok(&self.cached.as_ref().unwrap().1)
    }

    /// Checks every chunk, so a damaged file is found before it's trusted.
    pub fn verify(&mut self) -> io::Result<()> {
        for index in 0..self.chunk_count {
            self.load(index)?;
        }
        Ok(())
    }
}

impl<R: Read + Seek> Read for Reader<R> {
    fn read(&mut self, destination: &mut [u8]) -> io::Result<usize> {
        if self.position >= self.plaintext_len || destination.is_empty() {
            return Ok(0);
        }
        let chunk_len = self.chunk_len as u64;
        let index = self.position / chunk_len;
        let offset = (self.position % chunk_len) as usize;
        let chunk = self.load(index)?;
        let count = (chunk.len() - offset).min(destination.len());
        destination[..count].copy_from_slice(&chunk[offset..offset + count]);
        self.position += count as u64;
        Ok(count)
    }
}

impl<R: Read + Seek> Seek for Reader<R> {
    fn seek(&mut self, position: SeekFrom) -> io::Result<u64> {
        let target = match position {
            SeekFrom::Start(offset) => Some(offset),
            SeekFrom::End(offset) => self.plaintext_len.checked_add_signed(offset),
            SeekFrom::Current(offset) => self.position.checked_add_signed(offset),
        }
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "Seek before the start of the download"))?;
        self.position = target;
        Ok(target)
    }
}

/// Which copy the user asked for. Each service gives the best it has at or below it.
#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Quality {
    /// The best available, up to 24-bit/192 kHz.
    #[default]
    Max,
    /// Up to 24-bit/96 kHz.
    HiRes,
    /// 16-bit/44.1 kHz.
    Cd,
    /// Lossy, at most 320 kbps.
    Lossy,
}

impl Quality {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "max" => Some(Self::Max),
            "hiRes" => Some(Self::HiRes),
            "cd" => Some(Self::Cd),
            "lossy" => Some(Self::Lossy),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Max => "max",
            Self::HiRes => "hiRes",
            Self::Cd => "cd",
            Self::Lossy => "lossy",
        }
    }
}

/// One downloaded song.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    /// The app-wide track ID, `provider:providerTrackId`.
    pub id: String,
    pub provider: String,
    pub provider_track_id: String,
    /// The audio file's name in the store, without the vault extension (`tidal-1.flac`).
    pub file: String,
    /// `flac`, `m4a`, `mp3` or `ogg`: the decrypted file's container.
    pub container: String,
    pub mime_type: String,
    pub requested_quality: Quality,
    /// What the service delivered, e.g. "24-bit / 192 kHz FLAC".
    pub quality_label: String,
    #[serde(default, rename = "sampleRateKHz")]
    pub sample_rate_khz: Option<f64>,
    #[serde(default)]
    pub bit_depth: Option<u32>,
    pub size_bytes: u64,
    /// Seconds since the Unix epoch.
    pub downloaded_at: u64,
    /// The track's metadata as the server describes it, for showing it without a server.
    pub metadata: serde_json::Value,
    /// The encrypted cover's file name, when one was saved.
    #[serde(default)]
    pub cover_file: Option<String>,
}

/// A folder of encrypted downloads and their index.
pub struct Store {
    directory: PathBuf,
    key: Key,
    entries: Mutex<Vec<Entry>>,
}

/// A download being written. Commit it, or drop it to discard the partial file.
pub struct Pending {
    writer: Option<Writer<io::BufWriter<File>>>,
    partial: PathBuf,
    file: String,
}

impl Pending {
    pub fn writer(&mut self) -> &mut Writer<io::BufWriter<File>> {
        self.writer.as_mut().expect("pending download writer")
    }
}

impl Drop for Pending {
    fn drop(&mut self) {
        if self.writer.is_some() {
            let _ = fs::remove_file(&self.partial);
        }
    }
}

pub fn now_seconds() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |time| time.as_secs())
}

/// A file name for `id` that is safe on every platform.
pub fn file_stem(id: &str) -> String {
    id.chars().map(|character| if character.is_ascii_alphanumeric() { character } else { '-' }).take(120).collect()
}

impl Store {
    /// Opens (creating) the store in `directory`, with the key at `key_path`. Keep the key
    /// outside `directory`, so copying the folder alone doesn't copy the key.
    pub fn open(directory: PathBuf, key_path: &Path) -> io::Result<Self> {
        fs::create_dir_all(&directory)?;
        let key = Key::load_or_create(key_path)?;
        let entries = match fs::read(directory.join("index.json")) {
            Ok(bytes) => serde_json::from_slice::<Vec<Entry>>(&bytes).unwrap_or_default(),
            Err(_) => Vec::new(),
        };
        // An entry whose file is gone (deleted by hand) is forgotten.
        let entries = entries.into_iter().filter(|entry| directory.join(format!("{}.{FILE_EXTENSION}", entry.file)).is_file()).collect();
        // Interrupted downloads leave partial files behind.
        if let Ok(listing) = fs::read_dir(&directory) {
            for item in listing.flatten() {
                if item.path().extension().is_some_and(|extension| extension == "part") {
                    let _ = fs::remove_file(item.path());
                }
            }
        }
        Ok(Self { directory, key, entries: Mutex::new(entries) })
    }

    pub fn key(&self) -> &Key {
        &self.key
    }

    pub fn directory(&self) -> &Path {
        &self.directory
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Vec<Entry>> {
        self.entries.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn entries(&self) -> Vec<Entry> {
        self.lock().clone()
    }

    pub fn get(&self, id: &str) -> Option<Entry> {
        self.lock().iter().find(|entry| entry.id == id).cloned()
    }

    /// Where `file` (as named in an entry) is kept.
    pub fn path(&self, file: &str) -> PathBuf {
        self.directory.join(format!("{file}.{FILE_EXTENSION}"))
    }

    /// Starts writing `file`; nothing replaces an existing copy until [`Store::commit`].
    pub fn begin(&self, file: &str) -> io::Result<Pending> {
        if file.contains(['/', '\\']) || file.starts_with('.') {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "Invalid download file name"));
        }
        let mut suffix = [0; 6];
        getrandom::fill(&mut suffix).map_err(|error| io::Error::other(error.to_string()))?;
        let suffix = suffix.iter().map(|byte| format!("{byte:02x}")).collect::<String>();
        let partial = self.directory.join(format!("{file}.{suffix}.part"));
        let writer = Writer::new(io::BufWriter::new(File::create(&partial)?), &self.key)?;
        Ok(Pending { writer: Some(writer), partial, file: file.to_owned() })
    }

    /// Finishes `pending` and moves it into place; returns its decrypted size.
    pub fn finish(&self, mut pending: Pending) -> io::Result<u64> {
        let writer = pending.writer.take().expect("pending download writer");
        let size = writer.len();
        let file = writer.finish()?.into_inner().map_err(|error| error.into_error())?;
        file.sync_all()?;
        drop(file);
        let destination = self.path(&pending.file);
        if let Err(error) = fs::rename(&pending.partial, &destination) {
            let _ = fs::remove_file(&pending.partial);
            return Err(error);
        }
        Ok(size)
    }

    /// Adds or replaces `entry`, after its files are in place.
    pub fn record(&self, entry: Entry) -> io::Result<()> {
        let mut entries = self.lock();
        let replaced = entries.iter().position(|existing| existing.id == entry.id).map(|index| entries.remove(index));
        // A replaced copy in another container leaves its old file behind otherwise.
        if let Some(previous) = replaced {
            if previous.file != entry.file {
                let _ = fs::remove_file(self.path(&previous.file));
            }
            if previous.cover_file.is_some() && previous.cover_file != entry.cover_file {
                let _ = fs::remove_file(self.path(previous.cover_file.as_deref().unwrap()));
            }
        }
        entries.push(entry);
        self.save(&entries)
    }

    pub fn remove(&self, id: &str) -> io::Result<bool> {
        let mut entries = self.lock();
        let Some(index) = entries.iter().position(|entry| entry.id == id) else {
            return Ok(false);
        };
        let entry = entries.remove(index);
        self.save(&entries)?;
        let _ = fs::remove_file(self.path(&entry.file));
        if let Some(cover) = entry.cover_file {
            let _ = fs::remove_file(self.path(&cover));
        }
        Ok(true)
    }

    fn save(&self, entries: &[Entry]) -> io::Result<()> {
        let bytes = serde_json::to_vec_pretty(entries).map_err(io::Error::other)?;
        let temporary = self.directory.join("index.json.tmp");
        fs::write(&temporary, bytes)?;
        fs::rename(temporary, self.directory.join("index.json"))
    }

    /// A decrypting reader for `file`.
    pub fn open_file(&self, file: &str) -> io::Result<Reader<File>> {
        Reader::new(File::open(self.path(file))?, &self.key)
    }

    /// Encrypts small `bytes` (a cover) into `file` at once.
    pub fn write_small(&self, file: &str, bytes: &[u8]) -> io::Result<()> {
        let mut pending = self.begin(file)?;
        pending.writer().write_all(bytes)?;
        self.finish(pending).map(drop)
    }

    pub fn read_small(&self, file: &str) -> io::Result<Vec<u8>> {
        let mut reader = self.open_file(file)?;
        let mut bytes = Vec::with_capacity(reader.len() as usize);
        reader.read_to_end(&mut bytes)?;
        Ok(bytes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn sealed(key: &Key, plain: &[u8], pieces: usize) -> Vec<u8> {
        let mut writer = Writer::new(Vec::new(), key).unwrap();
        for piece in plain.chunks(pieces.max(1)) {
            writer.write_all(piece).unwrap();
        }
        writer.finish().unwrap()
    }

    fn sample(len: usize) -> Vec<u8> {
        (0..len).map(|index| (index * 31 % 251) as u8).collect()
    }

    #[test]
    fn round_trips_every_length_around_chunk_boundaries() {
        let key = Key::fixed(7);
        for len in [0, 1, CHUNK_LEN - 1, CHUNK_LEN, CHUNK_LEN + 1, CHUNK_LEN * 3, CHUNK_LEN * 3 + 17] {
            let plain = sample(len);
            let file = sealed(&key, &plain, 10_000);
            let mut reader = Reader::new(Cursor::new(file), &key).unwrap();
            assert_eq!(reader.len(), len as u64);
            let mut decrypted = Vec::new();
            reader.read_to_end(&mut decrypted).unwrap();
            assert_eq!(decrypted, plain, "length {len}");
        }
    }

    #[test]
    fn seeks_anywhere() {
        let key = Key::fixed(1);
        let plain = sample(CHUNK_LEN * 2 + 500);
        let mut reader = Reader::new(Cursor::new(sealed(&key, &plain, 4096)), &key).unwrap();
        for start in [0, 5, CHUNK_LEN - 3, CHUNK_LEN, CHUNK_LEN * 2 + 499] {
            reader.seek(SeekFrom::Start(start as u64)).unwrap();
            let mut bytes = [0; 8];
            let count = reader.read(&mut bytes).unwrap();
            assert_eq!(&bytes[..count], &plain[start..(start + count).min(plain.len())]);
        }
        reader.seek(SeekFrom::End(-1)).unwrap();
        let mut last = [0; 1];
        reader.read_exact(&mut last).unwrap();
        assert_eq!(last[0], *plain.last().unwrap());
    }

    #[test]
    fn rejects_wrong_keys_tampering_and_truncation() {
        let key = Key::fixed(2);
        let plain = sample(CHUNK_LEN * 2 + 10);
        let file = sealed(&key, &plain, 70_000);
        let mut wrong = Reader::new(Cursor::new(file.clone()), &Key::fixed(3)).unwrap();
        assert!(wrong.verify().is_err());

        let mut tampered = file.clone();
        tampered[HEADER_LEN as usize + 3] ^= 1;
        assert!(Reader::new(Cursor::new(tampered), &key).unwrap().verify().is_err());

        // Cut at a chunk boundary: the new last chunk was sealed as not final.
        let truncated = file[..HEADER_LEN as usize + CHUNK_LEN + TAG_LEN].to_vec();
        assert!(Reader::new(Cursor::new(truncated), &key).and_then(|mut reader| reader.verify()).is_err());
        assert!(Reader::new(Cursor::new(file[..20].to_vec()), &key).is_err());
    }

    #[test]
    fn the_file_holds_no_plaintext() {
        let key = Key::fixed(9);
        let plain = b"fLaC this is definitely audio".repeat(100);
        let file = sealed(&key, &plain, 64);
        assert!(!file.windows(4).any(|window| window == b"fLaC"));
    }

    #[test]
    fn the_store_records_reads_and_removes() {
        let root = std::env::temp_dir().join(format!("ambra-vault-test-{}", now_seconds() ^ u64::from(std::process::id())));
        let store = Store::open(root.join("downloads"), &root.join("keys/downloads.key")).unwrap();
        let mut pending = store.begin("tidal-1.flac").unwrap();
        pending.writer().write_all(b"audio").unwrap();
        assert_eq!(store.finish(pending).unwrap(), 5);
        store.record(Entry {
            id: "tidal:1".into(), provider: "tidal".into(), provider_track_id: "1".into(), file: "tidal-1.flac".into(),
            container: "flac".into(), mime_type: "audio/flac".into(), requested_quality: Quality::Max, quality_label: "FLAC".into(),
            sample_rate_khz: None, bit_depth: None, size_bytes: 5, downloaded_at: 0, metadata: serde_json::Value::Null, cover_file: None,
        }).unwrap();
        let reopened = Store::open(root.join("downloads"), &root.join("keys/downloads.key")).unwrap();
        assert_eq!(reopened.read_small("tidal-1.flac").unwrap(), b"audio");
        assert!(reopened.remove("tidal:1").unwrap());
        assert!(reopened.get("tidal:1").is_none());
        assert!(!reopened.path("tidal-1.flac").exists());
        let _ = fs::remove_dir_all(root);
    }
}
