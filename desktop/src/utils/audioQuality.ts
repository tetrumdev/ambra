import type { AudioQuality, Track } from "../types/music";
import { musicProviderName } from "./musicProviderName";

function positive(value: number | null | undefined) {
  return value != null && Number.isFinite(value) && value > 0 ? value : null;
}

function codecName(codec: string | null | undefined) {
  if (!codec || codec === "unknown") return null;
  if (/^pcm/i.test(codec)) return "PCM";
  if (/^(ogg )?vorbis$/i.test(codec)) return "Ogg Vorbis";
  return codec.toUpperCase();
}

function qualityFields(track: Track, decoded?: AudioQuality | null) {
  const reported = track.quality ?? "";
  const reportedCodec = codecName(reported.match(/^(Ogg Vorbis|FLAC|ALAC|AAC|MP3|PCM|WAV|AIFF|Opus)\b/i)?.[1]);
  const codec = decoded ? codecName(decoded.codec) : reportedCodec;
  const lossless = codec != null && ["FLAC", "ALAC", "PCM", "WAV", "AIFF"].includes(codec);
  const bitDepth = lossless ? positive(decoded
    ? decoded.bitDepth
    : Number(reported.match(/([\d.]+)-bit\b/i)?.[1])) : null;
  const sampleRate = decoded
    ? positive(decoded.sampleRateHz / 1000)
    : positive(Number(reported.match(/([\d.]+)\s*kHz\b/i)?.[1]));
  const channels = decoded ? positive(decoded.channels) : null;
  // Catalog maxima describe available editions, not the audio being decoded.
  // Only use an encoded bitrate from metadata when its codec matches the source.
  const reportedBitrate = !decoded || codec === reportedCodec
    ? positive(track.bitrateKbps) ?? positive(Number(reported.match(/([\d.]+)\s*kbps\b/i)?.[1]))
    : null;
  const decodedBitrate = positive(decoded?.bitrateKbps);
  const bitrate = decoded?.bitrateIsEstimate
    ? reportedBitrate ?? decodedBitrate
    : decodedBitrate ?? reportedBitrate;
  const estimated = bitrate != null && decoded?.bitrateIsEstimate === true && reportedBitrate == null;
  return { codec, lossless, bitDepth, sampleRate, channels, bitrate, estimated };
}

export function formatAudioQuality(track: Track, decoded?: AudioQuality | null) {
  if (decoded?.captureFormat) {
    const capture = decoded.captureFormat;
    const bitDepth = positive(Number(capture.sampleFormat.match(/\d+/)?.[0]));
    return {
      name: decoded.requestedQuality === "lossless" ? "Lossless requested" : "Soloist capture",
      details: ["PCM", bitDepth ? `${bitDepth}-bit` : null, `${capture.sampleRate / 1000} kHz`,
        capture.channels === 1 ? "Mono" : capture.channels === 2 ? "Stereo" : `${capture.channels} channels`].filter(Boolean).join(" · "),
      description: `Requested Spotify quality: ${decoded.requestedQuality ?? "unknown"}. Original Spotify codec and bit depth are unverified. These details describe captured PCM before Ambra output conversion and DSP.`,
    };
  }
  const { codec, lossless, bitDepth, sampleRate, channels } = qualityFields(track, decoded);
  const hiRes = lossless && ((bitDepth ?? 0) > 16 || (sampleRate ?? 0) > 48);
  const name = lossless
    ? hiRes ? "Hi-Res Lossless" : bitDepth === 16 && sampleRate === 44.1 ? "CD Quality" : "Lossless"
    : codec ? "Lossy" : "Quality unavailable";
  const specs = [
    codec,
    bitDepth ? `${bitDepth}-bit` : null,
    sampleRate ? `${Number(sampleRate.toFixed(3))} kHz` : null,
    channels ? channels === 1 ? "Mono" : channels === 2 ? "Stereo" : `${channels} channels` : null,
  ].filter((value): value is string => value != null);
  return {
    name,
    details: specs.join(" · "),
    description: [
      decoded ? "Source audio before output conversion." : "Reported source quality; decoded details are not available yet.",
      decoded?.normalizationGainDb != null && Number.isFinite(decoded.normalizationGainDb)
        ? `Volume normalized by ${decoded.normalizationGainDb > 0 ? "+" : "−"}${Math.abs(decoded.normalizationGainDb).toFixed(1)} dB.`
        : null,
    ].filter(Boolean).join(" "),
  };
}

