import { describe, expect, test } from "bun:test";
import type { Track } from "../src/types/music";
import { bestPlaylistCopy } from "../src/utils/searchRanking";

let next = 0;
const copy = (album: string, quality: string, releaseDate: string | null, changes: Partial<Track> = {}): Track => {
  const [depth, rate] = quality === "lossy" ? [null, null] : quality.split("/").map(Number);
  return {
    globalId: `qobuz:${next++}`, provider: "qobuz", name: "Killer Queen", artist: "Queen", album, releaseDate,
    isrc: "GBUM71029606", durationSeconds: 180, explicit: false,
    quality: quality === "lossy" ? "Ogg Vorbis" : `FLAC ${depth}-bit/${rate} kHz`,
    maximumBitDepth: depth, maximumSamplingRateKHz: rate, ...changes,
  } as Track;
};

// The copies Qobuz returns for Killer Queen's ISRC: hi-res only on later releases.
const sheerHeartAttack = () => copy("Sheer Heart Attack", "16/44.1", "1974-11-08");
const japan = () => copy("Greatest Hits In Japan", "24/96", "2020-01-15");
const pop = () => copy("Pop", "24/96", "2019-01-01");
const soundtrack = () => copy("Bohemian Rhapsody", "24/96", "2018-10-19");

describe("playlist improvement", () => {
  test("a song stays on its album rather than moving to a compilation for resolution", () => {
    const original = sheerHeartAttack();
    expect(bestPlaylistCopy(original, [japan(), pop(), soundtrack(), sheerHeartAttack()])).toBe(original);
  });

  test("a song moved to a later release returns to its album", () => {
    const album = sheerHeartAttack();
    expect(bestPlaylistCopy(japan(), [pop(), album, soundtrack()])).toBe(album);
  });

  test("a better copy of the same album is still an upgrade, editions included", () => {
    const original = copy("OK Computer", "16/44.1", "1997-05-21", { name: "Airbag" });
    const remaster = copy("OK Computer OKNOTOK 1997 2017", "24/96", "1997-05-21", { name: "Airbag (Remastered)" });
    expect(bestPlaylistCopy(original, [remaster])).toBe(remaster);
    expect(bestPlaylistCopy(remaster, [original])).toBe(remaster);
  });

  test("another album is used only to go from lossy to lossless", () => {
    const original = copy("Sheer Heart Attack", "lossy", "1974-11-08", { provider: "spotify" });
    const greatestHits = copy("Greatest Hits", "16/44.1", "1981-10-26");
    expect(bestPlaylistCopy(original, [greatestHits])).toBe(greatestHits);
    const albumLossless = sheerHeartAttack();
    expect(bestPlaylistCopy(original, [greatestHits, albumLossless])).toBe(albumLossless);
  });

  test("without dates the current album is home unless it's a compilation", () => {
    const original = copy("Sheer Heart Attack", "16/44.1", null);
    expect(bestPlaylistCopy(original, [copy("Pop", "24/96", null)])).toBe(original);
    const album = copy("Sheer Heart Attack", "16/44.1", null);
    expect(bestPlaylistCopy(copy("Greatest Hits In Japan", "24/96", null), [album])).toBe(album);
  });
});

describe("search grouping", () => {
  const suffer = (album: string, durationSeconds: number, isrc: string, provider: Track["provider"], albumArtist = "Napalm Death", name = "You Suffer") => ({
    globalId: `${provider}:${album}:${isrc}`, provider, name, artist: "Napalm Death", album, durationSeconds, isrc, explicit: false,
    albumArtists: [{ providerId: "", name: albumArtist, imageUrl: null }], quality: provider === "spotify" ? "Ogg Vorbis 320 kbps" : "FLAC 16-bit/44.1 kHz",
    maximumBitDepth: provider === "spotify" ? null : 16, maximumSamplingRateKHz: provider === "spotify" ? null : 44.1,
  }) as Track;

  test("a seconds-long song's releases gather into one result, live recordings apart", async () => {
    const { deduplicateSearchResults } = await import("../src/utils/searchRanking");
    const results = deduplicateSearchResults([
      suffer("The Best of Napalm Death", 4, "GBBPB0900001", "spotify"),
      suffer("Scum", 4, "GBBPB0703014", "qobuz"),
      suffer("Scum (Full Dynamic Range 2012 Edition)", 6, "GBBPB1201321", "tidal"),
      suffer("You Suffer", 1, "GBBPB0700001", "tidal"),
      suffer("Earache: The World's Shortest Album", 4, "GBBPB1201619", "spotify", "Various Artists"),
      suffer("Punishment In Capitals", 15, "GBCQV0300432", "qobuz"),
    ]);
    expect(results.map(track => track.album)).toEqual(["Scum", "Punishment In Capitals"]);
  });
});
