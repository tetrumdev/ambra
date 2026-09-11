use std::{
    collections::VecDeque,
    fs::File,
    io::{self, Cursor, Read, Seek, SeekFrom},
    path::Path,
    sync::{Mutex, OnceLock},
    thread,
    time::{Duration, Instant},
};

use reqwest::{
    StatusCode, Url,
    blocking::Client,
    header::{CONTENT_LENGTH, CONTENT_RANGE, RANGE},
};
use symphonia::core::{
    codecs::audio::{AudioDecoder, AudioDecoderOptions},
    errors::Error as SymphoniaError,
    formats::probe::Hint,
    formats::{FormatOptions, FormatReader, SeekMode, SeekTo, TrackType},
    io::{MediaSource, MediaSourceStream},
    meta::MetadataOptions,
    units::{Time, Timestamp},
};

use super::StreamSpec;

const HTTP_INITIAL_CACHE_BYTES: u64 = 128 * 1024;
const HTTP_STARTUP_WINDOW_BYTES: u64 = 1024 * 1024;
const HTTP_CACHE_BYTES: u64 = 4 * 1024 * 1024;
const HTTP_ATTEMPTS: usize = 3;

struct CachedHttpRange {
    url: String,
    range: String,
    headers: reqwest::header::HeaderMap,
    bytes: Vec<u8>,
    saved_at: Instant,
}

fn http_range_cache() -> &'static Mutex<VecDeque<CachedHttpRange>> {
    static CACHE: OnceLock<Mutex<VecDeque<CachedHttpRange>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(VecDeque::new()))
}

fn cacheable_audio_range(range: Option<&str>) -> bool {
    let Some((start, end)) = range
        .and_then(|value| value.strip_prefix("bytes="))
        .and_then(|value| value.split_once('-'))
    else {
        return false;
    };
    let (Ok(start), Ok(end)) = (start.parse::<u64>(), end.parse::<u64>()) else {
        return false;
    };
    end.checked_sub(start).is_some_and(|length| {
        length < HTTP_INITIAL_CACHE_BYTES && (start < HTTP_STARTUP_WINDOW_BYTES || length < 4096)
    })
}

pub struct DecodedSource {
    source: String,
    format: Box<dyn FormatReader>,
    decoder: Box<dyn AudioDecoder>,
    track_id: u32,
    spec: StreamSpec,
    duration_seconds: f64,
    scratch: Vec<f64>,
    scratch_pending: bool,
}

impl DecodedSource {
    pub fn open(source: String) -> Result<Self, String> {
        Self::open_hls_position(source, None)
    }

    pub fn open_at(source: String, position_seconds: f64) -> Result<Self, String> {
        if position_seconds > 0.0 && is_http_source(&source) && source_path(&source).ends_with(".m3u8")
        {
            return Self::open_hls_position(source, Some(position_seconds));
        }
        let mut decoder = Self::open(source)?;
        if position_seconds > 0.0 {
            decoder.seek(position_seconds)?;
        }
        Ok(decoder)
    }

