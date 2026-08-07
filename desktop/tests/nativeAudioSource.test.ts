import { describe, expect, test } from "bun:test";
import type { Track } from "../src/types/music";
import {
  nativeAudioQueue,
  nativeAudioSource,
  trackForNativeAudioSource,
} from "../src/utils/nativeAudioSource";

function track(overrides: Partial<Track>): Track {
  return {
    id: "test",
    provider: "tidal",
    providerTrackId: "1",
    playbackKind: "direct",
    audio: "https://audio.example/track.mp4",
    cover: "",
    nativeCover: null,
    name: "Test",
    album: "Test",
    albumId: null,
    artist: "Test",
    artists: [],
    trackNumber: null,
    discNumber: null,
    durationSeconds: 1,
    releaseDate: null,
    explicit: false,
    isrc: null,
    quality: null,
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
      id: "local",
      provider: "local",
      providerTrackId: "/Music/Ambra/song.mp3",
    });
    const streamed = track({
      id: "streamed",
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
      id: "local",
      provider: "local",
      providerTrackId: "/Music/Ambra/song.mp3",
    });
    const streamed = track({
      id: "streamed",
      playbackKind: "dash",
      audio: "http://127.0.0.1:8787/api/providers/tidal/tracks/1/manifest.mpd",
    });

    expect(
      trackForNativeAudioSource(
        [local, streamed],
        "http://127.0.0.1:8787/api/providers/tidal/tracks/1/playlist.m3u8",
      )?.id,
    ).toBe("streamed");
  });
});
