import "./App.css";
import { AppChrome } from "./components/AppChrome";
import { AlbumArtwork, BackgroundArtwork } from "./components/Artwork";
import { NowPlayingBar } from "./components/NowPlayingBar";
import { useAudioPlayer } from "./hooks/useAudioPlayer";
import { useMusicLibrary } from "./hooks/useMusicLibrary";
import { useState } from "react";
import { runLayoutTransition } from "./utils/runLayoutTransition";

type Screen = "bigscreen" | "library";

function App() {
  const [screen, setScreen] = useState<Screen>("bigscreen");
  const library = useMusicLibrary();
  const player = useAudioPlayer(library.tracks);
  const isBigscreen = screen === "bigscreen";

  const changeScreen = (nextScreen: Screen) => {
    runLayoutTransition(() => setScreen(nextScreen));
  };

  if (library.error) {
    return <p>Could not load the music library: {library.error}</p>;
  }

  if (!player.currentTrack) {
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
          <main id="libraryView"></main>
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