    fn open_hls_position(
        source: String,
        hls_position_seconds: Option<f64>,
    ) -> Result<Self, String> {
        let mut hint = Hint::new();
        let is_hls = is_http_source(&source) && source_path(&source).ends_with(".m3u8");
        if is_hls {
            hint.with_extension("m4a");
        } else if let Some(extension) = source_extension(&source) {
            hint.with_extension(extension);
        }

        let mut duration_hint = None;
        let mut hls_segment_start = 0.0;
        let media_source: Box<dyn MediaSource> = if is_hls {
            let (hls, segment_start) =
                HlsSource::open_at(&source, hls_position_seconds.unwrap_or_default())
                    .map_err(|error| error.to_string())?;
            duration_hint = Some(hls.duration_seconds);
            hls_segment_start = segment_start;
            Box::new(hls)
        } else if is_http_source(&source) {
            Box::new(HttpRangeSource::open(&source).map_err(|error| error.to_string())?)
        } else {
            let path = file_path(&source);
            Box::new(
                File::open(&path)
                    .map_err(|error| format!("Could not open audio source {path}: {error}"))?,
            )
        };

        let stream = MediaSourceStream::new(media_source, Default::default());
        let format_options = FormatOptions::default().seek_index_fill_period_ms(100);
        let format = symphonia::default::get_probe()
            .probe(&hint, stream, format_options, MetadataOptions::default())
            .map_err(|error| format!("Could not identify {source}: {error}"))?;

        let track = format
            .default_track(TrackType::Audio)
            .or_else(|| format.first_track_known_codec(TrackType::Audio))
            .cloned()
            .ok_or_else(|| format!("No decodable audio track was found in {source}"))?;
        let codec_parameters = track
            .codec_params
            .as_ref()
            .and_then(|parameters| parameters.audio())
            .ok_or_else(|| format!("Audio codec parameters are missing for {source}"))?;
        let sample_rate = codec_parameters
            .sample_rate
            .ok_or_else(|| format!("The sample rate is unknown for {source}"))?;
        let channels = codec_parameters
            .channels
            .as_ref()
            .map(|channels| channels.count())
            .filter(|channels| *channels > 0)
            .ok_or_else(|| format!("The channel layout is unknown for {source}"))?;
        let bits_per_sample = codec_parameters
            .bits_per_coded_sample
            .or(codec_parameters.bits_per_sample)
            .unwrap_or(32)
            .clamp(8, 32) as u16;
        let decoder = symphonia::default::get_codecs()
            .make_audio_decoder(codec_parameters, &AudioDecoderOptions::default())
            .map_err(|error| format!("Could not create an audio decoder for {source}: {error}"))?;
        let duration_seconds = track
            .time_base
            .zip(track.duration)
            .and_then(|(time_base, duration)| {
                i64::try_from(duration.get())
                    .ok()
                    .and_then(|duration| time_base.calc_time(Timestamp::new(duration)))
            })
            .map(|time| time.as_secs_f64())
            .or_else(|| {
                track
                    .num_frames
                    .map(|frames| frames as f64 / f64::from(sample_rate))
            })
            .filter(|duration| *duration > 0.0)
            .unwrap_or(0.0);
        // A fragmented MP4 reader may report only the first loaded fragment.
        // The VOD playlist describes the complete track, including when seeking.
        let duration_seconds = duration_hint.unwrap_or(duration_seconds);

        let mut decoded = Self {
            source,
            format,
            decoder,
            track_id: track.id,
            spec: StreamSpec {
                sample_rate,
                channels,
                bits_per_sample,
            },
            duration_seconds,
            scratch: Vec::with_capacity(16_384 * channels),
            scratch_pending: false,
        };
        if let Some(position_seconds) = hls_position_seconds {
            decoded.skip_frames((position_seconds - hls_segment_start).max(0.0))?;
        }
        Ok(decoded)
    }

    pub fn spec(&self) -> StreamSpec {
        self.spec
    }

    pub fn duration_seconds(&self) -> f64 {
        self.duration_seconds
    }

    pub fn seek(&mut self, position_seconds: f64) -> Result<(), String> {
        let time = Time::try_from_secs_f64(position_seconds.max(0.0))
            .ok_or_else(|| "The requested seek position is invalid".to_owned())?;
        let seek_result = self.format.seek(
            SeekMode::Accurate,
            SeekTo::Time {
                time,
                track_id: Some(self.track_id),
            },
        );
        if let Err(error) = seek_result {
            if is_http_source(&self.source) && source_path(&self.source).ends_with(".m3u8") {
                return self.reopen_hls_at(position_seconds);
            }
            return Err(format!("Could not seek {}: {error}", self.source));
        }
        self.decoder.reset();
        self.scratch.clear();
        self.scratch_pending = false;
        Ok(())
    }

