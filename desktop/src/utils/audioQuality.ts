import type { AudioQuality, Track } from "../types/music";

function positive(value: number | null | undefined) {
  return value != null && Number.isFinite(value) && value > 0 ? value : null;
}

function codecName(codec: string | null | undefined) {
  if (!codec || codec === "unknown") return null;
  if (/^pcm/i.test(codec)) return "PCM";
  if (/^(ogg )?vorbis$/i.test(codec)) return "Ogg Vorbis";
  return codec.toUpperCase();
}

export function formatAudioQuality(track: Track, decoded?: AudioQuality | null) {
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
  const hiRes = lossless && ((bitDepth ?? 0) > 16 || (sampleRate ?? 0) > 48);
  const name = lossless
    ? hiRes ? "Hi-Res Lossless" : bitDepth === 16 && sampleRate === 44.1 ? "CD Quality" : "Lossless"
    : codec ? "Lossy" : "Quality unavailable";
  const specs = [
    codec,
    bitDepth ? `${bitDepth}-bit` : null,
    sampleRate ? `${Number(sampleRate.toFixed(3))} kHz` : null,
    channels ? channels === 1 ? "Mono" : channels === 2 ? "Stereo" : `${channels} channels` : null,
    bitrate ? `${estimated ? "≈" : ""}${Math.round(bitrate).toLocaleString("en-US")} kbps` : "Bitrate unavailable",
  ].filter((value): value is string => value != null);
  return {
    name,
    details: specs.join(" · "),
    description: [
      decoded ? "Source audio before output conversion." : "Reported source quality; decoded details are not available yet.",
      estimated ? "Average encoded bitrate estimated from file size and duration, including container metadata." : null,
    ].filter(Boolean).join(" "),
  };
}
