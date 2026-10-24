//! Loudness normalization: one constant gain for a whole track (or album), applied in 64-bit float
//! before dither. There is no compressor or limiter, so a song's dynamics are untouched; a gain that
//! would lift a peak past full scale is reduced instead, so normalization never clips.
use ebur128::{EbuR128, Mode};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{
        Mutex, OnceLock,
        atomic::{AtomicBool, Ordering},
    },
};
use symphonia::core::meta::{StandardTag, Tag};

/// ReplayGain 2.0's reference, which every gain here is relative to.
pub const REFERENCE_LUFS: f64 = -18.0;
/// The quietest and loudest targets a listener may pick; boosts stay limited by each song's peak.
pub const TARGET_LUFS_RANGE: std::ops::RangeInclusive<f64> = -30.0..=-6.0;
/// The server reports each stream's loudness in this response header.
pub const LOUDNESS_HEADER: &str = "x-ambra-loudness";
const MAX_BOOST_DB: f64 = 12.0;
const RAMP_MILLISECONDS: usize = 30;
const CACHE_FILE: &str = "loudness-cache.json";
const CACHE_LIMIT: usize = 50_000;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum NormalizationMode {
    #[default]
    Off,
    Track,
    Album,
}

/// ReplayGain-style values relative to [`REFERENCE_LUFS`]; peaks are linear, 1.0 being full scale.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct LoudnessInfo {
    pub track_gain_db: Option<f64>,
    pub track_peak: Option<f64>,
    pub album_gain_db: Option<f64>,
    pub album_peak: Option<f64>,
}

impl LoudnessInfo {
    /// Fills each value this one lacks from `fallback`.
    pub fn or(self, fallback: Self) -> Self {
        Self {
            track_gain_db: self.track_gain_db.or(fallback.track_gain_db),
            track_peak: self.track_peak.or(fallback.track_peak),
            album_gain_db: self.album_gain_db.or(fallback.album_gain_db),
            album_peak: self.album_peak.or(fallback.album_peak),
        }
    }

    /// The linear gain bringing this mode's loudness to `target_lufs`. Unknown loudness plays unchanged.
    pub fn amplitude(&self, mode: NormalizationMode, target_lufs: f64) -> f64 {
        let track = self.track_gain_db.map(|gain| (gain, self.track_peak));
        let album = self.album_gain_db.map(|gain| (gain, self.album_peak));
        let chosen = match mode {
            NormalizationMode::Off => None,
            NormalizationMode::Track => track.or(album),
            NormalizationMode::Album => album.or(track),
        };
        let Some((gain_db, peak)) = chosen.filter(|(gain, _)| gain.is_finite()) else {
            return 1.0;
        };
        let gain_db = gain_db + target_lufs - REFERENCE_LUFS;
        let amplitude = 10_f64.powf(gain_db.min(MAX_BOOST_DB) / 20.0);
        if amplitude <= 1.0 {
            return amplitude;
        }
        // A boost may only use the headroom the recording leaves. Without a known peak there
        // is none to rely on, and a source already past full scale is not pushed further.
        let ceiling = peak
            .filter(|peak| peak.is_finite() && *peak > 0.0)
            .map_or(1.0, |peak| (1.0 / peak).max(1.0));
        amplitude.min(ceiling)
    }

    pub fn parse_header(value: &str) -> Self {
        let mut info = Self::default();
        for (key, value) in value
            .split(';')
            .filter_map(|part| part.split_once('='))
            .map(|(key, value)| (key.trim(), value.trim().parse::<f64>().ok()))
        {
            let value = value.filter(|value| value.is_finite());
            match key {
                "track" => info.track_gain_db = value,
                "track-peak" => info.track_peak = value.filter(|peak| *peak > 0.0),
                "album" => info.album_gain_db = value,
                "album-peak" => info.album_peak = value.filter(|peak| *peak > 0.0),
                _ => {}
            }
        }
        info
    }

    pub fn from_headers(headers: &reqwest::header::HeaderMap) -> Self {
        headers
            .get(LOUDNESS_HEADER)
            .and_then(|value| value.to_str().ok())
            .map(Self::parse_header)
            .unwrap_or_default()
    }

