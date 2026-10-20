import "./App.css";
import "./components/EntityView.css";
import { EntityView, type EntityPage, type EntityAction } from "./components/EntityView";
import { entityKey, type BrowseEntity } from "./utils/browse";

//Components
import { AppChrome } from "./components/AppChrome";
import { LibraryView, type LibrarySection } from "./components/LibraryView";
import { HomeView } from "./components/HomeView";
import { Sidebar } from "./components/Sidebar";
import { Queue } from "./components/Queue";
import { AppScrollbar } from "./components/AppScrollbar";
import { AlbumArtwork, BackgroundArtwork } from "./components/BigscreenArtwork";
import { NowPlayingBar } from "./components/NowPlayingBar";
import { LYRICS_COVER_DIM, LyricsView } from "./components/LyricsView";
import { SearchBar, type SearchFocusRequest } from "./components/SearchBar";
import { SearchView } from "./components/SearchView";
import { PlaylistView } from "./components/PlaylistView";
import { SettingsView } from "./components/SettingsView";
import { SettingsSidebar, type SettingsTab } from "./components/SettingsSidebar";

import { useAudioPlayer } from "./hooks/useAudioPlayer";
import { useMusicLibrary } from "./hooks/useMusicLibrary";
import { useListeningHistory } from "./hooks/useListeningHistory";
import { useStartupWindow } from "./hooks/useStartupWindow";
import { useAudioSettings } from "./hooks/AudioSettingsContext";
import { useStaleTrackRefresh } from "./hooks/useStaleTrackRefresh";
import { useTrackSearch } from "./hooks/useTrackSearch";
import { queueEntryForTrack, useQueue } from "./hooks/useQueue";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useStableCallback } from "./hooks/useStableCallback";
import { useLyricsAvailability } from "./hooks/useLyricsAvailability";
import {
  loadPreferences,
  savePlayback,
  savePreferences,
  type AppScreen,
} from "./utils/preferences";
import type { GlobalTrackId, Track } from "./types/music";
import { configuredSearchProviders, resolveTrackPlayback, type SearchProvider, type StreamingProvider } from "./api/server";
import {
  collectionQueueContext,
  libraryQueueContext,
  searchQueueContext,
} from "./utils/queueModel";
import { isSearchShortcut, isUnmodifiedKey } from "./utils/keyboard";
import { cachePlaylistArtwork } from "./utils/playlistArtworkCache";
import { preloadUpcomingBigscreenArtwork } from "./utils/artworkImages";
import { preloadLyrics } from "./utils/lyricsCache";
import { prepareLyricSync } from "./utils/lyricsOffset";

import { playlistTracks } from "./utils/playlists";
import {
  sortCollectionTracks,
  type TrackSort,
} from "./utils/trackCollectionOrder";

import { usePlaylists } from "./hooks/usePlaylists";
import { useServicePlaylists } from "./hooks/useServicePlaylists";

