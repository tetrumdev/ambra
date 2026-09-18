import "./App.css";

//Components
import { AppChrome } from "./components/AppChrome";
import { LibraryView, type LibrarySection } from "./components/LibraryView";
import { Sidebar } from "./components/Sidebar";
import { Queue } from "./components/Queue";
import { AppScrollbar } from "./components/AppScrollbar";
import { AlbumArtwork, BackgroundArtwork } from "./components/BigscreenArtwork";
import { NowPlayingBar } from "./components/NowPlayingBar";
import { SearchBar } from "./components/SearchBar";
import { SearchView } from "./components/SearchView";
import { PlaylistView } from "./components/PlaylistView";

import { useAudioPlayer } from "./hooks/useAudioPlayer";
import { useMusicLibrary } from "./hooks/useMusicLibrary";
import { useStaleTrackRefresh } from "./hooks/useStaleTrackRefresh";
import { useTrackSearch } from "./hooks/useTrackSearch";
import { queueEntryForTrack, useQueue } from "./hooks/useQueue";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  loadPreferences,
  savePreferences,
  type AppScreen,
} from "./utils/preferences";
import type { GlobalTrackId, Track } from "./types/music";
import { resolveTrackPlayback } from "./api/server";
import {
  collectionQueueContext,
  libraryQueueContext,
  searchQueueContext,
} from "./utils/queueModel";
import { isUnmodifiedKey } from "./utils/keyboard";
import { cachePlaylistArtwork } from "./utils/playlistArtworkCache";

import { playlistTracks } from "./utils/playlists";

import { usePlaylists } from "./hooks/usePlaylists";

