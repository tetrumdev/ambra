import { describe, expect, test } from "bun:test";
import type { Track } from "../src/types/music";
import { bestPlaylistCopy } from "../src/utils/searchRanking";
import { packageCopies } from "../src/utils/playlistImprovement";

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
const soundtrack_ = () => copy("Bohemian Rhapsody", "24/96", "2018-10-19");

describe("playlist improvement", () => {
  test("a song never moves to a worse-sounding copy", () => {
    const remaster = copy("OK Computer OKNOTOK 1997 2017", "24/96", "2017-06-23", { name: "Paranoid Android (Remastered)", isrc: "GBBKS1700185" });
    const single = copy("Paranoid Android", "16/44.1", "1997-05-26", { name: "Paranoid Android", isrc: "GBAYE9701376" });
    expect(bestPlaylistCopy(remaster, [single])).toBe(remaster);
  });

  test("a better copy is an upgrade, preferring a proper album over compilations", () => {
    const original = sheerHeartAttack();
    const greatestHits = copy("Greatest Hits", "24/96", "1981-10-26");
    const soundtrack = soundtrack_();
    expect(bestPlaylistCopy(original, [japan(), greatestHits, soundtrack])).toBe(soundtrack);
  });

  test("an equally good copy only replaces one on a compilation or regional pressing", () => {
    const album = copy("Pop", "24/96", "2019-01-01");
    expect(bestPlaylistCopy(japan(), [album])).toBe(album);
    const kept = pop();
    expect(bestPlaylistCopy(kept, [japan(), soundtrack_()])).toBe(kept);
  });
});

describe("package improvement", () => {
  const airbag = (album: string, quality: string, provider: Track["provider"] = "qobuz") => copy(album, quality, null, { name: "Airbag", provider });
  const android = (album: string, quality: string, provider: Track["provider"] = "qobuz") => copy(album, quality, null, { name: "Paranoid Android", provider });

  test("a package split across formats is reunited on one release in one format", () => {
    const members = [airbag("OK Computer OKNOTOK 1997 2017", "24/96"), android("Paranoid Android", "16/44.1")];
    const remaster = android("OK Computer OKNOTOK 1997 2017", "24/96");
    const moved = packageCopies(members, [[members[0]], [members[1], remaster]]);
    expect(moved).toEqual([members[0], remaster]);
  });

  test("a matched package isn't broken up for one member's better copy", () => {
    const members = [airbag("OK Computer", "16/44.1"), android("OK Computer", "16/44.1")];
    const hiResSingle = android("Paranoid Android", "24/96");
    expect(packageCopies(members, [[members[0]], [members[1], hiResSingle]])).toBeNull();
  });

  test("a matched package moves together for a better-sounding set", () => {
    const members = [airbag("OK Computer", "16/44.1"), android("OK Computer", "16/44.1")];
    const better = [airbag("OK Computer OKNOTOK 1997 2017", "24/96"), android("OK Computer OKNOTOK 1997 2017", "24/96")];
    expect(packageCopies(members, [[members[0], better[0]], [members[1], better[1]]])).toEqual(better);
    const otherService = [airbag("OK Computer OKNOTOK 1997 2017", "24/96", "tidal"), android("OK Computer OKNOTOK 1997 2017", "24/96")];
    expect(packageCopies(members, [[members[0], otherService[0]], [members[1], otherService[1]]])).toBeNull();
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
