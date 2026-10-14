//! Feed a new hardware stream silence before consuming any song samples.
//! Frame-based timing stays accurate despite short writes and device buffering,
//! and each pump returns promptly so pause/skip/device commands remain usable.
use super::{StreamSpec, output::AudioOutput};
use std::time::{Duration, Instant};

#[derive(Default)]
pub struct ResyncDelay {
    remaining_frames: usize,
    channels: usize,
    active: bool,
    silence: Vec<f64>,
    stalled_since: Option<Instant>,
    stall_timeout: Duration,
}

impl ResyncDelay {
    pub fn new(milliseconds: u32, spec: StreamSpec) -> Self {
        let frames =
            (u64::from(spec.sample_rate) * u64::from(milliseconds)).div_ceil(1000) as usize;
        Self {
            remaining_frames: frames,
            channels: spec.channels,
            active: frames > 0,
            silence: if frames > 0 {
                vec![0.0; frames.min(1024) * spec.channels]
            } else {
                vec![]
            },
            stalled_since: None,
            stall_timeout: Duration::from_millis(u64::from(milliseconds)) + Duration::from_secs(5),
        }
    }

    pub fn is_active(&self) -> bool {
        self.active
    }

    /// Queue exactly the configured silence, then queue music directly behind
    /// it. Waiting for device padding to reach zero can deadlock some drivers;
    /// FIFO ordering already ensures all silence plays before any song samples.
    pub fn pump(&mut self, output: &mut impl AudioOutput) -> Result<bool, String> {
        if !self.active {
            return Ok(false);
        }
        if self.remaining_frames > 0 {
            let count = self
                .remaining_frames
                .min(self.silence.len() / self.channels);
            let written = output.write(&self.silence[..count * self.channels], &[])?;
            if written > count {
                return Err("Audio output reported an invalid silence write".into());
            }
            self.remaining_frames -= written;
            if written > 0 {
                self.stalled_since = None;
            } else {
                let stalled = self.stalled_since.get_or_insert_with(Instant::now);
                if stalled.elapsed() >= self.stall_timeout {
                    return Err("Audio device stopped accepting samples during resync. Try reopening the output.".into());
                }
            }
        }
        if self.remaining_frames == 0 {
            self.active = false;
        }
        Ok(self.active)
    }
}
