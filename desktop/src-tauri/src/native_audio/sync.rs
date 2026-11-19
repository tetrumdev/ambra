//! Playing in step with other outputs, as one of a session's synced group.
//!
//! The server's core gives every output in the group the same anchor: song position `position`
//! is heard at `at` (on the server's clock, which the endpoint turns into this computer's). Each
//! output then lines itself up on its own. Before its first sample it writes exactly as much
//! silence as puts that sample on time, or drops what it's already too late for; while playing
//! it compares what it hears with the anchor and trims single frames, spread out and too few to
//! hear, so its sound card's clock can't drift away from the others'.
use std::{
    collections::VecDeque,
    time::{Duration, Instant},
};

/// An error below this is left alone; above it the output starts trimming frames.
const TRIM_START: f64 = 0.002;
/// Trimming stops once the error is back within this.
const TRIM_STOP: f64 = 0.000_5;
/// Beyond this the output is trimmed faster; still inaudible on music.
const TRIM_FAST_ABOVE: f64 = 0.02;
/// One frame in this many is dropped or doubled while trimming: 1 ms of correction a second.
const TRIM_SLOW_EVERY: f64 = 1_000.0;
const TRIM_FAST_EVERY: f64 = 200.0;
/// An error this large (a stall or an underrun) isn't trimmed away; the output lines up again.
pub const REALIGN_ABOVE: f64 = 0.15;
/// How quickly the measured error follows new measurements. The device's buffer level moves in
/// whole periods, so single readings jump by several milliseconds; the average doesn't.
const ERROR_SMOOTHING: Duration = Duration::from_millis(400);
/// After a format change mid-group, every output reopens its device: the next song starts this
/// much later than gapless, the same on every output, so they stay together.
pub const REOPEN_MARGIN: Duration = Duration::from_millis(250);

/// When the group hears song position `position`: at `at`, on this computer's clock.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Anchor {
    pub at: Instant,
    pub position: f64,
    /// The longest resync delay in the group, which a reopened output waits out with the others.
    pub group_resync: Duration,
}

impl Anchor {
    /// When song position `position` is heard.
    pub fn time_of(&self, position: f64) -> Instant {
        offset(self.at, position - self.position)
    }

    /// The song position heard at `now`.
    pub fn position_at(&self, now: Instant) -> f64 {
        self.position + signed_seconds(now, self.at)
    }

    /// The same timeline, carried over a song change: the song that ended at `ended_at` (its
    /// own position) hands over to the next one's start, later by `delay` when it can't be gapless.
    pub fn carried_over(&self, ended_at: f64, delay: Duration) -> Self {
        Self {
            at: self.time_of(ended_at) + delay,
            position: 0.0,
            group_resync: self.group_resync,
        }
    }
}

/// `at` moved by `seconds`, which may be negative.
pub fn offset(at: Instant, seconds: f64) -> Instant {
    if !seconds.is_finite() {
        return at;
    }
    let by = Duration::from_secs_f64(seconds.abs().min(1.0e6));
    if seconds >= 0.0 {
        at.checked_add(by).unwrap_or(at)
    } else {
        at.checked_sub(by).unwrap_or(at)
    }
}

/// `later - earlier` in seconds, negative when `later` comes first.
pub fn signed_seconds(later: Instant, earlier: Instant) -> f64 {
    if later >= earlier {
        later.duration_since(earlier).as_secs_f64()
    } else {
        -earlier.duration_since(later).as_secs_f64()
    }
}

/// This output's part in the group: holding for the start, then playing to the anchor.
#[derive(Debug)]
pub struct SyncState {
    pub epoch: u64,
    /// None while the output is held for the group's start.
    pub anchor: Option<Anchor>,
    /// The first sample went out on time; from here the output is only trimmed.
    pub aligned: bool,
    pub trim: DriftTrim,
    /// Frames still to drop (positive) or double (negative), owed by the trim.
    pub pending: i64,
}

impl SyncState {
    pub fn hold(epoch: u64) -> Self {
        Self { epoch, anchor: None, aligned: false, trim: DriftTrim::default(), pending: 0 }
    }

