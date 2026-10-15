import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { parseTrackLyrics } from "../src/types/lyrics";
import { detailedLine, focusLyric, lyricActive, segmentProgress } from "../src/utils/lyricsTiming";
import { createPlaybackClock } from "../src/utils/playbackClock";
import { line, lyricsFixture, segment } from "./lyricsFixtures";

afterEach(() => { for (const spy of spies.splice(0)) spy.mockRestore(); });
const spies: ReturnType<typeof spyOn>[] = [];

const at = (time: number) => { const spy = spyOn(performance, "now").mockReturnValue(time); spies.push(spy); return spy; };

describe("segment timing", () => {
  test("fill follows precise duration and resets after backward seeks", () => {
    const timed = segment("Amber", 1000, 2000);
    expect([500, 1000, 1250, 1500, 2000, 3000, 1100].map(time => segmentProgress(timed, time)))
      .toEqual([0, 0, 0.25, 0.5, 1, 1, 0.1]);
  });
  test("start is inclusive and end is exclusive", () => {
    const timed = segment("Amber", 1000, 2000);
    expect(lyricActive(timed, 999)).toBe(false);
    expect(lyricActive(timed, 1000)).toBe(true);
    expect(lyricActive(timed, 2000)).toBe(false);
  });
  test("plain text never receives invented timing", () => {
    expect(lyricActive(segment("plain", null, null, "none"), 5000)).toBe(false);
    expect(segmentProgress(segment("plain", null, null, "none"), 5000)).toBe(0);
  });
  test("zero duration and missing ends remain finite", () => {
    expect(segmentProgress(segment("x", 1000, 1000), 1000)).toBe(1);
    expect(segmentProgress(segment("x", 1000, null), 1000)).toBe(1);
  });
  test("line-only timing does not become word or syllable timing", () => {
    expect(detailedLine(lyricsFixture("line").lines[0])).toBe(false);
    expect(detailedLine(lyricsFixture("word").lines[0])).toBe(true);
    expect(detailedLine(lyricsFixture("syllable").lines[0])).toBe(true);
  });
  test("equal timestamps do not imply detail", () => {
    expect(detailedLine(line("ab", 0, 1000, [segment("a", 0, 1000), segment("b", 0, 1000)]))).toBe(false);
  });
  test("scripts without spaces retain independent fill", () => {
    const lyric = line("你好", 0, 2000, [segment("你", 0, 1000, "segment"), segment("好", 1000, 2000, "segment")]);
    expect(detailedLine(lyric)).toBe(true);
    expect(lyric.segments.map(value => segmentProgress(value, 1500))).toEqual([1, 0.5]);
  });
  test("background vocals remain in focus after lead finishes", () => {
    const { lines } = lyricsFixture();
    expect(focusLyric(lines, 3200)).toBe(0);
    expect(focusLyric(lines, 3700)).toBe(-1);
    expect(focusLyric(lines, 4500)).toBe(1);
  });
  test("overlapping vocals keep lead focus", () => {
    const { lines } = lyricsFixture();
    expect(focusLyric(lines, 2000)).toBe(0);
    expect(lyricActive(lines[0].backgroundVocals[0], 2000)).toBe(true);
  });
  test("positive and negative offsets move playback relative to lyrics", () => {
    const timed = segment("Amber", 1000, 2000);
    expect(segmentProgress(timed, 1000 + 250)).toBe(0.25);
    expect(segmentProgress(timed, 1000 - 250)).toBe(0);
  });
});

describe("playback clock", () => {
  test("interpolates without notifying React each frame", () => {
    const now = at(0); const clock = createPlaybackClock(); let notifications = 0;
    clock.subscribe(() => notifications++); clock.set(10); clock.setRunning(true);
    const count = notifications;
    now.mockReturnValue(100); expect(clock.getSmooth()).toBe(10.1);
    now.mockReturnValue(200); expect(clock.getSmooth()).toBe(10.2);
    expect(notifications).toBe(count); expect(clock.get()).toBe(10);
  });
  test("pause freezes and resume reanchors", () => {
    const now = at(0); const clock = createPlaybackClock(); clock.set(10); clock.setRunning(true);
    now.mockReturnValue(100); clock.setRunning(false);
    now.mockReturnValue(1000); expect(clock.getSmooth()).toBe(10.1);
    clock.setRunning(true); now.mockReturnValue(1100); expect(clock.getSmooth()).toBe(10.2);
  });
  test("seeking resets interpolation immediately", () => {
    const now = at(0); const clock = createPlaybackClock(); clock.set(10); clock.setRunning(true);
    now.mockReturnValue(200); clock.set(1); expect(clock.getSmooth()).toBe(1);
    now.mockReturnValue(300); expect(clock.getSmooth()).toBe(1.1);
  });
  test("missing native samples cannot advance indefinitely", () => {
    const now = at(0); const clock = createPlaybackClock(); clock.set(10); clock.setRunning(true);
    now.mockReturnValue(2000); expect(clock.getSmooth()).toBe(10.25);
    clock.setRunning(false); clock.set(10); now.mockReturnValue(3000); expect(clock.getSmooth()).toBe(10);
  });
});

describe("wire validation", () => {
  test("accepts all supported synchronization levels", () => {
    for (const sync of ["none", "line", "word", "segment", "syllable"] as const) expect(parseTrackLyrics(lyricsFixture(sync)).sync).toBe(sync);
  });
  test("rejects malformed data before animation", () => {
    for (const change of [
      (value: ReturnType<typeof lyricsFixture>) => { value.lines[0].segments[0].endMs = -1; },
      (value: ReturnType<typeof lyricsFixture>) => { value.lines[0].segments[0].startMs = Number.NaN; },
      (value: ReturnType<typeof lyricsFixture>) => { value.lines[0].text = "wrong"; },
      (value: ReturnType<typeof lyricsFixture>) => { value.offsetMs = Number.POSITIVE_INFINITY; },
    ]) {
      const value = lyricsFixture(); change(value); expect(() => parseTrackLyrics(value)).toThrow("Invalid lyrics response");
    }
  });
  test("distinguishes missing and instrumental responses", () => {
    for (const status of ["unavailable", "instrumental"] as const) {
      const value = { ...lyricsFixture(), status, lines: [], plainLyrics: null, sync: "none", hasWordSync: false };
      expect(parseTrackLyrics(value).status).toBe(status);
    }
  });
});
