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
