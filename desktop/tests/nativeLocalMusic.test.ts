import { expect, test } from "bun:test";
import { isDeviceTrack, nativeAudioSource, trackForNativeAudioStatus } from "../src/utils/nativeAudioSource";
import type { Track } from "../src/types/music";

test("local files use native paths on Windows and macOS; shared files retain server audio URLs", () => {
  for (const audio of ["asset://localhost/Music/song.flac", "http://asset.localhost/C%3A/Music/song.flac", "https://asset.localhost/C%3A/Music/song.flac"]) {
    const track = { provider: "local", audio, providerTrackId: "/Music/song.flac" } as Track;
    expect(isDeviceTrack(track)).toBe(true);
    expect(nativeAudioSource(track)).toBe("/Music/song.flac");
  }
  const remote = { provider: "local", audio: "http://127.0.0.1:49000/api/music/local/files/shared.flac", providerTrackId: "shared.flac" } as Track;
  expect(isDeviceTrack(remote)).toBe(false);
  expect(nativeAudioSource(remote)).toBe(remote.audio);
});

test("native status reuses the active track lookup and sees replacements and gapless advances", () => {
  let reads = 0;
  const tracks = Array.from({ length: 1000 }, (_, index) => ({
    get globalId() { reads++; return `local:${index}`; },
    provider: "local", audio: `asset://localhost/${index}`, providerTrackId: `/${index}`,
  }) as Track);
  const current = tracks[999];
  const next = tracks[500];
  expect(trackForNativeAudioStatus(tracks, "local:999", next, "/999")?.track).toBe(current);
  expect(reads).toBe(tracks.length);
  for (let i = 0; i < 10; i++) {
    expect(trackForNativeAudioStatus(tracks, "local:999", next, "/999")?.track).toBe(current);
  }
  expect(reads).toBe(tracks.length);
  expect(trackForNativeAudioStatus(tracks, "local:999", next, "/500")).toEqual({ track: next, advanced: true });
  const replacement = { ...current, providerTrackId: "/replacement" };
  const updated = [replacement, ...tracks.slice(0, -1)];
  expect(trackForNativeAudioStatus(updated, "local:999", next, "/replacement")?.track).toBe(replacement);
});
