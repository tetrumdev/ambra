import { describe, expect, test } from "bun:test";
import { artworkPalette, thumbnailArtwork, playableTrack, refreshTrackMetadata, type RemoteTrack } from "../src/api/server";

const spotifyTrack: RemoteTrack = {
  id: "spotify:4uLU6hMCjMI75M1A2tKUQC",
  provider: "spotify",
  providerTrackId: "4uLU6hMCjMI75M1A2tKUQC",
  title: "Never Gonna Give You Up",
  version: null,
  primaryArtist: {
    providerId: "0gxyHStUsqpMadRV0Di1Qt",
    name: "Rick Astley",
    imageUrl: "https://i.scdn.co/image/artist",
  },
  artists: [
    {
      providerId: "0gxyHStUsqpMadRV0Di1Qt",
      name: "Rick Astley",
      imageUrl: "https://i.scdn.co/image/artist",
    },
  ],
  album: {
    providerId: "6eUW0wxWtzkFdaEFsTJto6",
    title: "Whenever You Need Somebody",
    version: null,
    artists: [
      {
        providerId: "0gxyHStUsqpMadRV0Di1Qt",
        name: "Rick Astley",
        imageUrl: "https://i.scdn.co/image/artist",
      },
    ],
    coverUrl: "https://i.scdn.co/image/cover",
    releaseDate: "1987-11-16",
    label: "RCA Records",
    genres: ["pop"],
    upc: "196871067880",
  },
  durationSeconds: 213,
  trackNumber: 1,
  discNumber: 1,
  explicit: false,
  isrc: "GBARL9300135",
  copyright: "1987 RCA Records",
  quality: "Ogg Vorbis 320 kbps",
  maximumSamplingRateKHz: 44.1,
  maximumBitDepth: null,
  playback: {
    kind: "direct",
    url: "/api/providers/spotify/tracks/4uLU6hMCjMI75M1A2tKUQC/stream",
  },
};

describe("playableTrack", () => {
  test("maps provider-neutral Spotify artwork, artist, album, and metadata", () => {
    const track = playableTrack(spotifyTrack);

    expect(track.provider).toBe("spotify");
    expect(track.cover).toBe("https://i.scdn.co/image/cover");
    expect(track.nativeCover).toBe("https://i.scdn.co/image/cover");
    expect(track.artist).toBe("Rick Astley");
    expect(track.artists).toEqual(spotifyTrack.artists);
    expect(track.album).toBe("Whenever You Need Somebody");
    expect(track.albumArtists).toEqual(spotifyTrack.album!.artists);
    expect(track.releaseDate).toBe("1987-11-16");
    expect(track.isrc).toBe("GBARL9300135");
    expect(track.quality).toBe("Ogg Vorbis 320 kbps");
    expect(track.audio).toEndWith(spotifyTrack.playback.url);
  });
});

describe("shared artwork", () => {
  test("album tracks share thumbnail identity and local artwork stays local", () => {
    const track = playableTrack(spotifyTrack);
    const other = { ...track, globalId: "spotify:other", providerTrackId: "other" };
    expect(thumbnailArtwork(track)).toBe(thumbnailArtwork(other));
    const url = new URL(thumbnailArtwork(track));
    expect(url.pathname).toBe("/api/artwork/thumbnail");
    expect(url.searchParams.get("url")).toBe(track.nativeCover);
    expect(thumbnailArtwork({ ...track, provider: "local" })).toBe(track.cover);
  });

  test("concurrent palettes coalesce without high-quality resolution; failures retry", async () => {
    const original = globalThis.fetch;
    const urls: string[] = [];
    let fail = true;
    globalThis.fetch = (async (url: string) => {
      urls.push(url);
      return fail ? new Response("unavailable", { status: 503 })
        : Response.json(["#112233", "#445566", "#778899", "#abcdef"]);
    }) as typeof fetch;
    try {
      const track = playableTrack(spotifyTrack);
      const [a, b] = await Promise.all([artworkPalette(track), artworkPalette(track)]);
      expect(a).toEqual([]);
      expect(b).toEqual([]);
      expect(urls.length).toBe(1);
      fail = false;
      expect((await artworkPalette(track)).length).toBe(4);
      await artworkPalette(track);
      expect(urls.length).toBe(2);
      expect(urls.every(url => url.includes("/api/artwork/palette?"))).toBe(true);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("refreshTrackMetadata", () => {
  test("local tracks short-circuit without network use", async () => {
    const original = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      throw new Error("must not fetch");
    }) as unknown as typeof fetch;
    try {
      const track = { ...playableTrack(spotifyTrack), provider: "local" } as ReturnType<typeof playableTrack>;
      await expect(refreshTrackMetadata(track)).resolves.toBe(track);
      expect(calls).toBe(0);
    } finally {
      globalThis.fetch = original;
    }
  });

  test("streaming tracks resolve through the provider metadata endpoint", async () => {
    const original = globalThis.fetch;
    const urls: string[] = [];
    globalThis.fetch = (async (url: string) => {
      urls.push(url);
      return Response.json({ ...spotifyTrack, title: "Refreshed Title" });
    }) as unknown as typeof fetch;
    try {
      const track = playableTrack(spotifyTrack);
      const refreshed = await refreshTrackMetadata(track);
      expect(refreshed.name).toBe("Refreshed Title");
      expect(refreshed.globalId).toBe(track.globalId);
      expect(urls).toHaveLength(1);
      expect(urls[0]).toContain(`/api/providers/spotify/tracks/${spotifyTrack.providerTrackId}/metadata`);
    } finally {
      globalThis.fetch = original;
    }
  });
});
