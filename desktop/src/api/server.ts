import type {
  MusicProvider,
  PlaybackKind,
  Track,
  TrackArtist,
} from "../types/music";
import fallbackCover from "../assets/images/fallbackCover.png";
import type { PlaybackCachePlan } from "../utils/playbackCachePlan";

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
    throw new Error(
      `Ambra server returned HTTP ${response.status}: ${message}`,
    );
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

const playbackCachePlanUrl = `${serverBaseUrl}/api/playback/cache-plan`;
let queuedPlaybackCachePlan: PlaybackCachePlan | undefined;
let isPublishingPlaybackCachePlan = false;
let playbackCacheRevision = Date.now() * 1_000;

function nextPlaybackCacheRevision() {
  playbackCacheRevision = Math.max(
    playbackCacheRevision + 1,
    Date.now() * 1_000,
  );
  return playbackCacheRevision;
}

async function postPlaybackCachePlan(plan: PlaybackCachePlan) {
  const response = await fetch(playbackCachePlanUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...plan, revision: nextPlaybackCacheRevision() }),
  });
  if (!response.ok) {
    throw new Error(`Ambra server returned HTTP ${response.status}`);
  }
}

async function drainPlaybackCachePlans() {
  while (queuedPlaybackCachePlan) {
    const plan = queuedPlaybackCachePlan;
    queuedPlaybackCachePlan = undefined;
    try {
      await postPlaybackCachePlan(plan);
    } catch (error) {
      console.warn("Could not publish playback cache plan:", error);
    }
  }
  isPublishingPlaybackCachePlan = false;
}

export function publishPlaybackCachePlan(plan: PlaybackCachePlan) {
  queuedPlaybackCachePlan = plan;
  if (isPublishingPlaybackCachePlan) return;

  isPublishingPlaybackCachePlan = true;
  void drainPlaybackCachePlans();
}

export function publishPlaybackCachePlanOnUnload(plan: PlaybackCachePlan) {
  const body = JSON.stringify({
    ...plan,
    revision: nextPlaybackCacheRevision(),
  });
  try {
    if (
      navigator.sendBeacon(
        playbackCachePlanUrl,
        new Blob([body], { type: "application/json" }),
      )
    ) {
      return;
    }
  } catch (error) {
    console.warn("Could not send playback cache plan beacon:", error);
  }

  void fetch(playbackCachePlanUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    keepalive: true,
  }).catch((error) =>
    console.warn("Could not clear playback cache plan on unload:", error),
  );
}
