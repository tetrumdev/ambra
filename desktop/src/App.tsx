import "./App.css";

//Components
import { AppChrome } from "./components/AppChrome";
import { TracksView } from "./components/TracksView";
import { Sidebar } from "./components/Sidebar";
import { Queue } from "./components/Queue";
import { AppScrollbar } from "./components/AppScrollbar";
// import { ClickMenu } from "./components/ClickMenu";
import { AlbumArtwork, BackgroundArtwork } from "./components/BigscreenArtwork";
import { NowPlayingBar } from "./components/NowPlayingBar";
import { SearchBar } from "./components/SearchBar";
import { SearchResultsView } from "./components/SearchResultsView";


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
  const player = useAudioPlayer(availableTracks, preferences.playback, {
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
  const persistedPosition = player.isPlaying
    ? Math.floor(player.currentTime / 5) * 5
    : player.currentTime;
  const f11FullscreenRef = useRef(false);
  const latestSessionRef = useRef({ preferences, player });
  latestSessionRef.current = { preferences, player };
  const [activeScrollElement, setActiveScrollElement] =
    useState<HTMLDivElement | null>(null);

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
    const handleContextMenu = (event: MouseEvent) => {
      event.preventDefault();

      console.log("hello");
    };

    window.addEventListener("contextmenu", handleContextMenu);

    return () => {
      window.removeEventListener("contextmenu", handleContextMenu);
    };
  }, []);

  useEffect(() => {
    const handleKeyDown = async (event: KeyboardEvent) => {
      if (event.code !== "Escape") return;

      event.preventDefault();
      event.stopPropagation();

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
      changeScreen("library");
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

  return (
    <>
      <AppChrome
        currentScreen={screen}
        onExit={() => changeScreen("library")}
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
            registerScrollElement={setActiveScrollElement}
          />
        </main>
      ) : (
        <main id="library">
          <SearchBar
            query={searchQuery}
            provider={searchProvider}
            onQueryChange={setSearchQuery}
            onProviderChange={setSearchProvider}
          />
          <Sidebar />
          {searchQuery.trim() ? (
            <SearchResultsView
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
              registerScrollElement={setActiveScrollElement}
            />
          ) : (
            <TracksView
              tracks={library.tracks}
              playTrack={playFromLibrary}
              playStandalone={(trackId) =>
                playStandalone(queueContext, trackId)
              }
              addToQueue={(trackId) => addToQueue(queueContext, trackId)}
              playNext={(trackId) => playNext(queueContext, trackId)}
              addAlbum={library.addAlbum}
              isAddingAlbum={library.isAddingAlbum}
              addAlbumError={library.addAlbumError}
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
        onOpenQueue={() => changeScreen("queue")}
      />

      {!isBigscreen && <AppScrollbar scrollElement={activeScrollElement} />}
    </>
  );
}

export default App;
