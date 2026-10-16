//! Estimate one constant shift between synced lyrics and the playing recording.
//! Lyrics timed against another edit or master are usually off by a fixed amount,
//! so centre-panned vocal-band energy is matched against the lyric phrases.
use std::sync::atomic::{AtomicU64, Ordering};

use realfft::{RealFftPlanner, num_complex::Complex};
use serde::{Deserialize, Serialize};

use super::decoder::DecodedSource;

const FRAME_MS: i64 = 20;
const MAX_SHIFT_FRAMES: i64 = 10_000 / FRAME_MS;
const MAX_ANALYSIS_FRAMES: usize = 20 * 60 * 1000 / FRAME_MS as usize;
const MAX_WINDOWS: usize = 20_000;
/// Words separated by less than a breath belong to one sung phrase.
const PHRASE_GAP_MS: f64 = 250.0;
const MIN_PHRASES: usize = 8;
/// Removes loudness changes between song sections while keeping phrase-scale contrast.
const DETREND_FRAMES: usize = 7_500 / FRAME_MS as usize;
const ONSET_FRAMES: i64 = 300 / FRAME_MS;
/// Shifts within one second of the best one belong to the same peak.
const PEAK_FRAMES: i64 = 1_000 / FRAME_MS;
const MIN_PROMINENCE: f64 = 4.0;
const MIN_PEAK_MARGIN: f64 = 0.75;
const MIN_CORRECTION_MS: i64 = 150;

