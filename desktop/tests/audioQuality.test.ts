import { expect, test } from "bun:test";
import { compactAudioQuality, formatAudioQuality, signalPathQuality } from "../src/utils/audioQuality";
import type { AudioQuality, Track } from "../src/types/music";

const track = { quality: "FLAC 24-bit / 96 kHz", bitrateKbps: 2200 } as Track;
const decoded: AudioQuality = {
  codec: "flac", bitDepth: 24, sampleRateHz: 96000, channels: 2,
  bitrateKbps: 2200, bitrateIsEstimate: true,
};

test("playback details contain only format, bit depth, sample rate and channel layout", () => {
  expect(formatAudioQuality(track, decoded).details).toBe("FLAC · 24-bit · 96 kHz · Stereo");
  expect(formatAudioQuality(track, { ...decoded, channels: 1 }).details).toBe("FLAC · 24-bit · 96 kHz · Mono");
});

test("lossy playback omits bitrate and unknown bit depth", () => {
  expect(formatAudioQuality({ quality: "MP3 320 kbps" } as Track, {
    ...decoded, codec: "mp3", bitDepth: null, sampleRateHz: 44100, bitrateKbps: 320,
  }).details).toBe("MP3 · 44.1 kHz · Stereo");
});

test("reported quality omits unknown channels without adding bitrate placeholders", () => {
  expect(formatAudioQuality(track).details).toBe("FLAC · 24-bit · 96 kHz");
  expect(formatAudioQuality({ quality: "AAC" } as Track).details).toBe("AAC");
});

test("track-list quality keeps its existing bitrate display", () => {
  expect(compactAudioQuality({ quality: "MP3 320 kbps" } as Track)).toBe("MP3 320");
});

test("the quality light picks one tier from the source and the output path", () => {
  const qobuz = { ...track, provider: "qobuz" } as Track;
  expect(signalPathQuality(qobuz, decoded).tier).toBe("hiRes");
  expect(signalPathQuality(qobuz, { ...decoded, bitPerfect: true }).tier).toBe("bitPerfect");
  expect(signalPathQuality(qobuz, { ...decoded, bitDepth: 16, sampleRateHz: 44100 }).tier).toBe("lossless");
  expect(signalPathQuality({ quality: "MP3 320 kbps", provider: "local" } as Track, {
    ...decoded, codec: "mp3", bitDepth: null, sampleRateHz: 44100, bitrateKbps: 320, bitPerfect: true,
  }).tier).toBe("lossy");
  expect(signalPathQuality({ provider: "local" } as Track).tier).toBe("unknown");
});

test("the quality popup lists service, format, bitrate and the signal path", () => {
  const rows = signalPathQuality({ ...track, provider: "qobuz" } as Track, { ...decoded, normalizationGainDb: -4.25 }).rows;
  expect(rows).toEqual([
    { label: "Service", value: "Qobuz" },
    { label: "Format", value: "FLAC · 24-bit · 96 kHz · Stereo" },
    { label: "Bitrate", value: "2,200 kbps" },
    { label: "Volume leveling", value: "−4.3 dB, transparent" },
    { label: "Output", value: "Processed in 64-bit, dithered" },
  ]);
});
