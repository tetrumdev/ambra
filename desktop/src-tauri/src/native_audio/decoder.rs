use std::{
    collections::VecDeque,
    fs::File,
    io::{self, Read, Seek, SeekFrom},
    path::Path,
    sync::{Mutex, OnceLock},
    thread,
    time::{Duration, Instant},
};

use reqwest::{
    StatusCode, Url,
    blocking::Client,
    header::{CONTENT_RANGE, RANGE},
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

use super::{
    AudioQuality, StreamSpec,
    loudness::{self, LoudnessInfo, LoudnessMeter},
};

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
    end.checked_sub(start)
        .is_some_and(|length| length < HTTP_INITIAL_CACHE_BYTES)
}

fn cached_http_range(url: &str, range: &str) -> Option<(reqwest::header::HeaderMap, Vec<u8>)> {
    let mut cache = http_range_cache().lock().ok()?;
    cache.retain(|entry| entry.saved_at.elapsed() < Duration::from_secs(120));
    let index = cache
        .iter()
        .position(|entry| entry.url == url && entry.range == range)?;
    let entry = cache.remove(index)?;
    let result = (entry.headers.clone(), entry.bytes.clone());
    cache.push_back(entry);
    Some(result)
}

fn save_http_range(mut entry: CachedHttpRange) {
    if let Ok(mut cache) = http_range_cache().lock() {
        cache.retain(|saved| saved.url != entry.url || saved.range != entry.range);
        while cache.len() >= 64 {
            cache.pop_front();
        }
        entry.saved_at = Instant::now();
        cache.push_back(entry);
    }
}

pub struct DecodedSource(Decoded);
enum Decoded {
    File(Box<FileDecodedSource>),
    Live(Box<super::live::LivePcm>),
}
impl DecodedSource {
    pub fn open(source: String) -> Result<Self, String> {
        Self::open_at(source, 0.0)
    }
    pub fn open_at(source: String, position: f64) -> Result<Self, String> {
        if is_live_source(&source) {
            return super::live::LivePcm::open(source, position)
                .map(|live| Self(Decoded::Live(Box::new(live))));
        }
        FileDecodedSource::open_at(source, position).map(|file| Self(Decoded::File(Box::new(file))))
    }
    pub fn spec(&self) -> StreamSpec {
        match &self.0 {
            Decoded::File(file) => file.spec(),
            Decoded::Live(live) => live.spec(),
        }
    }
    pub fn duration_seconds(&self) -> f64 {
        match &self.0 {
            Decoded::File(file) => file.duration_seconds(),
            Decoded::Live(live) => live.duration_seconds(),
        }
    }
    pub fn audio_quality(&self) -> AudioQuality {
        match &self.0 {
            Decoded::File(file) => file.audio_quality(),
            Decoded::Live(live) => live.audio_quality(),
        }
    }
    pub fn loudness(&self) -> LoudnessInfo {
        match &self.0 {
            Decoded::File(file) => file.loudness(),
            Decoded::Live(_) => LoudnessInfo::default(),
        }
    }
    pub fn decode_next(&mut self) -> Result<Option<&[f64]>, String> {
        match &mut self.0 {
            Decoded::File(file) => file.decode_next(),
            Decoded::Live(live) => live.decode_next(),
        }
    }
}
pub(super) fn is_live_source(source: &str) -> bool {
    live_stream_id(source).is_some()
}

/// Live URLs may be direct server URLs or include the native bridge's per-process capability.
pub(super) fn live_stream_id(source: &str) -> Option<String> {
    let url = Url::parse(source).ok()?;
    if !matches!(url.scheme(), "http" | "https") {
        return None;
    }
    let path = url.path();
    let api_path = if let Some(path) = path.strip_prefix("/api/") {
        path
    } else {
        let (capability, path) = path.strip_prefix('/')?.split_once('/')?;
        if capability.len() != 64 || !capability.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return None;
        }
        path.strip_prefix("api/")?
    };
    let id = api_path.strip_prefix("playback/live/")?;
    (!id.is_empty() && !id.contains('/')).then(|| id.to_owned())
}

struct FileDecodedSource {
    source: String,
    format: Box<dyn FormatReader>,
    decoder: Box<dyn AudioDecoder>,
    track_id: u32,
    spec: StreamSpec,
    duration_seconds: f64,
    audio_quality: AudioQuality,
    scratch: Vec<f64>,
    scratch_pending: bool,
    loudness: LoudnessInfo,
    meter: Option<LoudnessMeter>,
}

impl FileDecodedSource {
    pub fn open(source: String) -> Result<Self, String> {
        Self::open_hls_position(source, None)
    }

