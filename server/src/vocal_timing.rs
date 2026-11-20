//! Optional vocal separation. A small MDX-Net model isolates a recording's vocals, and their
//! energy per frame shows when singing starts and stops far more precisely than an estimate
//! from the mix. Lyric auto-sync (ambra-lyric-sync) and line-ending repair read that curve.
//! The model runs in-process on tract, pure Rust, so it works wherever the server does;
//! chunks of a song are independent, so they run in parallel across cores.
//! Jobs, the cache of finished curves and the HTTP routes live in `api/vocal_timing.rs`.
use std::{
    path::Path,
    sync::atomic::{AtomicBool, AtomicUsize, Ordering},
    thread,
};

use realfft::{RealFftPlanner, RealToComplex, num_complex::Complex};
use sha2::{Digest, Sha256};
use std::sync::Arc;
use symphonia::core::{
    codecs::audio::AudioDecoderOptions,
    errors::Error as SymphoniaError,
    formats::{FormatOptions, TrackType, probe::Hint},
    io::{MediaSource, MediaSourceStream},
    meta::MetadataOptions,
};
use tract_onnx::prelude::*;

/// UVR-MDX-NET 9482: the smallest of the public MDX-Net vocal models, about 30 MB.
pub const MODEL_URL: &str =
    "https://github.com/TRvlvr/model_repo/releases/download/all_public_uvr_models/UVR_MDXNET_9482.onnx";
pub const MODEL_SHA256: &str = "f4f365207c56deb115bceedff3ad8fe98a751c745f9e370cecec6226b8b47184";
pub const MODEL_BYTES: u64 = 29_704_436;

const SAMPLE_RATE: u32 = 44_100;
const N_FFT: usize = 6144;
const HOP: usize = 1024;
/// The model reads the lowest 2048 bins (up to about 14.7 kHz).
const BINS: usize = 2048;
const CHUNK_FRAMES: usize = 256;
/// Frames at each end of a chunk the model sees without context are discarded.
const MARGIN: usize = 16;
const STEP: usize = CHUNK_FRAMES - 2 * MARGIN;
/// Vocal energy is summed over where singing carries it.
const LOW_BIN: usize = 150 * N_FFT / SAMPLE_RATE as usize;
const HIGH_BIN: usize = 6_000 * N_FFT / SAMPLE_RATE as usize;

pub struct Separator {
    plan: TypedRunnableModel<TypedModel>,
}

impl Separator {
    pub fn load(path: &Path) -> Result<Self, String> {
        let plan = tract_onnx::onnx()
            .model_for_path(path)
            .and_then(|model| model.with_input_fact(0, f32::fact([1, 4, BINS, CHUNK_FRAMES]).into()))
            .and_then(|model| model.into_optimized())
            .and_then(|model| model.into_runnable())
            .map_err(|error| format!("The vocal model could not be loaded: {error}"))?;
        Ok(Self { plan })
    }
}

/// Whether the file at `path` is the expected model, byte for byte.
pub fn verify_model(path: &Path) -> bool {
    let Ok(mut file) = std::fs::File::open(path) else { return false };
    let mut hasher = Sha256::new();
    std::io::copy(&mut file, &mut hasher).is_ok() && hex(&hasher.finalize()) == MODEL_SHA256
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// The isolated vocals' power per `ambra_lyric_sync::FRAME_MS` frame, from the start of the
/// recording. `threads` chunks are separated at once; `cancel` stops between batches.
pub fn vocal_power(
    separator: &Separator,
    source: Box<dyn MediaSource>,
    extension: Option<&str>,
    threads: usize,
    cancel: &AtomicBool,
) -> Result<Vec<f64>, String> {
    let mut hint = Hint::new();
    if let Some(extension) = extension {
        hint.with_extension(extension);
    }
    let stream = MediaSourceStream::new(source, Default::default());
    let mut format = symphonia::default::get_probe()
        .probe(&hint, stream, FormatOptions::default(), MetadataOptions::default())
        .map_err(|error| format!("Could not identify the recording: {error}"))?;
    let track = format
        .default_track(TrackType::Audio)
        .or_else(|| format.first_track_known_codec(TrackType::Audio))
        .cloned()
        .ok_or("No decodable audio track was found")?;
    let parameters = track
        .codec_params
        .as_ref()
        .and_then(|parameters| parameters.audio())
        .ok_or("Audio codec parameters are missing")?;
    let rate = parameters.sample_rate.ok_or("The sample rate is unknown")?;
    let channels = parameters.channels.as_ref().map_or(0, |channels| channels.count());
    if channels == 0 {
        return Err("The channel layout is unknown".into());
    }
    let mut decoder = symphonia::default::get_codecs()
        .make_audio_decoder(parameters, &AudioDecoderOptions::default())
        .map_err(|error| format!("Could not create an audio decoder: {error}"))?;

    let limit_frames = ambra_lyric_sync::MAX_ANALYSIS_FRAMES * ambra_lyric_sync::FRAME_MS as usize
        * SAMPLE_RATE as usize / 1000 / HOP;
    let mut analysis = Analysis::new(threads);
    let mut resampler = Resampler::new(rate);
    let mut interleaved: Vec<f32> = Vec::new();
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err("Vocal analysis was cancelled".into());
        }
        let packet = match format.next_packet() {
            Ok(Some(packet)) => packet,
            Ok(None) => break,
            Err(SymphoniaError::ResetRequired) => return Err("The audio stream layout changed".into()),
            Err(error) => return Err(format!("Could not read the recording: {error}")),
        };
        if packet.track_id != track.id {
            continue;
        }
        match decoder.decode(&packet) {
            Ok(decoded) => decoded.copy_to_vec_interleaved(&mut interleaved),
            Err(SymphoniaError::DecodeError(_)) | Err(SymphoniaError::IoError(_)) => continue,
            Err(error) => return Err(format!("Could not decode the recording: {error}")),
        }
        for frame in interleaved.chunks_exact(channels) {
            let left = frame[0];
            let right = frame.get(1).copied().unwrap_or(left);
            resampler.push([left, right], &mut analysis.audio);
        }
        analysis.run_ready(separator, false)?;
        if analysis.power.len() >= limit_frames {
            break;
        }
    }
    analysis.run_ready(separator, true)?;
    Ok(frame_grid(&analysis.power, analysis.total_samples()))
}

