import { expect, test } from "bun:test";
import { formatAudioQuality } from "../src/utils/audioQuality";
import type { Track } from "../src/types/music";

test("32-bit PCM capture never claims a verified Spotify lossless source", () => {
  const quality = formatAudioQuality({ quality: "FLAC 24-bit 44.1 kHz" } as Track, {
    codec: "pcm_s32le", sampleRateHz: 44100, channels: 2, bitDepth: null,
    bitrateKbps: 2822.4, bitrateIsEstimate: false,
    captureFormat: { codec: "pcm", sampleFormat: "s32le", sampleRate: 44100, channels: 2 },
    requestedQuality: "lossless", sourceFormatVerified: false,
  });
  expect(quality.name).toBe("Lossless requested");
  expect(quality.name).not.toContain("Hi-Res");
  expect(quality.details).toContain("S32LE PCM");
  expect(quality.description).toContain("unverified");
});
