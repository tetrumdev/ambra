import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Track } from "../src/types/music";

const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
let backendFile: string | null = null;

mock.module("@tauri-apps/api/core", () => ({
  invoke: async (command: string, args?: Record<string, unknown>) => {
    calls.push({ command, args });
    if (command === "load_streaming_cache") return backendFile;
    if (command === "save_streaming_cache") {
      backendFile = args?.json as string;
      return undefined;
    }
    return null;
  },
  isTauri: () => true,
}));

const { loadStreamingCache, saveCachedServerTracks } = await import("../src/utils/libraryCache");

const track = (id: string, provider: Track["provider"] = "tidal") =>
  ({
    globalId: `${provider}:${id}`,
    provider,
    providerTrackId: id,
    playbackKind: "direct",
    audio: "http://127.0.0.1/x",
    cover: "c.jpg",
    nativeCover: "c.jpg",
    name: `Song ${id}`,
    version: null,
    album: "Album",
    albumVersion: null,
    albumId: "1",
    albumArtists: [],
    artist: "Artist",
    artists: [{ providerId: "1", name: "Artist", imageUrl: null }],
    trackNumber: 1,
    discNumber: 1,
    durationSeconds: 100,
    releaseDate: null,
    explicit: false,
    isrc: null,
    copyright: null,
    label: null,
    genres: [],
    upc: null,
    quality: null,
    maximumSamplingRateKHz: null,
    maximumBitDepth: null,
  }) as Track;

const STORAGE_KEY = "ambra.streaming-library.v1";
let store: Map<string, string>;
const localStorageDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");

beforeEach(() => {
  calls.length = 0;
  backendFile = null;
  store = new Map();
  (globalThis as { isTauri?: boolean }).isTauri = true;
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    },
  });
});

afterEach(() => {
  delete (globalThis as { isTauri?: boolean }).isTauri;
  if (localStorageDescriptor) Object.defineProperty(globalThis, "localStorage", localStorageDescriptor);
  else Reflect.deleteProperty(globalThis, "localStorage");
});

describe("streaming library cache (desktop)", () => {
  test("loads from the backend file without touching localStorage", async () => {
    backendFile = JSON.stringify([track("1"), track("2")]);
    const tracks = await loadStreamingCache();
    expect(tracks.map((item) => item.globalId)).toEqual(["tidal:1", "tidal:2"]);
    expect(calls.map((call) => call.command)).toEqual(["load_streaming_cache"]);
  });

  test("migrates a legacy localStorage copy once, then removes it", async () => {
    store.set(STORAGE_KEY, JSON.stringify([track("9")]));
    const tracks = await loadStreamingCache();
    expect(tracks.map((item) => item.globalId)).toEqual(["tidal:9"]);
    expect(JSON.parse(backendFile!)).toHaveLength(1);
    expect(store.has(STORAGE_KEY)).toBe(false);

    calls.length = 0;
    expect((await loadStreamingCache()).map((item) => item.globalId)).toEqual(["tidal:9"]);
    expect(calls.map((call) => call.command)).toEqual(["load_streaming_cache"]);
  });

  test("the backend copy wins over a stale legacy copy", async () => {
    backendFile = JSON.stringify([track("new")]);
    store.set(STORAGE_KEY, JSON.stringify([track("old")]));
    const tracks = await loadStreamingCache();
    expect(tracks.map((item) => item.globalId)).toEqual(["tidal:new"]);
    expect(store.has(STORAGE_KEY)).toBe(false);
  });

  test("an empty backend returns an empty library", async () => {
    expect(await loadStreamingCache()).toEqual([]);
  });

  test("a burst of saves is coalesced into one write of the latest list, local tracks excluded", async () => {
    for (let count = 1; count <= 25; count++) {
      saveCachedServerTracks(Array.from({ length: count }, (_, index) => track(String(index))));
    }
    saveCachedServerTracks([track("a"), track("b"), track("local", "local")]);
    expect(calls).toHaveLength(0);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const saves = calls.filter((call) => call.command === "save_streaming_cache");
    expect(saves).toHaveLength(1);
    expect(JSON.parse(saves[0].args!.json as string).map((item: Track) => item.globalId)).toEqual([
      "tidal:a",
      "tidal:b",
    ]);
  });
});