    /// ReplayGain tags embedded in the file. Their reference is assumed to be ReplayGain's own.
    pub fn from_tags<'a>(tags: impl IntoIterator<Item = &'a Tag>) -> Self {
        let mut info = Self::default();
        for tag in tags {
            let Some(std) = tag.std.as_ref() else {
                continue;
            };
            match std {
                StandardTag::ReplayGainTrackGain(value) => {
                    info.track_gain_db = info.track_gain_db.or(parse_tag_number(value));
                }
                StandardTag::ReplayGainTrackPeak(value) => {
                    info.track_peak = info.track_peak.or(parse_tag_number(value));
                }
                StandardTag::ReplayGainAlbumGain(value) => {
                    info.album_gain_db = info.album_gain_db.or(parse_tag_number(value));
                }
                StandardTag::ReplayGainAlbumPeak(value) => {
                    info.album_peak = info.album_peak.or(parse_tag_number(value));
                }
                _ => {}
            }
        }
        info
    }
}

fn parse_tag_number(value: &str) -> Option<f64> {
    let number = value
        .trim()
        .trim_end_matches(|c: char| c.is_ascii_alphabetic() || c.is_whitespace());
    number.parse::<f64>().ok().filter(|value| value.is_finite())
}

/// Moves between gains over a few milliseconds so a change mid-song never clicks.
#[derive(Clone)]
pub struct NormalizationStage {
    current: f64,
    target: f64,
    step: f64,
    remaining: usize,
}

impl Default for NormalizationStage {
    fn default() -> Self {
        Self {
            current: 1.0,
            target: 1.0,
            step: 0.0,
            remaining: 0,
        }
    }
}

impl NormalizationStage {
    pub fn amplitude(&self) -> f64 {
        self.target
    }

    pub fn is_unity(&self) -> bool {
        self.remaining == 0 && self.current == 1.0
    }

    /// Takes effect at once; used where a song starts, so its first sample is already at its level.
    pub fn set(&mut self, amplitude: f64) {
        self.current = amplitude;
        self.target = amplitude;
        self.step = 0.0;
        self.remaining = 0;
    }

    pub fn ramp_to(&mut self, amplitude: f64, sample_rate: Option<u32>) {
        let frames = sample_rate.map_or(0, |rate| rate as usize * RAMP_MILLISECONDS / 1_000);
        if frames == 0 {
            self.set(amplitude);
            return;
        }
        self.target = amplitude;
        self.step = (amplitude - self.current) / frames as f64;
        self.remaining = frames;
    }

    pub fn settle(&mut self) {
        self.set(self.target);
    }

    pub fn process_in_place(&mut self, samples: &mut [f64], channels: usize) {
        if self.is_unity() {
            return;
        }
        for frame in samples.chunks_exact_mut(channels) {
            if self.remaining > 0 {
                self.current += self.step;
                self.remaining -= 1;
                if self.remaining == 0 {
                    self.current = self.target;
                }
            }
            for sample in frame {
                *sample *= self.current;
            }
        }
    }
}

/// Measures a song while it decodes from its start, for an exact gain the next time it plays.
pub struct LoudnessMeter {
    key: String,
    meter: EbuR128,
    channels: u32,
}

impl LoudnessMeter {
    pub fn start(key: String, channels: usize, sample_rate: u32) -> Option<Self> {
        if !MEASURING.load(Ordering::Acquire) || measured(&key).is_some() {
            return None;
        }
        let channels = u32::try_from(channels).ok()?;
        let meter = EbuR128::new(channels, sample_rate, Mode::I | Mode::TRUE_PEAK).ok()?;
        Some(Self {
            key,
            meter,
            channels,
        })
    }

    /// False once the meter can no longer give a result.
    pub fn add(&mut self, samples: &[f64]) -> bool {
        self.meter.add_frames_f64(samples).is_ok()
    }

    pub fn finish(self) {
        let Ok(loudness) = self.meter.loudness_global() else {
            return;
        };
        let peak = (0..self.channels)
            .filter_map(|channel| self.meter.true_peak(channel).ok())
            .fold(0.0_f64, f64::max);
        // Silence has no loudness to normalize to.
        if !loudness.is_finite() || peak <= 0.0 {
            return;
        }
        remember(
            self.key,
            Measured {
                gain_db: REFERENCE_LUFS - loudness,
                peak,
            },
        );
    }
}

#[derive(Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Measured {
    gain_db: f64,
    peak: f64,
}

struct Cache {
    directory: Option<PathBuf>,
    entries: Option<HashMap<String, Measured>>,
}

static MEASURING: AtomicBool = AtomicBool::new(false);