    pub fn start(&mut self, anchor: Anchor) {
        self.anchor = Some(anchor);
        self.aligned = false;
        self.trim = DriftTrim::default();
        self.pending = 0;
    }
}

/// Frames of silence still needed in front of the song so the frame at `head` (a song
/// position) is heard when the anchor says; negative when that time has passed and as many
/// song frames must be dropped. `queued_frames` are already in the device, ahead of it, and
/// `latency` is what the device adds after them.
pub fn lead_frames(anchor: &Anchor, head: f64, now: Instant, latency: Duration, queued_frames: usize, sample_rate: u32) -> i64 {
    let rate = f64::from(sample_rate);
    let due = signed_seconds(anchor.time_of(head), now);
    let lead = due - latency.as_secs_f64() - queued_frames as f64 / rate;
    (lead * rate).round() as i64
}

/// Keeps a playing output on the anchor by dropping or doubling single frames.
#[derive(Debug, Default)]
pub struct DriftTrim {
    smoothed: Option<f64>,
    measured_at: Option<Instant>,
    active: bool,
    /// Fractions of a frame owed to the correction.
    owed: f64,
}

impl DriftTrim {
    /// Takes one measurement: positive when this output is ahead of the anchor.
    pub fn observe(&mut self, error: f64, now: Instant) {
        if !error.is_finite() {
            return;
        }
        let smoothed = match (self.smoothed, self.measured_at) {
            (Some(previous), Some(at)) => {
                let elapsed = now.saturating_duration_since(at).as_secs_f64();
                let weight = elapsed / (ERROR_SMOOTHING.as_secs_f64() + elapsed);
                previous + (error - previous) * weight
            }
            _ => error,
        };
        self.smoothed = Some(smoothed);
        self.measured_at = Some(now);
    }

    /// The averaged error, in seconds; positive when ahead.
    pub fn error(&self) -> Option<f64> {
        self.smoothed
    }

    /// How many frames to drop (positive) or double (negative) now that `frames` more were
    /// played. Usually zero.
    pub fn frames(&mut self, frames: usize) -> i64 {
        let Some(error) = self.smoothed else { return 0 };
        if !self.active && error.abs() > TRIM_START {
            self.active = true;
        } else if self.active && error.abs() < TRIM_STOP {
            self.active = false;
            self.owed = 0.0;
        }
        if !self.active {
            return 0;
        }
        let every = if error.abs() > TRIM_FAST_ABOVE { TRIM_FAST_EVERY } else { TRIM_SLOW_EVERY };
        self.owed += frames as f64 / every;
        let whole = self.owed.floor();
        self.owed -= whole;
        // Behind (heard earlier in the song than due): drop frames to catch up.
        if error < 0.0 { whole as i64 } else { -(whole as i64) }
    }
}

