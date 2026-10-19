import type { AppScreen } from "../utils/preferences";
import { canUseWindowDragRegion } from "../utils/windowChrome";
import { FadeOutOnClose } from "../hooks/useFadeOutOnUnmount";
import "./AppChrome.css";
import "../App.css";

type AppChromeProps = {
  currentScreen: AppScreen;
  /** The screen still fading out behind the player as it opens; its chrome fades with it. */
  backdropScreen?: AppScreen;
  /** Whether the library chrome is fading out behind the player or back in as it closes. */
  swap?: "arriving" | "leaving";
  /** The player view on screen, which falls back to the cover when a song has no lyrics. */
  playerView: "bigscreen" | "lyrics";
  lyricsAvailable: boolean;
  isFullscreen: boolean | null;
  onExit?: () => void;
  onSelectPlayerView: (screen: "bigscreen" | "lyrics") => void;
};

const playerViews = [
  { screen: "bigscreen", label: "Album art", icon: "/albumIcon.svg" },
  { screen: "lyrics", label: "Lyrics", icon: "/lyricsIcon.svg" },
] as const;

export function AppChrome({
  currentScreen,
  backdropScreen,
  swap,
  playerView,
  lyricsAvailable,
  isFullscreen,
  onExit,
  onSelectPlayerView,
}: AppChromeProps) {
  const isWindows = navigator.userAgent.includes("Windows");
  const canDragWindow = canUseWindowDragRegion(
    isWindows ? "windows" : "other",
    isFullscreen,
  );
  const isPlayerScreen = currentScreen === "bigscreen" || currentScreen === "lyrics";
  const chromeScreen = isPlayerScreen ? backdropScreen : currentScreen;
  return (
    <>
      {(chromeScreen === "home" ||
        chromeScreen === "library" ||
        chromeScreen === "search" ||
        chromeScreen === "settings") &&
        canDragWindow && (
          <div
            className="libraryTitlebar"
            data-content-layout="library"
            data-swap={swap}
            data-tauri-drag-region={isPlayerScreen ? undefined : true}
          />
        )}

      {isPlayerScreen && (
        <>
          {canDragWindow && (
            <div className="bigscreenTitlebar" data-tauri-drag-region />
          )}
          <FadeOutOnClose>
            <div className="bigscreenCtrls">
              <button
                className="bigscreenClose xContainer"
                type="button"
                onClick={onExit}
                aria-label="Close player"
              >
                <img src="/x.svg" alt="" className="bigscreenBtn" id="closeBtn" />
              </button>
              <div
                className="bigscreenViewPicker"
                role="group"
                aria-label="Player view"
              >
                {playerViews.map((view) => (
                  <button
                    key={view.label}
                    className="bigscreenViewButton"
                    type="button"
                    aria-label={view.label}
                    aria-pressed={playerView === view.screen}
                    // Choosing lyrics for a song without any still takes effect from the next song that has them.
                    data-unavailable={view.screen === "lyrics" && !lyricsAvailable}
                    data-tooltip={view.screen === "lyrics" && !lyricsAvailable ? "No lyrics for this song" : undefined}
                    onClick={() => onSelectPlayerView(view.screen)}
                  >
                    <img src={view.icon} alt="" className="bigscreenBtn" />
                  </button>
                ))}
              </div>
            </div>
          </FadeOutOnClose>
        </>
      )}

      {chromeScreen === "queue" && (
        <>
          {canDragWindow && (
            <div
              className="libraryTitlebar"
              data-content-layout="queue"
              data-swap={swap}
              data-tauri-drag-region={isPlayerScreen ? undefined : true}
            />
          )}
          <button
            className="xContainer"
            type="button"
            onClick={onExit}
            data-queue-positioning
            data-swap={swap}
            inert={isPlayerScreen}
          >
            <img src="/x.svg" alt="Close" className="closeBtn" />
          </button>
        </>
      )}
    </>
  );
}
