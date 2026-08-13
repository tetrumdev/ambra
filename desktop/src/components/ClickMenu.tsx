import "./ClickMenu.css";
import type { GlobalTrackId } from "../types/music";

type ClickMenu = "clickMenuOn" | "clickMenuOff";

type ClickMenuProps = {
  hideClickMenu: () => void;
  xPos: number;
  yPos: number;
  trackId: GlobalTrackId | null;
  playTrack: (trackId: GlobalTrackId) => void;
  playStandalone: (trackId: GlobalTrackId) => void;
  addToQueue: (trackId: GlobalTrackId) => void;
  playNext: (trackId: GlobalTrackId) => void;
};

export function ClickMenu({
  hideClickMenu,
  xPos,
  yPos,
  trackId,
  playTrack,
  playStandalone,
  addToQueue,
  playNext,
}: ClickMenuProps) {
  return (
    <div id="preventClickCover" onClick={hideClickMenu}>
      <div
        id="clickMenu"
        style={{
          left: xPos,
          top: yPos,
          transform: `translate(
            ${xPos >= window.innerWidth - 180 ? "-100%" : "1%"},
            ${yPos >= window.innerHeight - 250 ? "-100%" : "1%"}
          )`,
        }}
      >
        <div
          id="standalonePlay"
          className="menuItem"
          onClick={() => {
            if (trackId !== null) playStandalone(trackId);
          }}
        >
          Standalone Play
        </div>
        <div
          id="normalPlay"
          className="menuItem"
          onClick={() => {
            if (trackId !== null) playTrack(trackId);
          }}
        >
          Play from Here
        </div>
        <div
          id="addToQueue"
          className="menuItem"
          onClick={() => {
            if (trackId !== null) addToQueue(trackId);
          }}
        >
          Add to Queue
        </div>
        <div
          id="playNext"
          className="menuItem"
          onClick={() => {
            if (trackId !== null) playNext(trackId);
          }}
        >
          Play Next
        </div>
      </div>
    </div>
  );
}
