import { expect, test } from "bun:test";
import { isDeviceTrack, nativeAudioSource } from "../src/utils/nativeAudioSource";
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
