import "./AppChrome.css";
import "../App.css";

type AppChromeProps = {
  isBigscreen: boolean;
  onExitBigscreen?: () => void;
};

export function AppChrome({ isBigscreen, onExitBigscreen }: AppChromeProps) {
  return (
    <>
      <div className="titlebar" data-tauri-drag-region />

      {isBigscreen && (
        <>
          <button id="xContainer" type="button" onClick={onExitBigscreen}>
            <img src="/x.svg" alt="Close" id="closeBtn" />
          </button>
        </>
      )}
    </>
  );
}