    pub fn decode_next(&mut self) -> Result<Option<&[f64]>, String> {
        if self.scratch_pending {
            self.scratch_pending = false;
            return Ok(Some(&self.scratch));
        }
        loop {
            let packet = match self.format.next_packet() {
                Ok(Some(packet)) => packet,
                Ok(None) => return Ok(None),
                Err(SymphoniaError::ResetRequired) => {
                    return Err(format!(
                        "The audio stream layout changed while decoding {}",
                        self.source
                    ));
                }
                Err(error) => {
                    return Err(format!("Could not read {}: {error}", self.source));
                }
            };
            if packet.track_id != self.track_id {
                continue;
            }

            match self.decoder.decode(&packet) {
                Ok(decoded) => {
                    decoded.copy_to_vec_interleaved(&mut self.scratch);
                    if !self.scratch.is_empty() {
                        return Ok(Some(&self.scratch));
                    }
                }
                Err(SymphoniaError::DecodeError(_)) | Err(SymphoniaError::IoError(_)) => continue,
                Err(error) => {
                    return Err(format!("Could not decode {}: {error}", self.source));
                }
            }
        }
    }

    fn reopen_hls_at(&mut self, position_seconds: f64) -> Result<(), String> {
        *self = Self::open_hls_position(self.source.clone(), Some(position_seconds))?;
        Ok(())
    }

    fn skip_frames(&mut self, seconds: f64) -> Result<(), String> {
        let target_frames = (seconds * f64::from(self.spec.sample_rate)).round() as u64;
        let mut skipped_frames = 0_u64;
        while skipped_frames < target_frames {
            let channels = self.spec.channels;
            let Some(samples) = self.decode_next()? else {
                break;
            };
            let frames = samples.len() / channels;
            let remaining = target_frames.saturating_sub(skipped_frames) as usize;
            if remaining < frames {
                self.scratch.drain(..remaining * channels);
                self.scratch_pending = true;
                break;
            }
            skipped_frames = skipped_frames.saturating_add(frames as u64);
        }
        Ok(())
    }
}

fn is_http_source(source: &str) -> bool {
    source.starts_with("http://") || source.starts_with("https://")
}

fn source_path(source: &str) -> &str {
    source.split(['?', '#']).next().unwrap_or(source)
}

fn source_extension(source: &str) -> Option<&str> {
    Path::new(source_path(source)).extension()?.to_str()
}

fn file_path(source: &str) -> String {
    source.strip_prefix("file://").unwrap_or(source).to_owned()
}

struct HlsSource {
    client: Client,
    resources: VecDeque<Url>,
    current: Option<Cursor<Vec<u8>>>,
    position: u64,
    duration_seconds: f64,
}

impl HlsSource {
    fn open_at(url: &str, position_seconds: f64) -> io::Result<(Self, f64)> {
        let client = http_client()?;
        let playlist_url = Url::parse(url).map_err(io_other)?;
        let (_, _, playlist_bytes) = get_bytes_with_retry(&client, playlist_url.as_str(), None)?;
        let playlist = String::from_utf8(playlist_bytes).map_err(io_other)?;
        let playlist = parse_hls_playlist(&playlist_url, &playlist)?;
        let (segment_index, segment_start) = playlist.segment_at(position_seconds);
        let resources = std::iter::once(playlist.initialization)
            .chain(
                playlist
                    .segments
                    .into_iter()
                    .skip(segment_index)
                    .map(|segment| segment.url),
            )
            .collect();
        Ok((
            Self {
                client,
                resources,
                current: None,
                position: 0,
                duration_seconds: playlist.duration_seconds,
            },
            segment_start,
        ))
    }

    fn open_next_resource(&mut self) -> io::Result<bool> {
        let Some(url) = self.resources.pop_front() else {
            return Ok(false);
        };
        let (_, _, bytes) = get_bytes_with_retry(&self.client, url.as_str(), None)?;
        self.current = Some(Cursor::new(bytes));
        Ok(true)
    }
}

