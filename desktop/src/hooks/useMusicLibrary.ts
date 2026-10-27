import { convertFileSrc, invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { setPersistentItem } from "../utils/persistentStorage";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isTrackAvailable } from "./useServiceAvailability";
import { whiteArtwork } from "../utils/artworkPlaceholder";
import { mark } from "../utils/perf";
import { localCoverSources } from "../utils/localArtwork";
import { reconcileServerLibrary, reconcileTracks } from "../utils/trackReconcile";
import type {
  GlobalTrackId,
  LibraryTrack,
  ScannedTrack,
  Track,
} from "../types/music";
import {
  addServerAlbum,
  addServerTrack,
  loadServerLibrary,
  removeServerTracks,
  type SearchProvider,
} from "../api/server";
import {
  loadCachedServerTracks,
  loadRemovedLibraryTrackIds,
  loadStreamingCache,
  saveCachedServerTracks,
  saveRemovedLibraryTrackIds,
} from "../utils/libraryCache";
import { moveAlbumToEndInOrder } from "../utils/trackOrder";
import { appendLibraryOrder, loadLibraryOrder, orderLibraryTracks, reorderLibraryTracks } from "../utils/libraryOrder";
import { loadLocalMusic } from "../api/localMusic";

type MusicLibrary = {
  tracks: LibraryTrack[];
  catalogTracks: Track[];
  isLoading: boolean;
  isRestoring: boolean;
  isServerReachable: boolean;
  error: string | null;
  isAddingAlbum: boolean;
  addAlbumError: string | null;
  addAlbum: (url: string) => Promise<boolean>;
  addTrack: (
    provider: SearchProvider,
    providerTrackId: string,
  ) => Promise<boolean>;
  rescanLocalMusic: () => Promise<number>;
  refreshStreamingMusic: () => Promise<number>;
  removeTracks: (trackIds: GlobalTrackId[]) => void;
  reorderTracks: (orderedTrackIds: GlobalTrackId[]) => void;
};

const LOCAL_RESCAN_DELAY_MS = 1500;

