import { describe, expect, test } from "bun:test";
import type { Track } from "../src/types/music";
import { filterTerms, trackMatches } from "../src/utils/trackFilter";
import { optionalColumnsTemplate, orderedOptionalColumns } from "../src/utils/trackColumnWidths";
import { audioQualityRank, compactAudioQuality } from "../src/utils/audioQuality";
import { sortCollectionTracks } from "../src/utils/trackCollectionOrder";

const track = (fields: Partial<Track>) => ({
  globalId: fields.name ?? "song", name: "Song", version: null, artist: "", artists: [], albumArtists: [],
  album: "", albumVersion: null, releaseDate: null, genres: [], label: null, quality: null,
  maximumBitDepth: null, maximumSamplingRateKHz: null, ...fields,
}) as Track;

describe("page filter", () => {
  const halo = track({ name: "Halo", artist: "Beyoncé", artists: [{ providerId: "1", name: "Beyoncé", imageUrl: null }], album: "I Am... Sasha Fierce", releaseDate: "2008-11-14" });

  test("matches every term anywhere in the song, ignoring case and accents", () => {
    expect(trackMatches(halo, filterTerms("beyonce"))).toBe(true);
    expect(trackMatches(halo, filterTerms("halo SASHA"))).toBe(true);
    expect(trackMatches(halo, filterTerms("2008"))).toBe(true);
    expect(trackMatches(halo, filterTerms("halo rihanna"))).toBe(false);
  });

  test("an empty query lets everything through", () => {
    expect(filterTerms("   ")).toEqual([]);
    expect(trackMatches(halo, [])).toBe(true);
  });
});

describe("optional columns", () => {
  test("keep their own order whatever order they were chosen in", () => {
    expect(orderedOptionalColumns(["plays", "unknown", "quality"]).map(column => column.key)).toEqual(["quality", "plays"]);
    expect(optionalColumnsTemplate(["year", "quality"])).toBe("minmax(96px, 0.8fr) minmax(56px, 0.3fr)");
    expect(optionalColumnsTemplate([])).toBe("");
  });

  test("quality reads compactly and ranks lossless above lossy", () => {
    const hiRes = track({ quality: "FLAC 24-bit 96 kHz" });
    const cd = track({ quality: "FLAC 16-bit 44.1 kHz" });
    const lossy = track({ quality: "Ogg Vorbis 320 kbps" });
    expect(compactAudioQuality(hiRes)).toBe("FLAC 24/96");
    expect(compactAudioQuality(lossy)).toBe("Ogg Vorbis 320");
    expect(audioQualityRank(hiRes)).toBeGreaterThan(audioQualityRank(cd));
    expect(audioQualityRank(cd)).toBeGreaterThan(audioQualityRank(lossy));
  });

  test("sorting by plays uses listening history", () => {
    const a = track({ name: "a" });
    const b = track({ name: "b" });
    const stats = new Map([["a", { plays: 9, lastPlayedAt: 1 }], ["b", { plays: 2, lastPlayedAt: 5 }]]);
    expect(sortCollectionTracks([a, b], { key: "plays", direction: "descending" }, stats).map(t => t.name)).toEqual(["b", "a"]);
    expect(sortCollectionTracks([a, b], { key: "lastPlayed", direction: "ascending" }, stats).map(t => t.name)).toEqual(["b", "a"]);
  });
});

import { isSongEnding, SONG_ENDING_SECONDS } from "../src/utils/songEnding";

describe("song ending", () => {
  test("covers only the last few seconds of a song with a known length", () => {
    expect(isSongEnding(200 - SONG_ENDING_SECONDS - 0.1, 200)).toBe(false);
    expect(isSongEnding(200 - SONG_ENDING_SECONDS, 200)).toBe(true);
    expect(isSongEnding(199.9, 200)).toBe(true);
    expect(isSongEnding(0, 0)).toBe(false);
    expect(isSongEnding(10, undefined)).toBe(false);
  });
});
