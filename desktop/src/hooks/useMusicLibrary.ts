import { convertFileSrc, invoke, isTauri } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import fallbackCover from "../assets/images/fallbackCover.png";
import type { ScannedTrack, Track } from "../types/music";
import { loadServerTracks } from "../api/server";

type MusicLibrary = {
  tracks: Track[];
  isLoading: boolean;
  error: string | null;
};

function playableLocalCover(cover: string | null) {
  if (cover === null) return fallbackCover;
  return cover.startsWith("data:") ? cover : convertFileSrc(cover);
}

function localTrack(track: ScannedTrack): Track {
  return {
    ...track,
    id: `local:${track.audio}`,
    provider: "local",
    providerTrackId: track.audio,
    playbackKind: "direct",
    audio: convertFileSrc(track.audio),
    cover: playableLocalCover(track.cover),
    albumId: null,
    artists: [{ providerId: track.artist, name: track.artist }],
    discNumber: null,
    releaseDate: null,
    explicit: false,
    isrc: null,
    quality: null,
  };
}

export function useMusicLibrary(): MusicLibrary {
  const [tracks, setTracks] = useState<Track[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const localTracks = isTauri()
      ? invoke<ScannedTrack[]>("scan_music")
      : Promise.resolve([]);
    const serverTracks = loadServerTracks().catch((reason: unknown) => {
      console.warn("Could not load streaming providers:", reason);
      return [];
    });

    void Promise.all([localTracks, serverTracks])
      .then(([scannedTracks, streamedTracks]) => {
        if (cancelled) return;
        setTracks([...streamedTracks, ...scannedTracks.map(localTrack)]);
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(String(reason));
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return { tracks, isLoading, error };
}
