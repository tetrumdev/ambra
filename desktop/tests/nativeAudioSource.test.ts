import { describe, expect, test } from "bun:test";
import type { Track } from "../src/types/music";
import {
  nativeAudioQueue,
  nativeAudioSource,
  trackForNativeAudioStatus,
  trackForNativeAudioSource,
} from "../src/utils/nativeAudioSource";

function track(overrides: Partial<Track>): Track {
  return {
    globalId: "test",
    provider: "tidal",
    providerTrackId: "1",
    playbackKind: "direct",
    audio: "https://audio.example/track.mp4",
    cover: "",
    nativeCover: null,
    name: "Test",
    version: null,
    album: "Test",
    albumVersion: null,
    albumId: null,
    albumArtists: [],
    artist: "Test",
    artists: [],
    trackNumber: null,
    discNumber: null,
    durationSeconds: 1,
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
    ...overrides,
  };
}

describe("nativeAudioSource", () => {
  test("uses the real filesystem path for local playback", () => {
    expect(
      nativeAudioSource(
        track({
          provider: "local",
          providerTrackId: "/Music/Ambra/song.mp3",
          audio: "asset://localhost/%2FMusic%2FAmbra%2Fsong.mp3",
        }),
      ),
    ).toBe("/Music/Ambra/song.mp3");
  });

  test("uses the AVPlayer-compatible HLS view of a DASH stream", () => {
    expect(
      nativeAudioSource(
        track({
          playbackKind: "dash",
          audio:
            "http://127.0.0.1:8787/api/providers/tidal/tracks/1/manifest.mpd",
        }),
      ),
    ).toBe("http://127.0.0.1:8787/api/providers/tidal/tracks/1/playlist.m3u8");
  });

  test("queues local and streamed tracks with the same ordering", () => {
    const local = track({
      globalId: "local",
      provider: "local",
      providerTrackId: "/Music/Ambra/song.mp3",
    });
    const streamed = track({
      globalId: "streamed",
      playbackKind: "dash",
      audio: "http://127.0.0.1:8787/api/providers/tidal/tracks/1/manifest.mpd",
    });

    expect(nativeAudioQueue([local, streamed], "local")).toEqual({
      source: "/Music/Ambra/song.mp3",
      nextSource:
        "http://127.0.0.1:8787/api/providers/tidal/tracks/1/playlist.m3u8",
    });
    expect(nativeAudioQueue([local, streamed], "streamed")).toEqual({
      source:
        "http://127.0.0.1:8787/api/providers/tidal/tracks/1/playlist.m3u8",
      nextSource: "/Music/Ambra/song.mp3",
    });
  });

  test("maps an automatically advanced queue item back to its track", () => {
    const local = track({
      globalId: "local",
      provider: "local",
      providerTrackId: "/Music/Ambra/song.mp3",
    });
    const streamed = track({
      globalId: "streamed",
      playbackKind: "dash",
      audio: "http://127.0.0.1:8787/api/providers/tidal/tracks/1/manifest.mpd",
    });

    expect(
      trackForNativeAudioSource(
        [local, streamed],
        "http://127.0.0.1:8787/api/providers/tidal/tracks/1/playlist.m3u8",
      )?.globalId,
    ).toBe("streamed");
  });

  test("accepts status for the visible track", () => {
    const current = track({ globalId: "current" });

    expect(
      trackForNativeAudioStatus(
        [current],
        current.globalId,
        undefined,
        nativeAudioSource(current),
      ),
    ).toEqual({ track: current, advanced: false });
  });

  test("accepts status only for the expected automatic advance", () => {
    const current = track({
      globalId: "current",
      audio: "https://audio.example/current.mp4",
    });
    const next = track({
      globalId: "next",
      audio: "https://audio.example/next.mp4",
    });

    expect(
      trackForNativeAudioStatus(
        [current, next],
        current.globalId,
        next,
        nativeAudioSource(next),
      ),
    ).toEqual({ track: next, advanced: true });
  });

  test("rejects stale status from the previously loaded track", () => {
    const previous = track({
      globalId: "previous",
      audio: "https://audio.example/previous.mp4",
    });
    const current = track({
      globalId: "current",
      audio: "https://audio.example/current.mp4",
    });

    expect(
      trackForNativeAudioStatus(
        [previous, current],
        current.globalId,
        undefined,
        nativeAudioSource(previous),
      ),
    ).toBeUndefined();
  });

  test("rejects status while the native worker has no loaded source", () => {
    const current = track({ globalId: "current" });

    expect(
      trackForNativeAudioStatus(
        [current],
        current.globalId,
        undefined,
        null,
      ),
    ).toBeUndefined();
  });

  test("rejects an unknown source when there is no expected next track", () => {
    const current = track({ globalId: "current" });

    expect(
      trackForNativeAudioStatus(
        [current],
        current.globalId,
        undefined,
        "https://audio.example/unknown.mp4",
      ),
    ).toBeUndefined();
  });
});
