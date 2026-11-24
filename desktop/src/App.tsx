import { isDeviceTrack } from "./utils/nativeAudioSource";
import { DownloadDialog } from "./components/DownloadDialog";
import { DownloadActivity } from "./components/DownloadActivity";
import "./App.css";
import "./components/EntityView.css";
import { EntityView, type EntityPage } from "./components/EntityView";
import { entityKey } from "./utils/browse";

//Components
import { LibraryView } from "./components/LibraryView";
import { HomeView } from "./components/HomeView";
import { Sidebar } from "./components/Sidebar";
import { PlaybackSidebar } from "./components/PlaybackSidebar";
import { AppScrollbar } from "./components/AppScrollbar";
import { NavigationSwipe } from "./components/NavigationSwipe";
// Keep the stage's artwork rules in their original order relative to the playback bar.
import "./components/BigscreenArtwork.css";
import { NowPlayingBar } from "./components/NowPlayingBar";
import { LyricsView } from "./components/LyricsView";
import { SearchBar } from "./components/SearchBar";
import { PlayerStage } from "./components/PlayerStage";
import { SearchView } from "./components/SearchView";
import { PlaylistView } from "./components/PlaylistView";
import { SettingsView } from "./components/SettingsView";
import { SettingsSidebar } from "./components/SettingsSidebar";

import { useAudioPlayer } from "./hooks/useAudioPlayer";
import { useMusicLibrary } from "./hooks/useMusicLibrary";
import { useListeningHistory } from "./hooks/useListeningHistory";
import { useStartupWindow } from "./hooks/useStartupWindow";
import { useAudioSettings } from "./hooks/AudioSettingsContext";
import { useStaleTrackRefresh } from "./hooks/useStaleTrackRefresh";
import { useTrackSearch } from "./hooks/useTrackSearch";
import { useQueue } from "./hooks/useQueue";
import { useQueueStep } from "./hooks/useQueueStep";
import { NowPlayingProvider } from "./hooks/useNowPlaying";
import { isTauri } from "@tauri-apps/api/core";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { getServerConnection, subscribeServerConnection } from "./api/serverConnection";
import { serverStateStatus, subscribeServerState } from "./utils/serverState";
import { useStableCallback } from "./hooks/useStableCallback";
import { useAppNavigation } from "./hooks/useAppNavigation";
import { usePageLayout } from "./hooks/usePageLayout";
import { usePlaybackActions } from "./hooks/usePlaybackActions";
import { useWindowFullscreen } from "./hooks/useWindowFullscreen";
import {
  loadPreferences,
  savePlayback,
  savePreferences,
  isPlayerScreen,
  type AppPreferences,
  type PlaylistGroup,
} from "./utils/preferences";
import { orderPlaylists } from "./utils/playlistOrder";
import type { GlobalTrackId, Playlist, Track } from "./types/music";
import { configuredSearchProviders, resolveTrackPlayback, type SearchProvider, type StreamingProvider } from "./api/server";
import {
  collectionQueueContext,
  libraryQueueContext,
} from "./utils/queueModel";
import { setShortcutOverrides } from "./utils/shortcuts";
import { ShortcutToast } from "./components/ShortcutToast";
import { MusicDropZone } from "./components/MusicDropZone";
import { PageFilterBar } from "./components/PageFilterBar";
import { UpdateNotice } from "./components/UpdateNotice";
import { useAutomaticUpdateChecks } from "./hooks/useAppUpdate";
import { PageFilterProvider } from "./hooks/usePageFilter";
import { TrackColumnsContext, type TrackColumnsStore } from "./hooks/useTrackColumns";
import { hideableTrackColumns, optionalColumnsTemplate, orderedOptionalColumns } from "./utils/trackColumnWidths";
import { cachePlaylistArtwork } from "./utils/playlistArtworkCache";
import { setReducedMotion } from "./utils/reducedMotion";
import { setMaxAnimationFps } from "./utils/frameRate";
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
import { useSettingsProfile } from "./hooks/useSettingsProfile";
import { useCoreQueue } from "./hooks/useCoreQueue";
import { useServicePlaylists } from "./hooks/useServicePlaylists";
import { TrackCreditsDialog } from "./components/TrackCreditsDialog";
import { SongContextMenu } from "./utils/trackMenu";