/// Linear interpolation to 44.1 kHz. Quality is irrelevant here; only energy over time is read.
struct Resampler {
    step: f64,
    position: f64,
    previous: Option<[f32; 2]>,
}

impl Resampler {
    fn new(rate: u32) -> Self {
        Self { step: f64::from(rate) / f64::from(SAMPLE_RATE), position: 0.0, previous: None }
    }

    fn push(&mut self, sample: [f32; 2], output: &mut Audio) {
        if self.step == 1.0 {
            output.samples.push(sample);
            return;
        }
        let Some(previous) = self.previous.replace(sample) else { return };
        // Emit every output sample that falls between the previous input sample and this one.
        while self.position < 1.0 {
            let t = self.position as f32;
            output.samples.push([
                previous[0] + (sample[0] - previous[0]) * t,
                previous[1] + (sample[1] - previous[1]) * t,
            ]);
            self.position += self.step;
        }
        self.position -= 1.0;
    }
}

struct Audio {
    /// 44.1 kHz stereo, starting at absolute sample `base`.
    samples: Vec<[f32; 2]>,
    base: usize,
}

struct Analysis {
    audio: Audio,
    /// Vocal power per model frame (HOP samples apart, centred on frame * HOP).
    power: Vec<f64>,
    next_chunk: usize,
    threads: usize,
    fft: Arc<dyn RealToComplex<f32>>,
    window: Vec<f32>,
}

impl Analysis {
    fn new(threads: usize) -> Self {
        let window = (0..N_FFT)
            .map(|i| 0.5 - 0.5 * (std::f32::consts::TAU * i as f32 / N_FFT as f32).cos())
            .collect();
        Self {
            audio: Audio { samples: Vec::new(), base: 0 },
            power: Vec::new(),
            next_chunk: 0,
            threads: threads.max(1),
            fft: RealFftPlanner::<f32>::new().plan_fft_forward(N_FFT),
            window,
        }
    }

    fn total_samples(&self) -> usize {
        self.audio.base + self.audio.samples.len()
    }

    /// The absolute sample range one chunk's spectra read.
    fn chunk_samples(chunk: usize) -> (isize, isize) {
        let first = (chunk * STEP) as isize - MARGIN as isize;
        let start = first * HOP as isize - (N_FFT / 2) as isize;
        let end = (first + CHUNK_FRAMES as isize - 1) * HOP as isize + (N_FFT / 2) as isize;
        (start, end)
    }

    /// Separates every chunk whose audio has fully arrived, a batch of `threads` at a time;
    /// at the end of the recording, the rest too, padded with silence.
    fn run_ready(&mut self, separator: &Separator, finished: bool) -> Result<(), String> {
        let total = self.total_samples();
        let needed_frames = total.div_ceil(HOP);
        loop {
            let mut batch = Vec::new();
            while batch.len() < self.threads {
                let chunk = self.next_chunk + batch.len();
                let (start, end) = Self::chunk_samples(chunk);
                let ready = end <= total as isize || (finished && chunk * STEP < needed_frames);
                if !ready {
                    break;
                }
                batch.push(self.slice(start, end));
            }
            if batch.is_empty() || (!finished && batch.len() < self.threads) {
                return Ok(());
            }
            let results = self.separate(separator, &batch)?;
            for frames in results {
                self.power.extend(frames);
            }
            self.next_chunk += batch.len();
            // Drop the audio no later chunk reads.
            let (keep_from, _) = Self::chunk_samples(self.next_chunk);
            let drop = (keep_from.max(0) as usize).saturating_sub(self.audio.base).min(self.audio.samples.len());
            self.audio.samples.drain(..drop);
            self.audio.base += drop;
        }
    }

