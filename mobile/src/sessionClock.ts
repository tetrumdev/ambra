/** Maps the server's monotonic clock onto this phone using the quickest recent round trip. */
export class SessionClock {
  private samples: { offset: number; roundTrip: number; at: number }[] = [];

  reset() { this.samples = []; }

  sample(serverTime: number, sent: number, received: number) {
    if (!Number.isFinite(serverTime) || received < sent) return;
    this.samples = [...this.samples.filter(sample => received - sample.at < 120_000),
      { offset: serverTime - (sent + received) / 2, roundTrip: received - sent, at: received }].slice(-12);
  }

  recent(now: number) { return this.samples.some(sample => now - sample.at < 15_000); }

  age(serverTime: number | undefined, receivedAt: number, now: number) {
    const best = this.samples.filter(sample => now - sample.at < 120_000)
      .reduce<(typeof this.samples)[number] | null>((best, sample) => !best || sample.roundTrip < best.roundTrip ? sample : best, null);
    return Math.max(0, (best && serverTime !== undefined && Number.isFinite(serverTime)
      ? now + best.offset - serverTime : now - receivedAt) / 1000);
  }
}
