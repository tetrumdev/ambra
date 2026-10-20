import type { LyricsAvailability } from "../hooks/useLyricsAvailability";
import type { AppScreen } from "../utils/preferences";
import { canUseWindowDragRegion } from "../utils/windowChrome";
import "./AppChrome.css";
import "../App.css";

type AppChromeProps = {
  currentScreen: AppScreen;
  /** The player view on screen, which falls back to the cover when a song has no synced lyrics. */
  playerView: "bigscreen" | "lyrics";
  lyricsAvailability: LyricsAvailability;
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
  playerView,
  lyricsAvailability,
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
  const lyricsUnavailable = lyricsAvailability === "none" ? "No lyrics for this song"
    : lyricsAvailability === "unsynced" ? "No synced lyrics for this song" : undefined;
  return (
    <>
      {(currentScreen === "home" ||
        currentScreen === "library" ||
        currentScreen === "search" ||
        currentScreen === "settings") &&
        canDragWindow && (
          <div
            className="libraryTitlebar"
            data-content-layout="library"
            data-tauri-drag-region
          />
        )}

      {isPlayerScreen && (
        <>
          {canDragWindow && (
            <div className="bigscreenTitlebar" data-tauri-drag-region />
          )}
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
                  // Choosing lyrics for a song without synced ones still takes effect from the next song that has them.
                  data-unavailable={view.screen === "lyrics" && !!lyricsUnavailable}
                  data-tooltip={view.screen === "lyrics" ? lyricsUnavailable : undefined}
                  onClick={() => onSelectPlayerView(view.screen)}
                >
                  <img src={view.icon} alt="" className="bigscreenBtn" />
                </button>
              ))}
            </div>
          </div>
        </>
      )}

      {/* The queue's close button sits beside search, in App's top-right controls. */}
      {currentScreen === "queue" && canDragWindow && (
        <div
          className="libraryTitlebar"
          data-content-layout="queue"
          data-tauri-drag-region
        />
      )}
    </>
  );
}
