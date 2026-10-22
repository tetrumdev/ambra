import { configuredSearchProviders, searchServerCatalog, type CatalogAlbum } from "../api/server";
import type { Track } from "../types/music";
import { formatAudioQuality } from "./audioQuality";
import { albumBaseTitle, sameAlbum } from "./catalogRanking";

/**
 * The same album on every connected service, and its other editions (deluxe, remastered,
 * anniversary) on each: anything by the same artist whose title matches once edition notes
 * are set aside. The open album is always first.
 */
export async function findAlbumVersions(album: CatalogAlbum, signal: AbortSignal): Promise<CatalogAlbum[]> {
  if (album.provider === "local") return [album];
  const providers = await configuredSearchProviders(signal);
  const pages = await Promise.allSettled(providers.map(provider =>
    searchServerCatalog(`${albumBaseTitle(album.title)} ${album.artist}`, provider, signal)));
  signal.throwIfAborted();
  if (!album.versions?.length && pages.length && pages.every(page => page.status === "rejected")) {
    throw new Error("Could not search album versions. Please try again.");
  }
  const seen = new Set([`${album.provider}:${album.id}`]);
  const versions = [album];
  const found = pages.flatMap(page => page.status === "fulfilled" ? page.value.albums ?? [] : []);
  for (const candidate of [...(album.versions ?? []), ...found]) {
    const key = `${candidate.provider}:${candidate.id}`;
    if (seen.has(key) || !sameAlbum(album, candidate)) continue;
    seen.add(key);
    versions.push(candidate);
  }
  return versions;
}

/** "Hi-Res Lossless · FLAC 24-bit 96 kHz" for an album's tracks; "Up to" when they differ. */
export function albumAudioQuality(tracks: Track[]): string | null {
  const streamed = tracks.filter(track => track.provider !== "local" || track.quality);
  if (!streamed.length) return null;
  const formats = streamed.map(track => {
    // The album advertises available catalog quality; the player reports decoded source quality.
    const catalogLossless = track.provider === "qobuz" || track.provider === "tidal";
    const advertised = catalogLossless && (track.maximumBitDepth || track.maximumSamplingRateKHz)
      ? { ...track, quality: ["FLAC", track.maximumBitDepth ? `${track.maximumBitDepth}-bit` : null,
          track.maximumSamplingRateKHz ? `${track.maximumSamplingRateKHz} kHz` : null].filter(Boolean).join(" ") }
      : track;
    const quality = formatAudioQuality(advertised);
    // An album line has no bitrate to show; only the format matters here.
    const details = quality.details.split(" · ").filter(part => !/bitrate|kbps/i.test(part)).join(" · ");
    return { label: quality.name === "Quality unavailable" ? quality.name : details ? `${quality.name} · ${details}` : quality.name,
      lossless: Number(quality.name !== "Lossy" && quality.name !== "Quality unavailable"),
      depth: track.maximumBitDepth ?? Number(track.quality?.match(/([\d.]+)-bit\b/i)?.[1] ?? 0),
      rate: track.maximumSamplingRateKHz ?? Number(track.quality?.match(/([\d.]+)\s*kHz\b/i)?.[1] ?? 0) };
  });
  if (formats.every(format => format.label === "Quality unavailable")) return null;
  const best = formats.reduce((top, format) => (format.lossless - top.lossless || format.depth - top.depth || format.rate - top.rate) > 0 ? format : top);
  return formats.every(format => format.label === best.label) ? best.label : `Up to ${best.label}`;
}

/** "24-bit/96 kHz" from an album's own catalog maxima, written like search results show it. */
export function catalogAlbumQuality(album: CatalogAlbum): string | null {
  if (!album.maximumBitDepth) return null;
  return album.maximumSamplingRateKHz
    ? `${album.maximumBitDepth}-bit/${Number(album.maximumSamplingRateKHz.toFixed(1))} kHz`
    : `${album.maximumBitDepth}-bit`;
}
