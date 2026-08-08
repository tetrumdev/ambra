import type {AppScreen} from "../utils/preferences";
import "./AppChrome.css";
import "../App.css";

type AppChromeProps = {
    currentScreen: AppScreen;
    onExit?: () => void;
};

export function AppChrome({
                              currentScreen,
                              onExit,
                          }: AppChromeProps) {
    return (
        <>
            {currentScreen === "library" && (
                <>
                    <div className="libraryTitlebar" data-tauri-drag-region/>
                </>
            )}

            {currentScreen === "bigscreen" && (
                <>
                    <div className="bigscreenTitlebar" data-tauri-drag-region/>
                    <button className="xContainer" type="button" onClick={onExit}>
                        <img src="/x.svg" alt="Close" className="closeBtn"/>
                    </button>
                </>
            )}

            {currentScreen === "queue" && (
                <>
                    <div className="libraryTitlebar" data-tauri-drag-region/>
                    <button className="xContainer" type="button" onClick={onExit}>
                        <img src="/x.svg" alt="Close" className="closeBtn"/>
                    </button>
                </>
            )}
        </>
    );
}