fn cache() -> &'static Mutex<Cache> {
    static CACHE: OnceLock<Mutex<Cache>> = OnceLock::new();
    CACHE.get_or_init(|| {
        Mutex::new(Cache {
            directory: None,
            entries: None,
        })
    })
}

pub fn set_cache_directory(directory: &Path) {
    if let Ok(mut cache) = cache().lock() {
        cache.directory = Some(directory.to_owned());
        cache.entries = None;
    }
}

/// Songs are only measured while normalization is on.
pub fn set_measuring(enabled: bool) {
    MEASURING.store(enabled, Ordering::Release);
}

fn with_entries<T>(read: impl FnOnce(&mut HashMap<String, Measured>, Option<&Path>) -> T) -> Option<T> {
    let mut cache = cache().lock().ok()?;
    let Cache { directory, entries } = &mut *cache;
    let entries = entries.get_or_insert_with(|| {
        directory
            .as_ref()
            .and_then(|directory| std::fs::read(directory.join(CACHE_FILE)).ok())
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default()
    });
    Some(read(entries, directory.as_deref()))
}

fn measured(key: &str) -> Option<Measured> {
    with_entries(|entries, _| entries.get(key).copied()).flatten()
}

fn remember(key: String, value: Measured) {
    let saved = with_entries(|entries, directory| {
        if entries.len() >= CACHE_LIMIT && !entries.contains_key(&key) {
            return None;
        }
        entries.insert(key, value);
        Some((directory?.join(CACHE_FILE), serde_json::to_vec(entries).ok()?))
    })
    .flatten();
    if let Some((path, bytes)) = saved
        && let Err(error) = crate::write_file_atomic(&path, &bytes)
    {
        eprintln!("Could not save measured loudness: {error}");
    }
}

/// Loudness this app measured itself, which is preferred over any reported value.
pub fn measured_info(key: &str) -> LoudnessInfo {
    measured(key).map_or_else(LoudnessInfo::default, |value| LoudnessInfo {
        track_gain_db: Some(value.gain_db),
        track_peak: Some(value.peak),
        ..LoudnessInfo::default()
    })
}