    pub fn open_at(source: String, position_seconds: f64) -> Result<Self, String> {
        if position_seconds > 0.0
            && is_http_source(&source)
            && source_path(&source).ends_with(".m3u8")
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
        let mut reported_loudness = LoudnessInfo::default();
        let media_source: Box<dyn MediaSource> = if is_hls {
            let (hls, segment_start) =
                HlsSource::open_at(&source, hls_position_seconds.unwrap_or_default())
                    .map_err(|error| error.to_string())?;
            duration_hint = Some(hls.duration_seconds);
            hls_segment_start = segment_start;
            reported_loudness = hls.loudness;
            Box::new(hls)
        } else if is_http_source(&source) {
            let http = HttpRangeSource::open(&source).map_err(|error| error.to_string())?;
            reported_loudness = http.loudness;
            Box::new(http)
        } else {
            let path = file_path(&source);
            Box::new(
                File::open(&path)
                    .map_err(|error| format!("Could not open audio source {path}: {error}"))?,
            )
        };

        let source_bytes = media_source.byte_len();
        let stream = MediaSourceStream::new(media_source, Default::default());
        let format_options = FormatOptions::default().seek_index_fill_period_ms(100);
        let mut format = symphonia::default::get_probe()
            .probe(&hint, stream, format_options, MetadataOptions::default())
            .map_err(|error| format!("Could not identify {source}: {error}"))?;
        let tagged_loudness = embedded_loudness(format.as_mut());

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

        let codec = symphonia::default::get_codecs()
            .get_audio_decoder(codec_parameters.codec)
            .map(|registration| registration.codec.info.short_name)
            .unwrap_or("unknown")
            .to_owned();
        // These are source properties. The output's fallback sample width is
        // not evidence of the recording's bit depth.
        let bit_depth = codec_parameters
            .bits_per_coded_sample
            .or(codec_parameters.bits_per_sample)
            .filter(|depth| *depth > 0);
        let is_pcm = codec.starts_with("pcm");
        // Output never exceeds 24 bits. Lossless integer sources up to 24 bits pass through
        // untouched; lossy float decodes and deeper masters sit on no 24-bit grid, so they
        // are dithered down to the device like processed audio.
        let lossless = is_pcm || codec == "flac" || codec == "alac";
        let exact_bits = bit_depth.filter(|depth| lossless && *depth <= 24);
        let bits_per_sample = exact_bits.unwrap_or(24).max(8) as u16;
        let requantize = exact_bits.is_none();
        let bitrate_kbps = if is_pcm {
            bit_depth
                .map(|depth| f64::from(sample_rate) * f64::from(depth) * channels as f64 / 1000.0)
        } else {
            source_bytes
                .filter(|bytes| *bytes > 0)
                .filter(|_| duration_seconds.is_finite() && duration_seconds > 0.0)
                .map(|bytes| bytes as f64 * 8.0 / duration_seconds / 1000.0)
        };
        let audio_quality = AudioQuality {
            codec,
            sample_rate_hz: sample_rate,
            bit_depth,
            channels,
            bitrate_kbps,
            bitrate_is_estimate: !is_pcm,
            normalization_gain_db: None,
            capture_format: None,
            requested_quality: None,
            source_format_verified: None,
        };

        let cache_key = loudness::cache_key(&source);
        let loudness = cache_key
            .as_deref()
            .map(loudness::measured_info)
            .unwrap_or_default()
            .or(tagged_loudness)
            .or(reported_loudness);
        // Only a decode from the very start can measure the whole song.
        let meter = cache_key
            .filter(|_| hls_position_seconds.is_none_or(|position| position <= 0.0))
            .and_then(|key| LoudnessMeter::start(key, channels, sample_rate));
        let mut decoded = Self {
            source,
            format,
            decoder,
            track_id: track.id,
            spec: StreamSpec {
                sample_rate,
                channels,
                bits_per_sample,
                requantize,
            },
            duration_seconds,
            audio_quality,
            scratch: Vec::with_capacity(16_384 * channels),
            scratch_pending: false,
            loudness,
            meter,
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

    pub fn audio_quality(&self) -> AudioQuality {
        self.audio_quality.clone()
    }

    pub fn loudness(&self) -> LoudnessInfo {
        self.loudness
    }

    pub fn seek(&mut self, position_seconds: f64) -> Result<(), String> {
        let time = Time::try_from_secs_f64(position_seconds.max(0.0))
            .ok_or_else(|| "The requested seek position is invalid".to_owned())?;
        // A skipped stretch would make the measurement describe part of the song.
        self.meter = None;
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
                Ok(None) => {
                    if let Some(meter) = self.meter.take() {
                        meter.finish();
                    }
                    return Ok(None);
                }
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
                        if let Some(meter) = self.meter.as_mut()
                            && !meter.add(&self.scratch)
                        {
                            self.meter = None;
                        }
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

/// ReplayGain tags from every metadata revision the probe found, container and ID3 alike.
fn embedded_loudness(format: &mut dyn FormatReader) -> LoudnessInfo {
    let mut metadata = format.metadata();
    let mut loudness = LoudnessInfo::default();
    loop {
        if let Some(revision) = metadata.current() {
            let tags = revision.media.tags.iter().chain(
                revision
                    .per_track
                    .iter()
                    .flat_map(|track| &track.metadata.tags),
            );
            loudness = loudness.or(LoudnessInfo::from_tags(tags));
        }
        if metadata.pop().is_none() {
            break;
        }
    }
    loudness
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
    current: Option<StreamingResource>,
    position: u64,
    duration_seconds: f64,
    loudness: LoudnessInfo,
}

impl HlsSource {
    fn open_at(url: &str, position_seconds: f64) -> io::Result<(Self, f64)> {
        let client = http_client()?;
        let playlist_url = Url::parse(url).map_err(io_other)?;
        let (_, playlist_headers, playlist_bytes) =
            get_bytes_with_retry(&client, playlist_url.as_str(), None)?;
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
                loudness: LoudnessInfo::from_headers(&playlist_headers),
            },
            segment_start,
        ))
    }

    fn open_next_resource(&mut self) -> io::Result<bool> {
        let Some(url) = self.resources.front() else {
            return Ok(false);
        };
        let resource = StreamingResource::open(self.client.clone(), url.to_string())?;
        self.resources.pop_front();
        self.current = Some(resource);
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

/// One forward-only HLS resource. HTTP framing determines EOF when length is
/// unknown; interrupted bodies resume after delivered bytes, never replay them.
struct StreamingResource {
    client: Client,
    url: String,
    response: Option<reqwest::blocking::Response>,
    position: u64,
    length: Option<u64>,
    finished: bool,
}

impl StreamingResource {
    fn open(client: Client, url: String) -> io::Result<Self> {
        let response = get_response_with_retry(&client, &url, None)?;
        if response.status() != StatusCode::OK {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "Unexpected HLS resource response",
            ));
        }
        let length = response.content_length();
        Ok(Self {
            client,
            url,
            response: Some(response),
            position: 0,
            length,
            finished: false,
        })
    }

    fn resume(&mut self) -> io::Result<()> {
        let range = format!("bytes={}-", self.position);
        let mut response = get_response_with_retry(&self.client, &self.url, Some(&range))?;
        let total = if response.status() == StatusCode::PARTIAL_CONTENT {
            let total =
                content_range_length(response.headers().get(CONTENT_RANGE)).ok_or_else(|| {
                    io::Error::new(
                        io::ErrorKind::InvalidData,
                        "HLS Content-Range length is missing",
                    )
                })?;
            if self.length.is_some_and(|length| length != total) {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "HLS resource length changed",
                ));
            }
            let count = validated_range_length(
                response.headers().get(CONTENT_RANGE),
                self.position,
                total.saturating_sub(1),
                total,
            )?;
            if response
                .content_length()
                .is_some_and(|length| length != count)
            {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "HLS range body length is inconsistent",
                ));
            }
            Some(total)
        } else if response.status() == StatusCode::OK {
            let total = response.content_length();
            if self
                .length
                .zip(total)
                .is_some_and(|(before, after)| before != after)
            {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "HLS resource length changed",
                ));
            }
            let skipped = io::copy(&mut response.by_ref().take(self.position), &mut io::sink())?;
            if skipped != self.position {
                return Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "HLS resource ended before resume position",
                ));
            }
            self.length.or(total)
        } else {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "Unexpected HLS resume response",
            ));
        };
        self.length = total;
        self.response = Some(response);
        Ok(())
    }
}

