import { describe, expect, test } from "bun:test";
import { defaultLyricSync, lyricPositionMs, lyricSyncStorageKey, nudgeLyricSync, parseLyricSync } from "../../mobile/src/lyricSync";
import { SessionClock } from "../../mobile/src/sessionClock";
import { focusBlock, lyricBlocks, lyricWordRuns, lyricWords } from "../../mobile/src/lyricsModel";
import type { LyricLine, TrackLyrics } from "../src/types/lyrics";

const line = (text: string, startMs: number, endMs: number | null): LyricLine => ({ text, startMs, endMs, segments: [{ text, startMs, endMs, granularity: "line", singer: null }], words: [], singer: null, key: null, translations: [], romanization: [], backgroundVocals: [] });
const data = (lines: LyricLine[]): TrackLyrics => ({ status: "lyrics", instrumental: false, sync: "line", hasWordSync: false, lines, offsetMs: 250, plainLyrics: null, source: "lrclib", originalFormat: "lrc", language: "en", singers: [], failedProviders: [] });

describe("mobile lyric synchronization", () => {
  test("opening late starts on current playback including report age, and unknown line ends cannot pin focus to the first verse", () => {
    const lyrics = data([line("First", 0, null), line("Middle", 30000, null), line("Current", 60000, null)]);
    const blocks = lyricBlocks(lyrics);
    const initial = lyricPositionMs({ positionSeconds: 60, playing: true, buffering: false }, 15, 180, lyrics.offsetMs);
    expect(initial).toBe(75250);
    expect(focusBlock(lyrics, blocks, initial)).toBe(2);
    expect(focusBlock(lyrics, blocks, 30250)).toBe(1);
    // Closing the view does not pause playback; the next opening re-anchors at its new position.
    const reopened = lyricPositionMs({ positionSeconds: 60, playing: true, buffering: false }, 40, 180, lyrics.offsetMs);
    expect(reopened).toBe(100250);
    expect(focusBlock(lyrics, blocks, reopened)).toBe(2);
    expect(lyricPositionMs({ positionSeconds: 60, playing: false, buffering: false }, 40, 180, 250)).toBe(60250);
    expect(lyricPositionMs({ positionSeconds: 60, playing: true, buffering: true }, 40, 180, 250)).toBe(60250);
    expect(lyricPositionMs({ positionSeconds: 179, playing: true, buffering: false }, 40, 180, -500)).toBe(179500);
  });

  test("wrapped words keep soft spaces on their trailing edge without adding leading spaces or changing sung letters", () => {
    const text = "She doesn’t care about anything";
    const source = line(text, 0, 5000);
    source.segments = [
      { text: "She doesn’t care ", startMs: 0, endMs: 2000, granularity: "word", singer: null },
      { text: "about anything", startMs: 2000, endMs: 5000, granularity: "word", singer: null },
    ];
    const words = lyricWords(source, "en");
    const runs = lyricWordRuns(words);
    expect(runs.map(run => run.text + run.trailing).join("")).toBe(text);
    expect(runs.find(run => run.text === "about")?.text.startsWith(" ")).toBe(false);
    expect(runs.every(run => !run.space)).toBe(true);
    expect(runs.flatMap(run => run.letters)).toEqual(words.flatMap(word => word.letters));
    const explicit = lyricWordRuns([{ text: "A", space: false, letters: [] }, { text: "\n ", space: true, letters: [] }, { text: "B", space: false, letters: [] }]);
    expect(explicit.map(run => run.break ? "\n" : run.text + run.trailing).join("")).toBe("A\nB");
  });

  test("server-clock samples remove delivery delay and ignore slow samples, stale clocks and server restarts", () => {
    const clock = new SessionClock();
    clock.sample(1000, 100, 120);
    expect(clock.age(1200, 400, 500)).toBeCloseTo(0.19, 8);
    clock.sample(1500, 500, 2000);
    expect(clock.age(1200, 400, 500)).toBeCloseTo(0.19, 8);
    expect(clock.age(undefined, 400, 500)).toBe(0.1);
    expect(clock.age(1200, 124900, 125000)).toBe(0.1);
    clock.reset();
    expect(clock.age(1200, 400, 500)).toBe(0.1);
  });

  test("timing nudges persist without shifting playback, reset cleanly, and remain bounded", () => {
    const adjusted = nudgeLyricSync(defaultLyricSync, 500);
    expect(parseLyricSync(JSON.stringify(adjusted))).toEqual(adjusted);
    const playing = { positionSeconds: 30, playing: true, buffering: false };
    expect(lyricPositionMs(playing, 0, 180, 250 + adjusted.correctionMs)).toBe(30750);
    expect(playing.positionSeconds).toBe(30);
    expect(nudgeLyricSync({ correctionMs: 59900, unsynced: false }, 500).correctionMs).toBe(60000);
    expect(nudgeLyricSync({ correctionMs: -59900, unsynced: false }, -500).correctionMs).toBe(-60000);
    expect(parseLyricSync("broken")).toEqual(defaultLyricSync);
    expect(parseLyricSync('{"correctionMs":"500"}')).toEqual(defaultLyricSync);
    expect(parseLyricSync(JSON.stringify(defaultLyricSync))).toEqual(defaultLyricSync);
    expect(lyricSyncStorageKey("provider:track/ä")).toMatch(/^[\w.-]+$/);
    expect(lyricSyncStorageKey("a/b")).not.toBe(lyricSyncStorageKey("a.b"));
  });
});