function App() {
  const [preferences, setPreferences] = useState(loadPreferences);
  const playlistStore = usePlaylists();
  const playlists = playlistStore.playlists;
  const [selectedPlaylistId, setSelectedPlaylistId] = useState<string | null>(
    null,
  );
  const [librarySection, setLibrarySection] =
    useState<LibrarySection>("overview");
  const searchQuery = preferences.search.query;
  const searchProvider = "all";
  const library = useMusicLibrary();
  const search = useTrackSearch(searchQuery, searchProvider);
  const availableTracks = useMemo(() => {
    const tracksById = new Map<string, Track>(
      [...playlistStore.tracks, ...library.catalogTracks].map((track) => [track.globalId, track]),
    );
    for (const track of search.knownTracks) {
      tracksById.set(track.globalId, track);
    }
    return [...tracksById.values()];
  }, [playlistStore.tracks, library.catalogTracks, search.knownTracks]);
  const queueContext = useMemo(
    () => libraryQueueContext(library.tracks),
    [library.tracks],
  );
  const queue = useQueue(availableTracks, preferences.playback.trackId);
  const playbackTracks = useMemo(() => {
    const tracksById = new Map(
      availableTracks.map((track) => [track.globalId, track]),
    );
    for (const entry of [...queue.historyEntries, ...queue.entries]) {
      tracksById.set(entry.track.globalId, entry.track);
    }
    return [...tracksById.values()];
  }, [availableTracks, queue.entries, queue.historyEntries]);
  const player = useAudioPlayer(playbackTracks, preferences.playback, {
    next: () => queue.next()?.track,
    completeCurrent: () => queue.completeCurrent()?.track,
    previous: () => queue.previous()?.track,
    peekNext: () => queue.peekNext()?.track,
    nextTrack: queue.upcomingEntries[0]?.track,
  });
  useStaleTrackRefresh(
    playlistStore.tracks,
    library.isServerReachable,
    playlistStore.updateTrack,
  );

  useEffect(() => {
    void cachePlaylistArtwork(playlistStore.tracks);
  }, [playlistStore.tracks]);

  useEffect(() => {
    if (library.isServerReachable || library.isLoading) return;

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
  }, [library.isLoading, library.isServerReachable, library.refreshStreamingMusic]);
  const screen = preferences.ui.screen;
  const isBigscreen =
    screen === "bigscreen" && player.currentTrack !== undefined;
  const isQueueView = screen === "queue";
  const isSearchView = screen === "search";
  const persistedPosition = player.isPlaying
    ? Math.floor(player.currentTime / 5) * 5
    : player.currentTime;
  const [isFullscreen, setIsFullscreen] = useState<boolean | null>(null);
  const f11FullscreenRef = useRef(false);
  const queueReturnScreenRef = useRef<"library" | "search">(
    screen === "search" ? "search" : "library",
  );
  const bigscreenReturnScreenRef =
    useRef<Exclude<AppScreen, "bigscreen">>("library");
  if (screen !== "bigscreen") bigscreenReturnScreenRef.current = screen;
  if (screen === "library" || screen === "search") {
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

  const playlistOptions = {
    playlists,
    onAdd: async (playlistId: string, trackId: string) => {
      const track = availableTracks.find(track => track.globalId === trackId);
      return track ? playlistStore.addTrack(playlistId, await resolveTrackPlayback(track, AbortSignal.timeout(8000))) : false;
    },
    onCreate: async (name: string, trackId: string) => {
      const track = availableTracks.find(track => track.globalId === trackId);
      return track ? Boolean(playlistStore.create(name, await resolveTrackPlayback(track, AbortSignal.timeout(8000)))) : false;
    },
  };

  const selectedPlaylist = playlists.find((playlist) => {
    return playlist.id === selectedPlaylistId;
  });
  const activeViewKey = isQueueView
    ? "queue"
    : isSearchView
      ? "search"
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
  const collectionTracks = selectedPlaylist
    ? playlistTracks(selectedPlaylist, availableTracks)
    : library.tracks;
  const activeCollectionContext = selectedPlaylist
    ? collectionQueueContext(collectionTracks, {
        kind: "playlist",
        id: selectedPlaylist.id,
      })
    : queueContext;

  const removeFromCollection = (trackIds: GlobalTrackId[]) => {
    if (selectedPlaylist) {
      playlistStore.removeTracks(selectedPlaylist.id, trackIds);
    } else {
      library.removeTracks(trackIds);
    }
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
      setPreferences((current) => ({
        ...current,
        ui: {
          ...current.ui,
          screen:
            current.ui.screen === "bigscreen"
              ? bigscreenReturnScreenRef.current
              : current.ui.screen === "queue"
                ? queueReturnScreenRef.current
                : "library",
        },
      }));

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

    window.addEventListener("keydown", handleKeyDown, true);

    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
    };
  }, []);

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
          if (current.ui.screen !== "bigscreen") {
            bigscreenReturnScreenRef.current = current.ui.screen;
          }

          return {
            ...current,
            ui: {
              ...current.ui,
              screen:
                current.ui.screen === "bigscreen"
                  ? bigscreenReturnScreenRef.current
                  : "bigscreen",
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
    if (!isBigscreen) {
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
  }, [isBigscreen]);

  useEffect(() => {
    savePreferences(preferences);
  }, [preferences]);

  useEffect(() => {
    if (!player.isSessionRestored) return;

    setPreferences((current) => {
      const playback = player.currentTrack
        ? {
            trackId: player.currentTrack.globalId,
            positionSeconds: persistedPosition,
          }
        : { trackId: null, positionSeconds: 0 };

      if (
        current.playback.trackId === playback.trackId &&
        current.playback.positionSeconds === playback.positionSeconds
      ) {
        return current;
      }

      return { ...current, playback };
    });
  }, [persistedPosition, player.currentTrack, player.isSessionRestored]);

  useEffect(() => {
    const saveLatestSession = () => {
      const latest = latestSessionRef.current;
      if (!latest.player.isSessionRestored) return;

      savePreferences({
        ...latest.preferences,
        playback: latest.player.currentTrack
          ? {
              trackId: latest.player.currentTrack.globalId,
              positionSeconds: latest.player.currentTime,
            }
          : { trackId: null, positionSeconds: 0 },
      });
    };

    window.addEventListener("beforeunload", saveLatestSession);
    return () => window.removeEventListener("beforeunload", saveLatestSession);
  }, []);

  const changeScreen = (nextScreen: AppScreen) => {
    setPreferences((current) => ({
      ...current,
      ui: {
        ...current.ui,
        screen: nextScreen,
      },
    }));
  };

  const changeSearchQuery = (nextQuery: string) => {
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

  const deleteQueueEntries = (queueIds: number[]) => {
    const result = queue.removeEntries(queueIds);
    if (!result.currentRemoved) return;
    if (result.item) player.playTrack(result.item.track.globalId);
    else player.clear();
  };

  const closeCurrentScreen = () => {
    changeScreen(
      screen === "bigscreen"
        ? bigscreenReturnScreenRef.current
        : screen === "queue"
          ? queueReturnScreenRef.current
          : "library",
    );
  };

  const openQueue = () => changeScreen("queue");

  const collectionViewProps = {
    tracks: collectionTracks,
    playlistOptions,
    playTrack: playFromCollection,
    playStandalone: (trackId: GlobalTrackId) =>
      playStandalone(activeCollectionContext, trackId),
    addToQueue: (trackId: GlobalTrackId) =>
      addToQueue(activeCollectionContext, trackId),
    playNext: (trackId: GlobalTrackId) =>
      playNext(activeCollectionContext, trackId),
    removeTracks: removeFromCollection,
    shuffleCollection,
    registerScrollElement,
  };

  return (
    <>
      <AppChrome
        currentScreen={screen}
        isFullscreen={isFullscreen}
        onExit={closeCurrentScreen}
      />

      {player.currentTrack && (
        <>
          <BackgroundArtwork track={player.currentTrack} active={isBigscreen} />
          <AlbumArtwork
            key={player.currentTrack.nativeCover ?? player.currentTrack.cover}
            track={player.currentTrack}
            active={isBigscreen}
          />
        </>
      )}

      {isBigscreen ? null : isQueueView ? (
        <main id="queue">
          <Queue
            currentEntry={queue.currentEntry}
            upcomingEntries={queue.upcomingEntries}
            jumpTo={jumpToQueueEntry}
            deleteEntries={deleteQueueEntries}
            registerScrollElement={registerScrollElement}
          />
        </main>
      ) : (
        <main id={isSearchView ? "search" : "library"}>
          <SearchBar
            query={searchQuery}
            onQueryChange={changeSearchQuery}
            onConfirm={() =>
              changeScreen(searchQuery.trim() ? "search" : "library")
            }
          />
          {playlistStore.error && <p role="alert">{playlistStore.error}</p>}
          <Sidebar
            activeLibrarySection={!isSearchView && !selectedPlaylist ? librarySection : null}
            activePlaylistId={!isSearchView ? selectedPlaylist?.id ?? null : null}
            onOpenLibrarySection={(section) => {
              setSelectedPlaylistId(null);
              setLibrarySection(section);
              changeScreen("library");
            }}
            onOpenLibrary={() => {
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
            playlists={playlists}
            onSelectPlaylist={(id) => {
              setSelectedPlaylistId(id);
              changeScreen("library");
            }}
          />
          {isSearchView ? (
            <SearchView
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
          ) : selectedPlaylist ? (
            <PlaylistView
              key={selectedPlaylist.id}
              playlist={selectedPlaylist}
              {...collectionViewProps}
            />
          ) : (
            <LibraryView
              key={`library:${librarySection}`}
              {...collectionViewProps}
              section={librarySection}
              onSectionChange={setLibrarySection}
              onRescanLocalMusic={library.rescanLocalMusic}
              onServiceConnected={() => {
                search.retry();
                void library.refreshStreamingMusic();
              }}
            />
          )}
        </main>
      )}

      <NowPlayingBar
        variant={isBigscreen ? "expanded" : "compact"}
        track={player.currentTrack}
        currentTime={player.currentTime}
        duration={player.duration}
        isPlaying={player.isPlaying}
        audioDecks={player.audioDecks}
        onPrevious={player.previous}
        onTogglePlayback={player.togglePlayback}
        onNext={player.next}
        onSeek={player.seek}
        onOpenBigscreen={() => changeScreen("bigscreen")}
        onOpenQueue={openQueue}
      />

      {!isBigscreen && <AppScrollbar scrollElement={activeScrollElement} />}
    </>
  );
}

export default App;