impl Read for HlsSource {
    fn read(&mut self, destination: &mut [u8]) -> io::Result<usize> {
        if destination.is_empty() {
            return Ok(0);
        }
        loop {
            if self.current.is_none() && !self.open_next_resource()? {
                return Ok(0);
            }
            let count = self
                .current
                .as_mut()
                .expect("HLS resource disappeared")
                .read(destination)?;
            if count == 0 {
                self.current = None;
                continue;
            }
            self.position = self.position.saturating_add(count as u64);
            return Ok(count);
        }
    }
}

impl Seek for HlsSource {
    fn seek(&mut self, position: SeekFrom) -> io::Result<u64> {
        match position {
            SeekFrom::Current(0) => Ok(self.position),
            _ => Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "Segmented HLS is a forward-only stream",
            )),
        }
    }
}

impl MediaSource for HlsSource {
    fn is_seekable(&self) -> bool {
        false
    }

    fn byte_len(&self) -> Option<u64> {
        None
    }
}

struct HlsSegment {
    url: Url,
    duration_seconds: f64,
}

struct HlsPlaylist {
    initialization: Url,
    segments: Vec<HlsSegment>,
    duration_seconds: f64,
}

impl HlsPlaylist {
    fn segment_at(&self, position_seconds: f64) -> (usize, f64) {
        let target = position_seconds.max(0.0);
        let mut start = 0.0;
        for (index, segment) in self.segments.iter().enumerate() {
            if target < start + segment.duration_seconds || index + 1 == self.segments.len() {
                return (index, start);
            }
            start += segment.duration_seconds;
        }
        (0, 0.0)
    }
}

fn parse_hls_playlist(base: &Url, playlist: &str) -> io::Result<HlsPlaylist> {
    let mut initialization = None;
    let mut segments = Vec::new();
    let mut duration_seconds = 0.0;
    let mut next_duration = None;
    for line in playlist
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
    {
        if let Some(attributes) = line.strip_prefix("#EXT-X-MAP:") {
            let uri = quoted_attribute(attributes, "URI=").ok_or_else(|| {
                io::Error::new(io::ErrorKind::InvalidData, "HLS map URI is missing")
            })?;
            initialization = Some(base.join(uri).map_err(io_other)?);
        } else if let Some(duration) = line.strip_prefix("#EXTINF:") {
            next_duration = Some(
                duration
                    .split_once(',')
                    .map_or(duration, |(duration, _)| duration)
                    .parse::<f64>()
                    .map_err(io_other)?,
            );
        } else if !line.starts_with('#') {
            let segment_duration = next_duration.take().ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::InvalidData,
                    "HLS segment duration is missing",
                )
            })?;
            duration_seconds += segment_duration;
            segments.push(HlsSegment {
                url: base.join(line).map_err(io_other)?,
                duration_seconds: segment_duration,
            });
        }
    }
    let initialization = initialization.ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            "HLS initialization map is missing",
        )
    })?;
    if segments.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "HLS playlist contains no media segments",
        ));
    }
    Ok(HlsPlaylist {
        initialization,
        segments,
        duration_seconds,
    })
}

fn quoted_attribute<'a>(attributes: &'a str, name: &str) -> Option<&'a str> {
    let value = attributes.split(name).nth(1)?;
    let value = value.strip_prefix('"')?;
    value.split_once('"').map(|(value, _)| value)
}

struct HttpRangeSource {
    client: Client,
    url: String,
    position: u64,
    length: u64,
    cache_start: u64,
    cache: Vec<u8>,
    initial_cache: Vec<u8>,
}

impl HttpRangeSource {
    fn open(url: &str) -> io::Result<Self> {
        let client = http_client()?;
        let range = format!("bytes=0-{}", HTTP_INITIAL_CACHE_BYTES - 1);
        let (status, headers, bytes) = get_bytes_with_retry(&client, url, Some(&range))?;
        let length = if status == StatusCode::PARTIAL_CONTENT {
            content_range_length(headers.get(CONTENT_RANGE))
        } else {
            headers
                .get(CONTENT_LENGTH)
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.parse().ok())
        }
        .or_else(|| (!bytes.is_empty()).then_some(bytes.len() as u64))
        .ok_or_else(|| io::Error::other("The server did not report the audio stream length"))?;

