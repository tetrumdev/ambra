import type { LyricLine, LyricSegment, TrackLyrics } from "../src/types/lyrics";

export const segment = (text: string, startMs: number | null, endMs: number | null, granularity: LyricSegment["granularity"] = "word"): LyricSegment => ({
  text, startMs, endMs, granularity, singer: null,
});
export const line = (text: string, startMs: number | null, endMs: number | null, segments: LyricSegment[]): LyricLine => ({
  text, startMs, endMs, segments, words: [], singer: null, translations: [], romanization: [], backgroundVocals: [], key: null,
});
export function lyricsFixture(sync: TrackLyrics["sync"] = "word"): TrackLyrics {
  const detailed = ["word", "segment", "syllable"].includes(sync);
  const first = line("Amber light", 1000, 3000, detailed
    ? sync === "syllable" ? [segment("Am", 1000, 1500, "syllable"), segment("ber ", 1500, 2000, "syllable"), segment("light", 2000, 3000)]
      : [segment("Amber ", 1000, 2000, sync === "segment" ? "segment" : "word"), segment("light", 2000, 3000)]
    : [segment("Amber light", sync === "none" ? null : 1000, sync === "none" ? null : 3000, sync === "none" ? "none" : "line")]);
  first.singer = "v1";
  first.translations = [{ language: "fr", segments: [segment("Lumière ambrée", null, null, "none")] }];
  first.romanization = [{ language: null, segments: [segment("am-ba", null, null, "none")] }];
  first.backgroundVocals = [line("Oh yeah", 1500, 3500, [segment("Oh ", 1500, 2500), segment("yeah", 2500, 3500)])];
  first.backgroundVocals[0].singer = "v2";
  const second = line("Carry on", 4000, 6000, [segment("Carry on", 4000, 6000, "line")]);
  if (sync === "none") {
    first.startMs = first.endMs = null;
    first.backgroundVocals = [];
    second.startMs = second.endMs = null;
    second.segments = [segment("Carry on", null, null, "none")];
  }
  if (!detailed && sync !== "none") {
    first.backgroundVocals[0].segments = [segment("Oh yeah", 1500, 3500, "line")];
  }
  return {
    status: "lyrics", instrumental: false, sync, hasWordSync: detailed,
    plainLyrics: "Amber light\nCarry on", lines: [first, second], source: "amll", originalFormat: "ttml",
    offsetMs: 0, language: "en", singers: [{ id: "v1", name: "Singer" }, { id: "v2", name: "Harmony" }], failedProviders: [],
  };
}