function App({ localOnly }: { localOnly: boolean }) {
  const [preferences, setPreferences] = useState(() => {
    const saved = loadPreferences();
    return localOnly ? { ...saved, ui: { ...saved.ui, screen: "library" as const } } : saved;
  });
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("outputs");
  const playlistStore = usePlaylists();
  const listeningHistory = useListeningHistory();
  const [browseEntity, setBrowseEntity] = useState<BrowseEntity | null>(null);
  const browseCache = useRef(new Map<string, EntityPage>());
  const [browseTracks, setBrowseTracks] = useState<Track[]>([]);
  const navigation = useRef<Array<{ entity: BrowseEntity | null; screen: AppScreen; playlistId: string | null; section: LibrarySection }>>([]);
  const rememberTracks = useCallback((tracks: Track[]) => setBrowseTracks(current => {
    const known = new Map(current.map(track => [track.globalId, track]));
    // Keep the same array when nothing changed so App and its memos don't rerun.
    if (tracks.every(track => known.get(track.globalId) === track)) return current;
    for (const track of tracks) known.set(track.globalId, track);
    return [...known.values()];
  }), []);
  const [selectedPlaylistId, setSelectedPlaylistId] = useState<string | null>(
    null,
  );
  const servicePlaylistStore = useServicePlaylists(selectedPlaylistId, !localOnly, preferences.ui.screen === "home");
  const playlists = useMemo(() => [...playlistStore.playlists, ...servicePlaylistStore.playlists], [playlistStore.playlists, servicePlaylistStore.playlists]);
  const [librarySection, setLibrarySection] =
    useState<LibrarySection>(localOnly ? "tracks" : "overview");
  const [collectionSorts, setCollectionSorts] = useState<
    Record<string, TrackSort>
  >({});
  const searchQuery = preferences.search.query;
  const [searchProviders, setSearchProviders] = useState<StreamingProvider[]>([]);
  const searchProvidersRequest = useRef(0);
  const searchProvider: SearchProvider = preferences.search.provider !== "all" && searchProviders.includes(preferences.search.provider)
    ? preferences.search.provider
    : "all";
  const refreshSearchProviders = useCallback(() => {
    if (localOnly) return;
    const request = ++searchProvidersRequest.current;
    void configuredSearchProviders().then((providers) => {
      if (request !== searchProvidersRequest.current) return;
      setSearchProviders(providers);
      setPreferences((current) => current.search.provider !== "all" && !providers.includes(current.search.provider)
        ? { ...current, search: { ...current.search, provider: "all" } }
        : current);
    }).catch(() => {
      if (request === searchProvidersRequest.current) setSearchProviders([]);
    });
  }, [localOnly]);
  useEffect(() => {
    if (localOnly) return;
    refreshSearchProviders();
    window.addEventListener("focus", refreshSearchProviders);
    window.addEventListener("online", refreshSearchProviders);
    return () => {
      searchProvidersRequest.current++;
      window.removeEventListener("focus", refreshSearchProviders);
      window.removeEventListener("online", refreshSearchProviders);
    };
  }, [refreshSearchProviders, localOnly]);
  const library = useMusicLibrary(localOnly);
  const search = useTrackSearch(localOnly ? "" : searchQuery, searchProvider);
  const availableTracks = useMemo(() => {
    const tracksById = new Map<string, Track>(
      [...listeningHistory.tracks, ...browseTracks, ...playlistStore.tracks, ...servicePlaylistStore.tracks, ...library.catalogTracks].map((track) => [track.globalId, track]),
    );
    for (const track of search.knownTracks) {
      tracksById.set(track.globalId, track);
    }
    return [...tracksById.values()];
  }, [listeningHistory.tracks, browseTracks, playlistStore.tracks, servicePlaylistStore.tracks, library.catalogTracks, search.knownTracks]);
  const queueContext = useMemo(
    () => libraryQueueContext(library.tracks),
    [library.tracks],
  );
  const queue = useQueue(availableTracks, preferences.playback.trackId, !library.isRestoring);
  const playbackTracks = useMemo(() => {
    const tracksById = new Map(
      availableTracks.map((track) => [track.globalId, track]),
    );
    for (const entry of [...queue.historyEntries, ...queue.entries]) {
      tracksById.set(entry.track.globalId, entry.track);
    }
    return [...tracksById.values()];
  }, [availableTracks, queue.entries, queue.historyEntries]);
  // Which way the queue last moved, so the player cover slides in from that side.
  const skipDirectionRef = useRef({ direction: 1, at: 0 });
  const skipDirection = useCallback(() =>
    performance.now() - skipDirectionRef.current.at < 3000 ? skipDirectionRef.current.direction : 1, []);
  const player = useAudioPlayer(playbackTracks, preferences.playback, {
    next: () => { skipDirectionRef.current = { direction: 1, at: performance.now() }; return queue.next()?.track; },
    completeCurrent: () => { skipDirectionRef.current = { direction: 1, at: performance.now() }; return queue.completeCurrent()?.track; },
    previous: () => { skipDirectionRef.current = { direction: -1, at: performance.now() }; return queue.previous()?.track; },
    peekNext: () => queue.peekNext()?.track,
    nextTrack: queue.upcomingEntries[0]?.track,
  }, listeningHistory.recordPlay);
  useStaleTrackRefresh(
    playlistStore.tracks,
    library.isServerReachable,
    playlistStore.updateTrack,
  );

  useEffect(() => {
    void cachePlaylistArtwork(playlistStore.tracks);
  }, [playlistStore.tracks]);

  useEffect(() => {
    void preloadUpcomingBigscreenArtwork(
      queue.upcomingEntries.map((entry) => entry.track),
    );
  }, [queue.upcomingEntries]);

  useEffect(() => {
    if (localOnly) return;
    const tracks = queue.upcomingEntries.slice(0, 2).map((entry) => entry.track);
    if (player.currentTrack) tracks.unshift(player.currentTrack);
    void preloadLyrics(tracks);
    if (preferences.ui.autoSyncLyrics && isTauri()) void prepareLyricSync(tracks);
  }, [player.currentTrack, queue.upcomingEntries, localOnly, preferences.ui.autoSyncLyrics]);

  useEffect(() => {
    if (localOnly || library.isServerReachable || library.isLoading) return;

    const retryStreamingMusic = () => {
      void library.refreshStreamingMusic().catch(() => {});
    };
    window.addEventListener("online", retryStreamingMusic);
    const handleVisibility = () => {
      if (!document.hidden) retryStreamingMusic();
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      window.removeEventListener("online", retryStreamingMusic);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [localOnly, library.isLoading, library.isServerReachable, library.refreshStreamingMusic]);
  const screen = preferences.ui.screen;
  const isBigscreen = screen === "bigscreen";
  const isLyricsView = screen === "lyrics";
  const isPlayerView = isBigscreen || isLyricsView;
  // Lyrics are the chosen view, but a song without any shows its cover until one with lyrics comes back.
  const prefersLyrics = isPlayerView ? isLyricsView : preferences.ui.playerView === "lyrics";
  const lyricsAvailability = useLyricsAvailability(player.currentTrack, prefersLyrics);
  // While a song's lyrics are still being looked up, the layout holds where it was.
  const showLyricsRef = useRef(false);
  if (!prefersLyrics) showLyricsRef.current = false;
  else if (lyricsAvailability !== "pending") showLyricsRef.current = lyricsAvailability === "lyrics";
  const showLyrics = showLyricsRef.current;
  // The lyrics on screen; when a song has none they stay to fade out rather than vanish.
  const lyricsTrackRef = useRef(player.currentTrack);
  if (showLyrics) lyricsTrackRef.current = player.currentTrack;
  const lyricsTrack = lyricsTrackRef.current;
  // When one song's lyrics replace another's, the old view stays a moment to drift out.
  const lyricsHandoff = useRef<{ track: typeof lyricsTrack; leaving: NonNullable<typeof lyricsTrack>[] }>({ track: lyricsTrack, leaving: [] });
  // Opening the player shows its lyrics at once; switching between them and the cover fades (LyricsView.css).
  const [lyricsShown, setLyricsShown] = useState(showLyrics && isPlayerView);
  const playerWasOpen = useRef(isPlayerView);
  if (lyricsShown && !(showLyrics && isPlayerView)) setLyricsShown(false);
  else if (!lyricsShown && showLyrics && isPlayerView && !playerWasOpen.current) setLyricsShown(true);
  useEffect(() => {
    playerWasOpen.current = isPlayerView;
    if (lyricsShown || !showLyrics || !isPlayerView) return;
    // Paint the hidden state once first, so lyrics switched to fade in from behind the cover.
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => setLyricsShown(true));
    });
    return () => cancelAnimationFrame(frame);
  }, [isPlayerView, showLyrics, lyricsShown]);
  if (lyricsTrack?.globalId !== lyricsHandoff.current.track?.globalId) {
    const previous = lyricsHandoff.current.track;
    const leaving = lyricsHandoff.current.leaving.filter((track) => track.globalId !== lyricsTrack?.globalId);
    lyricsHandoff.current = {
      track: lyricsTrack,
      leaving: previous && lyricsShown && isPlayerView ? [...leaving, previous].slice(-2) : leaving,
    };
  }
  const leavingLyrics = lyricsHandoff.current.leaving;
  const [, settleLyricsHandoff] = useState(0);
  useEffect(() => {
    if (!leavingLyrics.length) return;
    const timer = setTimeout(() => {
      lyricsHandoff.current = { ...lyricsHandoff.current, leaving: [] };
      settleLyricsHandoff((value) => value + 1);
      // Outlasts the arriving lyrics' rise, so ending the handoff never cuts it short.
    }, 900);
    return () => clearTimeout(timer);
  }, [leavingLyrics]);
  const [isFullscreen, setIsFullscreen] = useState<boolean | null>(null);
  const audioSettings = useAudioSettings();
  useStartupWindow(!library.isRestoring && !audioSettings?.loading && isFullscreen !== null);
  const f11FullscreenRef = useRef(false);
  const queueReturnScreenRef = useRef<Exclude<AppScreen, "bigscreen" | "lyrics" | "queue">>(
    screen === "home" || screen === "search" || screen === "settings" ? screen : "library",
  );
  const playerReturnScreenRef =
    useRef<Exclude<AppScreen, "bigscreen" | "lyrics">>("library");
  if (screen !== "bigscreen" && screen !== "lyrics") playerReturnScreenRef.current = screen;
  // While the player is open, the screen hidden behind it keeps what it showed.
  const libraryScreen = isPlayerView ? playerReturnScreenRef.current : screen;
  const isQueueView = libraryScreen === "queue";
  const isSettingsView = libraryScreen === "settings";
  const isHomeView = libraryScreen === "home" && !browseEntity;
  const isSearchView = libraryScreen === "search" && !browseEntity;
  if (screen === "home" || screen === "library" || screen === "search" || screen === "settings") {
    queueReturnScreenRef.current = screen;
  }
  const latestSessionRef = useRef({ preferences, player });
  latestSessionRef.current = { preferences, player };
  const [activeScrollElement, setActiveScrollElement] =
    useState<HTMLDivElement | null>(null);
  const scrollPositionsRef = useRef(new Map<string, number>());
  const registeredScrollElementRef = useRef<HTMLDivElement | null>(null);
  const restoreScrollFrameRef = useRef<number | null>(null);

  function createPlaylist(name: string) {
    return playlistStore.create(name);
  }

  const addTrackToPlaylist = useStableCallback(async (playlistId: string, trackId: string) => {
    const track = availableTracks.find(track => track.globalId === trackId);
    if (playlists.find(playlist => playlist.id === playlistId)?.provider)
      return track ? servicePlaylistStore.addTrack(playlistId, track) : false;
    return track ? playlistStore.addTrack(playlistId, await resolveTrackPlayback(track, AbortSignal.timeout(8000))) : false;
  });
  const createPlaylistWithTrack = useStableCallback(async (name: string, trackId: string) => {
    const track = availableTracks.find(track => track.globalId === trackId);
    return track ? Boolean(playlistStore.create(name, await resolveTrackPlayback(track, AbortSignal.timeout(8000)))) : false;
  });
  // Stable so playback-clock renders don't invalidate memoized track views.
  const playlistOptions = useMemo(
    () => ({ playlists: playlists.filter(playlist => playlist.editable !== false), onAdd: addTrackToPlaylist, onCreate: createPlaylistWithTrack }),
    [playlists, addTrackToPlaylist, createPlaylistWithTrack],
  );

  const selectedPlaylist = playlists.find((playlist) => {
    return playlist.id === selectedPlaylistId;
  });
  const servicePlaylistError = servicePlaylistStore.error
    ?? (selectedPlaylist ? servicePlaylistStore.errors[selectedPlaylist.id] : null);
  const activeViewKey = isQueueView
    ? "queue"
    : isSettingsView
      ? "settings"
    : browseEntity
      ? entityKey(browseEntity)
    : isSearchView
      ? "search"
    : isHomeView
      ? "home"
      : selectedPlaylist
        ? `playlist:${selectedPlaylist.id}`
        : `library:${librarySection}`;
  const registerScrollElement = useCallback(
    (element: HTMLDivElement | null) => {
      if (restoreScrollFrameRef.current !== null) {
        cancelAnimationFrame(restoreScrollFrameRef.current);
        restoreScrollFrameRef.current = null;
      }

      if (element === null) {
        const registeredElement = registeredScrollElementRef.current;
        if (registeredElement) {
          scrollPositionsRef.current.set(
            activeViewKey,
            registeredElement.scrollTop,
          );
          registeredScrollElementRef.current = null;
        }
        setActiveScrollElement(null);
        return;
      }

      registeredScrollElementRef.current = element;
      const savedPosition = scrollPositionsRef.current.get(activeViewKey) ?? 0;
      element.scrollTop = savedPosition;
      setActiveScrollElement(element);
      restoreScrollFrameRef.current = requestAnimationFrame(() => {
        if (registeredScrollElementRef.current === element) {
          element.scrollTop = savedPosition;
        }
        restoreScrollFrameRef.current = null;
      });
    },
    [activeViewKey],
  );
  const collectionSortKey = selectedPlaylist
    ? `playlist:${selectedPlaylist.id}`
    : "library:tracks";
  const collectionSort = collectionSorts[collectionSortKey] ?? null;
  const baseCollectionTracks = selectedPlaylist
    ? playlistTracks(selectedPlaylist, availableTracks)
    : library.tracks;
  const collectionTracks = useMemo(
    () => sortCollectionTracks(baseCollectionTracks, collectionSort),
    [baseCollectionTracks, collectionSort],
  );
  const activeCollectionContext = selectedPlaylist
    ? collectionQueueContext(collectionTracks, {
        kind: "playlist",
        id: selectedPlaylist.id,
      })
    : libraryQueueContext(
        sortCollectionTracks(library.tracks, collectionSort),
      );

  const removeFromCollection = (trackIds: GlobalTrackId[]) => {
    if (selectedPlaylist) {
      if (selectedPlaylist.provider) void servicePlaylistStore.removeTracks(selectedPlaylist.id, trackIds).catch(() => {});
      else playlistStore.removeTracks(selectedPlaylist.id, trackIds);
    } else {
      library.removeTracks(trackIds);
    }
  };

  const changeCollectionSort = (sort: TrackSort) => {
    setCollectionSorts((current) => ({
      ...current,
      [collectionSortKey]: sort,
    }));
  };

  const reorderCollectionTracks = (orderedTrackIds: GlobalTrackId[]) => {
    if (selectedPlaylist) {
      if (selectedPlaylist.provider) return;
      if (!playlistStore.reorderTracks(selectedPlaylist.id, orderedTrackIds)) return;
    } else {
      library.reorderTracks(orderedTrackIds);
    }
    changeCollectionSort(null);
  };

  useEffect(() => {
    if (!isTauri()) {
      setIsFullscreen(false);
      return;
    }

    let disposed = false;
    let stopListening: (() => void) | undefined;
    const appWindow = getCurrentWindow();
    const syncFullscreen = async () => {
      try {
        const fullscreen = await appWindow.isFullscreen();
        if (!disposed) {
          f11FullscreenRef.current = fullscreen;
          setIsFullscreen(fullscreen);
        }
      } catch (error) {
        console.error("Could not read fullscreen state:", error);
        if (!disposed) setIsFullscreen(false);
      }
    };

    void syncFullscreen();
    void appWindow.onResized(syncFullscreen).then((unlisten) => {
      if (disposed) unlisten();
      else stopListening = unlisten;
    });

    return () => {
      disposed = true;
      stopListening?.();
    };
  }, []);

  useEffect(() => {
    document.documentElement.toggleAttribute(
      "data-window-fullscreen",
      isFullscreen === true,
    );

    return () => {
      document.documentElement.removeAttribute("data-window-fullscreen");
    };
  }, [isFullscreen]);

  useEffect(() => {
    const handleKeyDown = async (event: KeyboardEvent) => {
      if (!isUnmodifiedKey(event, "F11") || event.repeat) return;

      event.preventDefault();

      if (!isTauri()) {
        setIsFullscreen(false);
        return;
      }

      try {
        const appWindow = getCurrentWindow();
        const isFullscreen = await appWindow.isFullscreen();
        const nextFullscreen = !isFullscreen;
        await appWindow.setFullscreen(nextFullscreen);
        f11FullscreenRef.current = nextFullscreen;
        setIsFullscreen(nextFullscreen);
      } catch (error) {
        console.error("Could not toggle fullscreen:", error);
      }
    };

    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  useEffect(() => {
    const disableContextMenu = (event: MouseEvent) => {
      event.preventDefault();
    };

    const disableNativeDrag = (event: DragEvent) => {
      event.preventDefault();
    };

    const resetHorizontalScroll = () => {
      document.scrollingElement?.scrollTo({ left: 0 });
      for (const element of document.querySelectorAll<HTMLElement>(
        "#library, #search, #queue, .libraryView, .searchView, #queueList",
      )) {
        if (element.scrollLeft !== 0) element.scrollLeft = 0;
      }
    };

    const preventHorizontalScroll = () => resetHorizontalScroll();
    const keepDragVertical = (event: PointerEvent) => {
      if (event.buttons !== 0) resetHorizontalScroll();
    };

    window.addEventListener("contextmenu", disableContextMenu, true);
    window.addEventListener("dragstart", disableNativeDrag, true);
    window.addEventListener("scroll", preventHorizontalScroll, true);
    window.addEventListener("pointermove", keepDragVertical, true);
    return () => {
      window.removeEventListener("contextmenu", disableContextMenu, true);
      window.removeEventListener("dragstart", disableNativeDrag, true);
      window.removeEventListener("scroll", preventHorizontalScroll, true);
      window.removeEventListener("pointermove", keepDragVertical, true);
    };
  }, []);

  useEffect(() => {
    const handleKeyDown = async (event: KeyboardEvent) => {
      if (!isUnmodifiedKey(event, "Escape")) return;
      // Let search, menus, and playlist dialogs handle their own Escape.
      if (event.target instanceof Element && event.target.closest("#searchBar, #trackMenuBackdrop, [data-click-menu-backdrop], dialog[open]"))
        return;
      event.preventDefault();
      event.stopPropagation();

      if (event.repeat) return;
      if (browseEntity && screen !== "bigscreen" && screen !== "lyrics" && screen !== "queue") { goBack(); return; }
      leaveScreen();

      if (f11FullscreenRef.current && isTauri()) {
        try {
          const appWindow = getCurrentWindow();
          if (!(await appWindow.isFullscreen())) {
            await appWindow.setFullscreen(true);
          }
        } catch (error) {
          console.error("Could not preserve fullscreen:", error);
        }
        return;
      }
    };

    // The mouse's back button steps back the same way (WebView history would do nothing).
    const handleMouseBack = (event: MouseEvent) => {
      if (event.button !== 3 && event.button !== 4) return;
      event.preventDefault();
      if (event.type !== "mouseup" || event.button !== 3) return;
      if (browseEntity && screen !== "bigscreen" && screen !== "lyrics" && screen !== "queue") goBack();
      else if (screen !== "library") leaveScreen();
    };

    window.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("mousedown", handleMouseBack, true);
    window.addEventListener("mouseup", handleMouseBack, true);

    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("mousedown", handleMouseBack, true);
      window.removeEventListener("mouseup", handleMouseBack, true);
    };
  }, [browseEntity, screen]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!isUnmodifiedKey(event, "KeyF")) return;
      if (
        event.target instanceof Element &&
        event.target.closest("#searchBar")
      ) {
        return;
      }

      if (event.repeat) return;

      const toggleBigscreen = () => {
        setPreferences((current) => {
          if (current.ui.screen !== "bigscreen" && current.ui.screen !== "lyrics") {
            if (!latestSessionRef.current.player.currentTrack) return current;
            playerReturnScreenRef.current = current.ui.screen;
          }

          return {
            ...current,
            ui: {
              ...current.ui,
              screen:
                current.ui.screen === "bigscreen" || current.ui.screen === "lyrics"
                  ? playerReturnScreenRef.current
                  : current.ui.playerView,
            },
          };
        });
      };

      if (!isTauri()) {
        event.preventDefault();
        event.stopPropagation();
        toggleBigscreen();
        return;
      }

      void invoke<boolean>("native_function_modifier_pressed").then((functionPressed) => {
        if (functionPressed) return;
        toggleBigscreen();
      });
    };

    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    if (!isPlayerView) {
      root.removeAttribute("data-bigscreen-idle");
      return;
    }

    let idleTimer: ReturnType<typeof setTimeout>;
    const markActive = () => {
      root.removeAttribute("data-bigscreen-idle");
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        root.setAttribute("data-bigscreen-idle", "true");
      }, 10_000);
    };

    markActive();
    window.addEventListener("pointermove", markActive);
    window.addEventListener("pointerdown", markActive);

    return () => {
      clearTimeout(idleTimer);
      window.removeEventListener("pointermove", markActive);
      window.removeEventListener("pointerdown", markActive);
      root.removeAttribute("data-bigscreen-idle");
    };
  }, [isPlayerView]);

  useEffect(() => {
    if ((screen === "bigscreen" || screen === "lyrics") && preferences.ui.playerView !== screen)
      setPreferences((current) => ({ ...current, ui: { ...current.ui, playerView: screen } }));
  }, [screen, preferences.ui.playerView]);

  useEffect(() => {
    savePreferences(preferences);
  }, [preferences]);

  // Saved straight from the clock, so playing never rerenders the app: every 5 s while playing, exactly while paused.
  useEffect(() => {
    if (!player.isSessionRestored) return;
    const track = player.currentTrack;
    let saved: string | undefined;
    const save = () => {
      const time = player.clock.get();
      const playback = track
        ? { trackId: track.globalId, positionSeconds: player.isPlaying ? Math.floor(time / 5) * 5 : time }
        : { trackId: null, positionSeconds: 0 };
      const key = `${playback.trackId}:${playback.positionSeconds}`;
      if (key === saved) return;
      saved = key;
      savePlayback(playback);
    };
    save();
    return player.clock.subscribe(save);
  }, [player.clock, player.currentTrack, player.isPlaying, player.isSessionRestored]);

  useEffect(() => {
    const saveLatestSession = () => {
      const latest = latestSessionRef.current;
      if (!latest.player.isSessionRestored) return;

      savePreferences(latest.preferences);
      savePlayback(latest.player.currentTrack
        ? {
            trackId: latest.player.currentTrack.globalId,
            positionSeconds: latest.player.clock.get(),
          }
        : { trackId: null, positionSeconds: 0 });
    };

    window.addEventListener("beforeunload", saveLatestSession);
    window.addEventListener("ambra:save-session", saveLatestSession);
    return () => {
      window.removeEventListener("beforeunload", saveLatestSession);
      window.removeEventListener("ambra:save-session", saveLatestSession);
    };
  }, []);

  // Player views and queue return to where they were opened from; search returns to the library.
  const leaveScreen = () => setPreferences((current) => ({
    ...current,
    ui: {
      ...current.ui,
      screen:
        (current.ui.screen === "bigscreen" || current.ui.screen === "lyrics")
          ? playerReturnScreenRef.current
          : current.ui.screen === "queue"
            ? queueReturnScreenRef.current
            : "library",
    },
  }));
  const goBack = useStableCallback(() => {
    const previous = navigation.current.pop();
    if (!previous) { setBrowseEntity(null); return; }
    setBrowseEntity(previous.entity); setSelectedPlaylistId(previous.playlistId); setLibrarySection(previous.section);
    setPreferences(current => ({ ...current, ui: { ...current.ui, screen: previous.screen } }));
  });
  const openEntity = useStableCallback((entity: BrowseEntity) => {
    if (browseEntity && entityKey(entity) === entityKey(browseEntity)) return;
    navigation.current.push({ entity: browseEntity, screen, playlistId: selectedPlaylistId, section: librarySection });
    setBrowseEntity(entity); setSelectedPlaylistId(null);
    setPreferences(current => ({ ...current, ui: { ...current.ui, screen: "library" } }));
  });
  const entityAction = async (action: EntityAction, tracks: Track[], id?: string) => {
    if (!tracks.length) return;
    const selected = tracks.find(track => track.globalId === id) ?? tracks[0];
    try {
      const track = await resolveTrackPlayback(selected, AbortSignal.timeout(8000));
      rememberTracks([track]);
      const context = searchQueueContext(tracks, browseEntity ? entityKey(browseEntity) : "browse", track);
      if (action === "shuffle") {
        const first = queue.shuffleContext(context);
        if (first) player.playTrack(first.track.globalId, await resolveTrackPlayback(first.track, AbortSignal.timeout(8000)));
        return;
      }
      if (action === "play") { queue.playFromContext(context, track.globalId); player.playTrack(track.globalId, track); return; }
      const entry = queueEntryForTrack(context, track.globalId);
      if (!entry) return;
      if (action === "standalone") { queue.playStandalone(entry); player.playTrack(track.globalId, track); return; }
      const start = !queue.currentEntry;
      if (action === "next") queue.playNext(entry);
      else for (const item of context.entries) queue.addToQueue(item);
      if (start) player.playTrack(track.globalId, track);
    } catch (error) { console.warn("Could not play catalog tracks:", error); }
  };

  const onEntityAction = useStableCallback((action: EntityAction, tracks: Track[], id?: string) => { void entityAction(action, tracks, id); });
  const addEntityTrack = useStableCallback((track: Track) => { if (track.provider !== "local") void library.addTrack(track.provider, track.providerTrackId); });
  // The now-playing title's library menu.
  const currentTrackId = player.currentTrack?.globalId;
  const currentInLibrary = useMemo(
    () => currentTrackId !== undefined && library.tracks.some(track => track.globalId === currentTrackId),
    [library.tracks, currentTrackId],
  );
  const currentSongMenu = useMemo(
    () => ({ playlistOptions, inLibrary: currentInLibrary, showAlbumLink: !isPlayerView, onAddToLibrary: addEntityTrack }),
    [playlistOptions, currentInLibrary, isPlayerView, addEntityTrack],
  );

  const changeScreen = (nextScreen: AppScreen) => {
    if ((nextScreen === "bigscreen" || nextScreen === "lyrics") && !isPlayerView && !player.currentTrack) return;
    setPreferences((current) => ({
      ...current,
      ui: {
        ...current.ui,
        screen: nextScreen,
      },
    }));
  };

  // Settings and the player have no search of their own; Cmd/Ctrl+F summons the bar over them.
  const hasSearchPage = !isPlayerView && !isSettingsView;
  const [searchSummon, setSearchSummon] = useState<"off" | "on" | "dismissed">("off");
  useEffect(() => setSearchSummon("off"), [screen]);
  const [searchFocus, setSearchFocus] = useState<SearchFocusRequest | null>(null);
  const requestSearchFocus = (caret: SearchFocusRequest["caret"]) =>
    setSearchFocus((current) => ({ id: (current?.id ?? 0) + 1, caret }));

  const changeSearchQuery = (nextQuery: string) => {
    // A blank query on a page without search leaves the listener where they are.
    if (!nextQuery.trim() && !hasSearchPage) {
      setPreferences((current) => ({ ...current, search: { ...current.search, query: nextQuery } }));
      return;
    }
    setBrowseEntity(null); navigation.current = [];
    setPreferences((current) => ({
      ...current,
      ui: {
        ...current.ui,
        screen: nextQuery.trim() ? "search" : "library",
      },
      search: {
        ...current.search,
        query: nextQuery,
      },
    }));
  };

  // Cmd/Ctrl+F opens Ambra's search everywhere, in place of the WebView's find bar.
  const openSearch = useStableCallback(() => {
    if (localOnly) return;
    if (!hasSearchPage) setSearchSummon("on");
    requestSearchFocus("select");
  });
  // Search opens only through its shortcut; typing elsewhere in the app never starts one.
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!isSearchShortcut(event)) return;
      event.preventDefault();
      openSearch();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [openSearch]);

  const playFromCollection = (trackId: GlobalTrackId) => {
    queue.playFromContext(activeCollectionContext, trackId);
    player.playTrack(trackId);
  };

  const shuffleCollection = () => {
    const first = queue.shuffleContext(activeCollectionContext);
    if (first) player.playTrack(first.track.globalId);
  };

  const resolvedSearchContext = async (trackId: GlobalTrackId) => {
    const track = await search.resolveTrack(trackId);
    return {
      context: searchQueueContext(
        search.results,
        `search:${searchProvider}:${searchQuery.trim()}`,
        track,
      ),
      track,
    };
  };

  const selectedSearchTrack = (trackId: GlobalTrackId) =>
    search.candidates.find(track => track.globalId === trackId)
      ?? search.knownTracks.find(track => track.globalId === trackId);

  const visibleSearchContext = (trackId: GlobalTrackId) =>
    searchQueueContext(
      search.results,
      `search:${searchProvider}:${searchQuery.trim()}`,
      selectedSearchTrack(trackId),
    );

  const playStandaloneFromSearch = async (trackId: GlobalTrackId) => {
    const { context, track } = await resolvedSearchContext(trackId);
    const entry = queueEntryForTrack(context, trackId);
    if (!entry) return;
    queue.playStandalone(entry);
    player.playTrack(trackId, track);
  };

  const addToQueueFromSearch = async (trackId: GlobalTrackId) => {
    if (queue.currentEntry) {
      const entry = queueEntryForTrack(visibleSearchContext(trackId), trackId);
      if (!entry) return;
      queue.addToQueue(entry);
      void search.resolveTrack(trackId);
      return;
    }
    const { context, track } = await resolvedSearchContext(trackId);
    const entry = queueEntryForTrack(context, trackId);
    if (!entry) return;
    queue.addToQueue(entry);
    player.playTrack(trackId, track);
  };

  const playNextFromSearch = async (trackId: GlobalTrackId) => {
    if (queue.currentEntry) {
      const entry = queueEntryForTrack(visibleSearchContext(trackId), trackId);
      if (!entry) return;
      queue.playNext(entry);
      void search.resolveTrack(trackId);
      return;
    }
    const { context, track } = await resolvedSearchContext(trackId);
    const entry = queueEntryForTrack(context, trackId);
    if (!entry) return;
    queue.playNext(entry);
    player.playTrack(trackId, track);
  };

  const playStandalone = (
    context: typeof queueContext,
    trackId: GlobalTrackId,
  ) => {
    const entry = queueEntryForTrack(context, trackId);
    if (!entry) return;
    queue.playStandalone(entry);
    player.playTrack(trackId);
  };

  const addToQueue = (context: typeof queueContext, trackId: GlobalTrackId) => {
    const entry = queueEntryForTrack(context, trackId);
    if (!entry) return;
    const shouldStartPlaying = queue.currentEntry === undefined;
    queue.addToQueue(entry);
    if (shouldStartPlaying) player.playTrack(trackId);
  };

  const playNext = (context: typeof queueContext, trackId: GlobalTrackId) => {
    const entry = queueEntryForTrack(context, trackId);
    if (!entry) return;
    const shouldStartPlaying = queue.currentEntry === undefined;
    queue.playNext(entry);
    if (shouldStartPlaying) player.playTrack(trackId);
  };

  const jumpToQueueEntry = (queueId: number) => {
    const entry = queue.jumpTo(queueId);
    if (entry) player.playTrack(entry.track.globalId);
  };

  const replayQueueHistoryEntry = (historyId: string) => {
    const entry = queue.replayHistory(historyId);
    if (entry) player.playTrack(entry.track.globalId, entry.track);
  };

  const deleteQueueEntries = (queueIds: number[]) => {
    const result = queue.removeEntries(queueIds);
    if (!result.currentRemoved) return;
    if (result.item) player.playTrack(result.item.track.globalId);
    else player.clear();
  };

  const closeCurrentScreen = () => {
    if (browseEntity && screen !== "bigscreen" && screen !== "lyrics" && screen !== "queue") { goBack(); return; }
    changeScreen(
      (screen === "bigscreen" || screen === "lyrics")
        ? playerReturnScreenRef.current
        : screen === "queue"
          ? queueReturnScreenRef.current
          : "library",
    );
  };

  const openQueue = () => changeScreen("queue");

  const collectionViewProps = {
    onOpenEntity: openEntity,
    tracks: collectionTracks,
    playlistOptions,
    playTrack: playFromCollection,
    playStandalone: (trackId: GlobalTrackId) =>
      playStandalone(activeCollectionContext, trackId),
    addToQueue: (trackId: GlobalTrackId) =>
      addToQueue(activeCollectionContext, trackId),
    playNext: (trackId: GlobalTrackId) =>
      playNext(activeCollectionContext, trackId),
    removeTracks: selectedPlaylist?.provider && (!selectedPlaylist.editable || servicePlaylistStore.busy.has(selectedPlaylist.id)) ? undefined : removeFromCollection,
    reorderTracks: selectedPlaylist?.provider ? undefined : reorderCollectionTracks,
    sort: collectionSort,
    onSortChange: changeCollectionSort,
    shuffleCollection,
    registerScrollElement,
  };

  return (
    <>
      <AppChrome
        currentScreen={screen}
        playerView={showLyrics ? "lyrics" : "bigscreen"}
        lyricsAvailable={lyricsAvailability !== "none"}
        isFullscreen={isFullscreen}
        onExit={closeCurrentScreen}
        onSelectPlayerView={changeScreen}
      />

      {(player.currentTrack || isPlayerView) && (
        <div className="playerStage" data-open={isPlayerView}>
          <BackgroundArtwork track={player.currentTrack} active={isPlayerView} animate={preferences.ui.animateSwirl}
            playing={player.isPlaying} coverId="albumCover" coverDim={lyricsShown ? LYRICS_COVER_DIM : 1} />
          {isPlayerView && [
            ...leavingLyrics.map((track) => ({ track, leaving: true })),
            ...(lyricsTrack ? [{ track: lyricsTrack, leaving: false }] : []),
          ].map(({ track, leaving }) => <LyricsView key={track.globalId}
            track={track} clock={player.clock} playing={player.isPlaying} onSeek={player.seek}
            motion={preferences.ui.lyricMotion} autoSync={preferences.ui.autoSyncLyrics}
            shown={!leaving && lyricsShown} leaving={leaving} arriving={!leaving && leavingLyrics.length > 0} />)}
        </div>
      )}
      {(player.currentTrack || isPlayerView) && (
        <AlbumArtwork
          track={player.currentTrack}
          active={isPlayerView}
          layout={showLyrics ? "lyrics" : "center"}
          direction={skipDirection}
        />
      )}

      {/* Stays mounted, hidden, behind the player, so closing it is instant and every scroll position holds. */}
      <main className="appScreen" id={isQueueView ? "queue" : isSettingsView ? "settings" : isSearchView ? "search" : "library"}
        data-hidden={isPlayerView || undefined} inert={isPlayerView && searchSummon !== "on"}>
        {/* On every screen; where a screen has no search of its own it waits hidden until summoned. */}
        {!localOnly && <SearchBar
          query={searchQuery}
          onQueryChange={changeSearchQuery}
          provider={searchProvider}
          providers={searchProviders}
          onProviderChange={(provider) => setPreferences((current) => ({
            ...current,
            search: { ...current.search, provider },
          }))}
          onConfirm={() => {
            if (searchQuery.trim()) { setBrowseEntity(null); changeScreen("search"); }
            else if (hasSearchPage) changeScreen("library");
          }}
          focusRequest={searchFocus}
          away={hasSearchPage || searchSummon === "on" ? undefined : searchSummon === "dismissed" ? "dismissed" : "page"}
          summoned={!hasSearchPage && searchSummon === "on"}
          onLeave={() => setSearchSummon((summon) => summon === "on" ? "dismissed" : summon)}
        />}
        {isQueueView && (
          <button className="xContainer queueClose" type="button" onClick={closeCurrentScreen}
            data-beside-search={localOnly ? undefined : true}>
            <img src="/x.svg" alt="Close" className="closeBtn" />
          </button>
        )}
        {!isQueueView && !isSettingsView && playlistStore.error && <p role="alert">{playlistStore.error}</p>}
        {!isQueueView && !isSettingsView && servicePlaylistError && <p className="playlistSyncError" role="alert">{servicePlaylistError}</p>}
        {isSettingsView ? <SettingsSidebar tab={settingsTab} onSelect={setSettingsTab} onBack={() => changeScreen("library")} /> : <Sidebar
          isHomeActive={isHomeView && !isQueueView}
          onOpenHome={() => {
            setBrowseEntity(null); navigation.current = [];
            setSelectedPlaylistId(null);
            changeScreen("home");
          }}
          isSettingsActive={isSettingsView}
          onOpenSettings={() => {
            setBrowseEntity(null); navigation.current = [];
            setSelectedPlaylistId(null);
            changeScreen("settings");
          }}
          activeLibrarySection={!isQueueView && !isSettingsView && !isSearchView && !isHomeView && !browseEntity && !selectedPlaylist ? librarySection : null}
          activePlaylistId={!isQueueView && !isSettingsView && !isSearchView && !isHomeView ? selectedPlaylist?.id ?? null : null}
          onOpenLibrarySection={(section) => {
            setBrowseEntity(null); navigation.current = [];
            setSelectedPlaylistId(null);
            setLibrarySection(section);
            changeScreen("library");
          }}
          onOpenLibrary={() => {
            setBrowseEntity(null); navigation.current = [];
            setSelectedPlaylistId(null);
            setLibrarySection("overview");
            changeScreen("library");
          }}
          onCreatePlaylist={createPlaylist}
          onRenamePlaylist={playlistStore.rename}
          onDeletePlaylist={(id) => {
            if (!playlistStore.deletePlaylist(id)) return false;
            if (selectedPlaylistId === id) setSelectedPlaylistId(null);
            return true;
          }}
          playlists={playlistStore.playlists}
          serviceGroups={servicePlaylistStore.groups}
          servicePlaylistVisibility={preferences.ui.servicePlaylistVisibility}
          playlistGroups={preferences.ui.playlistGroups}
          onTogglePlaylistGroup={(group, expanded) => setPreferences(current => current.ui.playlistGroups[group] === expanded ? current : {
            ...current, ui: { ...current.ui, playlistGroups: { ...current.ui.playlistGroups, [group]: expanded } },
          })}
          onSelectPlaylist={(id) => {
            setBrowseEntity(null); navigation.current = [];
            setSelectedPlaylistId(id);
            changeScreen("library");
          }}
        />}
        {isSettingsView ? (
          <SettingsView tab={settingsTab} onTabChange={setSettingsTab} registerScrollElement={registerScrollElement} showAudioQuality={preferences.ui.showAudioQuality}
            onServiceConnected={() => {
              refreshSearchProviders();
              void servicePlaylistStore.refresh();
              search.retry();
              void library.refreshStreamingMusic();
            }}
            onShowAudioQuality={showAudioQuality => setPreferences(current => ({ ...current, ui: { ...current.ui, showAudioQuality } }))}
            animateSwirl={preferences.ui.animateSwirl}
            lyricMotion={preferences.ui.lyricMotion}
            autoSyncLyrics={preferences.ui.autoSyncLyrics}
            servicePlaylistVisibility={preferences.ui.servicePlaylistVisibility}
            onServicePlaylistVisibilityChange={(provider, visible) => setPreferences(current => ({
              ...current, ui: { ...current.ui, servicePlaylistVisibility: { ...current.ui.servicePlaylistVisibility, [provider]: visible } },
            }))}
            onAutoSyncLyrics={autoSyncLyrics => setPreferences(current => ({ ...current, ui: { ...current.ui, autoSyncLyrics } }))}
            onLyricMotionChange={lyricMotion => setPreferences(current => ({ ...current, ui: { ...current.ui, lyricMotion } }))}
            onAnimateSwirl={animateSwirl => setPreferences(current => ({ ...current, ui: { ...current.ui, animateSwirl } }))} />
        ) : isQueueView ? (
          <Queue
            currentEntry={queue.currentEntry}
            upcomingEntries={queue.upcomingEntries}
            historyEntries={queue.historyEntries}
            jumpTo={jumpToQueueEntry}
            replayHistory={replayQueueHistoryEntry}
            reorderEntries={queue.reorderEntries}
            deleteEntries={deleteQueueEntries}
            deleteHistoryEntries={queue.removeHistoryEntries}
            registerScrollElement={registerScrollElement}
          />
        ) : browseEntity ? <EntityView key={entityKey(browseEntity)} entity={browseEntity} cache={browseCache.current} libraryTracks={library.tracks}
          onBack={goBack} onOpenEntity={openEntity} onAction={onEntityAction}
          onAddTrack={addEntityTrack}
          rememberTracks={rememberTracks} playlistOptions={playlistOptions} registerScrollElement={registerScrollElement} /> : isSearchView ? (
          <SearchView
            onOpenEntity={openEntity}
            playlistOptions={playlistOptions}
            query={searchQuery}
            provider={searchProvider}
            tracks={search.results}
            candidates={search.candidates}
            isSearching={search.isSearching}
            artists={search.artists}
            albums={search.albums}
            canRetry={search.canRetry}
            retry={search.retry}
            error={search.error}
            playStandalone={playStandaloneFromSearch}
            addToQueue={addToQueueFromSearch}
            playNext={playNextFromSearch}
            addToLibrary={(trackId) => {
              const track = selectedSearchTrack(trackId);
              if (
                track &&
                (track.provider === "tidal" ||
                  track.provider === "qobuz" ||
                  track.provider === "spotify")
              ) {
                void library.addTrack(track.provider, track.providerTrackId);
              }
            }}
            registerScrollElement={registerScrollElement}
          />
        ) : isHomeView ? (
          <HomeView entries={listeningHistory.entries} tracks={availableTracks} playlists={playlists}
            error={listeningHistory.error} onPlay={(tracks, id) => onEntityAction("play", tracks, id)}
            onSelectPlaylist={id => {
              setBrowseEntity(null); navigation.current = [];
              setSelectedPlaylistId(id);
              changeScreen("library");
            }} registerScrollElement={registerScrollElement} />
        ) : selectedPlaylist ? (
          <PlaylistView
            key={selectedPlaylist.id}
            playlist={selectedPlaylist}
            artworkTracks={baseCollectionTracks}
            {...collectionViewProps}
          />
        ) : (
          <LibraryView
            key={`library:${librarySection}`}
            {...collectionViewProps}
            section={librarySection}
            onSectionChange={setLibrarySection}
            onRescanLocalMusic={library.rescanLocalMusic}
          />
        )}
      </main>

      <NowPlayingBar
        onOpenEntity={openEntity}
        songMenu={currentSongMenu}
        variant={isPlayerView ? "expanded" : "compact"}
        track={player.currentTrack}
        audioQuality={player.audioQuality}
        showAudioQuality={preferences.ui.showAudioQuality}
        clock={player.clock}
        duration={player.duration}
        isPlaying={player.isPlaying}
        playbackError={player.playbackError}
        audioDecks={player.audioDecks}
        onPrevious={player.previous}
        onTogglePlayback={player.togglePlayback}
        onNext={player.next}
        onSeek={player.seek}
        onOpenBigscreen={() => changeScreen(preferences.ui.playerView)}
        onOpenQueue={openQueue}
      />

      <AppScrollbar scrollElement={activeScrollElement} hidden={isPlayerView} />
    </>
  );
}

export default App;