/// Identifies a song across sessions: a streamed track by its provider and ID (its URL's host,
/// port and query change), a file by its path, size and modification time.
pub fn cache_key(source: &str) -> Option<String> {
    if let Some(rest) = source
        .strip_prefix("http://")
        .or_else(|| source.strip_prefix("https://"))
    {
        let path = rest.split(['?', '#']).next()?;
        let path = &path[path.find('/')?..];
        let track = path.find("/tracks/")?;
        let id_start = track + "/tracks/".len();
        let id_end = path[id_start..]
            .find('/')
            .map_or(path.len(), |end| id_start + end);
        return Some(format!("stream:{}", &path[..id_end]));
    }
    let path = source.strip_prefix("file://").unwrap_or(source);
    let metadata = std::fs::metadata(path).ok()?;
    let modified = metadata
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_secs();
    Some(format!("file:{path}|{}|{modified}", metadata.len()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn info(gain: f64, peak: Option<f64>) -> LoudnessInfo {
        LoudnessInfo {
            track_gain_db: Some(gain),
            track_peak: peak,
            ..LoudnessInfo::default()
        }
    }

    #[test]
    fn off_and_unknown_loudness_leave_the_signal_untouched() {
        assert_eq!(info(-9.0, Some(1.0)).amplitude(NormalizationMode::Off, REFERENCE_LUFS), 1.0);
        assert_eq!(LoudnessInfo::default().amplitude(NormalizationMode::Track, REFERENCE_LUFS), 1.0);
    }

    #[test]
    fn loud_songs_are_turned_down_by_their_gain() {
        let amplitude = info(-6.0, Some(1.0)).amplitude(NormalizationMode::Track, REFERENCE_LUFS);
        assert!((amplitude - 10_f64.powf(-6.0 / 20.0)).abs() < 1e-12);
    }

    #[test]
    fn a_boost_never_lifts_the_peak_past_full_scale() {
        let amplitude = info(10.0, Some(0.5)).amplitude(NormalizationMode::Track, REFERENCE_LUFS);
        assert!((amplitude - 2.0).abs() < 1e-12);
        assert_eq!(info(4.0, None).amplitude(NormalizationMode::Track, REFERENCE_LUFS), 1.0);
        assert_eq!(info(4.0, Some(1.2)).amplitude(NormalizationMode::Track, REFERENCE_LUFS), 1.0);
    }

    #[test]
    fn the_target_shifts_every_gain_and_boosts_still_respect_the_peak() {
        let quieter = info(-6.0, Some(1.0)).amplitude(NormalizationMode::Track, -23.0);
        assert!((quieter - 10_f64.powf(-11.0 / 20.0)).abs() < 1e-12);
        let louder = info(-6.0, Some(0.5)).amplitude(NormalizationMode::Track, -10.0);
        assert!((louder - 10_f64.powf(2.0 / 20.0)).abs() < 1e-12);
        let capped = info(-2.0, Some(0.5)).amplitude(NormalizationMode::Track, -8.0);
        assert!((capped - 2.0).abs() < 1e-12, "a +8 dB boost stops at the 6 dB the peak leaves");
    }

    #[test]
    fn album_mode_prefers_album_gain_and_falls_back_to_the_track() {
        let both = LoudnessInfo {
            album_gain_db: Some(-3.0),
            album_peak: Some(1.0),
            ..info(-9.0, Some(1.0))
        };
        let album = both.amplitude(NormalizationMode::Album, REFERENCE_LUFS);
        assert!((album - 10_f64.powf(-3.0 / 20.0)).abs() < 1e-12);
        let track_only = info(-9.0, Some(1.0)).amplitude(NormalizationMode::Album, REFERENCE_LUFS);
        assert!((track_only - 10_f64.powf(-9.0 / 20.0)).abs() < 1e-12);
    }

    #[test]
    fn header_and_tags_parse() {
        let parsed = LoudnessInfo::parse_header("track=-7.5; track-peak=0.98;album=-6;album-peak=1");
        assert_eq!(parsed.track_gain_db, Some(-7.5));
        assert_eq!(parsed.track_peak, Some(0.98));
        assert_eq!(parsed.album_gain_db, Some(-6.0));
        assert_eq!(parsed.album_peak, Some(1.0));
        assert_eq!(parse_tag_number("-7.89 dB"), Some(-7.89));
        assert_eq!(parse_tag_number("0.988525"), Some(0.988525));
    }

    #[test]
    fn stream_keys_ignore_the_host_and_the_endpoint() {
        assert_eq!(
            cache_key("http://127.0.0.1:38147/api/providers/tidal/tracks/42/playlist.m3u8?x=1"),
            Some("stream:/api/providers/tidal/tracks/42".to_owned())
        );
        assert_eq!(
            cache_key("http://localhost:1/api/providers/qobuz/tracks/7/stream"),
            Some("stream:/api/providers/qobuz/tracks/7".to_owned())
        );
    }

    // The measurement cache and its switch are process-wide; tests that use them take turns.
    static GLOBALS: Mutex<()> = Mutex::new(());

    /// A 997 Hz tone 20 dB below full scale in both channels: -20 LUFS, 2 dB under the reference.
    fn write_tone(name: &str) -> (PathBuf, String) {
        let directory = std::env::temp_dir().join(format!("ambra-{name}-{}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join("tone.wav");
        let spec = hound::WavSpec {
            channels: 2,
            sample_rate: 48_000,
            bits_per_sample: 24,
            sample_format: hound::SampleFormat::Int,
        };
        let mut writer = hound::WavWriter::create(&path, spec).unwrap();
        for frame in 0..48_000 * 5 {
            let value = 0.1 * (2.0 * std::f64::consts::PI * 997.0 * frame as f64 / 48_000.0).sin();
            let sample = (value * 8_388_607.0).round() as i32;
            writer.write_sample(sample).unwrap();
            writer.write_sample(sample).unwrap();
        }
        writer.finalize().unwrap();
        set_cache_directory(&directory);
        (directory, path.to_string_lossy().into_owned())
    }

    fn decode_all(source: &str) -> Vec<f64> {
        let mut decoder = super::super::decoder::DecodedSource::open(source.to_owned()).unwrap();
        let mut samples = Vec::new();
        while let Some(block) = decoder.decode_next().unwrap() {
            samples.extend_from_slice(block);
        }
        samples
    }

    #[test]
    fn a_song_decoded_from_its_start_is_measured_for_its_next_play() {
        let _globals = GLOBALS.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let (directory, source) = write_tone("loudness-measure");
        set_measuring(true);

        let first = super::super::decoder::DecodedSource::open(source.clone()).unwrap();
        assert_eq!(first.loudness(), LoudnessInfo::default());
        drop(first);
        decode_all(&source);

        let measured = super::super::decoder::DecodedSource::open(source).unwrap().loudness();
        let gain = measured.track_gain_db.unwrap();
        assert!((gain - 2.0).abs() < 0.1, "measured gain {gain}");
        assert!((measured.track_peak.unwrap() - 0.1).abs() < 0.005);
        let amplitude = measured.amplitude(NormalizationMode::Track, REFERENCE_LUFS);
        assert!((amplitude - 10_f64.powf(gain / 20.0)).abs() < 1e-9);
        set_measuring(false);
        let _ = std::fs::remove_dir_all(directory);
    }

    /// Records what the engine sends to the device, at full float precision.
    struct CapturedOutput;
    static CAPTURED: Mutex<Vec<f64>> = Mutex::new(Vec::new());

    impl super::super::output::AudioOutput for CapturedOutput {
        fn open(_spec: super::super::StreamSpec) -> Result<Self, String> {
            Ok(Self)
        }
        fn open_device_with_mode(
            spec: super::super::StreamSpec,
            _device_id: Option<&str>,
            _exclusive_mode: bool,
            _processed: bool,
        ) -> Result<Self, String> {
            Self::open(spec)
        }
        fn start(&mut self) -> Result<(), String> {
            Ok(())
        }
        fn pause(&mut self) -> Result<(), String> {
            Ok(())
        }
        fn reset(&mut self) -> Result<(), String> {
            Ok(())
        }
        fn write(&mut self, first: &[f64], second: &[f64]) -> Result<usize, String> {
            let mut captured = CAPTURED.lock().unwrap();
            captured.extend_from_slice(first);
            captured.extend_from_slice(second);
            Ok((first.len() + second.len()) / 2)
        }
        fn queued_frames(&mut self) -> Result<usize, String> {
            Ok(0)
        }
        fn is_drained(&mut self) -> Result<bool, String> {
            Ok(true)
        }
    }

    fn play_through_engine(source: &str, mode: NormalizationMode) -> Vec<f64> {
        CAPTURED.lock().unwrap().clear();
        let (_commands, receiver) = crossbeam_channel::unbounded();
        let status = std::sync::Arc::new(Mutex::new(super::super::PlaybackStatus::default()));
        let mut engine =
            super::super::PlaybackEngine::<CapturedOutput>::new(receiver, status.clone(), None);
        engine.audio_settings.normalization = mode;
        engine.load(source.to_owned(), None, 0.0, true).unwrap();
        for _ in 0..1_000_000 {
            if status.lock().unwrap().ended {
                break;
            }
            engine.pump().unwrap();
        }
        assert!(status.lock().unwrap().ended, "playback never finished");
        std::mem::take(&mut CAPTURED.lock().unwrap())
    }

    #[test]
    fn the_engine_is_bit_exact_when_off_and_applies_one_constant_gain_when_on() {
        let _globals = GLOBALS.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let (directory, source) = write_tone("loudness-engine");
        set_measuring(true);
        let original = decode_all(&source);
        set_measuring(false);

        let unchanged = play_through_engine(&source, NormalizationMode::Off);
        assert_eq!(unchanged.len(), original.len());
        assert!(unchanged.iter().zip(&original).all(|(out, source)| out.to_bits() == source.to_bits()));

        let amplitude = measured_info(&cache_key(&source).unwrap()).amplitude(NormalizationMode::Track, REFERENCE_LUFS);
        assert!(amplitude > 1.2 && amplitude < 1.3, "a +2 dB boost, within the tone's headroom: {amplitude}");
        let normalized = play_through_engine(&source, NormalizationMode::Track);
        assert_eq!(normalized.len(), original.len());
        // Every sample is scaled by the same factor: no limiting, no compression, nothing clipped.
        assert!(normalized.iter().zip(&original).all(|(out, source)| out == &(source * amplitude)));
        assert!(normalized.iter().all(|sample| sample.abs() <= 1.0));
        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn the_stage_is_exact_at_unity_and_ramps_without_a_step() {
        let mut stage = NormalizationStage::default();
        let mut samples = vec![0.5, -0.25];
        stage.process_in_place(&mut samples, 2);
        assert_eq!(samples, vec![0.5, -0.25]);
        stage.ramp_to(0.5, Some(1_000));
        let mut ramp = vec![1.0; 60];
        stage.process_in_place(&mut ramp, 1);
        assert!(ramp.windows(2).all(|pair| pair[1] <= pair[0]));
        assert_eq!(*ramp.last().unwrap(), 0.5);
    }
}