        Ok(Self {
            client,
            url: url.to_owned(),
            position: 0,
            length,
            cache_start: 0,
            initial_cache: bytes[..bytes.len().min(HTTP_INITIAL_CACHE_BYTES as usize)].to_vec(),
            cache: bytes,
        })
    }

    fn refill(&mut self) -> io::Result<()> {
        if self.position >= self.length {
            self.cache.clear();
            return Ok(());
        }
        // Metadata probes may seek to the tail and then back to the audio header.
        // Keep that small opening range instead of downloading it twice.
        if self.position < self.initial_cache.len() as u64 {
            self.cache_start = 0;
            self.cache.clone_from(&self.initial_cache);
            return Ok(());
        }
        let cache_bytes = if self.position < HTTP_STARTUP_WINDOW_BYTES {
            HTTP_INITIAL_CACHE_BYTES
        } else {
            HTTP_CACHE_BYTES
        };
        let end = self
            .position
            .saturating_add(cache_bytes - 1)
            .min(self.length - 1);
        let range = format!("bytes={}-{}", self.position, end);
        let (status, _, bytes) = get_bytes_with_retry(&self.client, &self.url, Some(&range))?;
        self.cache_start = if status == StatusCode::PARTIAL_CONTENT {
            self.position
        } else {
            0
        };
        self.cache = bytes;
        Ok(())
    }

    fn cache_offset(&self) -> Option<usize> {
        let offset = self.position.checked_sub(self.cache_start)?;
        (offset < self.cache.len() as u64).then_some(offset as usize)
    }
}

fn http_client() -> io::Result<Client> {
    static CLIENT: OnceLock<Result<Client, String>> = OnceLock::new();
    CLIENT.get_or_init(|| Client::builder()
        .connect_timeout(Duration::from_secs(3))
        .timeout(Duration::from_secs(20))
        .pool_idle_timeout(Duration::from_secs(90))
        .tcp_keepalive(Duration::from_secs(30))
        .build()
        .map_err(|error| error.to_string()))
        .as_ref()
        .cloned()
        .map_err(|error| io::Error::other(error.clone()))
}

fn get_bytes_with_retry(
    client: &Client,
    url: &str,
    range: Option<&str>,
) -> io::Result<(StatusCode, reqwest::header::HeaderMap, Vec<u8>)> {
    let cacheable = cacheable_audio_range(range);
    if cacheable {
        if let Ok(mut cache) = http_range_cache().lock() {
            cache.retain(|entry| entry.saved_at.elapsed() < Duration::from_secs(120));
            if let Some(index) = cache
                .iter()
                .position(|entry| entry.url == url && Some(entry.range.as_str()) == range)
            {
                let entry = cache.remove(index).unwrap();
                let result = (
                    StatusCode::PARTIAL_CONTENT,
                    entry.headers.clone(),
                    entry.bytes.clone(),
                );
                cache.push_back(entry);
                return Ok(result);
            }
        }
    }
    #[cfg(test)]
    let started = std::time::Instant::now();
    let mut last_error = None;
    for attempt in 0..HTTP_ATTEMPTS {
        let mut request = client.get(url);
        if let Some(range) = range {
            request = request.header(RANGE, range);
        }
        match request
            .send()
            .and_then(|response| response.error_for_status())
        {
            Ok(response) => {
                let status = response.status();
                let headers = response.headers().clone();
                match response.bytes() {
                    Ok(bytes) => {
                        if cacheable
                            && status == StatusCode::PARTIAL_CONTENT
                            && bytes.len() <= HTTP_INITIAL_CACHE_BYTES as usize
                        {
                            if let Ok(mut cache) = http_range_cache().lock() {
                                cache.retain(|entry| {
                                    !(entry.url == url && Some(entry.range.as_str()) == range)
                                });
                                while cache.len() >= 64 {
                                    cache.pop_front();
                                }
                                cache.push_back(CachedHttpRange {
                                    url: url.to_owned(),
                                    range: range.unwrap().to_owned(),
                                    headers: headers.clone(),
                                    bytes: bytes.to_vec(),
                                    saved_at: Instant::now(),
                                });
                            }
                        }
                        #[cfg(test)]
                        if std::env::var_os("AMBRA_PROBE_TIMING").is_some() {
                            println!(
                                "Audio fetch {}: {} bytes in {:?}",
                                range.unwrap_or("resource"),
                                bytes.len(),
                                started.elapsed()
                            );
                        }
                        return Ok((status, headers, bytes.to_vec()));
                    }
                    Err(error) => last_error = Some(error.to_string()),
                }
            }
            Err(error) => last_error = Some(error.to_string()),
        }
        if attempt + 1 < HTTP_ATTEMPTS {
            thread::sleep(Duration::from_millis(100 * (1_u64 << attempt)));
        }
    }
    Err(io::Error::other(format!(
        "Network audio request failed after {HTTP_ATTEMPTS} attempts: {}",
        last_error.unwrap_or_else(|| "unknown error".to_owned())
    )))
}

