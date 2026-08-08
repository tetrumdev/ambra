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
  version: string | null;
  artists: TrackArtist[];
  coverUrl: string | null;
  releaseDate: string | null;
  label: string | null;
  genres: string[];
  upc: string | null;
};

type RemoteTrack = {
  id: string;
  provider: MusicProvider;
  providerTrackId: string;
  title: string;
  version: string | null;
  primaryArtist: TrackArtist;
  artists: TrackArtist[];
  album: RemoteAlbum | null;
  durationSeconds: number;
  trackNumber: number | null;
  discNumber: number | null;
  explicit: boolean;
  isrc: string | null;
  copyright: string | null;
  quality: string | null;
  maximumSamplingRateKHz: number | null;
  maximumBitDepth: number | null;
  playback: {
    kind: PlaybackKind;
    url: string;
  };
};

type LibraryResponse = {
  tracks: RemoteTrack[];
};

function playableTrack(track: RemoteTrack): Track {
  const displayTitle = withVersion(track.title, track.version);
  const displayAlbum = withVersion(
    track.album?.title ?? "Unknown Album",
    track.album?.version ?? null,
  );
  return {
    id: track.id,
    provider: track.provider,
    providerTrackId: track.providerTrackId,
    playbackKind: track.playback.kind,
    audio: `${serverBaseUrl}${track.playback.url}`,
    cover: track.album?.coverUrl ?? fallbackCover,
    nativeCover: track.album?.coverUrl ?? null,
    name: displayTitle,
    version: track.version,
    album: displayAlbum,
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

function withVersion(title: string, version: string | null) {
  return version?.trim() ? `${title} (${version})` : title;
}

async function libraryTracks(response: Response): Promise<Track[]> {
  if (!response.ok) {
    const body = await response.text();
    let message = body;
    try {
      const parsed = JSON.parse(body) as { error?: unknown };
      if (typeof parsed.error === "string") message = parsed.error;
    } catch {
      // Preserve non-JSON upstream errors verbatim.
    }
    throw new Error(`Ambra server returned HTTP ${response.status}: ${message}`);
  }

  const library = (await response.json()) as LibraryResponse;
  return library.tracks.map(playableTrack);
}

export async function loadServerTracks(): Promise<Track[]> {
  return libraryTracks(await fetch(`${serverBaseUrl}/api/library`));
}

export async function addServerAlbum(url: string): Promise<Track[]> {
  return libraryTracks(
    await fetch(`${serverBaseUrl}/api/library/albums`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    }),
  );
}
