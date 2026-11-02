import { expect, mock, test } from "bun:test";

mock.module("../src/utils/persistentStorage", () => ({ getPersistentItem: () => null, setPersistentItem: () => {} }));
const { trustedCorrection } = await import("../src/utils/lyricsAutoTuning");

test("a shift of a second or two is trusted on ordinary evidence", () => {
  expect(trustedCorrection({ bestMs: 1500, prominence: 5, margin: 1 })).toBe(1500);
});

test("a shift of several seconds needs much stronger evidence", () => {
  // Second Life Syndrome: in sync as published, yet a repeated section scored at 5.9 s.
  expect(trustedCorrection({ bestMs: -5920, prominence: 5, margin: 1 })).toBeNull();
  expect(trustedCorrection({ bestMs: -5920, prominence: 9, margin: 3 })).toBe(-5920);
});
