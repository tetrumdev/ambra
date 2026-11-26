import { expect, test } from "bun:test";
import { estimateClockOffset } from "../../desktop/src/utils/clockEstimate";
import { SyncTrim, carriedOver, positionAt } from "../src/phoneSync";

test("the clock estimate ignores slow round trips and follows the drift between clocks", () => {
  // The server's clock gains 50 ppm; slow readings are off by half their extra delay.
  const truth = (at: number) => 1000 + at * 5e-5;
  const samples = Array.from({ length: 30 }, (_, step) => {
    const at = step * 2000;
    const slow = step % 3 === 0;
    return { at, roundTrip: slow ? 40 : 4, offset: truth(at) + (slow ? 15 : 0) };
  });
  expect(Math.abs(estimateClockOffset(samples, 60_000)! - truth(60_000))).toBeLessThan(0.05);
  expect(estimateClockOffset([{ at: 0, roundTrip: 3, offset: 7 }], 5000)).toBe(7);
  expect(estimateClockOffset([], 0)).toBeNull();
});

test("the group timeline is read and carried over a song change", () => {
  const anchor = { atMs: 10_000, position: 30 };
  expect(positionAt(anchor, 12_500)).toBe(32.5);
  // The song ends at 200 s: the next one starts 170 s after the anchor.
  expect(carriedOver(anchor, 200)).toEqual({ atMs: 180_000, position: 0 });
});

test("small errors are left alone, larger ones nudged in the right direction, then released", () => {
  const trim = new SyncTrim();
  trim.observe(0.004, 0);
  expect(trim.rate()).toBe(1);
  const ahead = new SyncTrim();
  ahead.observe(0.03, 0);
  expect(ahead.rate()).toBeLessThan(1);
  const behind = new SyncTrim();
  behind.observe(-0.03, 0);
  expect(behind.rate()).toBeGreaterThan(1);
  const far = new SyncTrim();
  far.observe(-0.12, 0);
  expect(far.rate()).toBeCloseTo(1.02, 5);
  // Back within a few milliseconds, normal speed again.
  behind.observe(-0.001, 10_000);
  expect(behind.rate()).toBe(1);
});
