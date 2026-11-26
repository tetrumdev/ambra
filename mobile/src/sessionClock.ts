import { estimateClockOffset, type ClockSample } from "../../desktop/src/utils/clockEstimate";

/** How long readings are kept: long enough to see the clocks drift apart. */
const WINDOW_MS = 120_000;

/**
 * Maps the server's monotonic clock onto this phone: the quickest recent round trips, fitted
 * with the drift between the two clocks (`estimateClockOffset`, shared with desktop).
 */
export class SessionClock {
  private samples: ClockSample[] = [];

  reset() { this.samples = []; }

  sample(serverTime: number, sent: number, received: number) {
    if (!Number.isFinite(serverTime) || received < sent) return;
    this.samples = [...this.samples.filter(sample => received - sample.at < WINDOW_MS),
      { offset: serverTime - (sent + received) / 2, roundTrip: received - sent, at: received }].slice(-60);
  }

  recent(now: number) { return this.samples.some(sample => now - sample.at < 15_000); }

  /** The server's clock less this phone's at `now`, or null before any round trip. */
  offset(now: number) {
    return estimateClockOffset(this.samples.filter(sample => now - sample.at < WINDOW_MS), now);
  }

  age(serverTime: number | undefined, receivedAt: number, now: number) {
    const offset = this.offset(now);
    return Math.max(0, (offset !== null && serverTime !== undefined && Number.isFinite(serverTime)
      ? now + offset - serverTime : now - receivedAt) / 1000);
  }
}
