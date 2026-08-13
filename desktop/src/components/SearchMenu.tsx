import "./ClickMenu.css";
import type { GlobalTrackId } from "../types/music";

type SearchMenuProps = {
  hideSearchMenu: () => void;
  xPos: number;
  yPos: number;
  trackId: GlobalTrackId;
  addToLibrary: (trackId: GlobalTrackId) => void;
};

export function SearchMenu({
  hideSearchMenu,
  xPos,
  yPos,
  trackId,
  addToLibrary,
}: SearchMenuProps) {
  return (
    <div id="preventClickCover" onClick={hideSearchMenu}>
      <div id="searchMenu" style={{ left: xPos, top: yPos }}>
        <div
          id="addTrack"
          className="menuItem"
          onClick={() => {
            addToLibrary(trackId);
            hideSearchMenu();
          }}
        >
          Add to Library
        </div>
      </div>
    </div>
  );
}