function App({ localOnly, sharedPlayback = false, awaitingSharedPlayback = false, onPlaybackRelease }: {
  localOnly: boolean;
  sharedPlayback?: boolean;
  /** Still connecting to the server this app plays through; local playback isn't in use yet. */
  awaitingSharedPlayback?: boolean;
  onPlaybackRelease?: (release: () => Promise<void>) => void;
}) {
  // Rerenders when a service connects or drops, so what the pages offer stays current.
  const services = useServiceAvailability();
  const [preferences, setPreferences] = useState(loadPreferences);
  useSettingsProfile(setPreferences);
  // Applied while rendering, before any child's effects read it.
  setReducedMotion(preferences.ui.reduceMotion);
  setMaxAnimationFps(preferences.ui.maxAnimationFps);
  const playlistStore = usePlaylists();
  const listeningHistory = useListeningHistory(sharedPlayback);
  useAutomaticUpdateChecks();
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
    () => preferences.ui.navigation?.playlistId?.replace(/^ambra-server-playlist:[^:]+:/, "") ?? null,
  );
  const playlistImprovement = usePlaylistImprovement(playlistStore.playlists, playlistStore.tracks, playlistStore.replaceTracks, !localOnly);
  const servicePlaylistStore = useServicePlaylists(selectedPlaylistId, !localOnly, preferences.ui.screen === "home");
  const { playlistOrder } = preferences.ui;
  // Every list of playlists follows the order dragged in the sidebar.
  const ambraPlaylists = useMemo(() => orderPlaylists(playlistStore.playlists, playlistOrder.ambra), [playlistStore.playlists, playlistOrder.ambra]);
  const serviceGroups = useMemo(
    () => servicePlaylistStore.groups.map(group => ({ ...group, playlists: orderPlaylists(group.playlists, playlistOrder[group.provider]) })),
    [servicePlaylistStore.groups, playlistOrder],
  );
  const playlists = useMemo(
    () => [...ambraPlaylists, ...orderPlaylists(servicePlaylistStore.playlists, [...playlistOrder.spotify, ...playlistOrder.qobuz, ...playlistOrder.tidal])],
    [ambraPlaylists, servicePlaylistStore.playlists, playlistOrder],
  );
  const homePlaylists = useMemo(
    () => playlists.filter(playlist => !playlist.provider || preferences.ui.servicePlaylistVisibility[playlist.provider]),
    [playlists, preferences.ui.servicePlaylistVisibility],
  );
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
    return () => { searchProvidersRequest.current++; };
  }, [refreshSearchProviders, localOnly, services]);
  const library = useMusicLibrary(localOnly, sharedPlayback);
  const search = useTrackSearch(localOnly ? "" : searchQuery, searchProvider);
  const availableTracks = useMemo(() => {
    const tracksById = new Map<string, Track>();
    for (const tracks of [listeningHistory.tracks, browseTracks, playlistStore.tracks, servicePlaylistStore.tracks, library.catalogTracks, search.knownTracks]) {
      for (const track of tracks) tracksById.set(track.globalId, track);
    }
    const tracks = [...tracksById.values()];
    return sharedPlayback ? tracks.filter(track => !isDeviceTrack(track)) : tracks;
  }, [sharedPlayback, listeningHistory.tracks, browseTracks, playlistStore.tracks, servicePlaylistStore.tracks, library.catalogTracks, search.knownTracks]);
  // Root restores the playback mode and remounts when its queue authority changes.
  const [usingCore] = useState(sharedPlayback);
  /* eslint-disable react-hooks/rules-of-hooks -- `usingCore` never changes while mounted. */
  const queue = usingCore ? useCoreQueue(availableTracks) : useQueue(availableTracks, preferences.playback.trackId,
    // This computer's own queue was last saved when it last played locally, so it stays put
    // while the server it plays through is connecting: it would show a song long since played.
    !library.isRestoring && !awaitingSharedPlayback);
  const playbackTracks = useMemo(() => {
    if (usingCore) return availableTracks;
    let tracks = availableTracks;
    if (queue.historyEntries.length || queue.entries.length) {
      const tracksById = new Map<string, Track>();
      for (const track of availableTracks) tracksById.set(track.globalId, track);
      for (const entries of [queue.historyEntries, queue.entries]) {
        for (const { track } of entries) tracksById.set(track.globalId, track);
      }
      tracks = [...tracksById.values()];
    }
    return localOnly ? tracks.filter(isDeviceTrack) : tracks;
  }, [availableTracks, queue.entries, queue.historyEntries, localOnly, usingCore]);
  const queueStep = useQueueStep(queue);
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
  }, listeningHistory.recordPlay, !awaitingSharedPlayback);
  /* eslint-enable react-hooks/rules-of-hooks */
  useStaleTrackRefresh(
    playlistStore.tracks,
    library.isServerReachable,
    playlistStore.updateTrack,
  );

  useEffect(() => {
    const controller = new AbortController();
    void cachePlaylistArtwork(playlistStore.tracks, controller.signal);
    return () => controller.abort();
  }, [playlistStore.tracks]);

  useEffect(() => {
    void preloadUpcomingBigscreenArtwork(queue.upcomingEntries);
  }, [queue.upcomingEntries]);

  useEffect(() => {
    if (localOnly) return;
    const tracks = queue.upcomingEntries.slice(0, 2).map((entry) => entry.track);
    if (player.currentTrack) tracks.unshift(player.currentTrack);
    const controller = new AbortController();
    void preloadLyrics(tracks, controller.signal);
    if (preferences.ui.autoSyncLyrics && isTauri()) void prepareLyricSync(tracks, controller.signal);
    return () => controller.abort();
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
  const isFullscreen = useWindowFullscreen(
    isPlayerScreen(preferences.ui.screen),
    player.isPlaying,
  );
  const audioSettings = useAudioSettings();
  useStartupWindow(!library.isRestoring && !audioSettings?.loading && isFullscreen !== null);
  const {
    screen, isPlayerView, isSettingsView, isHomeView, isSearchView,
    browseEntity, librarySection, setLibrarySection, settingsTab, setSettingsTab,
    sidebarView, setPlaybackSidebarView, closePlaybackSidebar, sidebarWidth, setSidebarWidth,
    sessionPreferences, goBack, canNavigate, navigate, closeCurrentScreen, changeScreen,
    openEntity, openHome, openLibrarySection, selectPlaylist, openSettings, toggleQueue,
    openPlayer, playerOpenedByKeyRef, hasSearchPage, searchSummon, searchFocus, changeSearchQuery,
    confirmSearch, dismissSearch,
  } = useAppNavigation({
    preferences, setPreferences, selectedPlaylistId, setSelectedPlaylistId,
    hasCurrentTrack: player.currentTrack !== undefined, localOnly,
  });
  const latestSessionRef = useRef({ preferences: sessionPreferences, player, usingCore });
  latestSessionRef.current = { preferences: sessionPreferences, player, usingCore };
  useEffect(() => { onPlaybackRelease?.(() => latestSessionRef.current.player.release()); }, [onPlaybackRelease]);
  function createPlaylist(name: string) {
    return playlistStore.create(name);
  }

  // The queue can restore songs that aren't in the library, history, or loaded search results.
  const findPlaylistTrack = (trackId: string) =>
    availableTracks.find(track => track.globalId === trackId)
      ?? queue.entries.find(({ track }) => track.globalId === trackId)?.track;
  const addTrackToPlaylist = useStableCallback(async (playlistId: string, trackId: string) => {
    const track = findPlaylistTrack(trackId);
    if (!track || !isTrackAvailable(track)) return false;
    if (playlists.find(playlist => playlist.id === playlistId)?.provider)
      return servicePlaylistStore.addTrack(playlistId, track);
    return playlistStore.addTrack(playlistId, await resolveTrackPlayback(track, AbortSignal.timeout(8000)));
  });
  const createPlaylistWithTrack = useStableCallback(async (name: string, trackId: string) => {
    const track = findPlaylistTrack(trackId);
    if (!track || !isTrackAvailable(track)) return false;
    return Boolean(playlistStore.create(name, await resolveTrackPlayback(track, AbortSignal.timeout(8000))));
  });
  // A whole album or other collection, in order; songs already in the playlist are skipped.
  const addTracksToPlaylist = useStableCallback(async (playlistId: string, tracks: Track[]) => {
    const playlist = playlists.find(playlist => playlist.id === playlistId);
    const pending = tracks.filter(track => isTrackAvailable(track) && !playlist?.trackIds.includes(track.globalId));
    if (!playlist || !pending.length) return false;
    if (playlist.provider) {
      for (const track of pending) if (!await servicePlaylistStore.addTrack(playlistId, track)) return false;
      return true;
    }
    const resolved = await Promise.all(pending.map(track => resolveTrackPlayback(track, AbortSignal.timeout(8000))));
    return resolved.every(track => playlistStore.addTrack(playlistId, track));
  });
  const createPlaylistWithTracks = useStableCallback(async (name: string, tracks: Track[]) => {
    const pending = tracks.filter(track => isTrackAvailable(track));
    if (!pending.length) return false;
    const resolved = await Promise.all(pending.map(track => resolveTrackPlayback(track, AbortSignal.timeout(8000))));
    return Boolean(playlistStore.duplicate(name, resolved));
  });
  const togglePickerGroup = useCallback((group: PlaylistGroup, expanded: boolean) => setPreferences(current => current.ui.playlistPickerGroups[group] === expanded ? current : {
    ...current, ui: { ...current.ui, playlistPickerGroups: { ...current.ui.playlistPickerGroups, [group]: expanded } },
  }), []);
  // Stable so playback-clock renders don't invalidate memoized track views.
  const playlistOptions = useMemo(
    () => ({
      // Services whose playlists are hidden in Settings stay out of the picker too.
      playlists: homePlaylists.filter(playlist => playlist.editable !== false),
      onAdd: addTrackToPlaylist, onCreate: createPlaylistWithTrack,
      onAddTracks: addTracksToPlaylist, onCreateWithTracks: createPlaylistWithTracks,
      groups: preferences.ui.playlistPickerGroups, onToggleGroup: togglePickerGroup,
    }),
    [homePlaylists, addTrackToPlaylist, createPlaylistWithTrack, addTracksToPlaylist, createPlaylistWithTracks, preferences.ui.playlistPickerGroups, togglePickerGroup],
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
  const browseContextKey = browseEntity ? entityKey(browseEntity) : null;
  const viewKey = isSettingsView ? "settings"
    : browseContextKey ? `entity:${browseContextKey}`
    : isSearchView ? "search" : isHomeView ? "home"
    : selectedPlaylist || playlistPending ? `playlist:${selectedPlaylistId}`
    : `library:${librarySection}`;
  const { mainRef, activeScrollElement, registerScrollElement, pageFilter } = usePageLayout(viewKey, isPlayerView);

  const collectionSortKey = selectedPlaylist
    ? `playlist:${selectedPlaylist.id}`
    : "library:tracks";
  const collectionSort = collectionSorts[collectionSortKey] ?? null;
  // Kept between renders: every list under it compares this array to skip its own work.
  const baseCollectionTracks = useMemo(
    () => selectedPlaylist ? playlistTracks(selectedPlaylist, availableTracks) : library.tracks,
    [selectedPlaylist, availableTracks, library.tracks],
  );
  const collectionPackages = selectedPlaylist?.packages;
  const collectionStats = collectionSort?.key === "plays" || collectionSort?.key === "lastPlayed"
    ? listeningHistory.stats : undefined;
  const collection = useMemo(() => {
    if (!selectedPlaylist) {
      return { playlist: null, tracks: sortCollectionTracks(library.tracks, collectionSort, collectionStats) };
    }
    // Packaged songs stay together, in their own order, however the playlist is sorted.
    const sorted = sortCollectionTracks(baseCollectionTracks, collectionSort, collectionStats);
    return { playlist: selectedPlaylist, tracks: groupPackagedTracks(sorted, collectionPackages ?? []) };
  }, [selectedPlaylist, library.tracks, baseCollectionTracks, collectionSort, collectionPackages, collectionStats]);
  const collectionTracks = collection.tracks;
  // Built when a song is played or queued from the page, not on every render.
  const activeCollectionContext = () => collection.playlist
    ? collectionQueueContext(collection.tracks, {
        kind: "playlist",
        id: collection.playlist.id,
      }, collectionPackages)
    : libraryQueueContext(collection.tracks);

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

  const removeFromCollection = useStableCallback((trackIds: GlobalTrackId[]) => {
    if (selectedPlaylist) {
      if (selectedPlaylist.provider) void servicePlaylistStore.removeTracks(selectedPlaylist.id, trackIds).catch(() => {});
      else playlistStore.removeTracks(selectedPlaylist.id, trackIds);
    } else {
      library.removeTracks(trackIds);
    }
  });

  const changeCollectionSort = useStableCallback((sort: TrackSort) => {
    setCollectionSorts((current) => ({
      ...current,
      [collectionSortKey]: sort,
    }));
  });

  const reorderCollectionTracks = useStableCallback((orderedTrackIds: GlobalTrackId[]) => {
    if (selectedPlaylist) {
      if (selectedPlaylist.provider) void servicePlaylistStore.reorderTracks(selectedPlaylist.id, orderedTrackIds).catch(() => {});
      else if (!playlistStore.reorderTracks(selectedPlaylist.id, orderedTrackIds)) return;
    } else {
      library.reorderTracks(orderedTrackIds);
    }
    changeCollectionSort(null);
  });

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

  const libraryTrackIds = useMemo(() => new Set(library.tracks.map(track => track.globalId)), [library.tracks]);
  const addEntityTrack = useStableCallback((track: Track) => { if (track.provider !== "local") void library.addTrack(track.provider, track.providerTrackId); });
  // One at a time, so the songs land in the library in album order.
  const addEntityTracks = useStableCallback(async (tracks: Track[]) => {
    for (const track of tracks) if (track.provider !== "local") await library.addTrack(track.provider, track.providerTrackId);
  });
  // The now-playing title's library menu.
  const currentTrackId = player.currentTrack?.globalId;
  const currentInLibrary = currentTrackId !== undefined && libraryTrackIds.has(currentTrackId);
  const currentSongMenu = useMemo(
    () => ({ playlistOptions, inLibrary: currentInLibrary, showAlbumLink: !isPlayerView, onAddToLibrary: addEntityTrack }),
    [playlistOptions, currentInLibrary, isPlayerView, addEntityTrack],
  );

  const {
    onEntityAction, playFromCollection, shuffleCollection,
    playStandaloneFromCollection, addToQueueFromCollection, playNextFromCollection,
    playStandaloneFromSearch, addToQueueFromSearch, playNextFromSearch, selectedSearchTrack,
    jumpToQueueEntry, replayQueueHistoryEntry, deleteQueueEntries,
  } = usePlaybackActions({
    queue, player, activeCollectionContext, search, searchQuery, searchProvider,
    browseContextKey: browseContextKey ?? "browse", rememberTracks,
  });
  const togglePlayback = useStableCallback(() => { void player.togglePlayback(); });
  const updateUiPreferences = useCallback((patch: Partial<AppPreferences["ui"]>) => {
    setPreferences(current => ({ ...current, ui: { ...current.ui, ...patch } }));
  }, []);

  const serviceReadOnly = Boolean(selectedPlaylist?.provider && (!selectedPlaylist.editable || servicePlaylistStore.busy.has(selectedPlaylist.id)));
  const collectionViewProps = {
    onOpenEntity: openEntity,
    tracks: collectionTracks,
    playlistOptions,
    playTrack: playFromCollection,
    playStandalone: playStandaloneFromCollection,
    addToQueue: addToQueueFromCollection,
    playNext: playNextFromCollection,
    removeTracks: serviceReadOnly ? undefined : removeFromCollection,
    reorderTracks: serviceReadOnly ? undefined : reorderCollectionTracks,
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
    <SongContextMenu.Provider value={preferences.ui.songContextMenu}>
    <NowPlayingProvider trackId={player.currentTrack?.globalId} isPlaying={player.isPlaying} togglePlayback={togglePlayback}>
      <PlayerStage
        screen={screen}
        preferredView={preferences.ui.playerView}
        isFullscreen={isFullscreen}
        track={player.currentTrack}
        clock={player.clock}
        duration={player.duration}
        playing={player.isPlaying}
        onSeek={player.seek}
        motion={preferences.ui.lyricMotion}
        autoSync={preferences.ui.autoSyncLyrics}
        globalOffsetMs={preferences.ui.lyricsOffsetMs}
        animateSwirl={preferences.ui.animateSwirl}
        skipDirection={skipDirection}
        openedByKey={playerOpenedByKeyRef}
        onExit={closeCurrentScreen}
        onSelectView={changeScreen}
      />

      <TrackColumnsContext.Provider value={trackColumns}>
      <PageFilterProvider query={pageFilter?.query ?? ""}>
      {/* Stays mounted, hidden, behind the player, so closing it is instant and every scroll position holds. */}
      <main ref={mainRef} className="appScreen" id={isSettingsView ? "settings" : isSearchView ? "search" : "library"}
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
          onConfirm={confirmSearch}
          focusRequest={searchFocus}
          away={hasSearchPage || searchSummon === "on" ? undefined : searchSummon === "dismissed" ? "dismissed" : "page"}
          summoned={!hasSearchPage && searchSummon === "on"}
          onLeave={dismissSearch}
        />}
        {!isSettingsView && playlistStore.error && <p role="alert">{playlistStore.error}</p>}
        {isSettingsView ? <SettingsSidebar tab={settingsTab} onSelect={setSettingsTab} onBack={closeCurrentScreen} /> : <Sidebar
          isHomeActive={isHomeView}
          onOpenHome={openHome}
          isSettingsActive={isSettingsView}
          onOpenSettings={openSettings}
          activeLibrarySection={!isSettingsView && !isSearchView && !isHomeView && !browseEntity && !selectedPlaylist && !playlistPending ? librarySection : null}
          activePlaylistId={!isSettingsView && !isSearchView && !isHomeView ? selectedPlaylist?.id ?? null : null}
          onOpenLibrarySection={openLibrarySection}
          onCreatePlaylist={createPlaylist}
          onRenamePlaylist={renamePlaylist}
          onDuplicatePlaylist={duplicatePlaylist}
          onDeletePlaylist={deletePlaylist}
          playlists={ambraPlaylists}
          serviceGroups={serviceGroups}
          onReorderPlaylists={(group, ids) => setPreferences(current => ({
            ...current, ui: { ...current.ui, playlistOrder: { ...current.ui.playlistOrder, [group]: ids } },
          }))}
          servicePlaylistVisibility={preferences.ui.servicePlaylistVisibility}
          playlistGroups={preferences.ui.playlistGroups}
          onTogglePlaylistGroup={(group, expanded) => setPreferences(current => current.ui.playlistGroups[group] === expanded ? current : {
            ...current, ui: { ...current.ui, playlistGroups: { ...current.ui.playlistGroups, [group]: expanded } },
          })}
          onSelectPlaylist={selectPlaylist}
        />}
        {isSettingsView ? (
          <SettingsView
            tab={settingsTab}
            onTabChange={setSettingsTab}
            preferences={preferences.ui}
            onPreferencesChange={updateUiPreferences}
            registerScrollElement={registerScrollElement}
            onRescanLocalMusic={library.rescanLocalMusic}
            onServiceConnected={() => {
              void servicePlaylistStore.refresh();
              search.retry();
              void library.refreshStreamingMusic().catch(() => {});
            }}
            onServicePlaylistVisibilityChange={(provider, visible) => setPreferences(current => ({
              ...current, ui: { ...current.ui, servicePlaylistVisibility: { ...current.ui.servicePlaylistVisibility, [provider]: visible } },
            }))}
          />
        ) : browseEntity ? <EntityView key={browseContextKey} entity={browseEntity} cache={browseCache.current} libraryTracks={library.tracks}
          onBack={goBack} onOpenEntity={openEntity} onAction={onEntityAction}
          onAddTrack={addEntityTrack} onAddTracks={addEntityTracks}
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
            onAlbumAction={onEntityAction}
            addTracksToLibrary={addEntityTracks}
            savedTrackIds={libraryTrackIds}
            registerScrollElement={registerScrollElement}
          />
        ) : isHomeView ? (
          <HomeView entries={listeningHistory.entries} tracks={availableTracks} playlists={homePlaylists}
            error={listeningHistory.error} onAction={onEntityAction}
            onSelectPlaylist={selectPlaylist} onSelectAlbum={album => openEntity({ kind: "album", album })}
            registerScrollElement={registerScrollElement} />
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
      {pageFilter && <PageFilterBar {...pageFilter} />}
      </PageFilterProvider>
      </TrackColumnsContext.Provider>
      {!isPlayerView && <UpdateNotice />}
      <DownloadDialog />
      <DownloadActivity tracks={availableTracks} hidden={isPlayerView} />
      {!isPlayerView && !isSettingsView && servicePlaylistError && !playlistErrorDismissed && (
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
        canGoBack={queue.historyEntries.length > 0}
        queueStep={queueStep}
        canSkip={queue.upcomingEntries.length > 0}
        onSeek={player.seek}
        onOpenBigscreen={openPlayer}
        onToggleQueue={toggleQueue}
        queueSidebarOpen={sidebarView !== null}
        direction={skipDirection}
      />

      {sidebarView && <PlaybackSidebar
        view={sidebarView}
        floating={isPlayerView}
        preferredWidth={sidebarWidth}
        onResize={setSidebarWidth}
        onChangeView={setPlaybackSidebarView}
        onClose={closePlaybackSidebar}
        currentTrack={player.currentTrack}
        isPlaying={player.isPlaying}
        onTogglePlayback={player.togglePlayback}
        upcoming={queue.upcomingEntries}
        history={queue.historyEntries}
        onJumpTo={jumpToQueueEntry}
        onReplayHistory={replayQueueHistoryEntry}
        onRemove={deleteQueueEntries}
        onRemoveHistory={queue.removeHistoryEntries}
        onReorder={ids => queue.reorderEntries(
          queue.historyEntries.map(({ historyId }) => ({ historyId })),
          ids.map(queueId => ({ queueId })),
        )}
        onOpenEntity={openEntity}
        lyrics={<LyricsView key={player.currentTrack?.globalId} compact
          track={player.currentTrack} clock={player.clock} playing={player.isPlaying} onSeek={player.seek}
          motion={preferences.ui.lyricMotion} autoSync={preferences.ui.autoSyncLyrics} globalOffsetMs={preferences.ui.lyricsOffsetMs} />}
        recent={listeningHistory.entries}
        recentError={listeningHistory.error}
        onRecentAction={(action, track) => onEntityAction(action, [track], track.globalId)}
        playlistOptions={playlistOptions}
        savedTrackIds={libraryTrackIds}
        addToLibrary={addEntityTrack}
      />}

      <AppScrollbar scrollElement={activeScrollElement} hidden={isPlayerView} />
      <ShortcutToast />
      <MusicDropZone onImport={library.importFiles} />
      <NavigationSwipe canNavigate={canNavigate} navigate={navigate} screenRef={mainRef} contextKey={`${screen}:${viewKey}:${settingsTab}`} />
    </NowPlayingProvider>
    </SongContextMenu.Provider>
  );
}

export default App;