/// Drops (`count > 0`) or doubles (`count < 0`) that many frames, spread evenly through the
/// first `span` frames of `pcm`, so no two changes sit together. Returns the frames changed.
pub fn adjust_frames(pcm: &mut VecDeque<f64>, channels: usize, count: i64, span: usize) -> i64 {
    let available = pcm.len() / channels.max(1);
    let span = span.min(available);
    let wanted = count.unsigned_abs() as usize;
    if channels == 0 || span < 2 || wanted == 0 {
        return 0;
    }
    let changes = wanted.min(span / 2);
    let step = span / changes;
    // From the back, so earlier positions don't move as frames go in or out.
    for change in (0..changes).rev() {
        let frame = change * step + step / 2;
        let at = frame * channels;
        if count > 0 {
            pcm.drain(at..at + channels);
        } else {
            for channel in 0..channels {
                let sample = pcm[at + channel];
                pcm.insert(at + channels + channel, sample);
            }
        }
    }
    if count > 0 { changes as i64 } else { -(changes as i64) }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn anchor(at: Instant, position: f64) -> Anchor {
        Anchor { at, position, group_resync: Duration::ZERO }
    }

    #[test]
    fn silence_fills_exactly_the_time_until_the_first_sample_is_due() {
        let now = Instant::now();
        let start = anchor(now + Duration::from_millis(500), 10.0);
        assert_eq!(lead_frames(&start, 10.0, now, Duration::ZERO, 0, 1000), 500);
        // The device's own delay and what it already holds come off the silence.
        assert_eq!(lead_frames(&start, 10.0, now, Duration::from_millis(100), 50, 1000), 350);
        // A head further into the song is due later.
        assert_eq!(lead_frames(&start, 10.25, now, Duration::ZERO, 0, 1000), 750);
    }

    #[test]
    fn a_late_output_drops_what_it_missed() {
        let now = Instant::now();
        let started = anchor(now - Duration::from_millis(300), 0.0);
        assert_eq!(lead_frames(&started, 0.0, now, Duration::ZERO, 0, 1000), -300);
        assert_eq!(lead_frames(&started, 0.3, now, Duration::ZERO, 0, 1000), 0);
    }

    #[test]
    fn the_timeline_carries_over_a_song_change() {
        let now = Instant::now();
        let playing = anchor(now, 100.0);
        let next = playing.carried_over(180.0, Duration::ZERO);
        assert_eq!(next.position, 0.0);
        assert_eq!(next.at, now + Duration::from_secs(80));
        let reopened = playing.carried_over(180.0, Duration::from_millis(250));
        assert_eq!(reopened.at, now + Duration::from_millis(80_250));
    }

    #[test]
    fn small_errors_are_left_and_larger_ones_trimmed_slowly_in_the_right_direction() {
        let now = Instant::now();
        let mut trim = DriftTrim::default();
        trim.observe(0.001, now);
        assert_eq!(trim.frames(10_000), 0);
        let mut behind = DriftTrim::default();
        behind.observe(-0.005, now);
        assert_eq!(behind.frames(10_000), 10, "behind drops a frame in a thousand");
        let mut ahead = DriftTrim::default();
        ahead.observe(0.005, now);
        assert_eq!(ahead.frames(10_000), -10, "ahead doubles a frame in a thousand");
        let mut far = DriftTrim::default();
        far.observe(-0.05, now);
        assert_eq!(far.frames(1_000), 5);
    }

    #[test]
    fn trimming_stops_once_back_in_step() {
        let now = Instant::now();
        let mut trim = DriftTrim::default();
        trim.observe(-0.004, now);
        assert!(trim.frames(1_000) > 0);
        trim.smoothed = Some(-0.0001);
        assert_eq!(trim.frames(100_000), 0);
    }

    #[test]
    fn measurements_are_averaged_over_time() {
        let now = Instant::now();
        let mut trim = DriftTrim::default();
        trim.observe(0.0, now);
        trim.observe(0.01, now + Duration::from_millis(10));
        let error = trim.error().unwrap();
        assert!(error > 0.0 && error < 0.001, "one jump barely moves the average: {error}");
    }

    #[test]
    fn frames_are_dropped_and_doubled_spread_through_the_span() {
        let mut pcm: VecDeque<f64> = (0..20).map(f64::from).collect();
        assert_eq!(adjust_frames(&mut pcm, 2, 2, 10), 2);
        assert_eq!(pcm.len(), 16);
        // Frames 2 and 7 went; the rest keep their order.
        assert_eq!(pcm.iter().copied().collect::<Vec<_>>(), vec![0., 1., 2., 3., 6., 7., 8., 9., 10., 11., 12., 13., 16., 17., 18., 19.]);

        let mut pcm: VecDeque<f64> = (0..8).map(f64::from).collect();
        assert_eq!(adjust_frames(&mut pcm, 2, -1, 4), -1);
        assert_eq!(pcm.iter().copied().collect::<Vec<_>>(), vec![0., 1., 2., 3., 4., 5., 4., 5., 6., 7.]);
    }

    /// A device that keeps everything written (it never plays), telling silence from music.
    #[derive(Default)]
    struct Recording {
        silence: usize,
        music: usize,
    }

    impl super::super::output::AudioOutput for Recording {
        fn open(_spec: super::super::StreamSpec) -> Result<Self, String> { Ok(Self::default()) }
        fn start(&mut self) -> Result<(), String> { Ok(()) }
        fn pause(&mut self) -> Result<(), String> { Ok(()) }
        fn reset(&mut self) -> Result<(), String> { self.silence = 0; self.music = 0; Ok(()) }
        fn write(&mut self, first: &[f64], second: &[f64]) -> Result<usize, String> {
            let frames = (first.len() + second.len()) / 2;
            if first.first().is_some_and(|sample| *sample == 0.0) { self.silence += frames } else { self.music += frames }
            Ok(frames)
        }
        fn queued_frames(&mut self) -> Result<usize, String> { Ok(self.silence + self.music) }
        fn is_drained(&mut self) -> Result<bool, String> { Ok(false) }
    }

    fn held_engine(position: f64) -> super::super::PlaybackEngine<Recording> {
        use super::super::{PlaybackEngine, PlaybackStatus, StreamSpec};
        use std::sync::{Arc, Mutex};
        let spec = StreamSpec { sample_rate: 1000, channels: 2, bits_per_sample: 24, requantize: false };
        let mut engine = PlaybackEngine::<Recording>::new(crossbeam_channel::unbounded().1, Arc::new(Mutex::new(PlaybackStatus::default())), None);
        engine.spec = Some(spec);
        engine.desired_playing = true;
        engine.decoder_ended = true;
        engine.current_source = Some("song".into());
        engine.position_base = position;
        engine.pcm.extend(vec![0.25; 4000]);
        engine.install_output(Recording::default(), spec);
        engine.audio_settings.outputs[0].resync_delay_ms = 700;
        engine.apply_sync(super::super::SyncCommand::Hold { epoch: 7 });
        engine
    }

    #[test]
    fn a_held_output_reports_ready_and_stays_silent_until_the_start() {
        let mut engine = held_engine(5.0);
        engine.pump().unwrap();
        let status = engine.status.lock().unwrap().clone();
        assert_eq!(status.sync_ready, Some(7));
        assert_eq!(status.sync_resync_delay_ms, 700, "a freshly opened device asks for its resync delay");
        assert!(!status.is_playing);
        let output = engine.output.as_ref().unwrap();
        assert_eq!(output.silence + output.music, 0);
        // A start for another epoch is stale and ignored.
        engine.apply_sync(super::super::SyncCommand::Start { epoch: 6, at: Instant::now(), position: 5.0, group_resync: Duration::ZERO });
        engine.pump().unwrap();
        assert_eq!(engine.output.as_ref().unwrap().music, 0);
    }

    #[test]
    fn an_early_start_is_padded_with_exactly_the_silence_before_it() {
        let mut engine = held_engine(5.0);
        engine.pump().unwrap();
        engine.apply_sync(super::super::SyncCommand::Start { epoch: 7, at: Instant::now() + Duration::from_millis(300), position: 5.0, group_resync: Duration::ZERO });
        for _ in 0..20 {
            engine.pump().unwrap();
            if engine.output.as_ref().unwrap().music > 0 { break; }
        }
        let output = engine.output.as_ref().unwrap();
        assert!(output.music > 0, "the song follows the silence");
        assert!((280..=300).contains(&output.silence), "about 300 ms of silence: {}", output.silence);
        assert!(engine.sync.as_ref().unwrap().aligned);
    }

    #[test]
    fn a_late_start_drops_what_the_group_already_played() {
        let mut engine = held_engine(5.0);
        engine.pump().unwrap();
        engine.apply_sync(super::super::SyncCommand::Start { epoch: 7, at: Instant::now() - Duration::from_millis(200), position: 5.0, group_resync: Duration::ZERO });
        engine.pump().unwrap();
        let output = engine.output.as_ref().unwrap();
        assert_eq!(output.silence, 0);
        assert!(output.music > 0);
        let dropped = engine.position_base - 5.0;
        assert!((0.2..0.25).contains(&dropped), "about 200 ms dropped: {dropped}");
    }

    #[test]
    fn too_few_frames_are_left_alone() {
        let mut pcm: VecDeque<f64> = VecDeque::from(vec![0.0, 0.0]);
        assert_eq!(adjust_frames(&mut pcm, 2, 3, 100), 0);
        assert_eq!(pcm.len(), 2);
    }
}
