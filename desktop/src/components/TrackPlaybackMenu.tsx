import "./TrackMenus.css";
import type { GlobalTrackId } from "../types/music";

type TrackPlaybackMenuProps = {
  onClose: () => void;
  xPos: number;
  yPos: number;
  trackId: GlobalTrackId | null;
  playTrack?: (trackId: GlobalTrackId) => void;
  playStandalone: (trackId: GlobalTrackId) => void;
  addToQueue: (trackId: GlobalTrackId) => void;
  playNext: (trackId: GlobalTrackId) => void;
};

export function TrackPlaybackMenu({
  onClose,
  xPos,
  yPos,
  trackId,
  playTrack,
  playStandalone,
  addToQueue,
  playNext,
}: TrackPlaybackMenuProps) {
  return (
    <div id="trackMenuBackdrop" onClick={onClose}>
      <div
        id="trackPlaybackMenu"
        style={{
          height: playTrack ? 220 : 165,
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
        {playTrack && <div
          id="normalPlay"
          className="menuItem"
          onClick={() => {
            if (trackId !== null) playTrack(trackId);
          }}
        >
          Play from Here
        </div>}
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
