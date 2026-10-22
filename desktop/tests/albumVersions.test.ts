import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { CatalogAlbum } from "../src/api/server";
import type { Track } from "../src/types/music";
import { albumAudioQuality, findAlbumVersions } from "../src/utils/albumVersions";
import { albumIdentity, bestEditions, rankAlbums } from "../src/utils/catalogRanking";
import { bestQualityRecording } from "../src/utils/searchRanking";

const album = (changes: Partial<CatalogAlbum> = {}): CatalogAlbum => ({
  id: "qobuz:opera", provider: "qobuz", title: "A Night at the Opera", artist: "Queen",
  imageUrl: null, maximumBitDepth: 16, maximumSamplingRateKHz: 44.1, ...changes,
});
const track = (changes: Partial<Track> = {}): Track => ({
  globalId: "spotify:killer-queen", provider: "spotify", name: "Killer Queen", artist: "Queen",
  album: "Sheer Heart Attack", isrc: "GBAYE7400052", durationSeconds: 180, explicit: false,
  quality: "Ogg Vorbis", maximumBitDepth: null, maximumSamplingRateKHz: null, ...changes,
} as Track);
let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">> | undefined;
afterEach(() => { fetchSpy?.mockRestore(); });

describe("album versions", () => {
  test("consolidation retains every edition and service without nesting", () => {
    const standard = album();
    const deluxe = album({ id: "tidal:opera", provider: "tidal", title: "A Night at the Opera (Deluxe Edition)", maximumBitDepth: 24, maximumSamplingRateKHz: 96 });
    const [merged] = bestEditions([standard, deluxe]);
    expect(merged.id).toBe(deluxe.id);
    expect(merged.versions?.map(copy => copy.id)).toEqual([standard.id, deluxe.id]);
    const [again] = bestEditions([merged, standard]);
    expect(again.versions).toHaveLength(2);
    expect(again.versions?.every(copy => !copy.versions)).toBe(true);
  });

  test("search preserves copies even when provider IDs are identical", () => {
    const standard = album({ id: "123" });
    const deluxe = album({ id: "123", provider: "tidal", version: "Deluxe Edition" });
    const [merged] = rankAlbums([standard, deluxe], "Queen opera deluxe");
    expect(merged.provider).toBe("tidal");
    expect(merged.versions?.map(copy => copy.provider)).toEqual(["qobuz", "tidal"]);
  });

  test("album identity preserves year titles and separate performances", () => {
    expect(albumIdentity(album({ title: "1989" }))).not.toBe(albumIdentity(album({ title: "2001" })));
    expect(albumIdentity(album({ title: "Opera (Live)" }))).not.toBe(albumIdentity(album({ title: "Opera" })));
  });

  test("version discovery searches the base title and retains known copies", async () => {
    const standard = album({ title: "Discovery Fixture" });
    const deluxe = album({ id: "tidal:fixture", provider: "tidal", title: "Discovery Fixture (40th Anniversary Edition)" });
    const queries: string[] = [];
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async input => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/providers")) return Response.json({ providers: ["qobuz", "tidal"] });
      queries.push(url.searchParams.get("query")!);
      return Response.json({ tracks: [], artists: [], albums: [standard,
        album({ id: "qobuz:live", title: "Discovery Fixture (Live)" }),
        album({ id: "qobuz:namesake", title: "Discovery Fixture", artist: "Another Queen" })] });
    });
    const found = await findAlbumVersions({ ...deluxe, versions: [standard, deluxe] }, new AbortController().signal);
    expect(found.map(copy => copy.id)).toEqual([deluxe.id, standard.id]);
    expect(queries).toEqual(["Discovery Fixture Queen", "Discovery Fixture Queen"]);
  });

  test("failed searches surface a retryable error", async () => {
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async input => {
      if (String(input).endsWith("/providers")) return Response.json({ providers: ["qobuz"] });
      throw new Error("offline");
    });
    await expect(findAlbumVersions(album({ title: "Offline Fixture" }), new AbortController().signal)).rejects.toThrow("Could not search album versions");
  });

  test("a cancelled discovery does not resolve with partial results", async () => {
    const controller = new AbortController();
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async () => {
      controller.abort();
      return Response.json({ providers: [] });
    });
    await expect(findAlbumVersions(album(), controller.signal)).rejects.toThrow();
  });
});

