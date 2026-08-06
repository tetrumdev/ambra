import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import fallbackCover from "../assets/images/fallbackCover.png";
import type { ScannedTrack, Track } from "../types/music";

type MusicLibrary = {
  tracks: Track[];
  isLoading: boolean;
  error: string | null;
};

function playableCover(cover: string | null) {
  if (cover === null) return fallbackCover;
  return cover.startsWith("data:") ? cover : convertFileSrc(cover);
}

export function useMusicLibrary(): MusicLibrary {
  const [tracks, setTracks] = useState<Track[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    void invoke<ScannedTrack[]>("scan_music")
      .then((scannedTracks) => {
        if (cancelled) return;

        setTracks(
          scannedTracks.map((track) => ({
            ...track,
            id: track.audio,
            audio: convertFileSrc(track.audio),
            cover: playableCover(track.cover),
          })),
        );
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