impl Read for StreamingResource {
    fn read(&mut self, destination: &mut [u8]) -> io::Result<usize> {
        if destination.is_empty() || self.finished {
            return Ok(0);
        }
        let mut last_error = None;
        for attempt in 0..HTTP_ATTEMPTS {
            if self.length == Some(self.position) {
                self.finished = true;
                return Ok(0);
            }
            if self.response.is_none() {
                self.resume()?;
            }
            match self
                .response
                .as_mut()
                .expect("HLS response")
                .read(destination)
            {
                Ok(read) if read > 0 => {
                    self.position += read as u64;
                    return Ok(read);
                }
                Ok(_) if self.length.is_none_or(|length| length == self.position) => {
                    self.finished = true;
                    return Ok(0);
                }
                Ok(_) => {
                    last_error = Some(io::Error::new(
                        io::ErrorKind::UnexpectedEof,
                        "HLS resource was truncated",
                    ))
                }
                Err(error) => last_error = Some(error),
            }
            self.response = None;
            if attempt + 1 < HTTP_ATTEMPTS {
                thread::sleep(Duration::from_millis(100 * (1 << attempt)));
            }
        }
        Err(last_error.unwrap_or_else(|| io::Error::other("HLS resource read failed")))
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
    small_reads_until: u64,
    response: Option<reqwest::blocking::Response>,
    response_left: u64,
    response_cache: Option<CachedHttpRange>,
    loudness: LoudnessInfo,
}

impl HttpRangeSource {
    fn open(url: &str) -> io::Result<Self> {
        let client = http_client()?;
        let range = format!("bytes=0-{}", HTTP_INITIAL_CACHE_BYTES - 1);
        if let Some((headers, bytes)) = cached_http_range(url, &range) {
            let length = content_range_length(headers.get(CONTENT_RANGE))
                .ok_or_else(|| io::Error::other("Cached audio length is missing"))?;
            validated_range_length(
                headers.get(CONTENT_RANGE),
                0,
                HTTP_INITIAL_CACHE_BYTES - 1,
                length,
            )?;
            return Ok(Self {
                client,
                url: url.to_owned(),
                position: 0,
                length,
                cache_start: 0,
                initial_cache: bytes.clone(),
                cache: bytes,
                small_reads_until: HTTP_STARTUP_WINDOW_BYTES,
                response: None,
                response_left: 0,
                response_cache: None,
                loudness: LoudnessInfo::from_headers(&headers),
            });
        }
        let response = get_response_with_retry(&client, url, Some(&range))?;
        let status = response.status();
        let headers = response.headers().clone();
        let length = if status == StatusCode::PARTIAL_CONTENT {
            content_range_length(headers.get(CONTENT_RANGE))
        } else if status == StatusCode::OK {
            response.content_length()
        } else {
            None
        };
        let mut source = Self {
            client,
            url: url.to_owned(),
            position: 0,
            length: length.unwrap_or(0),
            cache_start: 0,
            initial_cache: Vec::new(),
            cache: Vec::new(),
            small_reads_until: HTTP_STARTUP_WINDOW_BYTES,
            response: None,
            response_left: 0,
            response_cache: None,
            loudness: LoudnessInfo::from_headers(&headers),
        };
        if length.is_none() && status == StatusCode::OK {
            // A seekable source needs a byte length. Preserve compatibility with
            // servers that ignore Range and omit it; ordinary ranges stream below.
            let bytes = response
                .bytes()
                .map_err(|e| io_other(e.without_url()))?
                .to_vec();
            if bytes.is_empty() {
                return Err(io::Error::other(
                    "The server did not report the audio stream length",
                ));
            }
            source.length = bytes.len() as u64;
            source.initial_cache =
                bytes[..bytes.len().min(HTTP_INITIAL_CACHE_BYTES as usize)].to_vec();
            source.cache = bytes;
        } else {
            source.begin_response(
                response,
                (HTTP_INITIAL_CACHE_BYTES - 1).min(source.length.saturating_sub(1)),
            )?;
        }
        Ok(source)
    }

