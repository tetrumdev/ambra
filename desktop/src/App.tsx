import { isDeviceTrack } from "./utils/nativeAudioSource";
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
import { NavigationSwipe } from "./components/NavigationSwipe";
import { AlbumArtwork, BackgroundArtwork } from "./components/BigscreenArtwork";
import { NowPlayingBar } from "./components/NowPlayingBar";
import { LyricsView } from "./components/LyricsView";
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
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { getServerConnection, subscribeServerConnection } from "./api/serverConnection";
import { serverStateStatus, subscribeServerState } from "./utils/serverState";
import { useStableCallback } from "./hooks/useStableCallback";
import { usePageNavigation } from "./hooks/usePageNavigation";
import { useLyricsAvailability } from "./hooks/useLyricsAvailability";
import {
  loadPreferences,
  savePlayback,
  savePreferences,
  type AppScreen,
} from "./utils/preferences";
import type { GlobalTrackId, Playlist, Track } from "./types/music";
import { configuredSearchProviders, resolveTrackPlayback, type SearchProvider, type StreamingProvider } from "./api/server";
import {
  collectionQueueContext,
  libraryQueueContext,
  searchQueueContext,
} from "./utils/queueModel";
import { acceptsPlaybackShortcut, isTypingTarget, wasKeyHandled } from "./utils/keyboard";
import { announceShortcut, matchesShortcut, matchingShortcut, setShortcutOverrides, type ShortcutOverrides } from "./utils/shortcuts";
import { actOnCursor, flashItem, hidePointer, installPointerCursor, moveCursor, moveSidebar, SIDEBAR_ROOT } from "./utils/keyboardNav";
import { ShortcutToast } from "./components/ShortcutToast";
import { PageFilterBar } from "./components/PageFilterBar";
import { UpdateNotice } from "./components/UpdateNotice";
import { useAutomaticUpdateChecks } from "./hooks/useAppUpdate";
import { PageFilterProvider } from "./hooks/usePageFilter";
import { TrackColumnsContext, type TrackColumnsStore } from "./hooks/useTrackColumns";
import { hideableTrackColumns, optionalColumnsTemplate, orderedOptionalColumns } from "./utils/trackColumnWidths";
import { cachePlaylistArtwork } from "./utils/playlistArtworkCache";
import { enterView } from "./utils/viewMotion";
import { setReducedMotion } from "./utils/reducedMotion";
import { isSongEnding } from "./utils/songEnding";
import { preloadUpcomingBigscreenArtwork } from "./utils/artworkImages";
import { preloadLyrics } from "./utils/lyricsCache";
import { prepareLyricSync } from "./utils/lyricsOffset";

import { playlistTracks } from "./utils/playlists";
import { groupPackagedTracks } from "./utils/playlistPackages";
import {
  sortCollectionTracks,
  type TrackSort,
} from "./utils/trackCollectionOrder";

import { usePlaylists } from "./hooks/usePlaylists";
import { usePlaylistImprovement } from "./hooks/usePlaylistImprovement";
import { isTrackAvailable, useServiceAvailability } from "./hooks/useServiceAvailability";
import "./components/UnavailableTracks.css";
import { useCorePlayer } from "./hooks/useCorePlayer";
import { useCoreQueue } from "./hooks/useCoreQueue";
import { useServicePlaylists } from "./hooks/useServicePlaylists";
import { useLyricsRest } from "./hooks/useLyricsRest";
import { TrackCreditsDialog } from "./components/TrackCreditsDialog";

/** On Windows the style change takes keyboard focus from the page, so shortcuts like Space stop until it's clicked. */
async function setWindowFullscreen(fullscreen: boolean) {
  await getCurrentWindow().setFullscreen(fullscreen);
  await getCurrentWebview().setFocus();
}

/** How long playback may stop before the display is allowed to sleep again. */
const DISPLAY_WAKE_RELEASE_DELAY_MS = 5_000;

/** Sessions saved before Settings stood apart could return to it; those go to the library instead. */
function withoutSettings<T extends AppScreen>(screen: T): Exclude<T, "settings"> {
  return (screen === "settings" ? "library" : screen) as Exclude<T, "settings">;
}

