import type { RemoteTrack } from "../api/server";
import type { Track } from "../types/music";
import { whiteArtwork } from "./artworkPlaceholder";

export function remoteTrack(track: RemoteTrack, mediaUrl: (path: string) => string): Track {
  const withVersion = (title: string, version: string | null) => version?.trim() ? `${title} (${version})` : title;
  return {
    globalId: track.id,
    provider: track.provider,
    providerTrackId: track.providerTrackId,
    playbackKind: track.playback.kind,
    audio: mediaUrl(track.playback.url),
    cover: track.album?.coverUrl ?? whiteArtwork,
    nativeCover: track.album?.coverUrl ?? null,
    name: withVersion(track.title, track.version),
    version: track.version,
    album: withVersion(track.album?.title ?? "Unknown Album", track.album?.version ?? null),
    albumVersion: track.album?.version ?? null,
    albumId: track.album?.providerId ?? null,
    albumArtists: track.album?.artists ?? [],
    artist: track.primaryArtist.name,
    artists: track.artists,
    trackNumber: track.trackNumber,
    discNumber: track.discNumber,
    durationSeconds: track.durationSeconds,
    releaseDate: track.album?.releaseDate ?? null,
    explicit: track.explicit,
    isrc: track.isrc,
    copyright: track.copyright,
    label: track.album?.label ?? null,
    genres: track.album?.genres ?? [],
    upc: track.album?.upc ?? null,
    quality: track.quality,
    maximumSamplingRateKHz: track.maximumSamplingRateKHz,
    maximumBitDepth: track.maximumBitDepth,
  };
}