    fn begin_response(
        &mut self,
        mut response: reqwest::blocking::Response,
        end: u64,
    ) -> io::Result<()> {
        let status = response.status();
        let range = format!("bytes={}-{}", self.position, end);
        let remaining = if status == StatusCode::PARTIAL_CONTENT {
            let count = validated_range_length(
                response.headers().get(CONTENT_RANGE),
                self.position,
                end,
                self.length,
            )?;
            if response
                .content_length()
                .is_some_and(|length| length != count)
            {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "Audio Content-Length does not match Content-Range",
                ));
            }
            count
        } else if status == StatusCode::OK {
            if response
                .content_length()
                .is_some_and(|length| length != self.length)
            {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "Audio length changed during playback",
                ));
            }
            let skipped = io::copy(&mut response.by_ref().take(self.position), &mut io::sink())?;
            if skipped != self.position {
                return Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "Audio response ended before the requested position",
                ));
            }
            end - self.position + 1
        } else {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "Unexpected audio range response",
            ));
        };
        self.response_cache = (status == StatusCode::PARTIAL_CONTENT
            && cacheable_audio_range(Some(&range)))
        .then(|| CachedHttpRange {
            url: self.url.clone(),
            range,
            headers: response.headers().clone(),
            bytes: Vec::new(),
            saved_at: Instant::now(),
        });
        self.cache.clear();
        self.response_left = remaining;
        self.response = Some(response);
        Ok(())
    }

    fn refill(&mut self) -> io::Result<()> {
        if self.position >= self.length {
            self.cache.clear();
            return Ok(());
        }
        // Retain downloaded opening bytes for metadata probes without caching
        // incomplete responses globally or increasing the bounded probe size.
        if self.position < self.initial_cache.len() as u64 {
            self.cache_start = 0;
            self.cache.clone_from(&self.initial_cache);
            return Ok(());
        }
        let count = if self.position < self.small_reads_until {
            HTTP_INITIAL_CACHE_BYTES
        } else {
            HTTP_CACHE_BYTES
        };
        let end = self.position.saturating_add(count - 1).min(self.length - 1);
        let range = format!("bytes={}-{}", self.position, end);
        if let Some((headers, bytes)) = cached_http_range(&self.url, &range) {
            let expected = validated_range_length(
                headers.get(CONTENT_RANGE),
                self.position,
                end,
                self.length,
            )?;
            if bytes.len() as u64 != expected {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "Cached audio range is incomplete",
                ));
            }
            self.cache_start = self.position;
            self.cache = bytes;
            return Ok(());
        }
        let response = get_response_with_retry(&self.client, &self.url, Some(&range))?;
        self.begin_response(response, end)
    }

    fn cache_offset(&self) -> Option<usize> {
        let offset = self.position.checked_sub(self.cache_start)?;
        (offset < self.cache.len() as u64).then_some(offset as usize)
    }
}