impl Read for HttpRangeSource {
    fn read(&mut self, destination: &mut [u8]) -> io::Result<usize> {
        if destination.is_empty() || self.position >= self.length {
            return Ok(0);
        }
        let mut written = 0;
        while written < destination.len() && self.position < self.length {
            if self.cache_offset().is_none() {
                self.refill()?;
            }
            let Some(offset) = self.cache_offset() else {
                break;
            };
            let available = self.cache.len() - offset;
            let count = available.min(destination.len() - written);
            destination[written..written + count]
                .copy_from_slice(&self.cache[offset..offset + count]);
            self.position += count as u64;
            written += count;
        }
        Ok(written)
    }
}

impl Seek for HttpRangeSource {
    fn seek(&mut self, position: SeekFrom) -> io::Result<u64> {
        let next = match position {
            SeekFrom::Start(position) => i128::from(position),
            SeekFrom::Current(delta) => i128::from(self.position) + i128::from(delta),
            SeekFrom::End(delta) => i128::from(self.length) + i128::from(delta),
        };
        if !(0..=i128::from(self.length)).contains(&next) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "Audio stream seek is outside the source",
            ));
        }
        self.position = next as u64;
        Ok(self.position)
    }
}

impl MediaSource for HttpRangeSource {
    fn is_seekable(&self) -> bool {
        true
    }

    fn byte_len(&self) -> Option<u64> {
        Some(self.length)
    }
}

fn content_range_length(value: Option<&reqwest::header::HeaderValue>) -> Option<u64> {
    value?.to_str().ok()?.rsplit_once('/')?.1.parse().ok()
}

fn io_other(error: impl std::fmt::Display) -> io::Error {
    io::Error::other(error.to_string())
}

#[cfg(test)]
mod tests {
    use std::{fs, mem::size_of, process, time::SystemTime};

    use super::{
        DecodedSource, content_range_length, file_path, parse_hls_playlist, source_extension,
    };
    use reqwest::Url;
    use reqwest::header::HeaderValue;

    #[test]
    fn extracts_source_extensions_without_query_parameters() {
        assert_eq!(
            source_extension("https://audio.test/track.flac?token=1"),
            Some("flac")
        );
        assert_eq!(source_extension("C:\\Music\\track.wav"), Some("wav"));
    }

    #[test]
    fn strips_file_url_prefixes() {
        assert_eq!(file_path("file:///Music/track.flac"), "/Music/track.flac");
    }

