import "./App.css";
import { AppChrome } from "./components/AppChrome";
import { TracksView } from "./components/TracksView";
import { Sidebar } from "./components/Sidebar";
import { Queue } from "./components/Queue";
// import { ClickMenu } from "./components/ClickMenu";
import { AlbumArtwork, BackgroundArtwork } from "./components/BigscreenArtwork";
import { NowPlayingBar } from "./components/NowPlayingBar";
import { useAudioPlayer } from "./hooks/useAudioPlayer";
import { useMusicLibrary } from "./hooks/useMusicLibrary";
import { queueEntryForTrack, useQueue } from "./hooks/useQueue";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  loadPreferences,
  savePreferences,
  type AppScreen,
} from "./utils/preferences";
import type { GlobalTrackId } from "./types/music";
import { libraryQueueContext } from "./utils/queueModel";

function App() {
  const [preferences, setPreferences] = useState(loadPreferences);
  const library = useMusicLibrary();
  const queueContext = useMemo(
    () => libraryQueueContext(library.tracks),
    [library.tracks],
  );
  const queue = useQueue(library.tracks, preferences.playback.trackId);
  const player = useAudioPlayer(library.tracks, preferences.playback, {
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

  const playStandalone = (trackId: GlobalTrackId) => {
    const entry = queueEntryForTrack(queueContext, trackId);
    if (!entry) return;
    queue.playStandalone(entry);
    player.playTrack(trackId);
  };

  const addToQueue = (trackId: GlobalTrackId) => {
    const entry = queueEntryForTrack(queueContext, trackId);
    if (!entry) return;
    const shouldStartPlaying = queue.currentEntry === undefined;
    queue.addToQueue(entry);
    if (shouldStartPlaying) player.playTrack(trackId);
  };

  const playNext = (trackId: GlobalTrackId) => {
    const entry = queueEntryForTrack(queueContext, trackId);
    if (!entry) return;
    const shouldStartPlaying = queue.currentEntry === undefined;
    queue.playNext(entry);
    if (shouldStartPlaying) player.playTrack(trackId);
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
            playTrack={playFromLibrary}
          />
        </main>
      ) : (
        <main id="library">
          <Sidebar />
          <TracksView
            tracks={library.tracks}
            playTrack={playFromLibrary}
            playStandalone={playStandalone}
            addToQueue={addToQueue}
            playNext={playNext}
            addAlbum={library.addAlbum}
            isAddingAlbum={library.isAddingAlbum}
            addAlbumError={library.addAlbumError}
          />
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
    </>
  );
}

export default App;
