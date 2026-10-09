import { expect, test } from "bun:test";
import type { AudioQuality } from "../src/types/music";
import { formatAudioQuality } from "../src/utils/audioQuality";
import { track } from "./searchFixture";

const decoded: AudioQuality = {
  codec: "flac", sampleRateHz: 96000, bitDepth: 24, channels: 2,
  bitrateKbps: 2642.4, bitrateIsEstimate: true,
};

test("shows decoded hi-res source details and identifies an estimated encoded bitrate", () => {
  const result = formatAudioQuality(track("local:1", "local"), decoded);
  expect(result.name).toBe("Hi-Res Lossless");
  expect(result.details).toBe("FLAC · 24-bit · 96 kHz · Stereo · ≈2,642 kbps");
  expect(result.description).toContain("including container metadata");
});

test("playing source overrides catalog maxima and an older quality label", () => {
  const result = formatAudioQuality(track("qobuz:1", "qobuz", {
    quality: "FLAC 24-bit/192 kHz", maximumBitDepth: 24, maximumSamplingRateKHz: 192,
  }), { ...decoded, sampleRateHz: 44100, bitDepth: 16 });
  expect(result.name).toBe("CD Quality");
  expect(result.details).toContain("16-bit · 44.1 kHz");
  expect(result.details).not.toContain("192");
});

test("lossy recordings show nominal bitrate without claiming decoder sample width as recording precision", () => {
  const result = formatAudioQuality(track("spotify:1", "spotify", { quality: "Ogg Vorbis 320 kbps" }), {
    ...decoded, codec: "vorbis", sampleRateHz: 44100, bitDepth: 32, bitrateKbps: 311,
  });
  expect(result.name).toBe("Lossy");
  expect(result.details).toBe("Ogg Vorbis · 44.1 kHz · Stereo · 320 kbps");
});

test("manifest bitrate remains available for segmented audio with no file length", () => {
  const result = formatAudioQuality(track("tidal:1", "tidal", {
    quality: "FLAC 24-bit/192 kHz", bitrateKbps: 5607.961,
  }), { ...decoded, sampleRateHz: 192000, bitrateKbps: null });
  expect(result.details).toBe("FLAC · 24-bit · 192 kHz · Stereo · 5,608 kbps");
  expect(result.description).not.toContain("estimated");
});

test("uncompressed PCM uses its source bitrate and preserves channel count", () => {
  const result = formatAudioQuality(track("local:1", "local"), {
    ...decoded, codec: "pcm_s16le", sampleRateHz: 48000, bitDepth: 16,
    channels: 6, bitrateKbps: 4608, bitrateIsEstimate: false,
  });
  expect(result.details).toBe("PCM · 16-bit · 48 kHz · 6 channels · 4,608 kbps");
  expect(result.name).toBe("Lossless");
});

test("legacy tracks expose only reported values and never invent catalog maxima or stereo", () => {
  const result = formatAudioQuality(track("qobuz:1", "qobuz", {
    quality: "FLAC", maximumBitDepth: 24, maximumSamplingRateKHz: 192,
  }));
  expect(result.details).toBe("FLAC · Bitrate unavailable");
  expect(result.description).toContain("Reported source quality");
});

test("a codec change cannot reuse an obsolete nominal bitrate", () => {
  const result = formatAudioQuality(track("tidal:1", "tidal", {
    quality: "AAC 320 kbps", bitrateKbps: 320,
  }), decoded);
  expect(result.name).toBe("Hi-Res Lossless");
  expect(result.details).toContain("≈2,642 kbps");
});

test("missing or invalid properties render readable unavailable text", () => {
  const result = formatAudioQuality(track("local:1", "local"), {
    codec: "unknown", sampleRateHz: NaN, bitDepth: 0, channels: 0,
    bitrateKbps: Infinity, bitrateIsEstimate: false,
  });
  expect(result.name).toBe("Quality unavailable");
  expect(result.details).toBe("Bitrate unavailable");
});
