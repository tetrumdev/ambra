import "./App.css";

//Components
import { AppChrome } from "./components/AppChrome";
import { LibraryView } from "./components/LibraryView";
import { Sidebar } from "./components/Sidebar";
import { Queue } from "./components/Queue";
import { AppScrollbar } from "./components/AppScrollbar";
// import { ClickMenu } from "./components/ClickMenu";
import { AlbumArtwork, BackgroundArtwork } from "./components/BigscreenArtwork";
import { NowPlayingBar } from "./components/NowPlayingBar";
import { SearchBar } from "./components/SearchBar";
import { SearchView } from "./components/SearchView";


import { useAudioPlayer } from "./hooks/useAudioPlayer";
import { useMusicLibrary } from "./hooks/useMusicLibrary";
import { useTrackSearch } from "./hooks/useTrackSearch";
import { queueEntryForTrack, useQueue } from "./hooks/useQueue";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  loadPreferences,
  savePreferences,
  type AppScreen,
} from "./utils/preferences";
import type { GlobalTrackId, Track } from "./types/music";
import type { SearchProvider } from "./api/server";
import {
  libraryQueueContext,
  searchQueueContext,
} from "./utils/queueModel";

function App() {
  const [preferences, setPreferences] = useState(loadPreferences);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchProvider, setSearchProvider] =
    useState<SearchProvider>("tidal");
  const library = useMusicLibrary();
  const search = useTrackSearch(searchQuery, searchProvider);
  const availableTracks = useMemo(() => {
    const tracksById = new Map<string, Track>(
      library.tracks.map((track) => [track.globalId, track]),
    );
    for (const track of search.knownTracks) {
      tracksById.set(track.globalId, track);
    }
    return [...tracksById.values()];
  }, [library.tracks, search.knownTracks]);
  const queueContext = useMemo(
    () => libraryQueueContext(library.tracks),
    [library.tracks],
  );
  const currentSearchContext = useMemo(
    () =>
      searchQueueContext(
        search.results,
        `search:${searchProvider}:${searchQuery.trim()}`,
      ),
    [search.results, searchProvider, searchQuery],
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
  const screen = preferences.ui.screen;
  const isBigscreen =
    screen === "bigscreen" && player.currentTrack !== undefined;
  const isQueueView = screen === "queue";
  const isSearchView = screen === "search";
  const persistedPosition = player.isPlaying
    ? Math.floor(player.currentTime / 5) * 5
    : player.currentTime;
  const [isFullscreen, setIsFullscreen] = useState(false);
  const f11FullscreenRef = useRef(false);
  const queueReturnScreenRef = useRef<"library" | "search">(
    screen === "search" ? "search" : "library",
  );
  if (screen === "library" || screen === "search") {
    queueReturnScreenRef.current = screen;
  }
  const latestSessionRef = useRef({ preferences, player });
  latestSessionRef.current = { preferences, player };
  const [activeScrollElement, setActiveScrollElement] =
    useState<HTMLDivElement | null>(null);

  useEffect(() => {
    let disposed = false;
    let stopListening: (() => void) | undefined;
    const appWindow = getCurrentWindow();
    const syncFullscreen = async () => {
      try {
        const fullscreen = await appWindow.isFullscreen();
        if (!disposed) setIsFullscreen(fullscreen);
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
      isFullscreen,
    );

    return () => {
      document.documentElement.removeAttribute("data-window-fullscreen");
    };
  }, [isFullscreen]);

  useEffect(() => {
    const handleKeyDown = async (event: KeyboardEvent) => {
      if (event.key !== "F11" || event.repeat) return;

      event.preventDefault();

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

    window.addEventListener("contextmenu", disableContextMenu, true);
    return () => {
      window.removeEventListener("contextmenu", disableContextMenu, true);
    };
  }, []);

  useEffect(() => {
    const handleKeyDown = async (event: KeyboardEvent) => {
      if (event.code !== "Escape") return;

      event.preventDefault();
      event.stopPropagation();

      if (event.target instanceof HTMLInputElement && event.target.id === "input") {
        event.target.blur();
        return;
      }

      if (f11FullscreenRef.current) {
        if (event.repeat) return;

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

      if (event.repeat) return;
      setPreferences((current) => ({
        ...current,
        ui: { ...current.ui, screen: queueReturnScreenRef.current },
      }));
    };

    window.addEventListener("keydown", handleKeyDown, true);

    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
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
    setSearchQuery(nextQuery);
    changeScreen(nextQuery.trim() ? "search" : "library");
  };

  const playFromLibrary = (trackId: GlobalTrackId) => {
    queue.playFromContext(queueContext, trackId);
    player.playTrack(trackId);
  };

  const playFromSearch = (trackId: GlobalTrackId) => {
    queue.playFromContext(currentSearchContext, trackId);
    player.playTrack(trackId);
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
      screen === "queue" ? queueReturnScreenRef.current : "library",
    );
  };

  const openQueue = () => changeScreen("queue");

  return (
    <>
      <AppChrome
        currentScreen={screen}
        onExit={closeCurrentScreen}
      />

      {isBigscreen ? (
        <>
          <AlbumArtwork track={player.currentTrack!} />
          <BackgroundArtwork track={player.currentTrack!} />
        </>
      ) : isQueueView ? (
        <main id="queue">
          <Queue
            currentEntry={queue.currentEntry}
            upcomingEntries={queue.upcomingEntries}
            jumpTo={jumpToQueueEntry}
            deleteEntries={deleteQueueEntries}
            registerScrollElement={setActiveScrollElement}
          />
        </main>
      ) : (
        <main id={isSearchView ? "search" : "library"}>
          <SearchBar
            query={searchQuery}
            provider={searchProvider}
            onQueryChange={changeSearchQuery}
            onProviderChange={setSearchProvider}
          />
          <Sidebar />
          {isSearchView ? (
            <SearchView
              query={searchQuery}
              provider={searchProvider}
              tracks={search.results}
              isSearching={search.isSearching}
              error={search.error}
              playTrack={playFromSearch}
              playStandalone={(trackId) =>
                playStandalone(currentSearchContext, trackId)
              }
              addToQueue={(trackId) =>
                addToQueue(currentSearchContext, trackId)
              }
              playNext={(trackId) =>
                playNext(currentSearchContext, trackId)
              }
              addToLibrary={(trackId) => {
                const track = search.results.find(
                  (candidate) => candidate.globalId === trackId,
                );
                if (
                  track &&
                  (track.provider === "tidal" ||
                    track.provider === "qobuz" ||
                    track.provider === "spotify")
                ) {
                  void library.addTrack(track.provider, track.providerTrackId);
                }
              }}
              registerScrollElement={setActiveScrollElement}
            />
          ) : (
            <LibraryView
              tracks={library.tracks}
              playTrack={playFromLibrary}
              playStandalone={(trackId) =>
                playStandalone(queueContext, trackId)
              }
              addToQueue={(trackId) => addToQueue(queueContext, trackId)}
              playNext={(trackId) => playNext(queueContext, trackId)}
              deleteTrack={library.deleteTrack}
              deleteTracks={library.deleteTracks}
              registerScrollElement={setActiveScrollElement}
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