    /// A copy of absolute samples `start..end`, with silence outside the recording.
    fn slice(&self, start: isize, end: isize) -> Vec<[f32; 2]> {
        (start..end)
            .map(|index| {
                usize::try_from(index)
                    .ok()
                    .and_then(|index| index.checked_sub(self.audio.base))
                    .and_then(|index| self.audio.samples.get(index).copied())
                    .unwrap_or([0.0; 2])
            })
            .collect()
    }

    fn separate(&self, separator: &Separator, batch: &[Vec<[f32; 2]>]) -> Result<Vec<Vec<f64>>, String> {
        let next = AtomicUsize::new(0);
        let mut results: Vec<Result<Vec<f64>, String>> = Vec::new();
        thread::scope(|scope| {
            let workers: Vec<_> = (0..batch.len().min(self.threads))
                .map(|_| {
                    scope.spawn(|| {
                        let mut done = Vec::new();
                        loop {
                            let index = next.fetch_add(1, Ordering::Relaxed);
                            let Some(samples) = batch.get(index) else { break };
                            done.push((index, self.separate_chunk(separator, samples)));
                        }
                        done
                    })
                })
                .collect();
            let mut done: Vec<_> = workers
                .into_iter()
                .flat_map(|worker| worker.join().unwrap_or_default())
                .collect();
            done.sort_by_key(|(index, _)| *index);
            results = done.into_iter().map(|(_, result)| result).collect();
        });
        if results.len() != batch.len() {
            return Err("Vocal separation stopped unexpectedly".into());
        }
        results.into_iter().collect()
    }

    /// One chunk: its spectra in, isolated-vocal spectra out, summed to power per kept frame.
    fn separate_chunk(&self, separator: &Separator, samples: &[[f32; 2]]) -> Result<Vec<f64>, String> {
        let mut input = tract_ndarray::Array4::<f32>::zeros((1, 4, BINS, CHUNK_FRAMES));
        let mut buffer = self.fft.make_input_vec();
        let mut spectrum = self.fft.make_output_vec();
        let mut scratch = self.fft.make_scratch_vec();
        for frame in 0..CHUNK_FRAMES {
            for channel in 0..2 {
                let offset = frame * HOP;
                for (i, target) in buffer.iter_mut().enumerate() {
                    *target = samples[offset + i][channel] * self.window[i];
                }
                self.fft
                    .process_with_scratch(&mut buffer, &mut spectrum, &mut scratch)
                    .map_err(|error| error.to_string())?;
                for (bin, value) in spectrum.iter().take(BINS).enumerate() {
                    input[[0, channel * 2, bin, frame]] = value.re;
                    input[[0, channel * 2 + 1, bin, frame]] = value.im;
                }
            }
        }
        let output = separator
            .plan
            .run(tvec!(Tensor::from(input).into()))
            .map_err(|error| format!("Vocal separation failed: {error}"))?;
        let output = output[0]
            .to_array_view::<f32>()
            .map_err(|error| error.to_string())?
            .into_dimensionality::<tract_ndarray::Ix4>()
            .map_err(|error| error.to_string())?;
        Ok((MARGIN..MARGIN + STEP)
            .map(|frame| {
                let power: f32 = (LOW_BIN..HIGH_BIN)
                    .map(|bin| {
                        (0..2)
                            .map(|channel| {
                                Complex::new(output[[0, channel * 2, bin, frame]], output[[0, channel * 2 + 1, bin, frame]])
                                    .norm_sqr()
                            })
                            .sum::<f32>()
                    })
                    .sum();
                f64::from(power) / N_FFT as f64
            })
            .collect())
    }
}

/// Model frames (centred HOP samples apart) resampled onto the lyric sync's frame grid.
fn frame_grid(power: &[f64], samples: usize) -> Vec<f64> {
    let frame_ms = ambra_lyric_sync::FRAME_MS as f64;
    let duration_ms = samples as f64 * 1000.0 / f64::from(SAMPLE_RATE);
    let frames = (duration_ms / frame_ms) as usize;
    (0..frames)
        .map(|frame| {
            let position = frame as f64 * frame_ms * f64::from(SAMPLE_RATE) / 1000.0 / HOP as f64;
            let index = position.floor() as usize;
            let t = position - index as f64;
            match (power.get(index), power.get(index + 1)) {
                (Some(a), Some(b)) => a + (b - a) * t,
                (Some(a), None) => *a,
                _ => 0.0,
            }
        })
        .collect()
}