describe("album quality", () => {
  test("uses catalog format maxima without requiring playback", () => {
    expect(albumAudioQuality([track({ provider: "qobuz", quality: null, maximumBitDepth: 24, maximumSamplingRateKHz: 96 })]))
      .toBe("Hi-Res Lossless · FLAC · 24-bit · 96 kHz");
  });
  test("mixed formats show the best available format as an upper bound", () => {
    expect(albumAudioQuality([
      track({ provider: "qobuz", maximumBitDepth: 16, maximumSamplingRateKHz: 44.1 }),
      track({ provider: "qobuz", maximumBitDepth: 24, maximumSamplingRateKHz: 96 }),
    ])).toBe("Up to Hi-Res Lossless · FLAC · 24-bit · 96 kHz");
  });
  test("unknown formats do not display bitrate placeholders as quality", () => {
    expect(albumAudioQuality([track({ quality: null })])).toBeNull();
    expect(albumAudioQuality([])).toBeNull();
  });
});

describe("playlist upgrade release preference", () => {
  const hiRes = { provider: "qobuz", quality: "FLAC 24-bit 96 kHz", maximumBitDepth: 24, maximumSamplingRateKHz: 96 } as const;
  test("equally good upgrades prefer the original album over regional compilations", () => {
    const original = track();
    const compilation = track({ ...hiRes, globalId: "qobuz:japan", album: "Greatest Hits Japan" });
    const studio = track({ ...hiRes, globalId: "qobuz:studio", album: "Sheer Heart Attack (Deluxe Edition)" });
    expect(bestQualityRecording(original, [compilation, studio])).toBe(studio);
    expect(bestQualityRecording(original, [studio, compilation])).toBe(studio);
  });
  test("an existing copy wins ties and better sound still outranks release preference", () => {
    const original = track({ ...hiRes });
    const tied = track({ ...hiRes, globalId: "qobuz:other" });
    const better = track({ ...hiRes, globalId: "qobuz:better", album: "Greatest Hits Japan", maximumSamplingRateKHz: 192 });
    expect(bestQualityRecording(original, [tied])).toBe(original);
    expect(bestQualityRecording(original, [better])).toBe(better);
  });
});

describe("preferred album version", () => {
  test("a picked version represents its album instead of the best-sounding copy", async () => {
    const store = new Map<string, string>();
    const storage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value); } };
    const previous = (globalThis as { localStorage?: unknown }).localStorage;
    (globalThis as { localStorage?: unknown }).localStorage = storage;
    try {
      const { preferAlbumVersion } = await import("../src/utils/catalogRanking");
      const standard = album({ id: "qobuz:preferred-standard", title: "Preference Fixture" });
      const hiRes = album({ id: "tidal:preferred-hires", provider: "tidal", title: "Preference Fixture (Deluxe Edition)", maximumBitDepth: 24, maximumSamplingRateKHz: 96 });
      expect(bestEditions([standard, hiRes])[0].id).toBe(hiRes.id);
      preferAlbumVersion(standard);
      const [merged] = bestEditions([standard, hiRes]);
      expect(merged.id).toBe(standard.id);
      expect(merged.versions).toHaveLength(2);
    } finally {
      (globalThis as { localStorage?: unknown }).localStorage = previous;
    }
  });
});

describe("artist page duplicates", () => {
  test("services crediting collaborators differently still give one album", () => {
    const herLoss = bestEditions([
      album({ id: "qobuz:loss", title: "Her Loss", artist: "Drake, 21 Savage" }),
      album({ id: "tidal:loss", provider: "tidal", title: "Her Loss", artist: "Drake" }),
      album({ id: "qobuz:songs", title: "$ome $exy $ongs 4 U", artist: "PARTYNEXTDOOR, Drake" }),
      album({ id: "tidal:songs", provider: "tidal", title: "$ome $exy $ongs 4 U", artist: "PARTYNEXTDOOR" }),
    ]);
    expect(herLoss.map(copy => copy.title)).toEqual(["Her Loss", "$ome $exy $ongs 4 U"]);
  });

  test("different artists' albums of the same name stay apart, and names aren't split mid-word", () => {
    const albums = bestEditions([
      album({ id: "qobuz:queen-hits", title: "Greatest Hits", artist: "Queen" }),
      album({ id: "qobuz:abba-hits", title: "Greatest Hits", artist: "ABBA" }),
      album({ id: "qobuz:alex", title: "Fixture", artist: "Alex Andy" }),
      album({ id: "qobuz:andy", title: "Fixture", artist: "Andy" }),
    ]);
    expect(albums).toHaveLength(4);
  });
});

test("a version repeated in the title matches one kept separately", () => {
  const instrumental = bestEditions([
    album({ id: "qobuz:dogs-i", title: "For All The Dogs Scary Hours Edition", version: "Instrumental", artist: "Drake" }),
    album({ id: "tidal:dogs-i", provider: "tidal", title: "For All The Dogs Scary Hours Edition (Instrumental)", version: "Instrumental", artist: "Drake" }),
    album({ id: "tidal:dogs", provider: "tidal", title: "For All The Dogs Scary Hours Edition", artist: "Drake" }),
  ]);
  expect(instrumental).toHaveLength(2);
});
