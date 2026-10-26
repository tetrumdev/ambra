//! Ambra live PCM protocol v1. Shared by the server and desktop decoder.
//! HTTP is nonseekable; a stream is consumed once. Only an explicit END frame means success.
use serde::{Deserialize, Serialize};
use std::io::{self, Read};

pub const MIME: &str = "application/vnd.ambra.pcm";
pub const MAGIC: &[u8; 8] = b"AMBPCM1\n";
pub const MAX_CHUNK: usize = 32768;
pub const FRAME_BYTES: usize = 8;
pub const BYTES_PER_SECOND: usize = 44_100 * FRAME_BYTES;
const ERROR: u32 = u32::MAX;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Format {
    pub codec: String,
    pub sample_format: String,
    pub sample_rate: u32,
    pub channels: u8,
}
impl Default for Format {
    fn default() -> Self {
        Self {
            codec: "pcm".into(),
            sample_format: "s32le".into(),
            sample_rate: 44_100,
            channels: 2,
        }
    }
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StreamInfo {
    pub stream_id: String,
    pub track_id: String,
    pub generation: u64,
    pub format: Format,
    pub start_position_seconds: f64,
    pub duration_seconds: f64,
    pub created_at_ms: u64,
    pub requested_quality: String,
    /// Never inferred from the capture container.
    pub source_format_verified: bool,
}
impl StreamInfo {
    pub fn validate(&self) -> io::Result<()> {
        if self.format != Format::default()
            || self.source_format_verified
            || self.stream_id.len() != 32
            || !self.stream_id.bytes().all(|b| b.is_ascii_hexdigit())
            || self.track_id.is_empty()
            || self.track_id.len() > 128
            || !self.start_position_seconds.is_finite()
            || self.start_position_seconds < 0.0
            || !self.duration_seconds.is_finite()
            || self.duration_seconds < 0.0
        {
            return Err(invalid("Unsupported or invalid live PCM metadata"));
        }
        Ok(())
    }
    pub fn header(&self) -> io::Result<Vec<u8>> {
        self.validate()?;
        let json = serde_json::to_vec(self)?;
        let mut bytes = MAGIC.to_vec();
        bytes.extend_from_slice(&(json.len() as u32).to_le_bytes());
        bytes.extend(json);
        Ok(bytes)
    }
    pub fn read(reader: &mut impl Read) -> io::Result<Self> {
        let mut magic = [0; 8];
        reader.read_exact(&mut magic)?;
        if &magic != MAGIC {
            return Err(invalid("Invalid live PCM protocol version"));
        }
        let length = read_length(reader)? as usize;
        if length > 4096 {
            return Err(invalid("Live PCM metadata exceeds its limit"));
        }
        let mut bytes = vec![0; length];
        reader.read_exact(&mut bytes)?;
        let info: Self = serde_json::from_slice(&bytes)?;
        info.validate()?;
        Ok(info)
    }
}

pub fn audio_frame(pcm: &[u8]) -> io::Result<Vec<u8>> {
    if pcm.is_empty() || pcm.len() > MAX_CHUNK || !pcm.len().is_multiple_of(FRAME_BYTES) {
        return Err(invalid("Invalid live PCM sample frame alignment"));
    }
    let mut bytes = (pcm.len() as u32).to_le_bytes().to_vec();
    bytes.extend_from_slice(pcm);
    Ok(bytes)
}
pub fn end_frame() -> Vec<u8> {
    0_u32.to_le_bytes().to_vec()
}
pub fn error_frame(message: &str) -> Vec<u8> {
    let message: String = message.chars().take(1024).collect();
    let mut bytes = ERROR.to_le_bytes().to_vec();
    bytes.extend_from_slice(&(message.len() as u32).to_le_bytes());
    bytes.extend_from_slice(message.as_bytes());
    bytes
}
pub fn read_frame(reader: &mut impl Read) -> io::Result<Option<Vec<u8>>> {
    let length = read_length(reader)?;
    if length == 0 {
        return Ok(None);
    }
    if length == ERROR {
        let size = read_length(reader)? as usize;
        if size > 4096 {
            return Err(invalid("Live PCM error exceeds its limit"));
        }
        let mut bytes = vec![0; size];
        reader.read_exact(&mut bytes)?;
        return Err(io::Error::other(
            String::from_utf8_lossy(&bytes).to_string(),
        ));
    }
    let length = length as usize;
    if length > MAX_CHUNK || !length.is_multiple_of(FRAME_BYTES) {
        return Err(invalid("Invalid live PCM sample frame alignment"));
    }
    let mut bytes = vec![0; length];
    reader.read_exact(&mut bytes)?;
    Ok(Some(bytes))
}
fn read_length(reader: &mut impl Read) -> io::Result<u32> {
    let mut bytes = [0; 4];
    reader.read_exact(&mut bytes)?;
    Ok(u32::from_le_bytes(bytes))
}
fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preserves_all_bits_and_requires_explicit_end() {
        let pcm: Vec<_> = [i32::MIN, i32::MAX, 0, 256]
            .iter()
            .flat_map(|n| n.to_le_bytes())
            .collect();
        let mut bytes = audio_frame(&pcm).unwrap();
        bytes.extend(end_frame());
        let mut reader = &bytes[..];
        assert_eq!(read_frame(&mut reader).unwrap(), Some(pcm));
        assert_eq!(read_frame(&mut reader).unwrap(), None);
        assert!(read_frame(&mut &[][..]).is_err());
        assert!(audio_frame(&[1, 2, 3]).is_err());
        assert!(
            read_frame(&mut &error_frame("Stream interrupted")[..])
                .unwrap_err()
                .to_string()
                .contains("Stream interrupted")
        );
        assert!(read_frame(&mut &(MAX_CHUNK as u32 + 8).to_le_bytes()[..]).is_err());
    }
}
