import "./ClickMenu.css";
import type { GlobalTrackId } from "../types/music";

type DeleteMenuProps = {
  hideDeleteMenu: () => void;
  xPos: number;
  yPos: number;
  trackId: GlobalTrackId;
  deleteTrack: (trackId: GlobalTrackId) => void;
};

export function DeleteMenu({
  hideDeleteMenu,
  xPos,
  yPos,
  trackId,
  deleteTrack,
}: DeleteMenuProps) {
  return (
    <div id="preventClickCover" onClick={hideDeleteMenu}>
      <div id="deleteMenu" style={{ left: xPos, top: yPos }}>
        <div
          id="deleteTrack"
          className="menuItem"
          onClick={() => {
            deleteTrack(trackId);
            hideDeleteMenu();
          }}
        >
          Delete
        </div>
      </div>
    </div>
  );
}
