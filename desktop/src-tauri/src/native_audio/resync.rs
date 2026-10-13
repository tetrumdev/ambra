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

#[cfg(test)]
mod tests {
    use super::*;
    #[derive(Default)]
    struct Output {
        channels: usize,
        capacity: usize,
        queued: usize,
        written: usize,
        fail: bool,
    }
    impl AudioOutput for Output {
        fn open(spec: StreamSpec) -> Result<Self, String> {
            Ok(Self {
                channels: spec.channels,
                capacity: 1024,
                ..Self::default()
            })
        }
        fn start(&mut self) -> Result<(), String> {
            Ok(())
        }
        fn pause(&mut self) -> Result<(), String> {
            Ok(())
        }
        fn reset(&mut self) -> Result<(), String> {
            self.queued = 0;
            Ok(())
        }
        fn write(&mut self, first: &[f64], second: &[f64]) -> Result<usize, String> {
            if self.fail {
                return Err("Device disconnected".into());
            }
            assert!(first.iter().chain(second).all(|sample| *sample == 0.0));
            assert!(first.len() <= 1024 * self.channels);
            let count = self.capacity.min(first.len() / self.channels);
            self.queued += count;
            self.written += count;
            Ok(count)
        }
        fn queued_frames(&mut self) -> Result<usize, String> {
            Ok(self.queued)
        }
        fn is_drained(&mut self) -> Result<bool, String> {
            Ok(self.queued == 0)
        }
    }
    fn spec() -> StreamSpec {
        StreamSpec {
            sample_rate: 44100,
            channels: 2,
            bits_per_sample: 24,
        }
    }

    #[test]
    fn zero_delay_does_not_touch_the_output() {
        let mut delay = ResyncDelay::new(0, spec());
        let mut output = Output {
            fail: true,
            ..Output::default()
        };
        assert!(!delay.pump(&mut output).unwrap());
        assert_eq!(output.written, 0);
    }
    #[test]
    fn sends_exact_delay_despite_short_writes_without_waiting_for_zero_padding() {
        let mut delay = ResyncDelay::new(725, spec());
        let mut output = Output::open(spec()).unwrap();
        output.capacity = 127;
        while delay.is_active() {
            delay.pump(&mut output).unwrap();
        }
        assert_eq!(output.written, 31973);
        assert_eq!(output.queued, 31973);
        assert!(!delay.pump(&mut output).unwrap());
        assert!(!delay.is_active());
    }
    #[test]
    fn full_device_buffer_does_not_consume_delay() {
        let mut delay = ResyncDelay::new(500, spec());
        let mut output = Output::open(spec()).unwrap();
        output.capacity = 0;
        let initial = delay.remaining_frames;
        assert!(delay.pump(&mut output).unwrap());
        assert_eq!(delay.remaining_frames, initial);
        output.capacity = 64;
        assert!(delay.pump(&mut output).unwrap());
        assert_eq!(delay.remaining_frames, initial - 64);
    }
    #[test]
    fn duration_follows_new_sample_rate_and_memory_stays_bounded() {
        let high_res = StreamSpec {
            sample_rate: 192000,
            channels: 2,
            bits_per_sample: 24,
        };
        let delay = ResyncDelay::new(10000, high_res);
        assert_eq!(delay.remaining_frames, 1920000);
        assert_eq!(delay.silence.len(), 2048);
    }
    #[test]
    fn hardware_errors_propagate_without_consuming_silence() {
        let mut delay = ResyncDelay::new(500, spec());
        let initial = delay.remaining_frames;
        let mut output = Output::open(spec()).unwrap();
        output.fail = true;
        assert!(delay.pump(&mut output).is_err());
        assert_eq!(delay.remaining_frames, initial);
    }

    #[test]
    fn stalled_device_reports_an_error_instead_of_buffering_forever() {
        let mut delay = ResyncDelay::new(500, spec());
        let mut output = Output::open(spec()).unwrap();
        output.capacity = 0;
        delay.stalled_since = Some(Instant::now() - Duration::from_secs(6));
        let error = delay.pump(&mut output).unwrap_err();
        assert!(error.contains("stopped accepting samples"));
    }
}
