import type { LyricsAvailability } from "../hooks/useLyricsAvailability";
import type { AppScreen } from "../utils/preferences";
import { canUseWindowDragRegion, desktopPlatform } from "../utils/windowChrome";
import "./AppChrome.css";
import "../App.css";

type AppChromeProps = {
  currentScreen: AppScreen;
  /** The player view on screen, which falls back to the cover when a song has no synced lyrics. */
  playerView: "bigscreen" | "lyrics";
  lyricsAvailability: LyricsAvailability;
  isFullscreen: boolean | null;
  canGoBack: boolean;
  canGoForward: boolean;
  onNavigate: (direction: "back" | "forward") => void;
  onExit?: () => void;
  onSelectPlayerView: (screen: "bigscreen" | "lyrics") => void;
};

const playerViews = [
  { screen: "bigscreen", label: "Album art", icon: "/album.svg" },
  { screen: "lyrics", label: "Lyrics", icon: "/lyrics.svg" },
] as const;
const directions = [
  { direction: "back", label: "Back" },
  { direction: "forward", label: "Forward" },
] as const;

export function AppChrome({
  currentScreen,
  playerView,
  lyricsAvailability,
  isFullscreen,
  canGoBack,
  canGoForward,
  onNavigate,
  onExit,
  onSelectPlayerView,
}: AppChromeProps) {
  const canDragWindow = canUseWindowDragRegion(desktopPlatform(), isFullscreen);
  const isPlayerScreen =
    currentScreen === "bigscreen" || currentScreen === "lyrics";
  const lyricsUnavailable = lyricsAvailability === "none" ? "No lyrics for this song" : undefined;
  const lyricsTooltip = lyricsUnavailable
    ?? (lyricsAvailability === "unsynced" ? "No synced lyrics for this song"
      : lyricsAvailability === "chosenNone" ? "No lyrics from the chosen source" : undefined);
  return (
    <>
      {canDragWindow && (isPlayerScreen
        ? <div className="bigscreenTitlebar" data-window-drag-region />
        : <div className="libraryTitlebar" data-content-layout="library" data-window-drag-region />
      )}
      <nav className="pageHistoryControls" aria-label="Page history"
        data-in-titlebar={canDragWindow || undefined} data-player={isPlayerScreen || undefined}>
        {directions.map(({ direction, label }) => (
          <button key={direction} type="button" aria-label={label} data-tooltip={label} data-direction={direction}
            disabled={direction === "back" ? !canGoBack : !canGoForward}
            onClick={() => onNavigate(direction)}>
            <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8"
              strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M9 4.5 3.5 10 9 15.5M4 10h12.5" />
            </svg>
          </button>
        ))}
      </nav>

      {isPlayerScreen && (
        <>
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
                  data-unavailable={
                    view.screen === "lyrics" && !!lyricsUnavailable
                  }
                  data-tooltip={
                    view.screen === "lyrics" ? lyricsTooltip : undefined
                  }
                  onClick={() => onSelectPlayerView(view.screen)}
                >
                  <img src={view.icon} alt="" className="bigscreenBtn" />
                </button>
              ))}
            </div>
          </div>
        </>
      )}

    </>
  );
}
