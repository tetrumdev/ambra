//! Feed a new hardware stream silence before consuming any song samples.
//! Count both the queued frames and actual running time: accepting silence into a
//! device buffer is not the same as playing it. Pumps stay short so commands work.
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
    duration: Duration,
    elapsed: Duration,
    started: bool,
    running_at: Option<Instant>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
    struct BufferedOutput {
        frames: usize,
        max_write: Option<usize>,
    }

    impl AudioOutput for BufferedOutput {
        fn open(_spec: StreamSpec) -> Result<Self, String> {
            Ok(Self::default())
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
            assert!(first.iter().chain(second).all(|sample| *sample == 0.0));
            let frames =
                ((first.len() + second.len()) / 2).min(self.max_write.unwrap_or(usize::MAX));
            self.frames += frames;
            Ok(frames)
        }
        fn queued_frames(&mut self) -> Result<usize, String> {
            Ok(self.frames)
        }
        fn is_drained(&mut self) -> Result<bool, String> {
            Ok(false)
        }
    }

    fn stereo() -> StreamSpec {
        StreamSpec {
            sample_rate: 1000,
            channels: 2,
            bits_per_sample: 24,
            requantize: false,
        }
    }

    #[test]
    fn queuing_a_second_of_silence_does_not_complete_a_second_of_resync() {
        let mut delay = ResyncDelay::new(1000, stereo());
        let mut output = BufferedOutput::default();
        assert!(
            delay.pump(&mut output).unwrap(),
            "resync finished as soon as silence entered the output buffer"
        );
        assert_eq!(output.frames, 1000);
        assert!(delay.is_active());
    }

    #[test]
    fn waits_the_configured_time_even_when_the_entire_delay_fits_in_one_buffer() {
        let start = Instant::now();
        let mut delay = ResyncDelay::new(1000, stereo());
        let mut output = BufferedOutput::default();
        assert!(delay.pump_at(&mut output, start).unwrap());
        assert!(
            delay
                .pump_at(&mut output, start + Duration::from_millis(999))
                .unwrap()
        );
        assert!(
            !delay
                .pump_at(&mut output, start + Duration::from_millis(1000))
                .unwrap()
        );
        assert_eq!(output.frames, 1000);
    }

    #[test]
    fn partial_writes_queue_all_silence_without_finishing_early() {
        let start = Instant::now();
        let mut delay = ResyncDelay::new(100, stereo());
        let mut output = BufferedOutput {
            max_write: Some(7),
            ..Default::default()
        };
        for _ in 0..15 {
            assert!(delay.pump_at(&mut output, start).unwrap());
        }
        assert_eq!(output.frames, 100);
        assert!(
            !delay
                .pump_at(&mut output, start + Duration::from_millis(100))
                .unwrap()
        );
        assert_eq!(output.frames, 100);
    }

    #[test]
    fn paused_time_does_not_count_as_resync_time() {
        let start = Instant::now();
        let mut delay = ResyncDelay::new(1000, stereo());
        let mut output = BufferedOutput::default();
        delay.pump_at(&mut output, start).unwrap();
        delay.pause_at(start + Duration::from_millis(400));
        let resumed = start + Duration::from_secs(20);
        assert!(delay.pump_at(&mut output, resumed).unwrap());
        assert!(
            delay
                .pump_at(&mut output, resumed + Duration::from_millis(599))
                .unwrap()
        );
        assert!(
            !delay
                .pump_at(&mut output, resumed + Duration::from_millis(600))
                .unwrap()
        );
    }

    #[test]
    fn zero_delay_never_writes_silence_or_waits() {
        let mut output = BufferedOutput::default();
        let mut delay = ResyncDelay::new(0, stereo());
        assert!(!delay.is_active());
        assert!(!delay.pump(&mut output).unwrap());
        assert_eq!(output.frames, 0);
    }

    #[test]
    fn stalled_output_still_errors_instead_of_waiting_forever() {
        let start = Instant::now();
        let mut output = BufferedOutput {
            max_write: Some(0),
            ..Default::default()
        };
        let mut delay = ResyncDelay::new(1000, stereo());
        assert!(delay.pump_at(&mut output, start).unwrap());
        assert!(
            delay
                .pump_at(&mut output, start + Duration::from_secs(6))
                .is_err()
        );
    }

    #[test]
    fn buffering_and_song_samples_stay_held_until_resync_finishes() {
        use super::super::{PlaybackEngine, PlaybackStatus};
        use std::sync::{Arc, Mutex};
        let (_, commands) = crossbeam_channel::unbounded();
        let status = Arc::new(Mutex::new(PlaybackStatus::default()));
        let mut engine = PlaybackEngine::<BufferedOutput>::new(commands, status.clone(), None);
        engine.spec = Some(stereo());
        engine.audio_settings.outputs[0].resync_delay_ms = 1000;
        engine.desired_playing = true;
        engine.decoder_ended = true;
        engine.current_source = Some("test song".into());
        engine.position_base = 12.0;
        engine.pcm.extend(vec![0.25; 2000]);
        engine.install_output(BufferedOutput::default(), stereo());
        engine.pump().unwrap();
        assert_eq!(engine.pcm.len(), 2000);
        assert_eq!(engine.rendered_frames, 0);
        assert_eq!(engine.output.as_ref().unwrap().frames, 1000);
        assert!(status.lock().unwrap().buffering);
        assert!(!status.lock().unwrap().is_playing);
        engine.pause().unwrap();
        assert!(engine.resync.running_at.is_none());
        assert!(!status.lock().unwrap().buffering);
        assert!(engine.resync.is_active());
    }
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
            duration: Duration::from_millis(u64::from(milliseconds)),
            elapsed: Duration::ZERO,
            started: false,
            running_at: None,
        }
    }

    pub fn is_active(&self) -> bool {
        self.active
    }

    /// Stop the running clock while the hardware is paused, retaining its queued silence.
    pub fn pause(&mut self) {
        self.pause_at(Instant::now());
    }

    fn pause_at(&mut self, now: Instant) {
        if let Some(previous) = self.running_at.take() {
            self.elapsed += now.saturating_duration_since(previous);
        }
        self.stalled_since = None;
    }

    /// Queue the configured silence and keep music/its clock held until that much
    /// running time has passed. Do not wait for padding to hit zero: some drivers
    /// never report an empty buffer, and FIFO ordering keeps silence before music.
    pub fn pump(&mut self, output: &mut impl AudioOutput) -> Result<bool, String> {
        self.pump_at(output, Instant::now())
    }

    fn pump_at(&mut self, output: &mut impl AudioOutput, now: Instant) -> Result<bool, String> {
        if !self.active {
            return Ok(false);
        }
        if self.started {
            if let Some(previous) = self.running_at.replace(now) {
                self.elapsed += now.saturating_duration_since(previous);
            }
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
                self.started = true;
                self.running_at.get_or_insert(now);
                self.stalled_since = None;
            } else {
                let stalled = self.stalled_since.get_or_insert(now);
                if now.saturating_duration_since(*stalled) >= self.stall_timeout {
                    return Err("Audio device stopped accepting samples during resync. Try reopening the output.".into());
                }
            }
        }
        if self.remaining_frames == 0 && self.elapsed >= self.duration {
            self.active = false;
            self.running_at = None;
        }
        Ok(self.active)
    }
}
