//! Token-bucket pacer for BBR send-rate gating.

use std::time::{Duration, Instant};

/// Token bucket pacing for BBR congestion control.
/// Matches C libudx's `tb_available` / `tb_last_refill_ms` fields.
/// Pure computation — no tokio timers.
#[derive(Debug, Clone)]
pub(crate) struct TokenBucket {
    /// Bytes currently available to send.
    available: u32,
    /// Time up to which elapsed time has been credited as tokens.
    last_refill: Option<Instant>,
    rate_bytes_per_ms: u32,
    max_burst: u32,
}

impl TokenBucket {
    pub(crate) fn new(mss: u32) -> Self {
        Self {
            available: 2 * mss,
            last_refill: None,
            rate_bytes_per_ms: 0,
            max_burst: 2 * mss,
        }
    }

    pub(crate) fn set_rate(&mut self, bytes_per_ms: u32) {
        self.rate_bytes_per_ms = bytes_per_ms;
    }

    /// Credits tokens for elapsed time at microsecond precision. Time too short
    /// to earn a whole byte stays uncredited, so frequent calls do not lose it.
    pub(crate) fn refill(&mut self, now: Instant) {
        let Some(last) = self.last_refill else {
            self.last_refill = Some(now);
            return;
        };
        if self.rate_bytes_per_ms == 0 {
            self.last_refill = Some(now);
            return;
        }
        let elapsed_us = now.saturating_duration_since(last).as_micros() as u64;
        let tokens = elapsed_us * self.rate_bytes_per_ms as u64 / 1000;
        if tokens == 0 {
            return;
        }
        let available = self.available as u64 + tokens;
        if available >= self.max_burst as u64 {
            self.available = self.max_burst;
            self.last_refill = Some(now);
        } else {
            self.available = available as u32;
            let credited_us = tokens * 1000 / self.rate_bytes_per_ms as u64;
            self.last_refill = Some(last + Duration::from_micros(credited_us));
        }
    }

    pub(crate) fn try_consume(&mut self, bytes: u32, now: Instant) -> bool {
        self.refill(now);
        if self.available >= bytes {
            self.available -= bytes;
            true
        } else {
            false
        }
    }

    pub(crate) fn delay_for(&self, bytes: u32, now: Instant) -> Duration {
        if self.rate_bytes_per_ms == 0 || self.available >= bytes {
            return Duration::ZERO;
        }

        let deficit = (bytes - self.available) as u64;
        let elapsed_us = self
            .last_refill
            .map_or(0, |last| now.saturating_duration_since(last).as_micros() as u64);
        let pending_tokens = elapsed_us * self.rate_bytes_per_ms as u64 / 1000;
        let effective_deficit = deficit.saturating_sub(pending_tokens);

        if effective_deficit == 0 {
            return Duration::ZERO;
        }

        Duration::from_micros((effective_deficit * 1000).div_ceil(self.rate_bytes_per_ms as u64))
    }

    pub(crate) fn reset(&mut self, now: Instant) {
        self.available = self.max_burst;
        self.last_refill = Some(now);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_new_has_initial_burst() {
        let tb = TokenBucket::new(1180);
        assert_eq!(tb.available, 2360);
    }

    #[test]
    fn test_try_consume_success() {
        let mut tb = TokenBucket::new(1180);
        let now = Instant::now();

        assert!(tb.try_consume(2360, now));
        assert_eq!(tb.available, 0);
    }

    #[test]
    fn test_try_consume_failure() {
        let mut tb = TokenBucket::new(1180);
        let now = Instant::now();

        assert!(!tb.try_consume(2361, now));
        assert_eq!(tb.available, 2360);
    }

    #[test]
    fn test_set_rate_and_refill() {
        let mut tb = TokenBucket::new(1180);
        let now = Instant::now();
        assert!(tb.try_consume(1000, now));

        tb.set_rate(100);
        let later = now + Duration::from_millis(10);
        tb.refill(later);

        assert_eq!(tb.available, 2360);
    }

    #[test]
    fn test_delay_when_exhausted() {
        let mut tb = TokenBucket::new(1180);
        let now = Instant::now();
        assert!(tb.try_consume(2360, now));

        tb.set_rate(100);
        let delay = tb.delay_for(1180, now);

        assert_eq!(delay, Duration::from_micros(11_800));
    }

    #[test]
    fn test_delay_zero_when_available() {
        let tb = TokenBucket::new(1180);
        let now = Instant::now();

        assert_eq!(tb.delay_for(1180, now), Duration::ZERO);
    }

    #[test]
    fn test_delay_zero_when_rate_zero() {
        let mut tb = TokenBucket::new(1180);
        let now = Instant::now();
        assert!(tb.try_consume(2360, now));

        assert_eq!(tb.delay_for(1180, now), Duration::ZERO);
    }

    #[test]
    fn test_reset() {
        let mut tb = TokenBucket::new(1180);
        let now = Instant::now();
        assert!(tb.try_consume(500, now));

        tb.reset(now + Duration::from_millis(1));

        assert_eq!(tb.available, 2360);
        assert!(tb.last_refill.is_some());
    }
}