    #[test]
    fn parses_http_content_range_lengths() {
        let value = HeaderValue::from_static("bytes 0-0/12345");
        assert_eq!(content_range_length(Some(&value)), Some(12_345));
    }

    #[test]
    fn resolves_hls_initialization_and_media_resources() {
        let base = Url::parse("http://127.0.0.1/tracks/1/playlist.m3u8").unwrap();
        let playlist = "#EXTM3U\n#EXT-X-MAP:URI=\"dash/init\"\n#EXTINF:4.5,\ndash/1\n#EXTINF:2.0,\nhttps://audio.test/2\n";
        let parsed = parse_hls_playlist(&base, playlist).unwrap();
        assert_eq!(parsed.duration_seconds, 6.5);
        assert_eq!(
            parsed.initialization.as_str(),
            "http://127.0.0.1/tracks/1/dash/init"
        );
        assert_eq!(
            parsed.segments[0].url.as_str(),
            "http://127.0.0.1/tracks/1/dash/1"
        );
        assert_eq!(parsed.segments[1].url.as_str(), "https://audio.test/2");
        assert_eq!(parsed.segment_at(5.0), (1, 4.5));
    }

    #[test]
    fn metadata_tail_probe_does_not_discard_initial_audio_bytes() {
        use std::io::{Read, Seek, SeekFrom};
        let mut source = super::HttpRangeSource {
            client: super::http_client().unwrap(),
            url: "http://127.0.0.1:0/must-not-fetch".into(),
            position: 1000,
            length: 1004,
            cache_start: 1000,
            cache: vec![9; 4],
            initial_cache: vec![1, 2, 3, 4],
        };
        let mut bytes = [0; 4];
        source.read_exact(&mut bytes).unwrap();
        assert_eq!(bytes, [9; 4]);
        source.seek(SeekFrom::Start(0)).unwrap();
        source.read_exact(&mut bytes).unwrap();
        assert_eq!(bytes, [1, 2, 3, 4]);
    }

    #[test]
    #[ignore = "requires a running server and AMBRA_PROBE_SOURCE; decodes without audio output"]
    fn measures_network_decode_startup() {
        let source = std::env::var("AMBRA_PROBE_SOURCE").expect("set AMBRA_PROBE_SOURCE");
        let position = std::env::var("AMBRA_PROBE_POSITION")
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or(0.0);
        let started = std::time::Instant::now();
        let mut decoder = DecodedSource::open_at(source, position).unwrap();
        let spec = decoder.spec();
        let target = spec.sample_rate as usize * spec.channels / 2;
        let mut samples = 0;
        while samples < target {
            let Some(block) = decoder.decode_next().unwrap() else {
                break;
            };
            samples += block.len();
        }
        assert!(
            samples >= target,
            "expected at least half a second of audio"
        );
        println!(
            "Half-second prebuffer ready in {:?}; track duration {:.3}s; {} Hz / {} channels",
            started.elapsed(),
            decoder.duration_seconds(),
            spec.sample_rate,
            spec.channels
        );
        let replay_started = std::time::Instant::now();
        let mut replay =
            DecodedSource::open_at(std::env::var("AMBRA_PROBE_SOURCE").unwrap(), position).unwrap();
        let mut replay_samples = 0;
        while replay_samples < target {
            let Some(block) = replay.decode_next().unwrap() else {
                break;
            };
            replay_samples += block.len();
        }
        assert!(replay_samples >= target);
        println!(
            "Replay half-second prebuffer ready in {:?}",
            replay_started.elapsed()
        );
    }

