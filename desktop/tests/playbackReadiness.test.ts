import { describe, expect, test } from "bun:test";
import { canAttemptPlayback } from "../src/utils/playbackReadiness";

describe("canAttemptPlayback", () => {
  test("waits for a new DASH track to buffer", () => {
    expect(canAttemptPlayback("dash", 0)).toBe(false);
    expect(canAttemptPlayback("dash", 2)).toBe(false);
    expect(canAttemptPlayback("dash", 3)).toBe(true);
  });

  test("allows direct tracks to initiate loading through play", () => {
    expect(canAttemptPlayback("direct", 0)).toBe(true);
  });
});