fn http_client() -> io::Result<Client> {
    static CLIENT: OnceLock<Result<Client, String>> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            Client::builder()
                .connect_timeout(Duration::from_secs(3))
                .timeout(Duration::from_secs(20))
                .pool_idle_timeout(Duration::from_secs(90))
                .tcp_keepalive(Duration::from_secs(30))
                .build()
                .map_err(|error| error.to_string())
        })
        .as_ref()
        .cloned()
        .map_err(|error| io::Error::other(error.clone()))
}

fn get_response_with_retry(
    client: &Client,
    url: &str,
    range: Option<&str>,
) -> io::Result<reqwest::blocking::Response> {
    let mut last_error = None;
    for attempt in 0..HTTP_ATTEMPTS {
        let mut request = client.get(url);
        if let Some(range) = range {
            request = request.header(RANGE, range);
        }
        match request.send() {
            Ok(response) if response.status().is_success() => return Ok(response),
            Ok(response) => {
                let status = response.status();
                let bytes = response.bytes().unwrap_or_default();
                let server_error = serde_json::from_slice::<serde_json::Value>(&bytes)
                    .ok()
                    .and_then(|body| body.get("error")?.as_str().map(str::to_owned));
                let message = server_error.as_ref().map_or_else(
                    || format!("HTTP status {status}"),
                    |message| format!("HTTP {status}: {message}"),
                );
                if server_error.is_some()
                    || !(status.is_server_error()
                        || status == StatusCode::REQUEST_TIMEOUT
                        || status == StatusCode::TOO_MANY_REQUESTS)
                {
                    return Err(io::Error::new(io::ErrorKind::PermissionDenied, message));
                }
                last_error = Some(message);
            }
            Err(error) => last_error = Some(error.without_url().to_string()),
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

fn get_bytes_with_retry(
    client: &Client,
    url: &str,
    range: Option<&str>,
) -> io::Result<(StatusCode, reqwest::header::HeaderMap, Vec<u8>)> {
    let mut last_error = None;
    for _ in 0..HTTP_ATTEMPTS {
        let response = get_response_with_retry(client, url, range)?;
        let status = response.status();
        let headers = response.headers().clone();
        match response.bytes() {
            Ok(bytes) => return Ok((status, headers, bytes.to_vec())),
            Err(error) => last_error = Some(error.without_url()),
        }
    }
    Err(io_other(last_error.expect("body read failed")))
}

impl Read for HttpRangeSource {
    fn read(&mut self, destination: &mut [u8]) -> io::Result<usize> {
        if destination.is_empty() || self.position >= self.length {
            return Ok(0);
        }
        let mut last_error = None;
        for attempt in 0..HTTP_ATTEMPTS {
            if self.cache_offset().is_none() && self.response.is_none() {
                if let Err(error) = self.refill() {
                    if matches!(
                        error.kind(),
                        io::ErrorKind::InvalidData | io::ErrorKind::PermissionDenied
                    ) {
                        return Err(error);
                    }
                    last_error = Some(error);
                    if attempt + 1 < HTTP_ATTEMPTS {
                        thread::sleep(Duration::from_millis(100 * (1 << attempt)));
                    }
                    continue;
                }
            }
            if let Some(offset) = self.cache_offset() {
                let count = (self.cache.len() - offset).min(destination.len());
                destination[..count].copy_from_slice(&self.cache[offset..offset + count]);
                self.position += count as u64;
                return Ok(count);
            }
            if let Some(response) = self.response.as_mut() {
                let count = (destination.len() as u64).min(self.response_left) as usize;
                match response.read(&mut destination[..count]) {
                    Ok(read) if read > 0 => {
                        if self.position == self.initial_cache.len() as u64
                            && self.position < HTTP_INITIAL_CACHE_BYTES
                        {
                            let count =
                                read.min((HTTP_INITIAL_CACHE_BYTES - self.position) as usize);
                            self.initial_cache.extend_from_slice(&destination[..count]);
                        }
                        if let Some(cache) = self.response_cache.as_mut() {
                            cache.bytes.extend_from_slice(&destination[..read]);
                        }
                        self.position += read as u64;
                        self.response_left -= read as u64;
                        if self.response_left == 0 {
                            self.response = None;
                            if let Some(cache) = self.response_cache.take() {
                                save_http_range(cache);
                            }
                        }
                        return Ok(read);
                    }
                    Ok(_) => {
                        last_error = Some(io::Error::new(
                            io::ErrorKind::UnexpectedEof,
                            "Audio range body was truncated",
                        ))
                    }
                    Err(error) => last_error = Some(error),
                }
                // Resume at the first unread byte. Already delivered audio must
                // never be discarded or replayed after a body timeout.
                self.response = None;
                self.response_cache = None;
                self.response_left = 0;
            } else {
                last_error = Some(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "Audio response was empty",
                ));
            }
            if attempt + 1 < HTTP_ATTEMPTS {
                thread::sleep(Duration::from_millis(100 * (1 << attempt)));
            }
        }
        Err(last_error.unwrap_or_else(|| io::Error::other("Audio range read failed")))
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
        let next = next as u64;
        if next != self.position {
            self.small_reads_until = next.saturating_add(HTTP_STARTUP_WINDOW_BYTES);
            self.response = None;
            self.response_cache = None;
            self.response_left = 0;
        }
        self.position = next;
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

fn validated_range_length(
    value: Option<&reqwest::header::HeaderValue>,
    start: u64,
    end: u64,
    length: u64,
) -> io::Result<u64> {
    let parsed = value
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("bytes "))
        .and_then(|value| value.split_once('/'))
        .and_then(|(range, total)| {
            let (first, last) = range.split_once('-')?;
            Some((
                first.parse::<u64>().ok()?,
                last.parse::<u64>().ok()?,
                total.parse::<u64>().ok()?,
            ))
        });
    match parsed {
        Some((first, last, total))
            if first == start
                && last >= first
                && last <= end
                && last < total
                && total == length =>
        {
            Ok(last - first + 1)
        }
        _ => Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Audio Content-Range does not match the requested bytes",
        )),
    }
}

fn io_other(error: impl std::fmt::Display) -> io::Error {
    io::Error::other(error.to_string())
}

#[cfg(test)]
mod http_streaming_tests {
    use super::*;
    use std::io::{BufRead, BufReader, Write};
    use std::net::TcpListener;
    use std::sync::mpsc;

    fn check_early_resource_read(hls: bool) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let (release, gate) = mpsc::channel();
        let server = thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut request = BufReader::new(socket.try_clone().unwrap());
            loop {
                let mut line = String::new();
                request.read_line(&mut line).unwrap();
                if line == "\r\n" {
                    break;
                }
            }
            if hls {
                write!(
                    socket,
                    "HTTP/1.1 200 OK\r\nContent-Length: 131072\r\nConnection: close\r\n\r\n"
                )
                .unwrap();
            } else {
                write!(socket, "HTTP/1.1 206 Partial Content\r\nContent-Length: 131072\r\nContent-Range: bytes 0-131071/131072\r\nConnection: close\r\n\r\n").unwrap();
            }
            socket.write_all(&[42; 8192]).unwrap();
            let _ = gate.recv_timeout(Duration::from_secs(3));
            let _ = socket.write_all(&vec![42; 131072 - 8192]);
        });
        let (finished, observed) = mpsc::channel();
        let reader = thread::spawn(move || {
            let started = Instant::now();
            let url = format!("http://{address}/audio");
            let mut source: Box<dyn Read> = if hls {
                Box::new(HlsSource {
                    client: http_client().unwrap(),
                    resources: VecDeque::from([Url::parse(&url).unwrap()]),
                    current: None,
                    position: 0,
                    duration_seconds: 1.0,
                    loudness: LoudnessInfo::default(),
                })
            } else {
                Box::new(HttpRangeSource::open(&url).unwrap())
            };
            let mut bytes = [0; 8192];
            let result = source.read_exact(&mut bytes);
            finished.send((result, bytes, started.elapsed())).unwrap();
        });
        let early = observed.recv_timeout(Duration::from_millis(500));
        let before_completion = early.is_ok();
        release.send(()).unwrap();
        let (result, bytes, elapsed) =
            early.unwrap_or_else(|_| observed.recv_timeout(Duration::from_secs(3)).unwrap());
        reader.join().unwrap();
        server.join().unwrap();
        result.unwrap();
        assert_eq!(bytes, [42; 8192]);
        eprintln!("EARLY_BODY_MS hls={hls} {}", elapsed.as_secs_f64() * 1000.0);
        assert!(
            before_completion,
            "startup/HLS read waited for the complete HTTP body"
        );
    }

    #[test]
    fn startup_range_yields_before_its_body_finishes() {
        check_early_resource_read(false);
    }
    #[test]
    fn hls_resource_yields_before_its_body_finishes() {
        check_early_resource_read(true);
    }

    #[test]
    fn interrupted_startup_and_hls_resume_exactly_and_accept_200_fallback() {
        for hls in [false, true] {
            for ignores_range in [false, true] {
                let listener = TcpListener::bind("127.0.0.1:0").unwrap();
                let address = listener.local_addr().unwrap();
                let server = thread::spawn(move || {
                    let bytes: Vec<u8> = (0..16384).map(|i| (i % 251) as u8).collect();
                    for part in 0..2 {
                        let (mut socket, _) = listener.accept().unwrap();
                        let mut request = BufReader::new(socket.try_clone().unwrap());
                        let mut range = None;
                        loop {
                            let mut line = String::new();
                            request.read_line(&mut line).unwrap();
                            if line == "\r\n" {
                                break;
                            }
                            if let Some(value) =
                                line.to_ascii_lowercase().strip_prefix("range: bytes=")
                            {
                                range = Some(
                                    value.split_once('-').unwrap().0.parse::<usize>().unwrap(),
                                );
                            }
                        }
                        if part == 1 {
                            assert_eq!(
                                range,
                                Some(8192),
                                "resume must start after delivered bytes"
                            );
                        }
                        let start = if part == 0 || ignores_range { 0 } else { 8192 };
                        if ignores_range || hls && part == 0 {
                            write!(socket, "HTTP/1.1 200 OK\r\nContent-Length: 16384\r\nConnection: close\r\n\r\n").unwrap();
                        } else {
                            write!(socket, "HTTP/1.1 206 Partial Content\r\nContent-Length: {}\r\nContent-Range: bytes {start}-16383/16384\r\nConnection: close\r\n\r\n", 16384-start).unwrap();
                        }
                        let end = if part == 0 { 8192 } else { 16384 };
                        socket.write_all(&bytes[start..end]).unwrap();
                    }
                });
                let url = format!("http://{address}/audio");
                let mut source: Box<dyn Read> = if hls {
                    Box::new(StreamingResource::open(http_client().unwrap(), url).unwrap())
                } else {
                    Box::new(HttpRangeSource::open(&url).unwrap())
                };
                let mut bytes = Vec::new();
                source.read_to_end(&mut bytes).unwrap();
                assert_eq!(
                    bytes,
                    (0..16384).map(|i| (i % 251) as u8).collect::<Vec<_>>()
                );
                server.join().unwrap();
            }
        }
    }

    #[test]
    fn hls_accepts_a_complete_resource_without_content_length() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut request = BufReader::new(socket.try_clone().unwrap());
            loop {
                let mut line = String::new();
                request.read_line(&mut line).unwrap();
                if line == "\r\n" {
                    break;
                }
            }
            socket
                .write_all(b"HTTP/1.1 200 OK\r\nConnection: close\r\n\r\nresource")
                .unwrap();
        });
        let mut source =
            StreamingResource::open(http_client().unwrap(), format!("http://{address}/hls"))
                .unwrap();
        let mut bytes = Vec::new();
        source.read_to_end(&mut bytes).unwrap();
        assert_eq!(bytes, b"resource");
        server.join().unwrap();
    }

    #[test]
    fn streaming_range_rejects_wrong_offsets_and_changed_files() {
        let valid = reqwest::header::HeaderValue::from_static("bytes 1048576-5242879/6291456");
        assert_eq!(
            validated_range_length(Some(&valid), 1048576, 5242879, 6291456).unwrap(),
            4194304
        );
        for header in [
            "bytes 0-4194303/6291456",
            "bytes 1048576-5242880/6291456",
            "bytes 1048576-5242879/6291457",
            "bytes 5242879-1048576/6291456",
        ] {
            let header = reqwest::header::HeaderValue::from_str(header).unwrap();
            assert!(validated_range_length(Some(&header), 1048576, 5242879, 6291456).is_err());
        }
        assert!(validated_range_length(None, 1048576, 5242879, 6291456).is_err());
    }

    #[test]
    fn interrupted_range_resumes_after_delivered_bytes() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let length = HTTP_STARTUP_WINDOW_BYTES + HTTP_CACHE_BYTES;
        let server = thread::spawn(move || {
            for part in 0..2 {
                let (mut socket, _) = listener.accept().unwrap();
                let mut request = BufReader::new(socket.try_clone().unwrap());
                let mut start = None;
                loop {
                    let mut line = String::new();
                    request.read_line(&mut line).unwrap();
                    if line == "\r\n" {
                        break;
                    }
                    if let Some(value) = line.to_ascii_lowercase().strip_prefix("range: bytes=") {
                        start = Some(value.split_once('-').unwrap().0.parse::<u64>().unwrap());
                    }
                }
                let start = start.unwrap();
                assert_eq!(start, HTTP_STARTUP_WINDOW_BYTES + part * 8192);
                let end = length - 1;
                write!(socket, "HTTP/1.1 206 Partial Content\r\nContent-Length: {}\r\nContent-Range: bytes {start}-{end}/{length}\r\nConnection: close\r\n\r\n", end - start + 1).unwrap();
                let prefix: Vec<_> = (start..start + 8192)
                    .map(|offset| (offset % 251) as u8)
                    .collect();
                socket.write_all(&prefix).unwrap();
                thread::sleep(Duration::from_millis(50));
                // Deliberately truncate each response after its useful prefix.
            }
        });
        let mut source = HttpRangeSource {
            client: http_client().unwrap(),
            url: format!("http://{address}/audio"),
            position: HTTP_STARTUP_WINDOW_BYTES,
            length,
            cache_start: 0,
            cache: Vec::new(),
            initial_cache: Vec::new(),
            small_reads_until: HTTP_STARTUP_WINDOW_BYTES,
            response: None,
            response_left: 0,
            response_cache: None,
            loudness: LoudnessInfo::default(),
        };
        let mut bytes = [0; 16384];
        source.read_exact(&mut bytes).unwrap();
        for (index, byte) in bytes.iter().enumerate() {
            assert_eq!(
                *byte,
                ((HTTP_STARTUP_WINDOW_BYTES + index as u64) % 251) as u8
            );
        }
        assert_eq!(
            source.position,
            HTTP_STARTUP_WINDOW_BYTES + bytes.len() as u64
        );
        server.join().unwrap();
    }

    #[test]
    fn playback_reads_large_range_before_its_body_finishes() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let (release, gate) = mpsc::channel();
        let server = thread::spawn(move || {
            let length = HTTP_STARTUP_WINDOW_BYTES + HTTP_CACHE_BYTES;
            for _ in 0..9 {
                let (mut socket, _) = listener.accept().unwrap();
                let mut request = BufReader::new(socket.try_clone().unwrap());
                let mut range = None;
                loop {
                    let mut line = String::new();
                    request.read_line(&mut line).unwrap();
                    if line == "\r\n" {
                        break;
                    }
                    if let Some(value) = line.to_ascii_lowercase().strip_prefix("range: bytes=") {
                        let (start, end) = value.trim().split_once('-').unwrap();
                        range = Some((start.parse::<u64>().unwrap(), end.parse::<u64>().unwrap()));
                    }
                }
                let (start, end) = range.unwrap();
                let end = end.min(length - 1);
                let count = (end - start + 1) as usize;
                write!(socket, "HTTP/1.1 206 Partial Content\r\nContent-Length: {count}\r\nContent-Range: bytes {start}-{end}/{length}\r\nConnection: close\r\n\r\n").unwrap();
                let prefix = if start >= HTTP_STARTUP_WINDOW_BYTES {
                    8192
                } else {
                    count
                };
                socket.write_all(&vec![42; prefix]).unwrap();
                if prefix < count {
                    let _ = gate.recv_timeout(Duration::from_secs(3));
                    let _ = socket.write_all(&vec![42; count - prefix]);
                }
            }
        });
        let mut source = HttpRangeSource::open(&format!("http://{address}/audio")).unwrap();
        let mut startup = vec![0; HTTP_STARTUP_WINDOW_BYTES as usize];
        source.read_exact(&mut startup).unwrap();
        assert!(startup.iter().all(|&byte| byte == 42));
        let (finished, observed) = mpsc::channel();
        let reader = thread::spawn(move || {
            let mut prefix = [0; 8192];
            let result = source.read_exact(&mut prefix);
            finished.send((result, prefix)).unwrap();
        });
        let early = observed.recv_timeout(Duration::from_millis(500));
        let read_before_completion = early.is_ok();
        release.send(()).unwrap();
        let (result, prefix) =
            early.unwrap_or_else(|_| observed.recv_timeout(Duration::from_secs(3)).unwrap());
        reader.join().unwrap();
        server.join().unwrap();
        result.unwrap();
        assert_eq!(prefix, [42; 8192]);
        assert!(
            read_before_completion,
            "audio waited for the entire 4 MiB HTTP range"
        );
    }
}
