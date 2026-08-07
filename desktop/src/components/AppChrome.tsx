import "./AppChrome.css";
import "../App.css";

type AppChromeProps = {
  isBigscreen: boolean;
  onExitBigscreen?: () => void;
};

export function AppChrome({ isBigscreen, onExitBigscreen }: AppChromeProps) {
  return (
    <>
      {!isBigscreen && (
        <div className="libraryTitlebar" data-tauri-drag-region />
      )}

      {isBigscreen && (
        <>
          <div className="bigscreenTitlebar" data-tauri-drag-region />
          <button id="xContainer" type="button" onClick={onExitBigscreen}>
            <img src="/x.svg" alt="Close" id="closeBtn" />
          </button>
        </>
      )}
    </>
  );
}
