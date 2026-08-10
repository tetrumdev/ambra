import "./ClickMenu.css";
import type { GlobalTrackId } from "../types/music";

type ClickMenu = "clickMenuOn" | "clickMenuOff";

type ClickMenuProps = {
  menuIsShowing: boolean;
  hideClickMenu: () => void;
  xPos: number;
  yPos: number;
  trackId: GlobalTrackId | null;
  playTrack: (trackId: GlobalTrackId) => void;
};

export function ClickMenu({
  menuIsShowing,
  hideClickMenu,
  xPos,
  yPos,
  trackId,
  playTrack,
}: ClickMenuProps) {
  return menuIsShowing ? (
    <div id="preventClickCover" onClick={hideClickMenu}>
      <div id="clickMenu" style={{ left: xPos, top: yPos }}>
        <div id="standalonePlay" className="menuItem">
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
        <div id="addToQueue" className="menuItem">
          Add to Queue
        </div>
        <div id="playNext" className="menuItem">
          Play Next
        </div>
      </div>
    </div>
  ) : (
    <></>
  );
}
