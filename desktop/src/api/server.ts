import type {
  MusicProvider,
  PlaybackKind,
  Track,
  TrackArtist,
} from "../types/music";
import fallbackCover from "../assets/images/fallbackCover.png";

const serverBaseUrl = (
  import.meta.env.VITE_AMBRA_SERVER_URL ?? "http://127.0.0.1:8787"
).replace(/\/$/, "");

type RemoteAlbum = {
  providerId: string;
  title: string;
  coverUrl: string | null;
  releaseDate: string | null;
};

type RemoteTrack = {
  id: string;
  provider: MusicProvider;
  providerTrackId: string;
  title: string;
  primaryArtist: TrackArtist;
  artists: TrackArtist[];
  album: RemoteAlbum | null;
  durationSeconds: number;
  trackNumber: number | null;
  discNumber: number | null;
  explicit: boolean;
  isrc: string | null;
  quality: string | null;
  playback: {
    kind: PlaybackKind;
    url: string;
  };
};

type LibraryResponse = {
  tracks: RemoteTrack[];
};

export async function loadServerTracks(): Promise<Track[]> {
  const response = await fetch(`${serverBaseUrl}/api/library`);
  if (!response.ok) {
    const message = await response.text();
    throw new Error(`Ambra server returned HTTP ${response.status}: ${message}`);
  }

  const library = (await response.json()) as LibraryResponse;
  return library.tracks.map((track) => ({
    id: track.id,
    provider: track.provider,
    providerTrackId: track.providerTrackId,
    playbackKind: track.playback.kind,
    audio: `${serverBaseUrl}${track.playback.url}`,
    cover: track.album?.coverUrl ?? fallbackCover,
    name: track.title,
    album: track.album?.title ?? "Unknown Album",
    albumId: track.album?.providerId ?? null,
    artist: track.primaryArtist.name,
    artists: track.artists,
    trackNumber: track.trackNumber,
    discNumber: track.discNumber,
    durationSeconds: track.durationSeconds,
    releaseDate: track.album?.releaseDate ?? null,
    explicit: track.explicit,
    isrc: track.isrc,
    quality: track.quality,
  }));
}
