import { describe, expect, test } from "bun:test";
import { parseCachedServerTracks } from "../src/utils/libraryCache";
import type { Track } from "../src/types/music";

const cachedTrack: Track = {
  id: "tidal:1",
  provider: "tidal",
  providerTrackId: "1",
  playbackKind: "dash",
  audio: "http://127.0.0.1:8787/track.mpd",
  cover: "cover.jpg",
  nativeCover: "cover.jpg",
  name: "Cached Song",
  album: "Cached Album",
  albumId: "10",
  artist: "Cached Artist",
  artists: [{ providerId: "20", name: "Cached Artist" }],
  trackNumber: 1,
  discNumber: 1,
  durationSeconds: 180,
  releaseDate: null,
  explicit: false,
  isrc: null,
  quality: "HIGH",
};

describe("parseCachedServerTracks", () => {
  test("restores valid streaming tracks", () => {
    expect(parseCachedServerTracks(JSON.stringify([cachedTrack]))).toEqual([
      cachedTrack,
    ]);
  });

  test("ignores corrupt cache entries", () => {
    expect(parseCachedServerTracks("not json")).toEqual([]);
    expect(
      parseCachedServerTracks(
        JSON.stringify([cachedTrack, { id: "incomplete" }]),
      ),
    ).toEqual([cachedTrack]);
  });
});
