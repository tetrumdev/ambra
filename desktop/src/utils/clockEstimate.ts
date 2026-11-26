/**
 * The server's clock less this device's, from timed round trips (NTP-style). Shared by
 * desktop's screens and the phone, and mirrored in the desktop engine's Rust
 * (`remote_endpoint.rs`, `estimate_clock_offset`).
 *
 * A reading is true to within half its round trip, so only readings nearly as quick as the
 * quickest are kept; anything slower was held up on the way. A weighted line through them
 * gives the offset and how fast the two clocks drift apart (tens of parts per million), so the
 * estimate moves smoothly between readings instead of jumping whenever a quicker one arrives.
 */
export type ClockSample = {
  /** When the reply arrived, on this device's monotonic clock (ms). */
  at: number;
  roundTrip: number;
  /** Server time less this device's at the round trip's midpoint (ms). */
  offset: number;
};

/** Real clocks drift far less than this; a steeper line is noise. */
const MAX_SKEW = 2e-4;
/** A drift is only fitted over readings spanning at least this long. */
const MIN_SKEW_SPAN_MS = 10_000;

export function estimateClockOffset(samples: readonly ClockSample[], now: number): number | null {
  const valid = samples.filter(sample => Number.isFinite(sample.offset) && Number.isFinite(sample.roundTrip) && sample.roundTrip >= 0);
  if (!valid.length) return null;
  const quickest = Math.min(...valid.map(sample => sample.roundTrip));
  const good = valid.filter(sample => sample.roundTrip <= quickest * 1.5 + 1);
  const weights = good.map(sample => 1 / (sample.roundTrip / 2 + 0.25) ** 2);
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const meanAt = good.reduce((sum, sample, index) => sum + weights[index] * sample.at, 0) / total;
  const meanOffset = good.reduce((sum, sample, index) => sum + weights[index] * sample.offset, 0) / total;
  let skew = 0;
  const span = Math.max(...good.map(sample => sample.at)) - Math.min(...good.map(sample => sample.at));
  if (good.length >= 4 && span >= MIN_SKEW_SPAN_MS) {
    let variance = 0;
    let covariance = 0;
    good.forEach((sample, index) => {
      variance += weights[index] * (sample.at - meanAt) ** 2;
      covariance += weights[index] * (sample.at - meanAt) * (sample.offset - meanOffset);
    });
    if (variance > 0) skew = Math.min(MAX_SKEW, Math.max(-MAX_SKEW, covariance / variance));
  }
  return meanOffset + skew * (now - meanAt);
}
