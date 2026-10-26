import { afterEach, expect, test } from "bun:test";
import { loadDiscover, type RemoteTrack } from "../src/api/server";
import { setServerForTesting } from "../src/api/serverConnection";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const remote: RemoteTrack = {
  id: "tidal:42", provider: "tidal", providerTrackId: "42", title: "Song", primaryArtist: { providerId: "7", name: "Artist", imageUrl: null },
  artists: [{ providerId: "7", name: "Artist", imageUrl: null }], album: { providerId: "8", title: "Album", coverUrl: "https://resources.tidal.com/cover.jpg", artists: [], genres: [], releaseDate: null, version: null, label: null, upc: null },
  durationSeconds: 180, playback: { kind: "dash", url: "/api/providers/tidal/tracks/42/manifest.mpd" }, version: null,
  trackNumber: null, discNumber: null, explicit: false, isrc: "GB123", copyright: null, quality: null, maximumSamplingRateKHz: null, maximumBitDepth: null,
};

test("Discover uses connected server and existing playable track conversion", async () => {
  setServerForTesting("http://paired-server:38147", "paired-token");
  globalThis.fetch = (async (url, init) => {
    expect(String(url)).toBe("http://paired-server:38147/api/recommendations/discover?limit=12");
    expect(init?.cache).toBe("no-store");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    return Response.json({ tracks: [remote], reasons: { "tidal:42": "Because you listen to shoegaze" }, status: "ready", generatedAt: 1000, refreshAfterMs: null });
  }) as typeof fetch;
  const value = await loadDiscover(new AbortController().signal);
  expect(value.tracks[0].audio).toBe("http://paired-server:38147/api/providers/tidal/tracks/42/manifest.mpd?access_token=paired-token");
  expect(value.tracks[0]).toMatchObject({ globalId: "tidal:42", artist: "Artist", name: "Song", album: "Album", playbackKind: "dash", cover: remote.album!.coverUrl });
});

test("local discoveries rebase media onto connected server", async () => {
  setServerForTesting("http://paired-server:38147", "paired-token");
  globalThis.fetch = (async () => Response.json({ tracks: [{ globalId: "local:a", provider: "local", audio: "/api/music/local/files/a.flac", cover: "/api/music/local/files/a.jpg" }], status: "ready" })) as typeof fetch;
  const value = await loadDiscover(new AbortController().signal);
  expect(value.tracks[0].audio).toBe("http://paired-server:38147/api/music/local/files/a.flac?access_token=paired-token");
  expect(value.tracks[0].cover).toBe("http://paired-server:38147/api/music/local/files/a.jpg?access_token=paired-token");
});

test("outages are surfaced without inventing recommendations", async () => {
  globalThis.fetch = (async () => Response.json({ error: "Unavailable" }, { status: 503 })) as typeof fetch;
  expect(loadDiscover(new AbortController().signal)).rejects.toThrow("Unavailable");
});

test("request cancellation reaches transport", async () => {
  const controller = new AbortController();
  controller.abort();
  globalThis.fetch = (async (_, init) => { init?.signal?.throwIfAborted(); throw new Error("Should abort"); }) as typeof fetch;
  expect(loadDiscover(controller.signal)).rejects.toThrow();
});
