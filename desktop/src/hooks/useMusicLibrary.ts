import { convertFileSrc, invoke, isTauri } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useState } from "react";
import fallbackCover from "../assets/images/fallbackCover.png";
import type {
  GlobalTrackId,
  LibraryTrack,
  ScannedTrack,
  Track,
} from "../types/music";
import {
  addServerAlbum,
  addServerTrack,
  loadServerTracks,
  type SearchProvider,
} from "../api/server";
import {
  loadCachedServerTracks,
  loadRemovedLibraryTrackIds,
  saveCachedServerTracks,
  saveRemovedLibraryTrackIds,
} from "../utils/libraryCache";
import { moveAlbumToEndInOrder } from "../utils/trackOrder";

type MusicLibrary = {
  tracks: LibraryTrack[];
  catalogTracks: Track[];
  isLoading: boolean;
  error: string | null;
  isAddingAlbum: boolean;
  addAlbumError: string | null;
  addAlbum: (url: string) => Promise<boolean>;
  addTrack: (
    provider: SearchProvider,
    providerTrackId: string,
  ) => Promise<boolean>;
  removeTracks: (trackIds: GlobalTrackId[]) => void;
};

function playableLocalCover(cover: string | null) {
  if (cover === null) return fallbackCover;
  return cover.startsWith("data:") ? cover : convertFileSrc(cover);
}

function localTrack(track: ScannedTrack): Track {
  return {
    ...track,
    globalId: `local:${track.audio}`,
    provider: "local",
    providerTrackId: track.audio,
    playbackKind: "direct",
    audio: convertFileSrc(track.audio),
    cover: playableLocalCover(track.cover),
    nativeCover: track.cover,
    version: null,
    albumId: null,
    albumVersion: null,
    albumArtists: [
      { providerId: track.artist, name: track.artist, imageUrl: null },
    ],
    artists: [
      { providerId: track.artist, name: track.artist, imageUrl: null },
    ],
    discNumber: null,
    releaseDate: null,
    explicit: false,
    isrc: null,
    copyright: null,
    label: null,
    genres: [],
    upc: null,
    quality: null,
    maximumSamplingRateKHz: null,
    maximumBitDepth: null,
  };
}

function appendUniqueTracks(currentTracks: Track[], incomingTracks: Track[]) {
  const existingIds = new Set(currentTracks.map((track) => track.globalId));
  return [
    ...currentTracks,
    ...incomingTracks.filter((track) => !existingIds.has(track.globalId)),
  ];
}

export function useMusicLibrary(): MusicLibrary {
  const [localTracks, setLocalTracks] = useState<Track[]>([]);
  const [serverTracks, setServerTracks] = useState<Track[]>(
    loadCachedServerTracks,
  );
  const [removedTrackIds, setRemovedTrackIds] = useState(
    loadRemovedLibraryTrackIds,
  );
  const [isLocalLoading, setIsLocalLoading] = useState(true);
  const [isServerLoading, setIsServerLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isAddingAlbum, setIsAddingAlbum] = useState(false);
  const [addAlbumError, setAddAlbumError] = useState<string | null>(null);
  const catalogTracks = useMemo(() => [...serverTracks, ...localTracks], [serverTracks, localTracks]);
  const tracks = useMemo(
    () =>
      catalogTracks
        .filter((track) => !removedTrackIds.has(track.globalId))
        .map((track, index) => ({
          ...track,
          libraryId: index + 1,
        })),
    [catalogTracks, removedTrackIds],
  );
  const isLoading = isLocalLoading && isServerLoading;

  useEffect(() => {
    saveCachedServerTracks(serverTracks);
  }, [serverTracks]);

  useEffect(() => {
    saveRemovedLibraryTrackIds(removedTrackIds);
  }, [removedTrackIds]);

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

  const addAlbum = useCallback(async (url: string) => {
    setIsAddingAlbum(true);
    setAddAlbumError(null);

    try {
      const albumTracks = await addServerAlbum(url);
      const albumTrackIds = new Set(
        albumTracks.map((track) => track.globalId),
      );
      setRemovedTrackIds((currentTrackIds) => {
        if (![...albumTrackIds].some((trackId) => currentTrackIds.has(trackId))) {
          return currentTrackIds;
        }

        return new Set(
          [...currentTrackIds].filter((trackId) => !albumTrackIds.has(trackId)),
        );
      });
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

  const addTrack = useCallback(
    async (provider: SearchProvider, providerTrackId: string) => {
      try {
        const [track] = await addServerTrack(provider, providerTrackId);
        if (!track) return false;

        setRemovedTrackIds((currentTrackIds) => {
          if (!currentTrackIds.has(track.globalId)) return currentTrackIds;
          const nextTrackIds = new Set(currentTrackIds);
          nextTrackIds.delete(track.globalId);
          return nextTrackIds;
        });
        setServerTracks((currentTracks) =>
          appendUniqueTracks(currentTracks, [track]),
        );
        return true;
      } catch (reason) {
        console.error("Could not add track to library:", reason);
        return false;
      }
    },
    [],
  );

  const removeTracks = useCallback((trackIds: GlobalTrackId[]) => {
    const idsToRemove = new Set(trackIds);
    if (idsToRemove.size === 0) return;

    setRemovedTrackIds((currentTrackIds) => {
      if ([...idsToRemove].every((trackId) => currentTrackIds.has(trackId))) {
        return currentTrackIds;
      }

      const nextTrackIds = new Set(currentTrackIds);
      for (const trackId of idsToRemove) nextTrackIds.add(trackId);
      return nextTrackIds;
    });
  }, []);

  return {
    tracks,
    catalogTracks,
    isLoading,
    error,
    isAddingAlbum,
    addAlbumError,
    addAlbum,
    addTrack,
    removeTracks,
  };
}
