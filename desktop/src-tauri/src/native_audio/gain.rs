const MIN_VOLUME: f64 = 0.0;
const MAX_VOLUME: f64 = 100.0;
const RAMP_MILLISECONDS: u32 = 15;

pub struct GainStage {
    volume: f64,
    current_amplitude: f64,
    target_amplitude: f64,
    ramp_step: f64,
    ramp_frames_remaining: usize,
}

impl Default for GainStage {
    fn default() -> Self {
        Self {
            volume: MAX_VOLUME,
            current_amplitude: 1.0,
            target_amplitude: 1.0,
            ramp_step: 0.0,
            ramp_frames_remaining: 0,
        }
    }
}

impl GainStage {
    pub fn volume(&self) -> f64 {
        self.volume
    }

    pub fn set_volume(&mut self, volume: f64, sample_rate: Option<u32>) -> Result<(), String> {
        if !volume.is_finite() || !(MIN_VOLUME..=MAX_VOLUME).contains(&volume) {
            return Err("The native audio volume must be between 0 and 100".to_owned());
        }
        if volume == self.volume {
            return Ok(());
        }

        self.volume = volume;
        self.target_amplitude = volume / MAX_VOLUME;
        let ramp_frames = sample_rate
            .map(|rate| rate as usize * RAMP_MILLISECONDS as usize / 1_000)
            .unwrap_or_default();
        if ramp_frames == 0 {
            self.current_amplitude = self.target_amplitude;
            self.ramp_step = 0.0;
            self.ramp_frames_remaining = 0;
        } else {
            self.ramp_step = (self.target_amplitude - self.current_amplitude) / ramp_frames as f64;
            self.ramp_frames_remaining = ramp_frames;
        }
        Ok(())
    }

    pub fn is_unity(&self) -> bool {
        self.ramp_frames_remaining == 0 && self.target_amplitude == 1.0
    }

    pub fn amplitude(&self) -> f64 {
        self.target_amplitude
    }

    pub fn settle(&mut self) {
        self.current_amplitude = self.target_amplitude;
        self.ramp_step = 0.0;
        self.ramp_frames_remaining = 0;
    }

    pub fn process_interleaved(
        &mut self,
        input: impl IntoIterator<Item = f64>,
        channels: usize,
        output: &mut Vec<f64>,
    ) {
        output.clear();
        let input = input.into_iter();
        output.reserve(input.size_hint().0);
        for (sample_index, sample) in input.enumerate() {
            if sample_index % channels == 0 && self.ramp_frames_remaining > 0 {
                self.current_amplitude += self.ramp_step;
                self.ramp_frames_remaining -= 1;
                if self.ramp_frames_remaining == 0 {
                    self.current_amplitude = self.target_amplitude;
                    self.ramp_step = 0.0;
                }
            }
            output.push(sample * self.current_amplitude);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::GainStage;

    #[test]
    fn applies_the_same_gain_to_every_channel_in_a_frame() {
        let mut gain = GainStage::default();
        gain.set_volume(50.0, None).unwrap();
        let mut output = Vec::new();

        gain.process_interleaved([1.0, -1.0, 0.5, -0.5], 2, &mut output);

        assert!((output[0] - 0.5).abs() < 1e-9);
        assert!((output[1] + 0.5).abs() < 1e-9);
        assert!((output[2] - 0.25).abs() < 1e-9);
        assert!((output[3] + 0.25).abs() < 1e-9);
    }

    #[test]
    fn rejects_invalid_volume_values() {
        let mut gain = GainStage::default();

        assert!(gain.set_volume(f64::NAN, None).is_err());
        assert!(gain.set_volume(-0.1, None).is_err());
        assert!(gain.set_volume(100.1, None).is_err());
    }

    #[test]
    fn ramps_gain_per_frame_instead_of_per_channel() {
        let mut gain = GainStage::default();
        gain.set_volume(50.0, Some(200)).unwrap();
        let mut output = Vec::new();

        gain.process_interleaved([1.0; 6], 2, &mut output);

        assert_eq!(output[0], output[1]);
        assert_eq!(output[2], output[3]);
        assert_eq!(output[4], output[5]);
        assert!((output[4] - 0.5).abs() < 1e-9);
    }

    #[test]
    fn exposes_the_linear_amplitude_used_by_platform_outputs() {
        let mut gain = GainStage::default();

        gain.set_volume(50.0, None).unwrap();
        assert!((gain.amplitude() - 0.5).abs() < 1e-9);
        gain.set_volume(10.0, None).unwrap();
        assert!((gain.amplitude() - 0.1).abs() < 1e-9);
    }

    #[test]
    fn one_hundred_is_unity_and_zero_is_silence() {
        let mut gain = GainStage::default();
        let mut output = Vec::new();

        assert!(gain.is_unity());
        gain.set_volume(0.0, None).unwrap();
        gain.process_interleaved([1.0, -1.0], 2, &mut output);

        assert_eq!(output, [0.0, -0.0]);
    }
}
