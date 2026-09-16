import { describe, expect, test } from "bun:test";
import { deduplicateSearchResults, rankSearchResults, groupSearchResults } from "../src/utils/searchRanking";
import { track } from "./searchFixture";

describe("provider-neutral recording ranking", () => {
  test("keeps Qobuz-only songs even when TIDAL has other results", () => {
    const tracks = [track("tidal:other", "tidal", { name: "Deadman Walking", isrc: "OTHER" }), track("qobuz:only", "qobuz")];
    expect(rankSearchResults(tracks, "deadman").map(t => t.globalId)).toEqual(["qobuz:only", "tidal:other"]);
  });
  test("uses original albums ahead of higher-resolution compilations with or without TIDAL", () => {
    for (const provider of ["tidal", "qobuz", "spotify"] as const) {
      const original = track(`${provider}:album`, provider, { maximumBitDepth: 16, quality: "FLAC" });
      const compilation = track("qobuz:hits", "qobuz", { album: "Greatest Hits", maximumBitDepth: 24, maximumSamplingRateKHz: 192, quality: "FLAC" });
      expect(rankSearchResults([compilation, original], "deadman")[0]?.globalId).toBe(original.globalId);
    }
  });
  test("explicit outranks clean even when clean has higher resolution", () => {
    const clean = track("qobuz:clean", "qobuz", { explicit: false, isrc: "CLEAN", quality: "FLAC", maximumBitDepth: 24 });
    const explicit = track("tidal:explicit", "tidal", { explicit: true, quality: "FLAC", maximumBitDepth: 16 });
    expect(rankSearchResults([clean, explicit], "deadman").map(t => t.globalId)).toEqual([explicit.globalId]);
  });
  test("ISRC tolerates featured credits in the title", () => {
    const a = track("tidal:1", "tidal", { explicit: true });
    const b = track("qobuz:1", "qobuz", { name: "Deadman (feat. Someone)", explicit: true, quality: "FLAC", maximumBitDepth: 24 });
    expect(rankSearchResults([a, b], "deadman").map(t => t.globalId)).toEqual([b.globalId]);
  });
  test("bit depth precedes sample rate within equivalent editions", () => {
    const a = track("tidal:16", "tidal", { quality: "FLAC", maximumBitDepth: 16, maximumSamplingRateKHz: 96 });
    const b = track("qobuz:24", "qobuz", { quality: "FLAC", maximumBitDepth: 24, maximumSamplingRateKHz: 44.1 });
    expect(rankSearchResults([a, b], "deadman")[0]?.globalId).toBe(b.globalId);
  });
  test("sample rate breaks bit-depth ties", () => {
    const a = track("tidal:96", "tidal", { maximumBitDepth: 24, maximumSamplingRateKHz: 96 });
    const b = track("qobuz:44", "qobuz", { maximumBitDepth: 24, maximumSamplingRateKHz: 44.1 });
    expect(rankSearchResults([a, b], "deadman")[0]?.globalId).toBe(a.globalId);
  });
  test("remasters with release evidence collapse despite differing ISRCs", () => {
    const a = track("qobuz:original", "qobuz");
    const b = track("qobuz:remaster", "qobuz", { name: "Deadman (Remastered)", album: "Sound Awake (Deluxe Remastered)", isrc: "REMASTER", durationSeconds: 720 });
    expect(rankSearchResults([a, b], "deadman").map(t => t.globalId)).toEqual([b.globalId]);
  });
  test("preserves native single-provider order while selecting editions", () => {
    const first = track("qobuz:first", "qobuz", { name: "Simple Boy", isrc: "FIRST" });
    expect(deduplicateSearchResults([first, track("qobuz:second", "qobuz")]).map(t => t.globalId)).toEqual([first.globalId, "qobuz:second"]);
  });
  test("retains Qobuz's original Plug Walk release over later thematic compilations", () => {
    const recording = { name: "Plug Walk", artist: "Rich the kid", isrc: "USUM71800892", durationSeconds: 174, explicit: true, quality: "FLAC", maximumBitDepth: 16, maximumSamplingRateKHz: 44.1 };
    const original = track("qobuz:51903642", "qobuz", { ...recording, album: "The World Is Yours" });
    const compilations = [
      track("qobuz:49115450", "qobuz", { ...recording, album: "Top 30 US" }),
      track("qobuz:112197744", "qobuz", { ...recording, album: "Gaming Rap Mix" }),
    ];
    const tracks = [original, ...compilations];
    expect(deduplicateSearchResults(tracks).map(t => t.globalId)).toEqual([original.globalId]);
    expect(rankSearchResults(tracks, "plug walk").map(t => t.globalId)).toEqual([original.globalId]);
    expect(groupSearchResults(tracks, "plug walk")[0]?.alternatives).toEqual(tracks);
    expect(rankSearchResults(tracks, "plug walk gaming rap mix")[0]?.globalId).toBe(compilations[1].globalId);
  });
  test("equivalent release selection preserves native rank regardless of provider, title, or catalog ID", () => {
    for (const provider of ["qobuz", "tidal", "spotify"] as const) {
      for (const [firstId, laterId] of [["9", "1"], ["1", "9"]]) {
        const first = track(`${provider}:${firstId}`, provider, { name: "An Arbitrary Song", album: "First Release" });
        const later = track(`${provider}:${laterId}`, provider, { name: first.name, album: "Another Release" });
        for (const releases of [[first, later], [later, first]]) {
          expect(deduplicateSearchResults(releases)).toEqual([releases[0]]);
          expect(rankSearchResults(releases, first.name)).toEqual([releases[0]]);
        }
      }
    }
  });
  test("uses native ranks rather than quality to order equally relevant songs", () => {
    const original = track("qobuz:radiohead", "qobuz", { name: "Paranoid Android", artist: "Radiohead" });
    const cover = track("qobuz:cover", "qobuz", { name: "Paranoid Android", artist: "Bear Ghost", isrc: "COVER", maximumBitDepth: 24, quality: "FLAC" });
    expect(rankSearchResults([original, cover], "paranoid android")[0]?.globalId).toBe(original.globalId);
  });
  test("fusion counts a provider once per recording, not once per release", () => {
    const a = track("qobuz:a", "qobuz");
    const b = track("qobuz:b", "qobuz", { name: "Another Deadman", isrc: "B" });
    const without = groupSearchResults([a, b], "deadman");
    const withDuplicates = groupSearchResults([a, track("qobuz:duplicate", "qobuz"), b], "deadman");
    expect(withDuplicates.map(g => g.fusionScore)).toEqual(without.map(g => g.fusionScore));
    expect(withDuplicates[0]?.alternatives).toHaveLength(2);
  });
  test("explicit artist requests override multi-provider consensus on namesakes", () => {
    const noise = { name: "Deadman", artist: "Other Artist", isrc: "OTHER" };
    expect(rankSearchResults([track("qobuz:noise", "qobuz", noise), track("tidal:noise", "tidal", noise), track("spotify:right", "spotify")], "deadman karnivool").map(t => t.globalId)).toEqual(["spotify:right"]);
  });
  test("retains non-Latin titles and prevents empty normalized identities", () => {
    const a = track("qobuz:a", "qobuz", { name: "夜に駆ける", artist: "YOASOBI", isrc: null });
    const b = track("qobuz:b", "qobuz", { name: "群青", artist: "YOASOBI", isrc: null });
    expect(rankSearchResults([a, b], "夜に駆ける").map(t => t.globalId)).toEqual([a.globalId]);
    expect(deduplicateSearchResults([a, b])).toHaveLength(2);
  });
  test("keeps live, acoustic, covers and remixes separate even with conflicting ISRC metadata", () => {
    expect(rankSearchResults([track("qobuz:studio", "qobuz"), track("qobuz:live", "qobuz", { version: "Live", name: "Deadman (Live)" }), track("qobuz:acoustic", "qobuz", { version: "Acoustic", name: "Deadman (Acoustic)" }), track("qobuz:cover", "qobuz", { artist: "Other Artist" })], "deadman")).toHaveLength(4);
  });
  test("does not merge unknown durations using title alone", () => {
    expect(deduplicateSearchResults([track("qobuz:a", "qobuz", { isrc: null, durationSeconds: 0 }), track("qobuz:b", "qobuz", { isrc: null, durationSeconds: 0 })])).toHaveLength(2);
  });
  test("does not collapse nearby durations through a transitive chain", () => {
    expect(deduplicateSearchResults([0, 7, 14].map((delta, i) => track(`qobuz:${i}`, "qobuz", { isrc: null, durationSeconds: 300 + delta })))).toHaveLength(3);
  });
  test("an original soundtrack is eligible and a requested compilation is respected", () => {
    const soundtrack = track("qobuz:soundtrack", "qobuz", { album: "Original Motion Picture Soundtrack", quality: "FLAC", maximumBitDepth: 24 });
    expect(rankSearchResults([track("tidal:other", "tidal"), soundtrack], "deadman")[0]?.globalId).toBe(soundtrack.globalId);
    const hits = track("qobuz:hits", "qobuz", { album: "Greatest Hits" });
    expect(rankSearchResults([track("tidal:original", "tidal"), hits], "deadman greatest hits")[0]?.globalId).toBe(hits.globalId);
  });
  test("never merges differing identifiers across unrelated album families", () => {
    expect(deduplicateSearchResults([track("qobuz:a", "qobuz"), track("qobuz:b", "qobuz", { album: "Another Album", isrc: "DIFFERENT" })])).toHaveLength(2);
  });
  test("a title-only query does not request a same-named soundtrack or single", () => {
    const album = track("qobuz:album", "qobuz", { name: "Bohemian Rhapsody (Remastered 2011)", album: "A Night at the Opera", quality: "FLAC", maximumBitDepth: 24, maximumSamplingRateKHz: 96 });
    const soundtrack = track("qobuz:soundtrack", "qobuz", { name: "Bohemian Rhapsody (2011 Remaster)", album: "Bohemian Rhapsody", quality: "FLAC", maximumBitDepth: 24, maximumSamplingRateKHz: 192 });
    expect(rankSearchResults([soundtrack, album], "bohemian rhapsody")[0]?.globalId).toBe(album.globalId);
    expect(rankSearchResults([soundtrack, album], "bohemian rhapsody karnivool")[0]?.globalId).toBe(album.globalId);
  });
  test("duplicate annotations do not split the same identified live performance", () => {
    const a = track("tidal:live", "tidal", { name: "Deadman (Live at The Forum)", version: null });
    const b = track("qobuz:live", "qobuz", { name: "Deadman (Live at The Forum)", version: "Live at The Forum" });
    expect(deduplicateSearchResults([a, b])).toHaveLength(1);
  });

  test("collapses an identified compilation appearance with a different master code", () => {
    const album = track("qobuz:album", "qobuz", { name: "Bohemian Rhapsody (Remastered 2011)", album: "A Night at the Opera", isrc: "ORIGINAL", durationSeconds: 354 });
    const hits = track("tidal:hits", "tidal", { name: "Bohemian Rhapsody (Remastered 2011)", album: "Greatest Hits", isrc: "HITS", durationSeconds: 356 });
    expect(rankSearchResults([hits, album], "bohemian rhapsody").map(track => track.globalId)).toEqual([album.globalId]);
  });

});
