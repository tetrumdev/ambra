import { describe, expect, test } from "bun:test";
import { advanceSpring, letterMotion, rippleSpring } from "../src/utils/lyricsMotion";
import { advanceLyricRipple, advanceLyricScrollMotion, advanceNativeDot, advanceNativeLetter, lyricClockStep, lyricFontSize, lyricRipple, lyricScrollSettled, lyricScrollTarget, nativeDot, nativeLetter, shouldAdvanceLyricRow, type LyricScrollGoal, type LyricScrollMotion } from "../../mobile/src/lyricsAnimation";

const heldLetter = () => nativeLetter(letterMotion({ text: "Oh", startMs: 1000, endMs: 3000, singer: null, granularity: "word" }, 0, 2));

describe("continuous mobile lyric motion", () => {
  test("lead lyric size is exactly five percent below the previous size on compact phones and tablets", () => {
    for (const width of [320, 390, 430, 768, 1024]) {
      const previous = Math.min(48, Math.max(34, width * 0.1)) * 1.15;
      expect(lyricFontSize(width)).toBeCloseTo(previous * 0.95, 8);
    }
  });

  test("inactive and paused rows stop submitting updates but resume for singing, release and seeks", () => {
    expect(shouldAdvanceLyricRow({ time: 1000, moving: false }, 1016, false, 1 / 60).advance).toBe(false);
    expect(shouldAdvanceLyricRow({ time: 1000, moving: false }, 1000, true, 1 / 60).advance).toBe(false);
    expect(shouldAdvanceLyricRow({ time: 1000, moving: false }, 1016, true, 1 / 60).advance).toBe(true);
    expect(shouldAdvanceLyricRow({ time: 1000, moving: true }, 1016, false, 1 / 60).advance).toBe(true);
    expect(shouldAdvanceLyricRow({ time: 1000, moving: false }, 5000, false, 1 / 60)).toEqual({ advance: true, snap: true });
    expect(shouldAdvanceLyricRow({ time: 1000, moving: false }, 0, false, 1 / 60)).toEqual({ advance: true, snap: true });
  });

  test("scroll snapshots stop changing once the ripple settles, and a new target wakes them", () => {
    const motion: LyricScrollMotion = { offset: 0, ripples: Array.from({ length: 10 }, lyricRipple) };
    const target: LyricScrollGoal = { offset: 160, focus: 1, origin: 0, epoch: 1, snap: false };
    expect(lyricScrollSettled(motion, target)).toBe(false);
    for (let frame = 0; frame < 1200; frame++) advanceLyricScrollMotion(motion, target, frame * 1000 / 120, 1 / 120, 0, true, false);
    expect(lyricScrollSettled(motion, target)).toBe(true);
    expect(lyricScrollSettled(motion, { ...target, offset: 200, epoch: 2 })).toBe(false);
  });

  test("small clock corrections never reverse the sweep, while real seeks and pauses apply immediately", () => {
    let current = 1000;
    for (let frame = 1; frame <= 120; frame++) {
      const sampled = 1000 + frame * 1000 / 120 + (frame % 2 ? -30 : 30);
      const next = lyricClockStep(current, sampled, 1 / 120, true);
      expect(next).toBeGreaterThan(current);
      expect(next - current).toBeLessThan(10);
      current = next;
    }
    expect(lyricClockStep(current, 400, 1 / 120, true)).toBe(400);
    expect(lyricClockStep(current, 12000, 1 / 120, true)).toBe(12000);
    expect(lyricClockStep(current, 1750, 1 / 120, false)).toBe(1750);
    expect(lyricClockStep(NaN, 5000, 0, true)).toBe(5000);
  });

  test("held notes keep spring momentum across frame rates and settle without a jump at line end", () => {
    const simulate = (fps: number) => {
      const letter = heldLetter();
      for (let frame = 0; frame <= fps * 2; frame++) advanceNativeLetter(letter, 1000 + frame * 1000 / fps, true, 1 / fps, frame === 0, false);
      const before = letter.scale.value;
      expect(before).toBeGreaterThan(1);
      advanceNativeLetter(letter, 3000 + 1000 / fps, false, 1 / fps, false, false);
      expect(Math.abs(letter.scale.value - before)).toBeLessThan(0.01);
      for (let frame = 1; frame < fps * 2; frame++) advanceNativeLetter(letter, 3000 + frame * 1000 / fps, false, 1 / fps, false, false);
      expect(letter.scale.value).toBeCloseTo(1, 4);
      expect(letter.lift.value).toBeCloseTo(0, 4);
      return before;
    };
    expect(Math.abs(simulate(60) - simulate(120))).toBeLessThan(0.01);
  });

  test("a seek clears old momentum and reduced motion keeps highlighting without lift or swell", () => {
    const letter = heldLetter();
    for (let frame = 0; frame < 60; frame++) advanceNativeLetter(letter, 1000 + frame * 16.67, true, 1 / 60, false, false);
    expect(letter.scale.value).toBeGreaterThan(1);
    advanceNativeLetter(letter, 0, false, 1 / 60, true, false);
    expect(letter.scale).toEqual({ value: 1, velocity: 0 });
    expect(letter.lift).toEqual({ value: 0, velocity: 0 });
    expect(letter.head).toBe(0);
    advanceNativeLetter(letter, 2500, true, 1 / 60, false, true);
    expect(letter.head).toBe(1);
    expect(letter.lift.value).toBe(0);
    expect(letter.scale.value).toBe(1);
    expect(letter.glow.value).toBe(0);
  });

  test("neighbouring lines set off in order, preserve velocity on retarget, and cancel lag for browsing", () => {
    const target: LyricScrollGoal = { offset: 150, focus: 1, origin: 0, epoch: 1, snap: false };
    const first = lyricRipple();
    const second = lyricRipple();
    advanceLyricRipple(first, target, 0, 0, 1 / 120, 0, false);
    advanceLyricRipple(second, target, 1, 0, 1 / 120, 0, false);
    for (let frame = 1; frame <= 8; frame++) {
      advanceLyricRipple(first, target, 0, frame * 1000 / 120, 1 / 120, 0, false);
      advanceLyricRipple(second, target, 1, frame * 1000 / 120, 1 / 120, 0, false);
    }
    expect(first.value).toBeGreaterThan(0);
    expect(second.value).toBe(0);
    const value = first.value;
    const velocity = first.velocity;
    advanceLyricRipple(first, { ...target, offset: 300, epoch: 2 }, 0, 75, 0, 0, false);
    expect(first.value).toBe(value);
    expect(first.velocity).toBe(velocity);
    advanceLyricRipple(first, target, 0, 80, 1 / 120, 87, true);
    expect(first.value).toBe(87);
    expect(first.velocity).toBe(0);
    for (let frame = 0; frame < 600; frame++) advanceLyricRipple(first, { ...target, offset: 0, epoch: 3 }, 0, 100 + frame * 1000 / 120, 1 / 120, 87, false);
    expect(first.value).toBe(0);
  });

  test("wrapped stanzas anchor on their first visual line and scroll limits stay inside content", () => {
    expect(lyricScrollTarget(500, 25, 400, 2000)).toBe(353);
    expect(lyricScrollTarget(0, 25, 400, 2000)).toBe(0);
    expect(lyricScrollTarget(1900, 25, 400, 2000)).toBe(1600);
    expect(lyricScrollTarget(50, 25, 400, 200)).toBe(0);
  });

  test("scroll jumps are compensated in the same frame and each row follows the desktop spring", () => {
    for (const fps of [60, 120]) {
      const motion: LyricScrollMotion = { offset: 0, ripples: Array.from({ length: 4 }, lyricRipple) };
      const initial: LyricScrollGoal = { offset: 0, focus: 0, origin: 0, epoch: 1, snap: true };
      advanceLyricScrollMotion(motion, initial, 0, 0, 0, true, false);
      const target = { ...initial, offset: 160, focus: 1, epoch: 2, snap: false };
      // The native scroll event still reports the old offset at this point.
      advanceLyricScrollMotion(motion, target, 0, 0, 0, true, false);
      expect(motion.offset).toBe(160);
      for (const ripple of motion.ripples) {
        const transform = motion.offset - ripple.value;
        expect(-160 + transform).toBe(0);
      }
      const desktop = motion.ripples.map(() => ({ value: 0, velocity: 0 }));
      for (let frame = 1; frame <= fps; frame++) {
        const now = frame * 1000 / fps;
        // Late or stale native events must not affect the visual trajectory.
        advanceLyricScrollMotion(motion, target, now, 1 / fps, frame % 2 ? 0 : 160, true, false);
        for (let index = 0; index < desktop.length; index++) {
          if (now >= index * 75) advanceSpring(desktop[index], 160, rippleSpring, 1 / fps);
          expect(motion.ripples[index].value).toBeCloseTo(desktop[index].value, 8);
          expect(motion.ripples[index].velocity).toBeCloseTo(desktop[index].velocity, 8);
        }
      }
      // Browsing and reduced motion remove every compensating transform immediately.
      advanceLyricScrollMotion(motion, target, 1100, 1 / fps, 87, false, false);
      expect(motion.offset).toBe(87);
      expect(motion.ripples.every(ripple => ripple.value === 87 && ripple.velocity === 0)).toBe(true);
      advanceLyricScrollMotion(motion, target, 1200, 1 / fps, 87, true, true);
      expect(motion.offset).toBe(160);
      expect(motion.ripples.every(ripple => ripple.value === 160 && ripple.velocity === 0)).toBe(true);
    }
  });

  test("break dots bloom in order, breathe while filling, and finish before vocals return", () => {
    const first = nativeDot();
    const last = nativeDot();
    for (let frame = 0; frame <= 10; frame++) {
      advanceNativeDot(first, 0, frame * 1000 / 120, 0, 6000, 1 / 120, false);
      advanceNativeDot(last, 2, frame * 1000 / 120, 0, 6000, 1 / 120, false);
    }
    expect(first.opacity).toBeGreaterThan(0);
    expect(last.opacity).toBe(0);
    for (let frame = 11; frame <= 600; frame++) advanceNativeDot(first, 0, frame * 1000 / 120, 0, 6000, 1 / 120, false);
    expect(first.opacity).toBeCloseTo(1, 3);
    for (let frame = 601; frame <= 720; frame++) advanceNativeDot(first, 0, frame * 1000 / 120, 0, 6000, 1 / 120, false);
    expect(first.opacity).toBeLessThan(0.02);
    advanceNativeDot(last, 2, 5000, 0, 6000, 1 / 120, true);
    expect(last.opacity).toBeGreaterThan(0.3);
    expect(last.x).toBe(0);
    expect(last.y).toBeCloseTo(0, 6);
  });
});