function App({ localOnly, sharedPlayback = false, onPlaybackRelease }: { localOnly: boolean; sharedPlayback?: boolean; onPlaybackRelease?: (release: () => Promise<void>) => void }) {
  const connectedServices = useServiceAvailability();
  const [preferences, setPreferences] = useState(loadPreferences);
  // Applied while rendering, before any child's effects read it.
  setReducedMotion(preferences.ui.reduceMotion);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>(preferences.ui.navigation?.settingsTab ?? "general");
  const playlistStore = usePlaylists();
  const listeningHistory = useListeningHistory();
  useAutomaticUpdateChecks();
  const [browseEntity, setBrowseEntity] = useState<BrowseEntity | null>(preferences.ui.navigation?.entity ?? null);
  const browseCache = useRef(new Map<string, EntityPage>());
  const [browseTracks, setBrowseTracks] = useState<Track[]>([]);
  const rememberTracks = useCallback((tracks: Track[]) => setBrowseTracks(current => {
    const known = new Map(current.map(track => [track.globalId, track]));
    // Keep the same array when nothing changed so App and its memos don't rerun.
    if (tracks.every(track => known.get(track.globalId) === track)) return current;
    for (const track of tracks) known.set(track.globalId, track);
    return [...known.values()];
  }), []);
  const [selectedPlaylistId, setSelectedPlaylistId] = useState<string | null>(
    preferences.ui.navigation?.playlistId?.replace(/^ambra-server-playlist:[^:]+:/, "") ?? null,
  );
  const playlistImprovement = usePlaylistImprovement(playlistStore.playlists, playlistStore.tracks, playlistStore.replaceTracks, !localOnly);
  const servicePlaylistStore = useServicePlaylists(selectedPlaylistId, !localOnly, preferences.ui.screen === "home");
  const playlists = useMemo(() => [...playlistStore.playlists, ...servicePlaylistStore.playlists], [playlistStore.playlists, servicePlaylistStore.playlists]);
  const [librarySection, setLibrarySection] =
    useState<LibrarySection>(preferences.ui.navigation?.section ?? "overview");
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
  const library = useMusicLibrary(localOnly, sharedPlayback);
  const search = useTrackSearch(localOnly ? "" : searchQuery, searchProvider);
  const availableTracks = useMemo(() => {
    const tracksById = new Map<string, Track>(
      [...listeningHistory.tracks, ...browseTracks, ...playlistStore.tracks, ...servicePlaylistStore.tracks, ...library.catalogTracks].map((track) => [track.globalId, track]),
    );
    for (const track of search.knownTracks) {
      tracksById.set(track.globalId, track);
    }
    return [...tracksById.values()].filter(track => !sharedPlayback || !isDeviceTrack(track));
  }, [sharedPlayback, listeningHistory.tracks, browseTracks, playlistStore.tracks, servicePlaylistStore.tracks, library.catalogTracks, search.knownTracks]);
  const queueContext = useMemo(
    () => libraryQueueContext(library.tracks),
    [library.tracks, connectedServices],
  );
  // Root restores the playback mode and remounts when its queue authority changes.
  const [usingCore] = useState(sharedPlayback);
  /* eslint-disable react-hooks/rules-of-hooks -- `usingCore` never changes while mounted. */
  const queue = usingCore ? useCoreQueue(availableTracks) : useQueue(availableTracks, preferences.playback.trackId, !library.isRestoring);
  const playbackTracks = useMemo(() => {
    const tracksById = new Map(
      availableTracks.map((track) => [track.globalId, track]),
    );
    for (const entry of [...queue.historyEntries, ...queue.entries]) {
      tracksById.set(entry.track.globalId, entry.track);
    }
    return [...tracksById.values()].filter(track => !localOnly || isDeviceTrack(track));
  }, [availableTracks, queue.entries, queue.historyEntries, localOnly]);
  // Which way the queue last moved, so the player cover slides in from that side.
  const skipDirectionRef = useRef({ direction: 1, at: 0 });
  const skipDirection = useCallback(() =>
    performance.now() - skipDirectionRef.current.at < 3000 ? skipDirectionRef.current.direction : 1, []);
  const player = usingCore ? useCorePlayer(queue) : useAudioPlayer(playbackTracks, preferences.playback, {
    next: () => { skipDirectionRef.current = { direction: 1, at: performance.now() }; return queue.next()?.track; },
    completeCurrent: () => { skipDirectionRef.current = { direction: 1, at: performance.now() }; return queue.completeCurrent()?.track; },
    previous: () => { skipDirectionRef.current = { direction: -1, at: performance.now() }; return queue.previous()?.track; },
    peekNext: () => queue.peekNext()?.track,
    nextTrack: queue.upcomingEntries[0]?.track,
  }, listeningHistory.recordPlay);
  /* eslint-enable react-hooks/rules-of-hooks */
  // Read by timers that outlive a render, such as the player controls fading out.
  const playerDurationRef = useRef(player.duration);
  playerDurationRef.current = player.duration;
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
  // Every shortcut handler reads the listener's own bindings from here.
  setShortcutOverrides(preferences.ui.shortcuts ?? {});
  const screen = preferences.ui.screen;
  const isBigscreen = screen === "bigscreen";
  const isLyricsView = screen === "lyrics";
  const isPlayerView = isBigscreen || isLyricsView;
  // Lyrics are the chosen view, but a song without synced ones shows its cover until one with them comes back.
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
  // During a long instrumental ending the lyrics step aside for the cover until the pointer moves.
  // Settling back after the next song starts drifts too, as gently as the lyrics left.
  const { resting: lyricsResting, gentle: lyricsDrift } = useLyricsRest(player.currentTrack, player.clock, isLyricsView && showLyrics, preferences.ui.autoSyncLyrics);
  const lyricsOnStage = showLyrics && !lyricsResting;
  // Opening the player shows its lyrics at once; switching between them and the cover fades (LyricsView.css).
  const [lyricsShown, setLyricsShown] = useState(lyricsOnStage && isPlayerView);
  const playerWasOpen = useRef(isPlayerView);
  if (lyricsShown && !(lyricsOnStage && isPlayerView)) setLyricsShown(false);
  else if (!lyricsShown && lyricsOnStage && isPlayerView && !playerWasOpen.current) setLyricsShown(true);
  useEffect(() => {
    playerWasOpen.current = isPlayerView;
    if (lyricsShown || !lyricsOnStage || !isPlayerView) return;
    // Paint the hidden state once first, so lyrics switched to fade in from behind the cover.
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => setLyricsShown(true));
    });
    return () => cancelAnimationFrame(frame);
  }, [isPlayerView, lyricsOnStage, lyricsShown]);
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
  // Settings is a separate place, never a page the queue or player sits over or returns to.
  const queueReturnScreenRef = useRef<Exclude<AppScreen, "bigscreen" | "lyrics" | "queue" | "settings">>(
    withoutSettings(preferences.ui.navigation?.queueReturnScreen ?? (screen === "home" || screen === "search" ? screen : "library")),
  );
  const playerReturnScreenRef = useRef<Exclude<AppScreen, "bigscreen" | "lyrics" | "settings">>(
    withoutSettings(preferences.ui.navigation?.playerReturnScreen ?? "library"),
  );
  if (screen !== "bigscreen" && screen !== "lyrics" && screen !== "settings") playerReturnScreenRef.current = screen;
  const playerOpenedByKeyRef = useRef(false);
  // While the player is open, the screen hidden behind it keeps what it showed.
  const libraryScreen = isPlayerView ? playerReturnScreenRef.current : screen;
  const isQueueView = libraryScreen === "queue";
  const isSettingsView = libraryScreen === "settings";
  const isHomeView = libraryScreen === "home" && !browseEntity;
  const isSearchView = libraryScreen === "search" && !browseEntity;
  if (screen === "home" || screen === "library" || screen === "search") {
    queueReturnScreenRef.current = screen;
  }
  // Page history restores content; retain player/queue overlays and their return screens too.
  const settingsReturnRef = useRef<{
    screen: AppScreen;
    playerReturnScreen: typeof playerReturnScreenRef.current;
    queueReturnScreen: typeof queueReturnScreenRef.current;
  } | null>(null);
  const underlyingScreen = screen === "bigscreen" || screen === "lyrics" ? playerReturnScreenRef.current : screen;
  const { back: goBack, forward: goForward, canGo: canGoInHistory } = usePageNavigation({
    screen: underlyingScreen === "queue" ? queueReturnScreenRef.current : underlyingScreen,
    entity: browseEntity, playlistId: selectedPlaylistId, section: librarySection,
    settingsTab, search: preferences.search,
  }, page => {
    setBrowseEntity(page.entity);
    setSelectedPlaylistId(page.playlistId);
    setLibrarySection(page.section);
    setSettingsTab(page.settingsTab);
    setPreferences(current => ({ ...current, search: page.search, ui: { ...current.ui, screen: page.screen } }));
  });
  const sessionPreferences = useMemo(() => ({
    ...preferences,
    ui: {
      ...preferences.ui,
      navigation: {
        playerReturnScreen: playerReturnScreenRef.current,
        queueReturnScreen: queueReturnScreenRef.current,
        entity: browseEntity,
        playlistId: selectedPlaylistId,
        section: librarySection,
        settingsTab,
      },
    },
  }), [preferences, localOnly, browseEntity, selectedPlaylistId, librarySection, settingsTab]);
  const latestSessionRef = useRef({ preferences: sessionPreferences, player, usingCore });
  latestSessionRef.current = { preferences: sessionPreferences, player, usingCore };
  useEffect(() => { onPlaybackRelease?.(() => latestSessionRef.current.player.release()); }, [onPlaybackRelease]);
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
    if (!track || !isTrackAvailable(track)) return false;
    if (playlists.find(playlist => playlist.id === playlistId)?.provider)
      return track ? servicePlaylistStore.addTrack(playlistId, track) : false;
    return track ? playlistStore.addTrack(playlistId, await resolveTrackPlayback(track, AbortSignal.timeout(8000))) : false;
  });
  const createPlaylistWithTrack = useStableCallback(async (name: string, trackId: string) => {
    const track = availableTracks.find(track => track.globalId === trackId);
    if (!track || !isTrackAvailable(track)) return false;
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
  // The app often opens before the server answers, so a saved playlist can't be found yet. Its
  // page waits for it instead of dropping back to the library, until its source has answered.
  const serverConnectionInfo = useSyncExternalStore(subscribeServerConnection, getServerConnection);
  const serverState = useSyncExternalStore(subscribeServerState, serverStateStatus);
  const selectedPlaylistProvider = selectedPlaylistId?.match(/^service:([^:]+):/)?.[1];
  const selectedPlaylistGone = selectedPlaylistProvider
    ? servicePlaylistStore.groups.some(group => group.provider === selectedPlaylistProvider)
    : !serverConnectionInfo?.server || (!localOnly && serverState.ready);
  const playlistPending = selectedPlaylistId !== null && !selectedPlaylist && !selectedPlaylistGone;
  const servicePlaylistError = servicePlaylistStore.error
    ?? (selectedPlaylist ? servicePlaylistStore.errors[selectedPlaylist.id] : null);
  const [playlistErrorDismissed, setPlaylistErrorDismissed] = useState(false);
  useEffect(() => setPlaylistErrorDismissed(false), [servicePlaylistError]);
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
      : selectedPlaylist || playlistPending
        ? `playlist:${selectedPlaylistId}`
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
  const collectionPackages = selectedPlaylist?.packages;
  const collectionTracks = useMemo(
    // Packaged songs stay together, in their own order, however the playlist is sorted.
    () => groupPackagedTracks(sortCollectionTracks(baseCollectionTracks, collectionSort, listeningHistory.stats), collectionPackages ?? []),
    [baseCollectionTracks, collectionSort, collectionPackages, listeningHistory.stats],
  );
  const activeCollectionContext = selectedPlaylist
    ? collectionQueueContext(collectionTracks, {
        kind: "playlist",
        id: selectedPlaylist.id,
      }, collectionPackages)
    : libraryQueueContext(
        sortCollectionTracks(library.tracks, collectionSort, listeningHistory.stats),
      );

  const duplicatePlaylist = (playlist: Playlist) => {
    const id = playlistStore.duplicate(playlist.name, playlistTracks(playlist, availableTracks));
    if (id) setSelectedPlaylistId(id);
  };
  const isServicePlaylist = (id: string) => servicePlaylistStore.playlists.some(playlist => playlist.id === id);
  const renamePlaylist = (id: string, name: string) =>
    isServicePlaylist(id) ? servicePlaylistStore.rename(id, name) : playlistStore.rename(id, name);
  const deletePlaylist = async (id: string) => {
    if (!await (isServicePlaylist(id) ? servicePlaylistStore.deletePlaylist(id) : playlistStore.deletePlaylist(id))) return false;
    setSelectedPlaylistId(current => current === id ? null : current);
    return true;
  };

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

  // Fullscreen in the player with music playing, the display stays on, like a video player's.
  // Letting go waits a moment, so the gap between songs doesn't hand the screen back.
  const keepDisplayAwake = isFullscreen === true && isPlayerView && player.isPlaying;
  useEffect(() => {
    if (!isTauri()) return;
    const send = (awake: boolean) => void invoke("set_display_wake", { awake })
      .catch(error => console.warn("Could not change display sleep:", error));
    if (keepDisplayAwake) {
      send(true);
      return;
    }
    const release = setTimeout(() => send(false), DISPLAY_WAKE_RELEASE_DELAY_MS);
    return () => clearTimeout(release);
  }, [keepDisplayAwake]);
  useEffect(() => () => {
    if (isTauri()) void invoke("set_display_wake", { awake: false }).catch(() => {});
  }, []);

  useEffect(() => {
    // macOS owns its fullscreen command and the shortcut assigned to it.
    if (!isTauri() || !navigator.userAgent.includes("Windows")) return;
    const handleKeyDown = async (event: KeyboardEvent) => {
      if (!matchesShortcut(event, "toggleFullscreen") || event.repeat) return;

      event.preventDefault();

      try {
        const nextFullscreen = !(await getCurrentWindow().isFullscreen());
        await setWindowFullscreen(nextFullscreen);
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

  const canNavigate = useStableCallback((direction: "back" | "forward") => {
    if (document.querySelector("dialog[open], #trackMenuBackdrop, [data-click-menu-backdrop], .columnPickerMenu")) return false;
    if (screen === "settings" && direction === "back") return true;
    if (screen === "bigscreen" || screen === "lyrics" || screen === "queue") return direction === "back";
    return canGoInHistory(direction);
  });
  const navigate = useStableCallback((direction: "back" | "forward") => {
    if (!canNavigate(direction)) return false;
    if (screen === "settings" && direction === "back") {
      closeCurrentScreen();
      return true;
    }
    if (screen === "bigscreen" || screen === "lyrics" || screen === "queue") {
      leaveScreen();
      return true;
    }
    return direction === "back" ? goBack() : goForward();
  });

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (wasKeyHandled(event) || !matchesShortcut(event, "closeScreen")) return;
      // Dialogs keep their native Escape dismissal; elsewhere it must not leave fullscreen.
      if (document.querySelector("dialog[open]")) return;
      event.preventDefault();
      // Let search, menus, and playlist dialogs handle their own Escape.
      if (document.querySelector("#trackMenuBackdrop, [data-click-menu-backdrop]")
        || (event.target instanceof Element && event.target.closest("#searchBar")))
        return;
      // Settings is a place you visit rather than a page of its own, so Escape returns from it too.
      if (screen === "settings") {
        // A text field in settings keeps Escape for itself.
        if (isTypingTarget(event.target)) return;
        event.preventDefault();
        if (!event.repeat) closeCurrentScreen();
        return;
      }
      if (screen !== "bigscreen" && screen !== "lyrics" && screen !== "queue") return;
      event.preventDefault();
      event.stopPropagation();

      if (event.repeat) return;
      leaveScreen();
    };

    const handleNavigationKey = (event: KeyboardEvent) => {
      const direction = matchingShortcut(event, ["back", "forward"] as const);
      if (!direction || wasKeyHandled(event)) return;
      event.preventDefault();
      if (!event.repeat) navigate(direction);
    };
    const handleMouseNavigation = (event: MouseEvent) => {
      if (event.button !== 3 && event.button !== 4) return;
      event.preventDefault();
      if (event.type === "mouseup") navigate(event.button === 3 ? "back" : "forward");
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keydown", handleNavigationKey, true);
    window.addEventListener("mousedown", handleMouseNavigation, true);
    window.addEventListener("mouseup", handleMouseNavigation, true);
    window.addEventListener("auxclick", handleMouseNavigation, true);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keydown", handleNavigationKey, true);
      window.removeEventListener("mousedown", handleMouseNavigation, true);
      window.removeEventListener("mouseup", handleMouseNavigation, true);
      window.removeEventListener("auxclick", handleMouseNavigation, true);
    };
  }, [screen, goBack, goForward, navigate]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!matchesShortcut(event, "togglePlayer")) return;
      if (
        isTypingTarget(event.target) ||
        (event.target instanceof Element &&
        event.target.closest("#searchBar"))
      ) {
        return;
      }

      if (event.repeat) return;

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

  // Before paint, so a player opened from the keyboard is never seen with its controls showing.
  useLayoutEffect(() => {
    const root = document.documentElement;
    if (!isPlayerView) {
      root.removeAttribute("data-bigscreen-idle");
      return;
    }

    let idleTimer: ReturnType<typeof setTimeout>;
    // The controls fade out after a song's change, never into it.
    const becomeIdle = () => {
      if (isSongEnding(player.clock.get(), playerDurationRef.current)) idleTimer = setTimeout(becomeIdle, 500);
      else root.setAttribute("data-bigscreen-idle", "true");
    };
    const markActive = () => {
      root.removeAttribute("data-bigscreen-idle");
      clearTimeout(idleTimer);
      idleTimer = setTimeout(becomeIdle, 10_000);
    };

    // Only a real move wakes the controls, not the page shifting under a still pointer.
    const onPointerMove = (event: PointerEvent) => {
      if (event.movementX || event.movementY) markActive();
    };

    let snapFrame = 0;
    if (playerOpenedByKeyRef.current) {
      // Already put away rather than fading out; the fades start once the pointer moves.
      root.setAttribute("data-bigscreen-snap", "");
      root.setAttribute("data-bigscreen-idle", "true");
      snapFrame = requestAnimationFrame(() => {
        snapFrame = requestAnimationFrame(() => root.removeAttribute("data-bigscreen-snap"));
      });
    } else {
      markActive();
    }
    playerOpenedByKeyRef.current = false;
    // The player is for watching, so the pointer gets out of the way until it moves.
    hidePointer();
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerdown", markActive);

    return () => {
      clearTimeout(idleTimer);
      cancelAnimationFrame(snapFrame);
      root.removeAttribute("data-bigscreen-snap");
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerdown", markActive);
      root.removeAttribute("data-bigscreen-idle");
    };
  }, [isPlayerView]);

  useEffect(() => {
    if ((screen === "bigscreen" || screen === "lyrics") && preferences.ui.playerView !== screen)
      setPreferences((current) => ({ ...current, ui: { ...current.ui, playerView: screen } }));
  }, [screen, preferences.ui.playerView]);

  useEffect(() => {
    savePreferences(sessionPreferences);
  }, [sessionPreferences]);
  // Saved straight from the clock, so playing never rerenders the app: every 5 s while playing, exactly while paused.
  useEffect(() => {
    if (!player.isSessionRestored || usingCore) return;
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
  }, [player.clock, player.currentTrack, player.isPlaying, player.isSessionRestored, usingCore]);

  useEffect(() => {
    const saveLatestSession = () => {
      const latest = latestSessionRef.current;
      if (!latest.player.isSessionRestored) return;

      savePreferences(latest.preferences);
      if (latest.usingCore) return;
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

  // Player views and queue return to the page where they were opened.
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
  const openEntity = useStableCallback((entity: BrowseEntity) => {
    if (browseEntity && entityKey(entity) === entityKey(browseEntity) && !isPlayerView && screen !== "queue") return;
    setBrowseEntity(entity); setSelectedPlaylistId(null);
    setPreferences(current => ({ ...current, ui: { ...current.ui, screen: "library" } }));
  });
  const entityAction = async (action: EntityAction, tracks: Track[], id?: string) => {
    if (id && !isTrackAvailable(id)) return;
    tracks = tracks.filter(track => isTrackAvailable(track));
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
  const libraryTrackIds = useMemo(() => new Set(library.tracks.map(track => track.globalId)), [library.tracks]);
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
    setBrowseEntity(null);
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
      if (!matchesShortcut(event, "search")) return;
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

  /** Restores the page Settings was opened over; returns the screen to show, if goBack didn't settle it. */
  const leaveSettings = (): AppScreen | null => {
    const origin = settingsReturnRef.current;
    settingsReturnRef.current = null;
    const restored = goBack();
    if (origin) {
      playerReturnScreenRef.current = origin.playerReturnScreen;
      queueReturnScreenRef.current = origin.queueReturnScreen;
      // A player opened over nothing playing can't come back once the song is gone.
      const playerGone = (origin.screen === "bigscreen" || origin.screen === "lyrics") && !player.currentTrack;
      return playerGone ? origin.playerReturnScreen : origin.screen;
    }
    return restored ? null : "library";
  };

  const closeCurrentScreen = () => {
    if (screen === "settings") {
      const target = leaveSettings();
      if (target) changeScreen(target);
      return;
    }
    if (browseEntity && screen !== "bigscreen" && screen !== "lyrics" && screen !== "queue") { goBack(); return; }
    changeScreen(
      (screen === "bigscreen" || screen === "lyrics")
        ? playerReturnScreenRef.current
        : screen === "queue"
          ? queueReturnScreenRef.current
          : "library",
    );
  };

  // The queue and player replace Settings rather than opening over it.
  const openQueue = () => {
    if (screen === "settings") leaveSettings();
    changeScreen("queue");
  };
  const openPlayer = useStableCallback(() => {
    if (!player.currentTrack) return;
    if (screen === "settings") leaveSettings();
    changeScreen(preferences.ui.playerView);
  });
  const toggleBigscreen = useStableCallback(() => {
    if (isPlayerView) {
      changeScreen(playerReturnScreenRef.current);
    } else {
      // Opened from the keyboard, the player starts with its extra controls already put away.
      playerOpenedByKeyRef.current = Boolean(player.currentTrack);
      openPlayer();
      // Without a song the player stays shut, so say why.
      if (!player.currentTrack) announceShortcut("Nothing is playing");
    }
  });
  const openSettings = () => {
    if (screen === "settings") return;
    settingsReturnRef.current = {
      screen,
      playerReturnScreen: playerReturnScreenRef.current,
      queueReturnScreen: queueReturnScreenRef.current,
    };
    setBrowseEntity(null);
    setSelectedPlaylistId(null);
    changeScreen("settings");
  };

  // Q opens the queue and closes it again; Cmd/Ctrl+comma opens settings.
  const handleScreenShortcut = useStableCallback((event: KeyboardEvent) => {
    if (wasKeyHandled(event) || event.repeat) return;
    if (matchesShortcut(event, "openSettings")) {
      event.preventDefault();
      if (!isSettingsView) openSettings();
    } else if (matchesShortcut(event, "toggleQueue") && !isTypingTarget(event.target)) {
      event.preventDefault();
      if (isQueueView) closeCurrentScreen();
      else openQueue();
    }
  });
  useEffect(() => {
    window.addEventListener("keydown", handleScreenShortcut);
    return () => window.removeEventListener("keydown", handleScreenShortcut);
  }, [handleScreenShortcut]);

  // The page's lists and the sidebar, item by item (utils/keyboardNav.ts). Captured first, so a
  // key that moves through a list doesn't also seek or change the volume.
  const handleListShortcut = useStableCallback((event: KeyboardEvent) => {
    if (isPlayerView || !acceptsPlaybackShortcut(event, true)) return;
    const id = matchingShortcut(event, [
      "listNext", "listPrevious", "listFirst", "listLast", "playSelected", "addSelectedToQueue", "playSelectedNext",
      "sidebarNext", "sidebarPrevious",
    ] as const);
    if (!id) return;
    const main = mainRef.current;
    const focused = document.activeElement;
    const inSidebar = focused instanceof Element && focused.closest(SIDEBAR_ROOT) !== null;
    // The sidebar is a list too: once it has the keyboard, the list keys move through it.
    const sidebarStep = id === "sidebarNext" || (inSidebar && id === "listNext") ? 1
      : id === "sidebarPrevious" || (inSidebar && id === "listPrevious") ? -1 : 0;
    if (sidebarStep) {
      if (moveSidebar(main, sidebarStep)) event.preventDefault();
      return;
    }
    if (inSidebar) return;
    if (id === "listNext" || id === "listPrevious" || id === "listFirst" || id === "listLast") {
      const move = id === "listNext" ? 1 : id === "listPrevious" ? -1 : id === "listFirst" ? "first" : "last";
      // A page without a list keeps the key, so it scrolls as usual.
      if (moveCursor(main, move)) event.preventDefault();
      return;
    }
    // A focused control other than the selected item keeps Enter for itself.
    const target = event.target instanceof Element ? event.target : null;
    const control = target?.closest("button, a, summary, input, select, textarea, [role='button']");
    if (control && !control.matches("[data-nav-cursor]")) return;
    const action = id === "playSelected" ? "play" : id === "addSelectedToQueue" ? "queue" : "next";
    if (event.repeat) { event.preventDefault(); return; }
    const result = actOnCursor(main, action);
    if (!result) return;
    event.preventDefault();
    flashItem(result.item);
    if (result.text === null) announceShortcut(action === "queue" ? "Only songs can be queued" : "Only songs can play next");
    else if (result.text) announceShortcut(result.text);
  });
  useEffect(() => {
    window.addEventListener("keydown", handleListShortcut, true);
    const removePointerCursor = installPointerCursor();
    return () => {
      window.removeEventListener("keydown", handleListShortcut, true);
      removePointerCursor();
    };
  }, [handleListShortcut]);
  const changeShortcuts = useStableCallback((shortcuts: ShortcutOverrides) =>
    setPreferences(current => ({ ...current, ui: { ...current.ui, shortcuts } })));

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
    // Only AMBRA's own playlists can bind songs into packages; the library and service playlists can't hold them.
    ...(selectedPlaylist && !selectedPlaylist.provider ? {
      packages: collectionPackages,
      bindTracks: (trackIds: GlobalTrackId[]) => playlistStore.bindTracks(selectedPlaylist.id, trackIds),
      unbindTracks: (trackIds: GlobalTrackId[]) => playlistStore.unbindTracks(selectedPlaylist.id, trackIds),
    } : {}),
    sort: collectionSort,
    onSortChange: changeCollectionSort,
    shuffleCollection,
    registerScrollElement,
  };

  // Each screen or page rises in as it opens, in the frame it first paints.
  const mainRef = useRef<HTMLElement>(null);
  const viewKey = isSettingsView ? "settings" : isQueueView ? "queue" : browseEntity ? `entity:${entityKey(browseEntity)}`
    : isSearchView ? "search" : isHomeView ? "home" : selectedPlaylist || playlistPending ? `playlist:${selectedPlaylistId}` : `library:${librarySection}`;
  const shownView = useRef(viewKey);
  useLayoutEffect(() => {
    if (shownView.current === viewKey) return;
    shownView.current = viewKey;
    // The page is the last thing in the screen, after the search bar and sidebar.
    if (!isPlayerView) enterView(mainRef.current?.lastElementChild);
  }, [viewKey, isPlayerView]);

  // / filters the songs on the page; each page starts unfiltered.
  const [pageFilter, setPageFilter] = useState<{ view: string; query: string; focus: number } | null>(null);
  useEffect(() => setPageFilter(current => current && current.view !== viewKey ? null : current), [viewKey]);
  const activePageFilter = pageFilter?.view === viewKey && !isPlayerView ? pageFilter : null;
  const handlePageFilterShortcut = useStableCallback((event: KeyboardEvent) => {
    if (!matchesShortcut(event, "filterPage") || isPlayerView || ["search", "home", "settings"].includes(viewKey)) return;
    if (!acceptsPlaybackShortcut(event) || !mainRef.current?.querySelector(".columnInfo")) return;
    event.preventDefault();
    if (event.repeat) return;
    setPageFilter(current => ({
      view: viewKey,
      query: current?.view === viewKey ? current.query : "",
      focus: (current?.focus ?? 0) + 1,
    }));
  });
  useEffect(() => {
    window.addEventListener("keydown", handlePageFilterShortcut);
    return () => window.removeEventListener("keydown", handlePageFilterShortcut);
  }, [handlePageFilterShortcut]);

  // Optional columns are one choice for every song list, spliced into their grids from the root.
  const chosenTrackColumns = preferences.ui.trackColumns;
  useLayoutEffect(() => {
    const template = optionalColumnsTemplate(chosenTrackColumns);
    if (template) document.documentElement.style.setProperty("--library-extra-columns", template);
    else document.documentElement.style.removeProperty("--library-extra-columns");
  }, [chosenTrackColumns]);
  // Standard columns left out are dropped from every grid by the root's stylesheet (LibraryView.css).
  const hiddenTrackColumns = preferences.ui.hiddenTrackColumns;
  useLayoutEffect(() => {
    if (hiddenTrackColumns.length) document.documentElement.dataset.hiddenColumns = hiddenTrackColumns.join(" ");
    else delete document.documentElement.dataset.hiddenColumns;
  }, [hiddenTrackColumns]);
  const trackColumns = useMemo<TrackColumnsStore>(() => ({
    extra: chosenTrackColumns,
    setExtra: columns => setPreferences(current => ({
      ...current, ui: { ...current.ui, trackColumns: orderedOptionalColumns(columns).map(column => column.key) },
    })),
    hidden: hiddenTrackColumns,
    setHidden: columns => setPreferences(current => ({
      ...current, ui: { ...current.ui, hiddenTrackColumns: hideableTrackColumns.filter(key => columns.includes(key)) },
    })),
    stats: listeningHistory.stats,
  }), [chosenTrackColumns, hiddenTrackColumns, listeningHistory.stats]);

  return (
    <>
      <AppChrome
        currentScreen={screen}
        playerView={showLyrics ? "lyrics" : "bigscreen"}
        lyricsAvailability={lyricsAvailability}
        isFullscreen={isFullscreen}
        onExit={closeCurrentScreen}
        onSelectPlayerView={changeScreen}
      />

      {(player.currentTrack || isPlayerView) && (
        <div className="playerStage" data-open={isPlayerView}>
          <BackgroundArtwork track={player.currentTrack} active={isPlayerView} animate={preferences.ui.animateSwirl}
            playing={player.isPlaying} />
          {isPlayerView && [
            ...leavingLyrics.map((track) => ({ track, leaving: true })),
            ...(lyricsTrack ? [{ track: lyricsTrack, leaving: false }] : []),
          ].map(({ track, leaving }) => <LyricsView key={track.globalId}
            track={track} clock={player.clock} playing={player.isPlaying} onSeek={player.seek}
            motion={preferences.ui.lyricMotion} autoSync={preferences.ui.autoSyncLyrics} globalOffsetMs={preferences.ui.lyricsOffsetMs}
            shown={!leaving && lyricsShown} resting={!leaving && lyricsDrift} leaving={leaving} arriving={!leaving && leavingLyrics.length > 0} />)}
        </div>
      )}
      {(player.currentTrack || isPlayerView) && (
        <AlbumArtwork
          track={player.currentTrack}
          active={isPlayerView}
          layout={lyricsOnStage ? "lyrics" : "center"}
          resting={lyricsDrift}
          direction={skipDirection}
        />
      )}

      <TrackColumnsContext.Provider value={trackColumns}>
      <PageFilterProvider query={activePageFilter?.query ?? ""}>
      {/* Stays mounted, hidden, behind the player, so closing it is instant and every scroll position holds. */}
      <main ref={mainRef} className="appScreen" id={isQueueView ? "queue" : isSettingsView ? "settings" : isSearchView ? "search" : "library"}
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
          <button className="xContainer queueClose" type="button" onClick={closeCurrentScreen}>
            <img src="/x.svg" alt="Close" className="closeBtn" />
          </button>
        )}
        {!isQueueView && !isSettingsView && playlistStore.error && <p role="alert">{playlistStore.error}</p>}
        {isSettingsView ? <SettingsSidebar tab={settingsTab} onSelect={setSettingsTab} onBack={closeCurrentScreen} /> : <Sidebar
          isHomeActive={isHomeView && !isQueueView}
          onOpenHome={() => {
            setBrowseEntity(null);
            setSelectedPlaylistId(null);
            changeScreen("home");
          }}
          isSettingsActive={isSettingsView}
          onOpenSettings={openSettings}
          activeLibrarySection={!isQueueView && !isSettingsView && !isSearchView && !isHomeView && !browseEntity && !selectedPlaylist && !playlistPending ? librarySection : null}
          activePlaylistId={!isQueueView && !isSettingsView && !isSearchView && !isHomeView ? selectedPlaylist?.id ?? null : null}
          onOpenLibrarySection={(section) => {
            setBrowseEntity(null);
            setSelectedPlaylistId(null);
            setLibrarySection(section);
            changeScreen("library");
          }}
          onOpenLibrary={() => {
            setBrowseEntity(null);
            setSelectedPlaylistId(null);
            setLibrarySection("overview");
            changeScreen("library");
          }}
          onCreatePlaylist={createPlaylist}
          onRenamePlaylist={renamePlaylist}
          onDuplicatePlaylist={duplicatePlaylist}
          onDeletePlaylist={deletePlaylist}
          playlists={playlistStore.playlists}
          serviceGroups={servicePlaylistStore.groups}
          servicePlaylistVisibility={preferences.ui.servicePlaylistVisibility}
          playlistGroups={preferences.ui.playlistGroups}
          onTogglePlaylistGroup={(group, expanded) => setPreferences(current => current.ui.playlistGroups[group] === expanded ? current : {
            ...current, ui: { ...current.ui, playlistGroups: { ...current.ui.playlistGroups, [group]: expanded } },
          })}
          onSelectPlaylist={(id) => {
            setBrowseEntity(null);
            setSelectedPlaylistId(id);
            changeScreen("library");
          }}
        />}
        {isSettingsView ? (
          <SettingsView onRescanLocalMusic={library.rescanLocalMusic} tab={settingsTab} onTabChange={setSettingsTab} registerScrollElement={registerScrollElement} showAudioQuality={preferences.ui.showAudioQuality}
            onServiceConnected={() => {
              refreshSearchProviders();
              void servicePlaylistStore.refresh();
              search.retry();
              void library.refreshStreamingMusic();
            }}
            onShowAudioQuality={showAudioQuality => setPreferences(current => ({ ...current, ui: { ...current.ui, showAudioQuality } }))}
            reduceMotion={preferences.ui.reduceMotion}
            onReduceMotion={reduceMotion => setPreferences(current => ({ ...current, ui: { ...current.ui, reduceMotion } }))}
            animateSwirl={preferences.ui.animateSwirl}
            lyricMotion={preferences.ui.lyricMotion}
            autoSyncLyrics={preferences.ui.autoSyncLyrics}
            lyricsOffsetMs={preferences.ui.lyricsOffsetMs}
            onLyricsOffsetChange={lyricsOffsetMs => setPreferences(current => ({ ...current, ui: { ...current.ui, lyricsOffsetMs } }))}
            servicePlaylistVisibility={preferences.ui.servicePlaylistVisibility}
            shortcuts={preferences.ui.shortcuts ?? {}}
            onShortcutsChange={changeShortcuts}
            onServicePlaylistVisibilityChange={(provider, visible) => setPreferences(current => ({
              ...current, ui: { ...current.ui, servicePlaylistVisibility: { ...current.ui.servicePlaylistVisibility, [provider]: visible } },
            }))}
            onAutoSyncLyrics={autoSyncLyrics => setPreferences(current => ({ ...current, ui: { ...current.ui, autoSyncLyrics } }))}
            onLyricMotionChange={lyricMotion => setPreferences(current => ({ ...current, ui: { ...current.ui, lyricMotion } }))}
            onAnimateSwirl={animateSwirl => setPreferences(current => ({ ...current, ui: { ...current.ui, animateSwirl } }))} />
        ) : isQueueView ? (
          <Queue
            onOpenEntity={openEntity}
            currentEntry={queue.currentEntry}
            upcomingEntries={queue.upcomingEntries}
            historyEntries={queue.historyEntries}
            jumpTo={jumpToQueueEntry}
            replayHistory={replayQueueHistoryEntry}
            reorderEntries={queue.reorderEntries}
            deleteEntries={deleteQueueEntries}
            deleteHistoryEntries={queue.removeHistoryEntries}
            registerScrollElement={registerScrollElement}
            playlistOptions={playlistOptions}
            savedTrackIds={libraryTrackIds}
            addToLibrary={addEntityTrack}
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
            allTracks={search.allResults}
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
            error={listeningHistory.error} onAction={onEntityAction}
            onSelectPlaylist={id => {
              setBrowseEntity(null);
              setSelectedPlaylistId(id);
              changeScreen("library");
            }} registerScrollElement={registerScrollElement} />
        ) : selectedPlaylist ? (
          <PlaylistView
            key={selectedPlaylist.id}
            playlist={selectedPlaylist}
            artworkTracks={baseCollectionTracks}
            onRename={selectedPlaylist.editable === false ? undefined : renamePlaylist}
            onDuplicate={() => duplicatePlaylist(selectedPlaylist)}
            onDelete={selectedPlaylist.editable === false ? undefined : deletePlaylist}
            savedTrackIds={libraryTrackIds}
            addToLibrary={id => { const track = baseCollectionTracks.find(track => track.globalId === id); if (track) addEntityTrack(track); }}
            onImprove={selectedPlaylist.provider ? undefined : () => playlistImprovement.improve(selectedPlaylist.id)}
            improvementProgress={playlistImprovement.progress}
            improvementReport={playlistImprovement.reports[selectedPlaylist.id]}
            onExit={playlistImprovement.clear}
            {...collectionViewProps}
          />
        ) : playlistPending ? (
          <div className="libraryView smoothScroll" ref={registerScrollElement}>
            <p className="playlistPending" role="status">
              {localOnly && serverConnectionInfo?.server
                ? `This playlist opens once ${serverConnectionInfo.server.name} reconnects.`
                : "Loading playlist…"}
            </p>
          </div>
        ) : (
          <LibraryView
            key={`library:${librarySection}`}
            {...collectionViewProps}
            section={librarySection}
            onSectionChange={setLibrarySection}
          />
        )}
      </main>
      {activePageFilter && <PageFilterBar query={activePageFilter.query} focusRequest={activePageFilter.focus}
        onQueryChange={query => setPageFilter(current => current && { ...current, query })}
        onClose={() => setPageFilter(null)} />}
      </PageFilterProvider>
      </TrackColumnsContext.Provider>
      {!isPlayerView && <UpdateNotice />}
      {!isPlayerView && !isQueueView && !isSettingsView && servicePlaylistError && !playlistErrorDismissed && (
        <div className="playlistSyncError" role="alert" data-playback-error={!!player.playbackError}>
          <span data-tooltip={servicePlaylistError} data-tooltip-overflow="">{servicePlaylistError}</span>
          <button type="button" aria-label="Dismiss playlist error" data-tooltip="Dismiss"
            onClick={() => setPlaylistErrorDismissed(true)}>
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
              <path d="m3 3 6 6m0-6-6 6" />
            </svg>
          </button>
        </div>
      )}

      <TrackCreditsDialog onOpenArtist={(artist) => openEntity({ kind: "artist", artist })} />
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
        previousActivation={player.previousActivation}
        nextActivation={player.nextActivation}
        playbackError={player.playbackError}
        audioDecks={player.audioDecks}
        onPrevious={player.previous}
        onTogglePlayback={player.togglePlayback}
        onNext={player.next}
        onSeek={player.seek}
        onOpenBigscreen={openPlayer}
        onOpenQueue={openQueue}
        direction={skipDirection}
      />

      <AppScrollbar scrollElement={activeScrollElement} hidden={isPlayerView} />
      <ShortcutToast />
      <NavigationSwipe canNavigate={canNavigate} navigate={navigate} contextKey={`${screen}:${activeViewKey}:${settingsTab}`} />
    </>
  );
}

export default App;
