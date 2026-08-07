import { convertFileSrc, invoke, isTauri } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useState } from "react";
import fallbackCover from "../assets/images/fallbackCover.png";
import type { ScannedTrack, Track } from "../types/music";
import { addServerTidalAlbum, loadServerTracks } from "../api/server";
import {
  loadCachedServerTracks,
  saveCachedServerTracks,
} from "../utils/libraryCache";
import { moveAlbumToEndInOrder } from "../utils/trackOrder";

type MusicLibrary = {
  tracks: Track[];
  isLoading: boolean;
  error: string | null;
  isAddingAlbum: boolean;
  addAlbumError: string | null;
  addTidalAlbum: (url: string) => Promise<boolean>;
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
    nativeCover: track.cover,
    albumId: null,
    artists: [{ providerId: track.artist, name: track.artist }],
    discNumber: null,
    releaseDate: null,
    explicit: false,
    isrc: null,
    quality: null,
  };
}

function appendUniqueTracks(currentTracks: Track[], incomingTracks: Track[]) {
  const existingIds = new Set(currentTracks.map((track) => track.id));
  return [
    ...currentTracks,
    ...incomingTracks.filter((track) => !existingIds.has(track.id)),
  ];
}

export function useMusicLibrary(): MusicLibrary {
  const [localTracks, setLocalTracks] = useState<Track[]>([]);
  const [serverTracks, setServerTracks] = useState<Track[]>(
    loadCachedServerTracks,
  );
  const [isLocalLoading, setIsLocalLoading] = useState(true);
  const [isServerLoading, setIsServerLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isAddingAlbum, setIsAddingAlbum] = useState(false);
  const [addAlbumError, setAddAlbumError] = useState<string | null>(null);
  const tracks = useMemo(
    () => [...serverTracks, ...localTracks],
    [localTracks, serverTracks],
  );
  const isLoading = isLocalLoading && isServerLoading;

  useEffect(() => {
    saveCachedServerTracks(serverTracks);
  }, [serverTracks]);

  useEffect(() => {
    let cancelled = false;

    const loadLocalTracks = async () => {
      if (!isTauri()) return [];

      try {
        const cachedTracks = await invoke<ScannedTrack[]>("load_cached_music");
        if (!cancelled && cachedTracks.length > 0) {
          setLocalTracks(cachedTracks.map(localTrack));
        }
      } catch (reason) {
        console.warn("Could not load cached local library:", reason);
      }

      return invoke<ScannedTrack[]>("scan_music");
    };

    void loadLocalTracks()
      .then((loadedTracks) => {
        if (!cancelled) setLocalTracks(loadedTracks.map(localTrack));
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(String(reason));
      })
      .finally(() => {
        if (!cancelled) setIsLocalLoading(false);
      });

    void loadServerTracks()
      .then((loadedTracks) => {
        if (!cancelled) {
          setServerTracks((currentTracks) =>
            appendUniqueTracks(currentTracks, loadedTracks),
          );
        }
      })
      .catch((reason: unknown) => {
        console.warn("Could not load streaming providers:", reason);
      })
      .finally(() => {
        if (!cancelled) setIsServerLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const addTidalAlbum = useCallback(async (url: string) => {
    setIsAddingAlbum(true);
    setAddAlbumError(null);

    try {
      const albumTracks = await addServerTidalAlbum(url);
      setServerTracks((currentTracks) =>
        moveAlbumToEndInOrder(currentTracks, albumTracks),
      );
      return true;
    } catch (reason) {
      setAddAlbumError(String(reason));
      return false;
    } finally {
      setIsAddingAlbum(false);
    }
  }, []);

  return {
    tracks,
    isLoading,
    error,
    isAddingAlbum,
    addAlbumError,
    addTidalAlbum,
  };
}
