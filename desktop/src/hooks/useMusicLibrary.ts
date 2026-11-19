import { getServerConnection, subscribeServerConnection, serverUrl, serverConnectionSignal } from "../api/serverConnection";
import { convertFileSrc, invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { setPersistentItem } from "../utils/persistentStorage";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { isTrackAvailable, setServiceEventsAvailable, updateServiceAvailability } from "./useServiceAvailability";
import { followLibraryEvents, type LibraryVersions } from "../api/libraryEvents";
import { whiteArtwork } from "../utils/artworkPlaceholder";
import { mark } from "../utils/perf";
import { localCoverSources } from "../utils/localArtwork";
import { applyServerLibraryDelta, reconcileServerLibrary, reconcileTracks } from "../utils/trackReconcile";
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
  loadCachedServerLibrary,
  type CachedServerLibrary,
  loadRemovedLibraryTrackIds,
  loadStreamingCache,
  saveCachedServerLibrary,
  saveRemovedLibraryTrackIds,
} from "../utils/libraryCache";
import { moveAlbumToEndInOrder } from "../utils/trackOrder";
import { appendLibraryOrder, loadLibraryOrder, orderLibraryTracks, reorderLibraryTracks } from "../utils/libraryOrder";
import { loadLocalMusic, localMusicSnapshot, localMusicTrack, mergeLocalMusic } from "../api/localMusic";
import { offlineTrack, useLocalDownloads } from "../utils/offlineDownloads";

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
  /** Adds dropped audio files or folders to the library; resolves to how many songs were added. */
  importFiles: (paths: string[]) => Promise<number>;
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
  const connection = useSyncExternalStore(subscribeServerConnection, getServerConnection);
  const serverKey = `${connection?.server?.publicKey ?? ""}:${serverUrl("/api/library")}`;
  const cachedServerLibrary = useRef<{ key: string; library: CachedServerLibrary } | null>(null);
  const refreshServer = useRef<() => Promise<number>>(async () => 0);
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
  const [sharedLocalTracks, setSharedLocalTracks] = useState<Track[]>(
    () => localOnly ? [] : localMusicSnapshot()?.tracks ?? [],
  );
  const [serverTracks, setServerTracks] = useState<Track[]>(
    () => {
      const library = localOnly ? { tracks: [] } : loadCachedServerLibrary();
      cachedServerLibrary.current = { key: serverKey, library };
      return library.tracks;
    },
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
  const downloaded = useLocalDownloads();
  const offlineDownloads = !sharedPlayback && (localOnly || !isServerReachable) && downloaded.size ? downloaded : null;
  const catalogTracks = useMemo(() => {
    const catalog = localOnly && !sharedPlayback ? localTracks
      : [...(localOnly ? [] : serverTracks), ...(localOnly ? [] : sharedLocalTracks), ...(sharedPlayback ? [] : localTracks)];
    // Without a server, songs downloaded to this device are still there to play.
    if (!offlineDownloads) return catalog;
    const known = new Set(catalog.map(track => track.globalId));
    return [...catalog, ...[...offlineDownloads.values()].filter(entry => !known.has(entry.id)).map(offlineTrack)];
  }, [serverTracks, sharedLocalTracks, localTracks, localOnly, sharedPlayback, offlineDownloads]);
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

  const serverTracksRef = useRef(serverTracks);
  serverTracksRef.current = serverTracks;

  const savedRemovedTrackIds = useRef(removedTrackIds);
  useEffect(() => {
    if (savedRemovedTrackIds.current === removedTrackIds) return;
    savedRemovedTrackIds.current = removedTrackIds;
    saveRemovedLibraryTrackIds(removedTrackIds);
  }, [removedTrackIds]);

  useEffect(() => {
    let cancelled = false;
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

    return () => {
      cancelled = true;
      stopListening?.();
    };
  }, []);

  useEffect(() => {
    if (localOnly) return;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, serverConnectionSignal()]);
    const remembered = cachedServerLibrary.current;
    let snapshot = remembered && remembered.key === serverKey ? remembered.library : loadCachedServerLibrary();
    setServerTracks(snapshot.tracks);
    setSharedLocalTracks(localMusicSnapshot()?.tracks ?? []);
    setIsServerReachable(false);
    setIsServerLoading(true);
    const ready = snapshot.cursor ? Promise.resolve() : loadStreamingCache().then(cached => {
      if (signal.aborted || snapshot.cursor || snapshot.tracks.length) return;
      if (cached.cursor || cached.tracks.length) {
        snapshot = cached;
        cachedServerLibrary.current = { key: serverKey, library: snapshot };
        setServerTracks(cached.tracks);
        mark("streaming-cache-loaded");
      }
    }).catch(reason => console.warn("Could not load the streaming library cache:", reason));

    let versions: LibraryVersions | undefined;
    let legacy = false;
    let streaming: Promise<number> | undefined;
    let local: Promise<void> | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let poll: ReturnType<typeof setInterval> | undefined;

    const retryChanges = () => {
      if (retry || signal.aborted || !versions) return;
      retry = setTimeout(() => {
        retry = undefined;
        void syncStreaming().catch(() => {});
        void syncLocal();
      }, 3000);
    };

    const syncStreaming = (refresh = false): Promise<number> => {
      if (streaming) return streaming;
      if (signal.aborted || (!legacy && !versions?.services)) return Promise.resolve(snapshot.tracks.length);
      const wanted = versions?.streaming;
      streaming = (async () => {
        await ready;
        signal.throwIfAborted();
        const takeSnapshot = refresh && snapshot.retry;
        if (!legacy && wanted === snapshot.cursor && !takeSnapshot) {
          setIsServerReachable(true);
          return snapshot.tracks.length;
        }
        const result = await loadServerLibrary(signal, legacy ? undefined : takeSnapshot ? "" : snapshot.cursor ?? "");
        signal.throwIfAborted();
        const apply = (current: Track[]) => result.cursor && !result.reset
          ? applyServerLibraryDelta(current, result.tracks, result.removedTrackIds ?? [], result.updatedTrackIds)
          : reconcileServerLibrary(current, result.tracks, result.unavailableTrackIds);
        const previous = snapshot.tracks;
        const tracks = apply(previous);
        // A lookup failure remains retryable on the next reconnect or explicit refresh.
        const retry = Boolean(result.retry || (result.cursor && !result.reset && snapshot.retry));
        const cursor = result.cursor;
        const changed = tracks !== snapshot.tracks || retry !== Boolean(snapshot.retry);
        if (changed || cursor !== snapshot.cursor) {
          const save = changed || !snapshot.cursor;
          snapshot = { tracks, cursor, retry };
          cachedServerLibrary.current = { key: serverKey, library: snapshot };
          if (save) saveCachedServerLibrary(snapshot);
          setServerTracks(current => current === previous ? tracks : apply(current));
        }
        setIsServerReachable(true);
        mark("server-synced");
        return tracks.length;
      })().catch(reason => {
        if (!signal.aborted) {
          setIsServerReachable(false);
          retryChanges();
        }
        throw reason;
      }).finally(() => {
        streaming = undefined;
        if (signal.aborted) return;
        setIsServerLoading(false);
        // A notification may arrive while the request is still being resolved.
        if (versions?.streaming !== wanted) void syncStreaming().catch(() => {});
      });
      return streaming;
    };

    const syncLocal = () => {
      if (local || signal.aborted || (!legacy && !versions)) return;
      const wanted = versions?.local;
      if (!legacy && wanted === localMusicSnapshot()?.tag) return;
      local = loadLocalMusic(signal, !legacy).then(({ tracks }) => {
        if (!signal.aborted) setSharedLocalTracks(tracks);
      }).catch(retryChanges).finally(() => {
        local = undefined;
        if (versions?.local !== wanted) syncLocal();
      });
    };

    refreshServer.current = () => syncStreaming(true);
    const onOnline = () => {
      if (legacy) {
        void syncStreaming().catch(() => {});
        void syncLocal();
      }
    };
    window.addEventListener("online", onOnline);
    followLibraryEvents(signal, next => {
      setServiceEventsAvailable(true);
      if (next.services) updateServiceAvailability(next.services);
      const reconnected = !versions?.services;
      versions = next;
      void syncStreaming(reconnected).catch(() => {});
      syncLocal();
    }, () => {
      versions = undefined;
      setIsServerReachable(false);
      setIsServerLoading(false);
    }, () => {
      legacy = true;
      setServiceEventsAvailable(false);
      void syncStreaming().catch(() => {});
      syncLocal();
      poll = setInterval(syncLocal, 5000);
    });
    return () => {
      controller.abort();
      clearTimeout(retry);
      clearInterval(poll);
      window.removeEventListener("online", onOnline);
      refreshServer.current = async () => 0;
      setServiceEventsAvailable(false);
    };
  }, [localOnly, serverKey, connection]);

  const addAlbum = useCallback(async (url: string) => {
    setIsAddingAlbum(true);
    setAddAlbumError(null);

    const signal = serverConnectionSignal();
    try {
      const albumTracks = await addServerAlbum(url);
      signal.throwIfAborted();
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
      const signal = serverConnectionSignal();
      try {
        const [track] = await addServerTrack(provider, providerTrackId);
        signal.throwIfAborted();
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
  }, [localOnly, serverKey]);

  const importFiles = useCallback(async (paths: string[]) => {
    if (!isTauri()) throw new Error("Add music from the desktop app.");
    // Shared playback lists only the server's music, so dropped songs are copied there too.
    const upload = !localOnly && sharedPlayback;
    const signal = serverConnectionSignal();
    const result = await invoke<{ tracks: ScannedTrack[]; imported: number; server: Track[] | null }>(
      "import_dropped_music", { paths, upload },
    );
    setLocalTracks((current) => reconcileTracks(current, result.tracks.map(localTrack)));
    if (result.server && !signal.aborted) {
      const shared = result.server.map(localMusicTrack);
      setSharedLocalTracks(current => reconcileTracks(current, mergeLocalMusic(current, shared)));
    }
    return result.imported;
  }, [localOnly, sharedPlayback]);

  const refreshStreamingMusic = useCallback(() => refreshServer.current(), []);

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
    importFiles,
    refreshStreamingMusic,
    removeTracks,
    reorderTracks: (orderedTrackIds: GlobalTrackId[]) => {
      setLibraryOrder((current) =>
        reorderLibraryTracks(current, orderedTrackIds),
      );
    },
  };
}
