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

    pub fn process_in_place(&mut self, samples: &mut [f64], channels: usize) {
        for frame in samples.chunks_exact_mut(channels) {
            if self.ramp_frames_remaining > 0 {
                self.current_amplitude += self.ramp_step;
                self.ramp_frames_remaining -= 1;
                if self.ramp_frames_remaining == 0 {
                    self.current_amplitude = self.target_amplitude;
                }
            }
            for sample in frame {
                *sample *= self.current_amplitude;
            }
        }
    }

}
