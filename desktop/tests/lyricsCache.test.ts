import { afterEach, expect, test } from "bun:test";
import { setServerForTesting } from "../src/api/serverConnection";
import type { Track } from "../src/types/music";
import { cachedLyrics, loadLyrics } from "../src/utils/lyricsCache";

const original = globalThis.fetch;
afterEach(() => { globalThis.fetch = original; });

test("a cached song's lyrics are one object, however often they are read", async () => {
  setServerForTesting("http://selected:38147", null);
  let requests = 0;
  globalThis.fetch = (async () => {
    requests += 1;
    return Response.json({
      status: "lyrics", instrumental: false, sync: "word", hasWordSync: true, plainLyrics: null,
      source: "amll", originalFormat: "ttml", offsetMs: 0, language: "en", singers: [], failedProviders: [],
      lines: [{
        text: "Hold this", startMs: 0, endMs: 2000, singer: null, translations: [], romanization: [], backgroundVocals: [], key: null,
        segments: [
          { text: "Hold ", startMs: 0, endMs: 1000, granularity: "word", singer: null },
          { text: "this", startMs: 1000, endMs: 2000, granularity: "word", singer: null },
        ],
        words: [],
      }],
    });
  }) as typeof fetch;
  const track = {
    globalId: "qobuz:1", name: "Song", artist: "Artist", album: "Album", durationSeconds: 200,
    provider: "qobuz", providerTrackId: "1",
  } as Track;

  expect(cachedLyrics(track)).toBeUndefined();
  const loaded = await loadLyrics(track);
  expect(loaded.lines[0].segments).toHaveLength(2);
  // The lyrics view compares by identity: a copy per read made it rebuild every letter of the
  // song, and measure them all again, each time it or the player asked.
  expect(cachedLyrics(track)).toBe(loaded);
  expect(cachedLyrics(track)).toBe(loaded);
  expect(await loadLyrics(track)).toBe(loaded);
  expect(requests).toBe(1);
});

test("lyrics requests are shared until their last consumer leaves", async () => {
  setServerForTesting("http://selected:38147", null);
  let requests = 0;
  let cancellations = 0;
  let finish: (() => void) | undefined;
  globalThis.fetch = (async (_input, init) => {
    requests++;
    return new Promise<Response>((resolve, reject) => {
      finish = () => resolve(Response.json({
        status: "unavailable", instrumental: null, sync: "none", hasWordSync: false, plainLyrics: null,
        source: null, originalFormat: null, offsetMs: 0, language: null, singers: [], lines: [], failedProviders: [],
      }));
      init?.signal?.addEventListener("abort", () => { cancellations++; reject(init.signal?.reason); }, { once: true });
    });
  }) as typeof fetch;
  const track = { globalId: "tidal:shared", name: "Shared", artist: "Artist", album: "Album",
    durationSeconds: 200, provider: "tidal", providerTrackId: "shared" } as Track;

  const view = new AbortController();
  const preload = new AbortController();
  const first = loadLyrics(track, view.signal);
  const second = loadLyrics(track, preload.signal);
  expect(requests).toBe(1);
  view.abort();
  await expect(first).rejects.toThrow();
  expect(cancellations).toBe(0);
  preload.abort();
  await expect(second).rejects.toThrow();
  await Promise.resolve();
  expect(cancellations).toBe(1);

  const retried = loadLyrics(track);
  expect(requests).toBe(2);
  finish!();
  expect((await retried).status).toBe("unavailable");
});
