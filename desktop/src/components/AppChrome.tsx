import "./AppChrome.css";

type AppChromeProps = {
  isBigscreen: boolean;
  onExitBigscreen?: () => void;
};

export function AppChrome({ isBigscreen, onExitBigscreen }: AppChromeProps) {
  return (
    <>
      <div className="titlebar" data-tauri-drag-region />

      <div className="mainLogo">
        <img src="/ambra.svg" id="logoImg" />
      </div>

      {isBigscreen && (
        <>
          {/*<h1 className="mainLogo" id="ambraText">
              ambra
            </h1>
            <h4 className="mainLogo" id="smallText">
              by
            </h4>
            <h3 className="mainLogo" id="quantiumText">
              Quantium Labs
            </h3>*/}

          <button id="xContainer" type="button" onClick={onExitBigscreen}>
            <img src="/x.svg" alt="Close" id="closeBtn" />
          </button>
        </>
      )}
    </>
  );
}