function localTrack(track: ScannedTrack): Track {
  const { thumbnail: _thumbnail, ...scanned } = track;
  const { cover, fullCover } = localCoverSources(track, convertFileSrc, whiteArtwork);
  return {
    ...scanned,
    globalId: `local:${track.audio}`,
    provider: "local",
    providerTrackId: track.audio,
    playbackKind: "direct",
    audio: convertFileSrc(track.audio),
    cover,
    fullCover,
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

export function useMusicLibrary(localOnly: boolean, sharedPlayback = false): MusicLibrary {
  const [libraryOrder, setLibraryOrder] = useState(loadLibraryOrder);
  const savedLibraryOrder = useRef(libraryOrder);
  useEffect(() => {
    // The initial value came from storage; re-serializing it on mount is wasted work.
    if (savedLibraryOrder.current === libraryOrder) return;
    savedLibraryOrder.current = libraryOrder;
    try { setPersistentItem("ambra.library-order.v1", JSON.stringify(libraryOrder)); }
    catch (error) { console.warn("Could not save library ordering:", error); }
  }, [libraryOrder]);
  const [localTracks, setLocalTracks] = useState<Track[]>([]);
  const [sharedLocalTracks, setSharedLocalTracks] = useState<Track[]>([]);
  const [serverTracks, setServerTracks] = useState<Track[]>(
    () => localOnly ? [] : loadCachedServerTracks(),
  );
  const [removedTrackIds, setRemovedTrackIds] = useState(
    loadRemovedLibraryTrackIds,
  );
  const [isLocalLoading, setIsLocalLoading] = useState(true);
  const [isServerLoading, setIsServerLoading] = useState(!localOnly);
  const [isLocalCacheLoading, setIsLocalCacheLoading] = useState(true);
  const [isServerReachable, setIsServerReachable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isAddingAlbum, setIsAddingAlbum] = useState(false);
  const [addAlbumError, setAddAlbumError] = useState<string | null>(null);
  const catalogTracks = useMemo(() => [...(localOnly ? [] : [...serverTracks, ...sharedLocalTracks]), ...(sharedPlayback ? [] : localTracks)], [serverTracks, sharedLocalTracks, localTracks, localOnly, sharedPlayback]);
  const tracks = useMemo(
    () =>
      orderLibraryTracks(catalogTracks, libraryOrder)
        .filter((track) => !removedTrackIds.has(track.globalId))
        .map((track, index) => ({
          ...track,
          libraryId: index + 1,
        })),
    [catalogTracks, libraryOrder, removedTrackIds],
  );
  const isLoading = isLocalLoading && isServerLoading;

  // Only persist what changed since it was loaded. On a normal launch the cached
  // library is restored and confirmed unchanged, so nothing is re-serialized.
  const serverTracksRef = useRef(serverTracks);
  serverTracksRef.current = serverTracks;
  const savedServerTracks = useRef(serverTracks);
  useEffect(() => {
    if (savedServerTracks.current === serverTracks) return;
    savedServerTracks.current = serverTracks;
    saveCachedServerTracks(serverTracks);
  }, [serverTracks]);

  const savedRemovedTrackIds = useRef(removedTrackIds);
  useEffect(() => {
    if (savedRemovedTrackIds.current === removedTrackIds) return;
    savedRemovedTrackIds.current = removedTrackIds;
    saveRemovedLibraryTrackIds(removedTrackIds);
  }, [removedTrackIds]);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    // Show the cached streaming library immediately; the server sync below is
    // only a refresh. Ignored if the server (or a legacy copy) already answered.
    if (!localOnly) void loadStreamingCache()
      .then((cached) => {
        if (cancelled || cached.length === 0) return;
        setServerTracks((current) => {
          if (current.length > 0) return current;
          // Adopted as-is from storage, so the save effect must not rewrite it.
          savedServerTracks.current = cached;
          mark("streaming-cache-loaded");
          return cached;
        });
      })
      .catch((reason) => console.warn("Could not load the streaming library cache:", reason));

    // Thumbnails are generated in the background after a scan; pick them up as
    // they land without rescanning the disk.
    let stopListening: (() => void) | undefined;
    if (isTauri()) {
      void listen("local-library-updated", () => {
        void invoke<ScannedTrack[]>("load_cached_music")
          .then((updated) => {
            if (cancelled) return;
            setLocalTracks((current) =>
              reconcileTracks(current, updated.map(localTrack)),
            );
          })
          .catch(() => {});
      })
        .then((unlisten) => {
          if (cancelled) unlisten();
          else stopListening = unlisten;
        })
        .catch(() => {});
    }

    let hasCachedLibrary = false;
    const loadLocalTracks = async (): Promise<Track[] | null> => {
      try {
        if (!isTauri()) return [];
        const cachedTracks = await invoke<ScannedTrack[]>("load_cached_music");
        if (!cancelled && cachedTracks.length > 0) {
          setLocalTracks(cachedTracks.map(localTrack));
          setIsLocalLoading(false);
          hasCachedLibrary = true;
          mark("local-cache-loaded");
        }
      } catch (reason) {
        console.warn("Could not load cached local library:", reason);
      } finally {
        if (!cancelled) setIsLocalCacheLoading(false);
      }

      // With the cache on screen the rescan is only a background refresh, so let
      // startup, first interaction and provider sync finish before touching disk.
      if (hasCachedLibrary) await new Promise((resolve) => setTimeout(resolve, LOCAL_RESCAN_DELAY_MS));
      if (cancelled) return null;
      return (await invoke<ScannedTrack[]>("scan_music")).map(localTrack);
    };

    void loadLocalTracks()
      .then((loadedTracks) => {
        if (cancelled || loadedTracks === null) return;
        mark("local-scan-done");
        // An unchanged library keeps its array and track identities.
        setLocalTracks((current) =>
          reconcileTracks(current, loadedTracks),
        );
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(String(reason));
      })
      .finally(() => {
        if (!cancelled) setIsLocalLoading(false);
      });

    if (!localOnly) void loadServerLibrary(controller.signal)
      .then(({ tracks: loadedTracks, unavailableTrackIds }) => {
        if (!cancelled) {
          // A successful response is authoritative. Keeping cached tracks from
          // disconnected providers leaves playable-looking rows whose stream
          // endpoints can only return 503.
          setServerTracks((current) =>
            reconcileServerLibrary(current, loadedTracks, unavailableTrackIds),
          );
          setIsServerReachable(true);
          mark("server-synced");
        }
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setIsServerReachable(false);
          console.warn("Could not load streaming providers:", reason);
        }
      })
      .finally(() => {
        if (!cancelled) setIsServerLoading(false);
      });

    return () => {
      cancelled = true;
      controller.abort();
      stopListening?.();
    };
  }, [localOnly]);

  useEffect(() => {
    if (localOnly) return;
    let disposed = false;
    let refreshing = false;
    const controller = new AbortController();
    const refresh = async () => {
      if (refreshing) return;
      refreshing = true;
      try {
        const tracks = await loadLocalMusic(controller.signal);
        if (!disposed) setSharedLocalTracks(current => reconcileTracks(current, tracks));
      } catch { /* The device library stays available while the server is away. */ }
      finally { refreshing = false; }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => { disposed = true; controller.abort(); clearInterval(timer); };
  }, [localOnly]);

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
      setLibraryOrder(current => appendLibraryOrder(catalogTracks, current, moveAlbumToEndInOrder([], albumTracks).map(track => track.globalId)));
      return true;
    } catch (reason) {
      setAddAlbumError(String(reason));
      return false;
    } finally {
      setIsAddingAlbum(false);
    }
  }, [catalogTracks]);

  const addTrack = useCallback(
    async (provider: SearchProvider, providerTrackId: string) => {
      if (!isTrackAvailable(`${provider}:`)) return false;
      try {
        const [track] = await addServerTrack(provider, providerTrackId);
        if (!track) return false;
        const restoring = removedTrackIds.has(track.globalId);
        const alreadyKnown = catalogTracks.some(item => item.globalId === track.globalId);

        setRemovedTrackIds((currentTrackIds) => {
          if (!currentTrackIds.has(track.globalId)) return currentTrackIds;
          const nextTrackIds = new Set(currentTrackIds);
          nextTrackIds.delete(track.globalId);
          return nextTrackIds;
        });
        setServerTracks((currentTracks) =>
          restoring ? moveAlbumToEndInOrder(currentTracks, [track]) : appendUniqueTracks(currentTracks, [track]),
        );
        if (restoring || !alreadyKnown) {
          setLibraryOrder(current => appendLibraryOrder(catalogTracks, current, [track.globalId]));
        }
        return true;
      } catch (reason) {
        console.error("Could not add track to library:", reason);
        return false;
      }
    },
    [catalogTracks, removedTrackIds],
  );

  const removeTracks = useCallback((trackIds: GlobalTrackId[]) => {
    const idsToRemove = new Set(trackIds);
    if (idsToRemove.size === 0) return;

    // Presentation tombstones hide the rows immediately; the server forgets them so
    // its saved library stops growing and stops loading removed tracks.
    const streamingTracks = serverTracksRef.current.filter((track) => idsToRemove.has(track.globalId));
    if (streamingTracks.length > 0) {
      void removeServerTracks(streamingTracks).catch((reason) =>
        console.warn("Could not remove tracks from the streaming library:", reason),
      );
    }

    setRemovedTrackIds((currentTrackIds) => {
      if ([...idsToRemove].every((trackId) => currentTrackIds.has(trackId))) {
        return currentTrackIds;
      }

      const nextTrackIds = new Set(currentTrackIds);
      for (const trackId of idsToRemove) nextTrackIds.add(trackId);
      return nextTrackIds;
    });
  }, []);

  const rescanLocalMusic = useCallback(async () => {
    if (!isTauri()) return 0;
    setIsLocalLoading(true);
    setError(null);
    try {
      const loadedTracks = (await invoke<ScannedTrack[]>("scan_music")).map(localTrack);
      setLocalTracks((current) =>
        reconcileTracks(current, loadedTracks),
      );
      return loadedTracks.length;
    } catch (reason) {
      setError(String(reason));
      throw reason;
    } finally {
      setIsLocalLoading(false);
    }
  }, [localOnly]);

  const refreshStreamingMusic = useCallback(async () => {
    if (localOnly) return 0;
    try {
      const { tracks: loadedTracks, unavailableTrackIds } = await loadServerLibrary();
      setServerTracks((current) =>
        reconcileServerLibrary(current, loadedTracks, unavailableTrackIds),
      );
      setIsServerReachable(true);
      return loadedTracks.length;
    } catch (reason) {
      setIsServerReachable(false);
      throw reason;
    }
  }, [localOnly]);

  return {
    tracks,
    catalogTracks,
    isLoading,
    isRestoring: isLocalCacheLoading || (localTracks.length === 0 && isLocalLoading),
    isServerReachable: !localOnly && isServerReachable,
    error,
    isAddingAlbum,
    addAlbumError,
    addAlbum,
    addTrack,
    rescanLocalMusic,
    refreshStreamingMusic,
    removeTracks,
    reorderTracks: (orderedTrackIds: GlobalTrackId[]) => {
      setLibraryOrder((current) =>
        reorderLibraryTracks(current, orderedTrackIds),
      );
    },
  };
}
