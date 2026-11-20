//! Estimate one constant shift between synced lyrics and the playing recording.
//! Lyrics timed against another edit or master are usually off by a fixed amount,
//! so the recording's vocal energy is matched against the lyric phrases (ambra-lyric-sync).
//! The same energy also shows when the singing actually stops, near the last phrase.
//! A server with the vocal separation model supplies the isolated vocals' energy; without
//! it, centre-panned vocal-band energy is measured here from the mix.
use std::sync::atomic::{AtomicU64, Ordering};

use ambra_lyric_sync::{FRAME_MS, LyricOffset, LyricWindow, MAX_ANALYSIS_FRAMES, MAX_WINDOWS};
use realfft::{RealFftPlanner, num_complex::Complex};

use super::decoder::DecodedSource;

/// Each request supersedes the previous one, which stops decoding at its next packet.
static GENERATION: AtomicU64 = AtomicU64::new(0);

/// `vocal_power` is the server's measurement of the isolated vocals, per `FRAME_MS` frame;
/// when absent, the vocals are estimated from the recording at `source`.
#[tauri::command]
pub async fn detect_lyric_offset(
    source: String,
    windows: Vec<LyricWindow>,
    vocal_power: Option<Vec<f64>>,
) -> Result<LyricOffset, String> {
    let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    if windows.len() > MAX_WINDOWS {
        return Err("Too many lyric timings to analyze".to_owned());
    }
    tauri::async_runtime::spawn_blocking(move || {
        // TEMPORARY tuning diagnostics: names the song without any URL query or token.
        let label = source
            .split(['?', '#'])
            .next()
            .and_then(|path| path.rsplit(['/', '\\']).find(|part| !part.is_empty()))
            .unwrap_or("?")
            .to_owned();
        let power = match vocal_power {
            Some(power) => power,
            None => band_power(source, generation).inspect_err(|error| {
                eprintln!("[lyric-sync] {label}: failed, {error}");
            })?,
        };
        ambra_lyric_sync::analyze(power, &windows, &label)
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Centre-panned 250 Hz–4 kHz power per frame: the singing, guessed from the mix.
fn band_power(source: String, generation: u64) -> Result<Vec<f64>, String> {
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
    Ok(power)
}
