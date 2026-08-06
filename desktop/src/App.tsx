import "./App.css";
import { AppChrome } from "./components/AppChrome";
import { TracksView } from "./components/TracksView";
import { Sidebar } from "./components/Sidebar";
import { AlbumArtwork, BackgroundArtwork } from "./components/Artwork";
import { NowPlayingBar } from "./components/NowPlayingBar";
import { useAudioPlayer } from "./hooks/useAudioPlayer";
import { useMusicLibrary } from "./hooks/useMusicLibrary";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useRef, useState } from "react";
import {
  loadPreferences,
  savePreferences,
  type AppScreen,
} from "./utils/preferences";

function App() {
  const [preferences, setPreferences] = useState(loadPreferences);
  const library = useMusicLibrary();
  const player = useAudioPlayer(library.tracks, preferences.playback);
  const screen = preferences.ui.screen;
  const isBigscreen = screen === "bigscreen";
  const persistedPosition = player.isPlaying
    ? Math.floor(player.currentTime / 5) * 5
    : player.currentTime;
  const latestSessionRef = useRef({ preferences, player });
  latestSessionRef.current = { preferences, player };

  useEffect(() => {
    const handleKeyDown = async (event: KeyboardEvent) => {
      if (event.key !== "F11" || event.repeat) return;

      event.preventDefault();

      try {
        const appWindow = getCurrentWindow();
        const isFullscreen = await appWindow.isFullscreen();
        await appWindow.setFullscreen(!isFullscreen);
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
    const handleKeyDown = async (event: KeyboardEvent) => {
      if (event.code !== "Escape" || event.repeat) return;

      changeScreen("library");
    };

    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  useEffect(() => {
    savePreferences(preferences);
  }, [preferences]);

  useEffect(() => {
    if (!player.isSessionRestored || !player.currentTrack) return;

    setPreferences((current) => {
      const playback = {
        trackId: player.currentTrack!.id,
        positionSeconds: persistedPosition,
      };

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
      if (!latest.player.isSessionRestored || !latest.player.currentTrack) {
        return;
      }

      savePreferences({
        ...latest.preferences,
        playback: {
          trackId: latest.player.currentTrack.id,
          positionSeconds: latest.player.currentTime,
        },
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

  if (library.isLoading) {
    return <p>Scanning Library...</p>;
  }

  if (library.error) {
    return <p>Could not load the music library: {library.error}</p>;
  }

  if (!player.currentTrack) {
    return <p>Add music files to ~/Music/Ambra, then relaunch Ambra.</p>;
  }

  if (library.tracks.length === 0) {
    return <p>Add music files to ~/Music/Ambra, then relaunch Ambra.</p>;
  }

  return (
    <>
      {isBigscreen ? (
        <>
          <AppChrome
            isBigscreen={isBigscreen}
            onExitBigscreen={() => changeScreen("library")}
          />
          <AlbumArtwork track={player.currentTrack} />
          <BackgroundArtwork track={player.currentTrack} />
        </>
      ) : (
        <>
          <AppChrome isBigscreen={isBigscreen} />
          <main id="library">
            <Sidebar />
            <TracksView tracks={library.tracks} />
          </main>
        </>
      )}

      <NowPlayingBar
        variant={isBigscreen ? "bigscreen" : "compact"}
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
      />
    </>
  );
}

export default App;
