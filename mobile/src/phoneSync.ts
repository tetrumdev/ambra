/**
 * The phone's part in a synced group (desktop's `native_audio/sync.rs`, for a player that can't
 * place single samples). The server gives every output the same timeline: song position
 * `position` is heard at `atMs` (here on this phone's monotonic clock). The phone starts as
 * close to it as it can, then keeps measuring what it plays against it: small errors are
 * nudged away by playing a touch faster or slower (pitch-corrected, inaudible), larger ones
 * by seeking to where the group is.
 */
export type SyncAnchor = { atMs: number; position: number };

/** Errors below this are left alone; trimming stops once back within `TRIM_STOP`. */
const TRIM_START = 0.015;
const TRIM_STOP = 0.005;
/** Beyond this a nudge would take too long: seek to the group instead. */
export const REALIGN_ABOVE = 0.25;
/** How far the rate may move from 1: 2% fixes 20 ms a second and stays unnoticeable on music. */
const MAX_RATE_CHANGE = 0.02;
/** Rates move in steps this size, so small wobbles in the error don't change it. */
const RATE_STEP = 0.005;
/** A new rate is only set this long after the last: every change costs the player a little. */
export const RATE_HOLD_MS = 1000;
/** Seconds of error corrected per second of playing, per second of error. */
const TRIM_GAIN = 0.6;
/** How quickly the measured error follows new readings; single readings jitter. */
const SMOOTHING_MS = 300;

/** The song position the group hears at `nowMs`. */
export function positionAt(anchor: SyncAnchor, nowMs: number) {
  return anchor.position + (nowMs - anchor.atMs) / 1000;
}

/** The same timeline carried over a song change: the song that ends at `endedAt` hands over to the next one's start. */
export function carriedOver(anchor: SyncAnchor, endedAt: number): SyncAnchor {
  return { atMs: anchor.atMs + (endedAt - anchor.position) * 1000, position: 0 };
}

/** Keeps a playing phone on the timeline. */
export class SyncTrim {
  private smoothed: number | null = null;
  private measuredAt = 0;
  private active = false;

  reset() { this.smoothed = null; this.active = false; }

  /** One reading: positive when the phone is ahead of the group. */
  observe(error: number, nowMs: number) {
    if (!Number.isFinite(error)) return;
    if (this.smoothed === null) this.smoothed = error;
    else {
      const elapsed = Math.max(0, nowMs - this.measuredAt);
      this.smoothed += (error - this.smoothed) * (elapsed / (SMOOTHING_MS + elapsed));
    }
    this.measuredAt = nowMs;
  }

  error() { return this.smoothed; }

  /** The playback rate that brings the phone back on the timeline; 1 when it's on it. */
  rate() {
    const error = this.smoothed;
    if (error === null) return 1;
    if (!this.active && Math.abs(error) > TRIM_START) this.active = true;
    else if (this.active && Math.abs(error) < TRIM_STOP) this.active = false;
    if (!this.active) return 1;
    // Ahead plays slower, behind plays faster, in whole steps.
    const change = Math.max(-MAX_RATE_CHANGE, Math.min(MAX_RATE_CHANGE, error * TRIM_GAIN));
    const stepped = Math.round(change / RATE_STEP) * RATE_STEP;
    return stepped === 0 ? 1 - Math.sign(change) * RATE_STEP : 1 - stepped;
  }
}