    #[test]
    fn restored_hls_starts_at_target_segment_and_preserves_remaining_samples() {
        use std::{
            io::{Read, Write},
            net::TcpListener,
            sync::{
                Arc,
                atomic::{AtomicBool, Ordering},
            },
            thread,
            time::{Duration, Instant},
        };
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let source = format!("http://{}/playlist.m3u8", listener.local_addr().unwrap());
        let stopped = Arc::new(AtomicBool::new(false));
        let stop = stopped.clone();
        let server = thread::spawn(move || {
            let mut paths = Vec::new();
            let deadline = Instant::now() + Duration::from_secs(10);
            while !stop.load(Ordering::SeqCst) && Instant::now() < deadline {
                let Ok((mut stream, _)) = listener.accept() else {
                    thread::sleep(Duration::from_millis(1));
                    continue;
                };
                stream
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let mut request = [0; 4096];
                let count = stream.read(&mut request).unwrap();
                let request = String::from_utf8_lossy(&request[..count]);
                let path = request.split_whitespace().nth(1).unwrap().to_owned();
                let playlist = format!(
                    "#EXTM3U\n#EXT-X-MAP:URI=\"init\"\n#EXTINF:{0},\nfirst\n#EXTINF:{0},\nsecond\n#EXTINF:{1},\nthird\n#EXT-X-ENDLIST\n",
                    179712.0 / 44100.0,
                    12.0 - 2.0 * 179712.0 / 44100.0
                );
                let bytes: &[u8] = match path.as_str() {
                    "/playlist.m3u8" => playlist.as_bytes(),
                    "/init" => include_bytes!("../../tests/fixtures/hls/init.mp4"),
                    "/second" => include_bytes!("../../tests/fixtures/hls/second.m4s"),
                    "/third" => include_bytes!("../../tests/fixtures/hls/third.m4s"),
                    _ => b"",
                };
                paths.push(path);
                write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    bytes.len()
                )
                .unwrap();
                stream.write_all(bytes).unwrap();
            }
            paths
        });
        let decoded = (|| {
            let mut decoder = DecodedSource::open_at(source, 5.0)?;
            let mut samples = 0;
            while let Some(block) = decoder.decode_next()? {
                samples += block.len();
            }
            Ok::<_, String>((samples, decoder.duration_seconds()))
        })();
        stopped.store(true, Ordering::SeqCst);
        let paths = server.join().unwrap();
        let (samples, duration) = decoded.unwrap();
        assert_eq!(paths, ["/playlist.m3u8", "/init", "/second", "/third"]);
        assert_eq!(samples, 7 * 44100 * 2);
        assert!(
            (duration - 12.0).abs() < 0.001,
            "decoded duration: {duration}"
        );
    }

    #[test]
    fn decodes_integer_pcm_without_losing_sample_values() {
        let nonce = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path =
            std::env::temp_dir().join(format!("ambra-decoder-{}-{nonce}.wav", process::id()));
        let samples = [i16::MIN, i16::MAX, -1, 1, 0, 16_384, -16_384, 0];
        let data_size = (samples.len() * size_of::<i16>()) as u32;
        let mut wav = Vec::with_capacity(44 + data_size as usize);
        wav.extend_from_slice(b"RIFF");
        wav.extend_from_slice(&(36 + data_size).to_le_bytes());
        wav.extend_from_slice(b"WAVEfmt ");
        wav.extend_from_slice(&16_u32.to_le_bytes());
        wav.extend_from_slice(&1_u16.to_le_bytes());
        wav.extend_from_slice(&2_u16.to_le_bytes());
        wav.extend_from_slice(&48_000_u32.to_le_bytes());
        wav.extend_from_slice(&(48_000_u32 * 4).to_le_bytes());
        wav.extend_from_slice(&4_u16.to_le_bytes());
        wav.extend_from_slice(&16_u16.to_le_bytes());
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&data_size.to_le_bytes());
        for sample in samples {
            wav.extend_from_slice(&sample.to_le_bytes());
        }
        fs::write(&path, wav).unwrap();

        let mut decoder = DecodedSource::open(path.to_string_lossy().into_owned()).unwrap();
        let decoded = decoder.decode_next().unwrap().unwrap();
        let expected = samples.map(|sample| f64::from(sample) / 32_768.0);
        assert_eq!(&decoded[..expected.len()], &expected);

        fs::remove_file(path).unwrap();
    }
}
