import type { AppScreen } from "../utils/preferences";
import { canUseWindowDragRegion } from "../utils/windowChrome";
import "./AppChrome.css";
import "../App.css";

type AppChromeProps = {
  currentScreen: AppScreen;
  isFullscreen: boolean | null;
  onExit?: () => void;
};

export function AppChrome({
  currentScreen,
  isFullscreen,
  onExit,
}: AppChromeProps) {
  const isWindows = navigator.userAgent.includes("Windows");
  const canDragWindow = canUseWindowDragRegion(
    isWindows ? "windows" : "other",
    isFullscreen,
  );

  return (
    <>
      {(currentScreen === "library" || currentScreen === "search") &&
        canDragWindow && (
          <div className="libraryTitlebar" data-tauri-drag-region />
        )}

      {currentScreen === "bigscreen" && (
        <>
          {canDragWindow && (
            <div className="bigscreenTitlebar" data-tauri-drag-region />
          )}
          <button className="xContainer" type="button" onClick={onExit}>
            <img src="/x.svg" alt="Close" className="closeBtn" />
          </button>
        </>
      )}

      {currentScreen === "queue" && (
        <>
          {canDragWindow && (
            <div className="libraryTitlebar" data-tauri-drag-region />
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
