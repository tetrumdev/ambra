//! Portable PCM processing. Device ownership and UI stay outside this module.
use biquad::{Biquad, Coefficients, DirectForm2Transposed, Type};
use fft_convolver::TwoStageFFTConvolver;
use serde::{Deserialize, Serialize};
use std::{io::Cursor, path::Path};

pub const BLOCK_FRAMES: usize = 1024;
pub const MAX_IR_BYTES: usize = 8 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EqBand {
    pub enabled: bool,
    pub kind: FilterKind,
    pub frequency: f64,
    pub gain_db: f64,
    pub q: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FilterKind {
    Peak,
    LowShelf,
    HighShelf,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImpulseFile {
    pub id: String,
    pub name: String,
    pub sample_rate: u32,
    pub channels: usize,
    pub frames: usize,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DspPreset {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub headroom_db: f64,
    pub output_gain_db: f64,
    pub bands: Vec<EqBand>,
    pub convolution: Vec<ImpulseFile>,
}

impl DspPreset {
    pub fn validate(&self) -> Result<(), String> {
        if self.id.is_empty()
            || self.id.len() > 128
            || self.name.trim().is_empty()
            || self.name.len() > 120
        {
            return Err("DSP presets need an ID and a name of at most 120 characters".into());
        }
        if !self.headroom_db.is_finite()
            || !(0.0..=30.0).contains(&self.headroom_db)
            || !self.output_gain_db.is_finite()
            || !(-60.0..=12.0).contains(&self.output_gain_db)
        {
            return Err("Headroom must be 0–30 dB and output gain must be -60–12 dB".into());
        }
        if self.bands.len() > 32 || self.convolution.len() > 16 {
            return Err("A preset supports at most 32 EQ bands and 16 impulse files".into());
        }
        for band in &self.bands {
            if !band.frequency.is_finite()
                || !(10.0..=96000.0).contains(&band.frequency)
                || !band.gain_db.is_finite()
                || !(-24.0..=24.0).contains(&band.gain_db)
                || !band.q.is_finite()
                || !(0.1..=20.0).contains(&band.q)
            {
                return Err("EQ requires 10–96000 Hz, -24–24 dB and Q 0.1–20".into());
            }
        }
        let mut rates = std::collections::HashSet::new();
        for impulse in &self.convolution {
            impulse_path(Path::new("."), &impulse.id)?;
            if !rates.insert(impulse.sample_rate) {
                return Err("Use one convolution impulse per sample rate".into());
            }
        }
        Ok(())
    }
}

pub fn impulse_path(directory: &Path, id: &str) -> Result<std::path::PathBuf, String> {
    if id.is_empty()
        || id.len() > 128
        || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
    {
        return Err("Invalid impulse file ID".into());
    }
    Ok(directory.join("dsp-impulses").join(format!("{id}.wav")))
}

pub fn read_impulse(bytes: &[u8]) -> Result<(u32, Vec<Vec<f64>>), String> {
    if bytes.len() > MAX_IR_BYTES {
        return Err("Impulse WAV must be at most 8 MB".into());
    }
    let mut reader = hound::WavReader::new(Cursor::new(bytes))
        .map_err(|e| format!("Invalid impulse WAV: {e}"))?;
    let spec = reader.spec();
    let channels = usize::from(spec.channels);
    if !(1..=2).contains(&channels)
        || !(8000..=384000).contains(&spec.sample_rate)
        || reader.duration() == 0
        || reader.duration() > 262144
    {
        return Err("Impulse WAV must be mono/stereo, 8–384 kHz, and 1–262144 frames".into());
    }
    let samples: Vec<f64> = match spec.sample_format {
        hound::SampleFormat::Float => reader
            .samples::<f32>()
            .map(|s| s.map(f64::from))
            .collect::<Result<_, _>>(),
        hound::SampleFormat::Int => {
            let scale = 2.0_f64.powi(i32::from(spec.bits_per_sample) - 1);
            reader
                .samples::<i32>()
                .map(|s| s.map(|v| f64::from(v) / scale))
                .collect::<Result<_, _>>()
        }
    }
    .map_err(|e| format!("Could not decode impulse WAV: {e}"))?;
    if samples.len() % channels != 0 || samples.iter().any(|s| !s.is_finite()) {
        return Err("Impulse WAV contains incomplete or non-finite samples".into());
    }
    let mut planar = vec![Vec::with_capacity(samples.len() / channels); channels];
    for frame in samples.chunks_exact(channels) {
        for (channel, sample) in frame.iter().enumerate() {
            planar[channel].push(*sample);
        }
    }
    Ok((spec.sample_rate, planar))
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DspStatus {
    pub preset_name: Option<String>,
    pub active: bool,
    pub sample_rate: Option<u32>,
    pub peak_dbfs: Option<f64>,
    pub clipped_samples: u64,
    pub warnings: Vec<String>,
}

struct Pipeline {
    channels: usize,
    gain: f64,
    filters: Vec<Vec<DirectForm2Transposed<f64>>>,
    convolvers: Vec<TwoStageFFTConvolver<f64>>,
    input: Vec<f64>,
    output: Vec<f64>,
    tail_frames: usize,
    active: bool,
}

impl Pipeline {
    fn build(
        preset: Option<&DspPreset>,
        rate: u32,
        channels: usize,
        directory: &Path,
    ) -> Result<(Self, Vec<String>), String> {
        if rate == 0 || channels == 0 || channels > 32 {
            return Err("Invalid DSP stream format".into());
        }
        let mut result = Self {
            channels,
            gain: 1.0,
            filters: vec![Vec::new(); channels],
            convolvers: Vec::new(),
            input: vec![0.0; BLOCK_FRAMES],
            output: vec![0.0; BLOCK_FRAMES],
            tail_frames: 0,
            active: false,
        };
        let mut warnings = Vec::new();
        let Some(preset) = preset.filter(|p| p.enabled) else {
            return Ok((result, warnings));
        };
        preset.validate()?;
        result.gain = 10.0_f64.powf((-preset.headroom_db + preset.output_gain_db) / 20.0);
        for band in preset
            .bands
            .iter()
            .filter(|b| b.enabled && b.gain_db != 0.0)
        {
            if band.frequency >= f64::from(rate) / 2.0 {
                warnings.push(format!(
                    "{} Hz band skipped at {} Hz sample rate",
                    band.frequency, rate
                ));
                continue;
            }
            let kind = match band.kind {
                FilterKind::Peak => Type::PeakingEQ(band.gain_db),
                FilterKind::LowShelf => Type::LowShelf(band.gain_db),
                FilterKind::HighShelf => Type::HighShelf(band.gain_db),
            };
            // The normalized API maps 1 to Nyquist (omega = PI * normalized).
            // biquad 0.5's Hertz helper divides by 2*rate, placing filters at
            // one quarter of their requested frequency; use the explicit ratio.
            let coefficients = Coefficients::<f64>::from_normalized_params(
                kind,
                2.0 * band.frequency / f64::from(rate),
                band.q,
            )
            .map_err(|e| format!("Could not configure EQ: {e:?}"))?;
            for filters in &mut result.filters {
                filters.push(DirectForm2Transposed::new(coefficients));
            }
        }
        if !preset.convolution.is_empty() {
            let impulse = preset.convolution.iter().find(|i| i.sample_rate == rate)
                .ok_or_else(|| format!("{} needs an impulse WAV for {} Hz. Import a matching file or bypass convolution.", preset.name, rate))?;
            let bytes = std::fs::read(impulse_path(directory, &impulse.id)?)
                .map_err(|e| format!("Could not load impulse WAV: {e}"))?;
            let (impulse_rate, planar) = read_impulse(&bytes)?;
            if impulse_rate != rate || (planar.len() != 1 && planar.len() != channels) {
                return Err(
                    "Impulse WAV sample rate/channel count does not match the output".into(),
                );
            }
            result.tail_frames = planar[0].len().saturating_sub(1);
            for channel in 0..channels {
                let mut convolver = TwoStageFFTConvolver::default();
                convolver
                    .init_default(128, &planar[if planar.len() == 1 { 0 } else { channel }])
                    .map_err(|e| format!("Could not configure convolution: {e}"))?;
                result.convolvers.push(convolver);
            }
        }
        result.active =
            result.gain != 1.0 || !result.filters[0].is_empty() || !result.convolvers.is_empty();
        Ok((result, warnings))
    }

    fn process(&mut self, samples: &mut [f64]) -> Result<(), String> {
        if !self.active {
            return Ok(());
        }
        for frame in samples.chunks_exact_mut(self.channels) {
            for (channel, sample) in frame.iter_mut().enumerate() {
                *sample *= self.gain;
                for filter in &mut self.filters[channel] {
                    *sample = filter.run(*sample);
                }
            }
        }
        if !self.convolvers.is_empty() {
            for chunk in samples.chunks_mut(BLOCK_FRAMES * self.channels) {
                let frames = chunk.len() / self.channels;
                for channel in 0..self.channels {
                    for (index, frame) in chunk.chunks_exact(self.channels).enumerate() {
                        self.input[index] = frame[channel];
                    }
                    self.convolvers[channel]
                        .process(&self.input[..frames], &mut self.output[..frames])
                        .map_err(|e| format!("Convolution failed: {e}"))?;
                    for (index, frame) in chunk.chunks_exact_mut(self.channels).enumerate() {
                        frame[channel] = self.output[index];
                    }
                }
            }
        }
        Ok(())
    }
    fn reset(&mut self) {
        for filters in &mut self.filters {
            for filter in filters {
                filter.reset_state();
            }
        }
        for convolver in &mut self.convolvers {
            convolver.reset();
        }
    }
}

pub struct DspEngine {
    pipeline: Pipeline,
    previous: Option<Pipeline>,
    fade_frames: usize,
    fade_remaining: usize,
    scratch: Vec<f64>,
    pub status: DspStatus,
}

impl DspEngine {
    pub fn build(
        preset: Option<&DspPreset>,
        rate: u32,
        channels: usize,
        directory: &Path,
    ) -> Result<Self, String> {
        let (pipeline, warnings) = Pipeline::build(preset, rate, channels, directory)?;
        let active = pipeline.active;
        Ok(Self {
            pipeline,
            previous: None,
            fade_frames: (rate as usize / 100).max(1),
            fade_remaining: 0,
            scratch: Vec::with_capacity(BLOCK_FRAMES * channels),
            status: DspStatus {
                preset_name: preset.map(|p| p.name.clone()),
                active,
                sample_rate: Some(rate),
                warnings,
                ..Default::default()
            },
        })
    }
    pub fn transition_from(&mut self, previous: Self) {
        if self.pipeline.channels == previous.pipeline.channels {
            self.previous = Some(previous.pipeline);
            self.fade_remaining = self.fade_frames;
        }
    }
    pub fn active(&self) -> bool {
        self.pipeline.active || self.previous.is_some()
    }
    pub fn tail_frames(&self) -> usize {
        self.pipeline.tail_frames
    }
    pub fn reset(&mut self) {
        self.pipeline.reset();
        self.previous = None;
        self.fade_remaining = 0;
        self.status.peak_dbfs = None;
        self.status.clipped_samples = 0;
    }
    pub fn process(&mut self, samples: &mut [f64]) -> Result<(), String> {
        if let Some(previous) = self.previous.as_mut() {
            self.scratch.clear();
            self.scratch.extend_from_slice(samples);
            previous.process(&mut self.scratch)?;
        }
        self.pipeline.process(samples)?;
        if self.previous.is_some() {
            for (frame, old_frame) in samples
                .chunks_exact_mut(self.pipeline.channels)
                .zip(self.scratch.chunks_exact(self.pipeline.channels))
            {
                if self.fade_remaining == 0 {
                    break;
                }
                let mix = 1.0 - self.fade_remaining as f64 / self.fade_frames as f64;
                for (sample, old) in frame.iter_mut().zip(old_frame) {
                    *sample = old * (1.0 - mix) + *sample * mix;
                }
                self.fade_remaining -= 1;
            }
            if self.fade_remaining == 0 {
                self.previous = None;
            }
        }
        let mut peak = 0.0_f64;
        for sample in samples {
            if !sample.is_finite() {
                return Err("DSP produced a non-finite sample".into());
            }
            peak = peak.max(sample.abs());
            if sample.abs() > 1.0 {
                self.status.clipped_samples = self.status.clipped_samples.saturating_add(1);
            }
        }
        self.status.peak_dbfs = (peak > 0.0).then(|| 20.0 * peak.log10());
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn preset() -> DspPreset {
        DspPreset {
            id: "test".into(),
            name: "Test".into(),
            enabled: true,
            headroom_db: 0.0,
            output_gain_db: 0.0,
            bands: Vec::new(),
            convolution: Vec::new(),
        }
    }
    #[test]
    fn bypass_and_neutral_preset_preserve_every_sample_bit() {
        for preset in [None, Some(preset())] {
            let mut engine = DspEngine::build(preset.as_ref(), 48000, 2, Path::new(".")).unwrap();
            let mut samples = vec![-0.0, 1.0, -1.0, 0.1234567890123456];
            let bits: Vec<_> = samples.iter().map(|s: &f64| s.to_bits()).collect();
            engine.process(&mut samples).unwrap();
            assert_eq!(
                bits,
                samples.iter().map(|s| s.to_bits()).collect::<Vec<_>>()
            );
            assert!(!engine.active());
        }
    }
    #[test]
    fn eq_has_expected_response_without_channel_crosstalk() {
        let mut preset = preset();
        preset.bands.push(EqBand {
            enabled: true,
            kind: FilterKind::Peak,
            frequency: 1000.0,
            gain_db: -6.0,
            q: 1.0,
        });
        for rate in [44100, 48000, 96000] {
            let mut engine = DspEngine::build(Some(&preset), rate, 2, Path::new(".")).unwrap();
            let mut samples: Vec<_> = (0..rate)
                .flat_map(|n| {
                    [
                        (std::f64::consts::TAU * 1000.0 * f64::from(n) / f64::from(rate)).sin(),
                        0.0,
                    ]
                })
                .collect();
            engine.process(&mut samples).unwrap();
            let rms = (samples[samples.len() / 2..]
                .chunks_exact(2)
                .map(|f| f[0] * f[0])
                .sum::<f64>()
                / f64::from(rate / 2))
            .sqrt();
            assert!(
                (rms / (0.5_f64).sqrt() - 10.0_f64.powf(-6.0 / 20.0)).abs() < 0.001,
                "rate={rate} rms={rms}"
            );
            assert!(samples.chunks_exact(2).all(|frame| frame[1] == 0.0));
            engine.reset();
            let mut silence = vec![0.0; 512];
            engine.process(&mut silence).unwrap();
            assert!(silence.iter().all(|s| *s == 0.0));
        }
    }
    #[test]
    fn convolution_matches_direct_reference_across_irregular_blocks_and_reset() {
        let directory = std::env::temp_dir().join(format!("ambra-dsp-test-{}", std::process::id()));
        std::fs::create_dir_all(directory.join("dsp-impulses")).unwrap();
        let path = impulse_path(&directory, "reference").unwrap();
        let mut writer = hound::WavWriter::create(
            &path,
            hound::WavSpec {
                channels: 2,
                sample_rate: 48000,
                bits_per_sample: 32,
                sample_format: hound::SampleFormat::Float,
            },
        )
        .unwrap();
        for sample in [1.0_f32, 0.5, 0.25, -0.5, 0.125, 0.0] {
            writer.write_sample(sample).unwrap();
        }
        writer.finalize().unwrap();
        let mut preset = preset();
        preset.convolution.push(ImpulseFile {
            id: "reference".into(),
            name: "reference.wav".into(),
            sample_rate: 48000,
            channels: 2,
            frames: 3,
        });
        let mut engine = DspEngine::build(Some(&preset), 48000, 2, &directory).unwrap();
        let mut samples = vec![1.0, 2.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0];
        for chunk in samples.chunks_mut(2) {
            engine.process(chunk).unwrap();
        }
        let expected = [1.0, 1.0, 0.25, -1.0, 0.125, 0.0, 0.0, 0.0];
        for (a, b) in samples.iter().zip(expected) {
            assert!((a - b).abs() < 1e-10, "{samples:?}");
        }
        engine.reset();
        let mut silence = vec![0.0; 32];
        engine.process(&mut silence).unwrap();
        assert!(silence.iter().all(|s| s.abs() < 1e-10));
        assert!(DspEngine::build(Some(&preset), 44100, 2, &directory).is_err());
        std::fs::remove_dir_all(directory).unwrap();
    }
    #[test]
    fn reports_clipping_and_rejects_nonfinite_configuration() {
        let mut preset = preset();
        preset.output_gain_db = 6.0;
        let mut engine = DspEngine::build(Some(&preset), 48000, 1, Path::new(".")).unwrap();
        let mut samples = [1.0, -1.0, 0.0];
        engine.process(&mut samples).unwrap();
        assert_eq!(engine.status.clipped_samples, 2);
        assert!((engine.status.peak_dbfs.unwrap() - 6.0).abs() < 1e-9);
        preset.headroom_db = f64::NAN;
        assert!(preset.validate().is_err());
        assert!(impulse_path(Path::new("."), "../secret").is_err());
    }
    #[test]
    fn changing_preset_fades_and_returns_to_exact_bypass() {
        let mut preset = preset();
        preset.headroom_db = 6.0;
        let old = DspEngine::build(Some(&preset), 48000, 2, Path::new(".")).unwrap();
        let mut next = DspEngine::build(None, 48000, 2, Path::new(".")).unwrap();
        next.transition_from(old);
        let mut signal = vec![1.0; 1200];
        next.process(&mut signal).unwrap();
        assert!((signal[0] - 10.0_f64.powf(-6.0 / 20.0)).abs() < 1e-10);
        assert_eq!(signal[0], signal[1]);
        assert_eq!(signal[1199], 1.0);
        assert!(!next.active());
    }
}