export type QualityTier = "bitPerfect" | "hiRes" | "lossless" | "lossy" | "unknown";

const tierLabels: Record<QualityTier, string> = {
  bitPerfect: "Bit-perfect",
  hiRes: "Hi-Res Lossless",
  lossless: "Lossless",
  lossy: "Lossy",
  unknown: "Quality unavailable",
};

/** Everything the quality light and its popup show: one tier for the color, then the signal path. */
export function signalPathQuality(track: Track, decoded?: AudioQuality | null) {
  const quality = formatAudioQuality(track, decoded);
  const { lossless, bitrate, estimated } = qualityFields(track, decoded);
  const capture = decoded?.captureFormat != null;
  const tier: QualityTier = capture ? "lossy"
    : quality.name === "Quality unavailable" ? "unknown"
    : !lossless ? "lossy"
    : decoded?.bitPerfect ? "bitPerfect"
    : quality.name === "Hi-Res Lossless" ? "hiRes" : "lossless";
  const gain = decoded?.normalizationGainDb;
  const rows: { label: string; value: string }[] = [
    { label: "Service", value: musicProviderName(track.provider) },
    { label: "Format", value: quality.details || "Unknown" },
  ];
  if (bitrate != null) rows.push({ label: "Bitrate", value: `${estimated ? "~" : ""}${Math.round(bitrate).toLocaleString()} kbps` });
  if (decoded) {
    rows.push({
      label: "Volume leveling",
      value: gain == null || !Number.isFinite(gain) ? "Off"
        : Math.abs(gain) < 0.05 ? "0.0 dB" : `${gain > 0 ? "+" : "−"}${Math.abs(gain).toFixed(1)} dB, transparent`,
    });
    rows.push({
      label: "Output",
      value: decoded.bitPerfect ? "Bit-perfect" : capture ? "Captured PCM, processed in 64-bit" : "Processed in 64-bit, dithered",
    });
  }
  return {
    tier,
    label: tier === "lossless" ? quality.name : tierLabels[tier],
    /** The source's own class, which stays visible when the output is bit-perfect. */
    name: quality.name,
    rows,
    note: capture ? quality.description : decoded ? null : "Reported quality; decoded details are not available yet.",
  };
}

/** A song's reported quality in a few characters, for a track list column: "FLAC 24/96", "Ogg Vorbis 320". */
export function compactAudioQuality(track: Track) {
  const { codec, lossless, bitDepth, sampleRate, bitrate } = qualityFields(track);
  const depth = bitDepth ?? (lossless ? positive(track.maximumBitDepth) : null);
  const rate = sampleRate ?? (lossless ? positive(track.maximumSamplingRateKHz) : null);
  if (lossless && depth && rate) return `${codec} ${depth}/${Number(rate.toFixed(1))}`;
  if (codec && bitrate) return `${codec} ${Math.round(bitrate)}`;
  return codec;
}

/** Orders songs from the lowest quality to the highest; lossless always outranks lossy. */
export function audioQualityRank(track: Track) {
  const { codec, lossless, bitDepth, sampleRate, bitrate } = qualityFields(track);
  if (lossless) {
    const depth = bitDepth ?? positive(track.maximumBitDepth) ?? 16;
    const rate = sampleRate ?? positive(track.maximumSamplingRateKHz) ?? 44.1;
    return 1_000_000 + depth * 1_000 + rate;
  }
  return codec ? bitrate ?? 1 : 0;
}
