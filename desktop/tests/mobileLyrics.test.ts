import { describe, expect, test } from "bun:test";
import type { LyricLine, LyricSegment, TrackLyrics } from "../src/types/lyrics";
import { letterMotion, letterVisuals } from "../src/utils/lyricsMotion";
import { lyricBlocks, lyricSeekSeconds, lyricWords, focusBlock } from "../../mobile/src/lyricsModel";

const segment = (text: string, startMs: number | null, endMs: number | null): LyricSegment => ({ text, startMs, endMs, granularity: "word", singer: null });
const line = (text: string, startMs: number | null, endMs: number | null): LyricLine => ({ text, startMs, endMs, segments: [segment(text, startMs, endMs)], words: [], singer: null, translations: [], romanization: [], backgroundVocals: [], key: null });
const lyrics = (lines: LyricLine[], extra: Partial<TrackLyrics> = {}): TrackLyrics => ({ status: "lyrics", instrumental: false, sync: "word", hasWordSync: true, plainLyrics: null, lines, source: "amll", originalFormat: "ttml", offsetMs: 250, language: "en", singers: [], failedProviders: [], ...extra });

describe("mobile lyrics", () => {
  test("desktop instrumental gaps and shared timing stay aligned with tap-to-seek offsets", () => {
    const data = lyrics([line("First", 6000, 8000), line("Second", 14000, 17000)]);
    const blocks = lyricBlocks(data);
    expect(blocks.map(block => block.kind)).toEqual(["pause", "lines", "pause", "lines"]);
    expect(focusBlock(data, blocks, 1000)).toBe(0);
    expect(focusBlock(data, blocks, 6500)).toBe(1);
    expect(focusBlock(data, blocks, 9000)).toBe(2);
    const seconds = lyricSeekSeconds(14000, data.offsetMs);
    expect(seconds).toBe(13.75);
    expect(focusBlock(data, blocks, seconds * 1000 + data.offsetMs)).toBe(3);
    expect(lyricSeekSeconds(100, 500)).toBe(0);
    expect(lyricSeekSeconds(100, -500)).toBe(0.6);
  });

  test("unknown line ends do not invent breaks, and untimed lyrics retain blank paragraphs", () => {
    const lines = [line("One", 0, null), line("Two", 12000, 15000)];
    expect(lyricBlocks(lyrics(lines)).filter(block => block.kind === "pause")).toHaveLength(0);
    const plain = lyrics([line("A", null, null), line("", null, null), line("B", null, null)], { sync: "none", hasWordSync: false });
    expect(lyricBlocks(plain).filter(block => block.kind === "lines").map(block => block.rows[0].line.text)).toEqual(["A", "", "B"]);
  });

  test("word wrapping preserves spaces and emoji without shifting segment timing or counting spaces as letters", () => {
    const detailed = { ...line("Hello 👋🏽 world", 100, 2100), segments: [segment("Hello ", 100, 1100), segment("👋🏽 ", 1100, 1500), segment("world", 1500, 2100)] };
    const words = lyricWords(detailed, "en");
    expect(words.map(word => word.text).join("")).toBe(detailed.text);
    const letters = words.flatMap(word => word.letters);
    expect(letters[0].motion.count).toBe(5);
    expect(letters[5].text).toBe("👋🏽");
    expect(letters[5].motion.segment.startMs).toBe(1100);
    expect(letters[6].motion.segment.startMs).toBe(1500);
    expect(letters[6].motion.index).toBe(0);
    expect(lyricWords(detailed, "invalid_locale").map(word => word.text).join("")).toBe(detailed.text);
  });

  test("duets, background vocals, romanization and desktop quote glyphs remain grouped", () => {
    const lead = { ...line('"Sing"', 1000, 3000), singer: "one", segments: [segment('"Sing', 1000, 2000), segment('"', 2000, 3000)] };
    const backing = { ...line("Reply", 2000, 5000), singer: "two" };
    lead.backgroundVocals.push(backing);
    lead.romanization.push({ language: "en", segments: [segment("Sing", 1000, 3000)] });
    const data = lyrics([lead], { singers: [{ id: "one", name: "Lead" }, { id: "two", name: "Guest" }] });
    const blocks = lyricBlocks(data);
    const group = blocks.find(block => block.kind === "lines")!;
    expect(group.rows.map(row => row.kind)).toEqual(["lead", "romanization", "background"]);
    expect(group.rows[0].line.text).toBe("“Sing”");
    expect(group.rows[0].words.map(word => word.text).join("")).toBe("“Sing”");
    expect(group.rows[2].alternate).toBe(true);
    expect(group.rows[2].singer).toBe("Guest");
    expect(focusBlock(data, blocks, 4000)).toBe(0);
  });

  test("native letters use desktop held-note targets and release back to rest", () => {
    const letter = letterMotion(segment("Oh", 1000, 3000), 0, 2);
    expect(letter.emphasis).toBe(true);
    expect(letterVisuals(letter, 0, false).scale).toBe(1);
    const ringing = letterVisuals(letter, 1600, true);
    expect(ringing.scale).toBeGreaterThan(1.02);
    expect(ringing.lift).toBeGreaterThan(0);
    expect(ringing.glow).toBeGreaterThan(0);
    expect(letterVisuals(letter, 3600, false).scale).toBe(1);
  });
});