/// Each request supersedes the previous one, which stops decoding at its next packet.
static GENERATION: AtomicU64 = AtomicU64::new(0);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LyricWindow {
    start_ms: f64,
    end_ms: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LyricOffset {
    /// Milliseconds to add to the lyric offset; 0 when no reliable shift was found.
    correction_ms: i64,
    confident: bool,
}

const UNCERTAIN: LyricOffset = LyricOffset {
    correction_ms: 0,
    confident: false,
};

#[tauri::command]
pub async fn detect_lyric_offset(
    source: String,
    windows: Vec<LyricWindow>,
) -> Result<LyricOffset, String> {
    let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    if windows.len() > MAX_WINDOWS {
        return Err("Too many lyric timings to analyze".to_owned());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let phrases = phrases(&windows);
        if phrases.len() < MIN_PHRASES {
            return Ok(UNCERTAIN);
        }
        let envelope = vocal_envelope(source, generation)?;
        Ok(best_offset(&envelope, &phrases))
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Lyric windows merged into sung phrases, in frames on the expected audio timeline.
fn phrases(windows: &[LyricWindow]) -> Vec<(i64, i64)> {
    let mut windows: Vec<(f64, f64)> = windows
        .iter()
        .filter(|window| window.start_ms.is_finite() && window.end_ms.is_finite())
        .map(|window| (window.start_ms.max(0.0), window.end_ms.min(86_400_000.0)))
        .filter(|(start, end)| end > start)
        .collect();
    windows.sort_by(|a, b| a.0.total_cmp(&b.0));
    let mut merged: Vec<(f64, f64)> = Vec::new();
    for (start, end) in windows {
        match merged.last_mut() {
            Some(last) if start <= last.1 + PHRASE_GAP_MS => last.1 = last.1.max(end),
            _ => merged.push((start, end)),
        }
    }
    merged
        .into_iter()
        .map(|(start, end)| {
            let frame = |ms: f64| (ms / FRAME_MS as f64).round() as i64;
            (frame(start), frame(end))
        })
        .filter(|(start, end)| end > start)
        .collect()
}

/// Detrended, standardized log energy of centre-panned 250 Hz–4 kHz content per frame.
fn vocal_envelope(source: String, generation: u64) -> Result<Vec<f64>, String> {
    let mut decoded = DecodedSource::open(source)?;
    let spec = decoded.spec();
    let rate = spec.sample_rate as usize;
    let channels = spec.channels;
    let hop = (rate * FRAME_MS as usize / 1000).max(1);
    let window = (hop * 2).next_power_of_two();
    let fft = RealFftPlanner::<f32>::new().plan_fft_forward(window);
    let hann: Vec<f32> = (0..window)
        .map(|i| 0.5 - 0.5 * (std::f32::consts::TAU * i as f32 / window as f32).cos())
        .collect();
    let low = (250 * window / rate).max(1);
    let high = (4_000 * window / rate).min(window / 2);
    let mut input = fft.make_input_vec();
    let mut mid_spectrum = fft.make_output_vec();
    let mut side_spectrum = fft.make_output_vec();
    let mut scratch = fft.make_scratch_vec();
    // Half a window of leading silence centres frame i on i * FRAME_MS.
    let mut mid = vec![0.0_f32; window / 2];
    let mut side = vec![0.0_f32; window / 2];
    let mut power = Vec::new();

    'decode: while let Some(samples) = decoded.decode_next()? {
        if GENERATION.load(Ordering::SeqCst) != generation {
            return Err("Lyric offset analysis was superseded".to_owned());
        }
        for frame in samples.chunks_exact(channels) {
            let left = frame[0] as f32;
            let right = frame.get(1).map_or(left, |right| *right as f32);
            mid.push((left + right) * 0.5);
            side.push((left - right) * 0.5);
        }
        let mut start = 0;
        while mid.len() - start >= window {
            let mut spectrum = |samples: &[f32], output: &mut [Complex<f32>]| {
                for ((target, sample), weight) in input.iter_mut().zip(samples).zip(&hann) {
                    *target = sample * weight;
                }
                fft.process_with_scratch(&mut input, output, &mut scratch)
                    .map_err(|error| error.to_string())
            };
            spectrum(&mid[start..start + window], &mut mid_spectrum)?;
            spectrum(&side[start..start + window], &mut side_spectrum)?;
            // Side energy approximates what is panned away from the centre vocal.
            let centre: f32 = (low..high)
                .map(|bin| (mid_spectrum[bin].norm_sqr() - side_spectrum[bin].norm_sqr()).max(0.0))
                .sum();
            power.push(f64::from(centre) / window as f64);
            start += hop;
            if power.len() >= MAX_ANALYSIS_FRAMES {
                break 'decode;
            }
        }
        mid.drain(..start);
        side.drain(..start);
    }
    if power.len() < 2 * DETREND_FRAMES {
        return Err("The recording is too short to analyze".to_owned());
    }

    // Silence would dominate a plain log; floor it at the quiet end of the track.
    let mut sorted = power.clone();
    sorted.sort_by(f64::total_cmp);
    let floor = sorted[sorted.len() / 20].max(1e-12);
    let log: Vec<f64> = power.iter().map(|value| (value + floor).ln()).collect();
    let prefix = prefix_sums(&log);
    let detrended: Vec<f64> = (0..log.len())
        .map(|i| {
            let from = i.saturating_sub(DETREND_FRAMES);
            let to = (i + DETREND_FRAMES + 1).min(log.len());
            log[i] - (prefix[to] - prefix[from]) / (to - from) as f64
        })
        .collect();
    let deviation = (detrended.iter().map(|value| value * value).sum::<f64>()
        / detrended.len() as f64)
        .sqrt()
        .max(1e-9);
    Ok(detrended
        .into_iter()
        .map(|value| value / deviation)
        .collect())
}

fn prefix_sums(values: &[f64]) -> Vec<f64> {
    let mut prefix = Vec::with_capacity(values.len() + 1);
    prefix.push(0.0);
    for value in values {
        prefix.push(prefix.last().unwrap() + value);
    }
    prefix
}

/// Scores every shift by phrase/gap energy contrast plus energy rises at phrase starts.
fn best_offset(envelope: &[f64], phrases: &[(i64, i64)]) -> LyricOffset {
    let frames = envelope.len() as i64;
    let prefix = prefix_sums(envelope);
    let sum = |from: i64, to: i64| {
        let (from, to) = (from.clamp(0, frames), to.clamp(0, frames));
        (
            prefix[to as usize] - prefix[from as usize],
            (to - from).max(0),
        )
    };
    let total = prefix[frames as usize];
    let shifts: Vec<i64> = (-MAX_SHIFT_FRAMES..=MAX_SHIFT_FRAMES).collect();
    let mut contrast = Vec::with_capacity(shifts.len());
    let mut onsets = Vec::with_capacity(shifts.len());
    for &shift in &shifts {
        // A positive correction means each phrase is sung earlier than its timing says.
        let (mut inside, mut count) = (0.0, 0);
        let (mut rise, mut rises) = (0.0, 0);
        for &(start, end) in phrases {
            let (value, length) = sum(start - shift, end - shift);
            inside += value;
            count += length;
            let onset = start - shift;
            if onset - ONSET_FRAMES >= 0 && onset + ONSET_FRAMES <= frames {
                rise += sum(onset, onset + ONSET_FRAMES).0 - sum(onset - ONSET_FRAMES, onset).0;
                rises += 1;
            }
        }
        if count < PEAK_FRAMES || frames - count < PEAK_FRAMES || rises < MIN_PHRASES {
            return UNCERTAIN;
        }
        contrast.push(inside / count as f64 - (total - inside) / (frames - count) as f64);
        onsets.push(rise / (rises as f64 * ONSET_FRAMES as f64));
    }
    let standardize = |values: &mut Vec<f64>| {
        let mean = values.iter().sum::<f64>() / values.len() as f64;
        let deviation = (values
            .iter()
            .map(|value| (value - mean).powi(2))
            .sum::<f64>()
            / values.len() as f64)
            .sqrt()
            .max(1e-9);
        for value in values.iter_mut() {
            *value = (*value - mean) / deviation;
        }
    };
    standardize(&mut contrast);
    standardize(&mut onsets);
    let scores: Vec<f64> = contrast.iter().zip(&onsets).map(|(a, b)| a + b).collect();

    let best = (0..scores.len())
        .max_by(|&a, &b| scores[a].total_cmp(&scores[b]))
        .unwrap();
    let away = |index: usize| (index as i64 - best as i64).abs() > PEAK_FRAMES;
    let mut background: Vec<f64> = (0..scores.len())
        .filter(|&i| away(i))
        .map(|i| scores[i])
        .collect();
    if background.is_empty() {
        return UNCERTAIN;
    }
    background.sort_by(f64::total_cmp);
    let median = background[background.len() / 2];
    let mut deviations: Vec<f64> = background
        .iter()
        .map(|value| (value - median).abs())
        .collect();
    deviations.sort_by(f64::total_cmp);
    let noise = (1.4826 * deviations[deviations.len() / 2]).max(1e-9);
    // Repeating song structure can produce a rival peak, typically a bar or phrase away.
    let rival = (0..scores.len())
        .filter(|&i| away(i))
        .filter(|&i| {
            let from = i.saturating_sub(12);
            let to = (i + 13).min(scores.len());
            scores[from..to].iter().all(|value| *value <= scores[i])
        })
        .map(|i| scores[i])
        .fold(f64::NEG_INFINITY, f64::max);
    let confident = (scores[best] - median) / noise >= MIN_PROMINENCE
        && (rival == f64::NEG_INFINITY || (scores[best] - rival) / noise >= MIN_PEAK_MARGIN);
    if !confident {
        return UNCERTAIN;
    }
    let correction_ms = shifts[best] * FRAME_MS;
    LyricOffset {
        correction_ms: if correction_ms.abs() < MIN_CORRECTION_MS {
            0
        } else {
            correction_ms
        },
        confident,
    }
}
