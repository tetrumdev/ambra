import { describe, expect, test } from "bun:test";
import {
  parseCachedServerTracks,
  parseRemovedLibraryTrackIds,
} from "../src/utils/libraryCache";
import type { Track } from "../src/types/music";

const cachedTrack: Track = {
  globalId: "tidal:1",
  provider: "tidal",
  providerTrackId: "1",
  playbackKind: "dash",
  audio: "http://127.0.0.1:8787/track.mpd",
  cover: "cover.jpg",
  nativeCover: "cover.jpg",
  name: "Cached Song",
  version: null,
  album: "Cached Album",
  albumVersion: null,
  albumId: "10",
  albumArtists: [
    { providerId: "20", name: "Cached Artist", imageUrl: null },
  ],
  artist: "Cached Artist",
  artists: [{ providerId: "20", name: "Cached Artist", imageUrl: null }],
  trackNumber: 1,
  discNumber: 1,
  durationSeconds: 180,
  releaseDate: null,
  explicit: false,
  isrc: null,
  copyright: null,
  label: null,
  genres: [],
  upc: null,
  quality: "HIGH",
  maximumSamplingRateKHz: null,
  maximumBitDepth: null,
};

describe("parseCachedServerTracks", () => {
  test("restores valid streaming tracks", () => {
    expect(parseCachedServerTracks(JSON.stringify([cachedTrack]))).toEqual([
      cachedTrack,
    ]);
  });

  test("migrates the previous id field to globalId", () => {
    const { globalId, ...legacyTrack } = cachedTrack;

    expect(
      parseCachedServerTracks(
        JSON.stringify([{ ...legacyTrack, id: globalId }]),
      ),
    ).toEqual([cachedTrack]);
  });

  test("ignores corrupt cache entries", () => {
    expect(parseCachedServerTracks("not json")).toEqual([]);
    expect(
      parseCachedServerTracks(
        JSON.stringify([cachedTrack, { globalId: "incomplete" }]),
      ),
    ).toEqual([cachedTrack]);
  });
});

describe("parseRemovedLibraryTrackIds", () => {
  test("restores unique track IDs", () => {
    expect(
      parseRemovedLibraryTrackIds(
        JSON.stringify(["local:/song.flac", "tidal:1", "tidal:1"]),
      ),
    ).toEqual(["local:/song.flac", "tidal:1"]);
  });

  test("ignores invalid stored values", () => {
    expect(parseRemovedLibraryTrackIds("not json")).toEqual([]);
    expect(parseRemovedLibraryTrackIds(JSON.stringify({ track: "tidal:1" }))).toEqual(
      [],
    );
  });
});
