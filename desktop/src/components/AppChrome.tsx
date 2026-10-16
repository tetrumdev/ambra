import type { AppScreen } from "../utils/preferences";
import { canUseWindowDragRegion } from "../utils/windowChrome";
import "./AppChrome.css";
import "../App.css";

type AppChromeProps = {
  currentScreen: AppScreen;
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
  isFullscreen,
  onExit,
  onSelectPlayerView,
}: AppChromeProps) {
  const isWindows = navigator.userAgent.includes("Windows");
  const canDragWindow = canUseWindowDragRegion(
    isWindows ? "windows" : "other",
    isFullscreen,
  );
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

      {(currentScreen === "bigscreen" || currentScreen === "lyrics") && (
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
                  aria-pressed={currentScreen === view.screen}
                  onClick={() => onSelectPlayerView(view.screen)}
                >
                  <img src={view.icon} alt="" className="bigscreenBtn" />
                </button>
              ))}
            </div>
          </div>
        </>
      )}

      {currentScreen === "queue" && (
        <>
          {canDragWindow && (
            <div
              className="libraryTitlebar"
              data-content-layout="queue"
              data-tauri-drag-region
            />
          )}
          <button
            className="xContainer"
            type="button"
            onClick={onExit}
            data-queue-positioning
          >
            <img src="/x.svg" alt="Close" className="closeBtn" />
          </button>
        </>
      )}
    </>
  );
}
