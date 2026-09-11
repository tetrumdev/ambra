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
          <img id="menuPlayIcon" className="menuIcon" src="/Play.svg" />
          Standalone Play
        </div>
        {playTrack && (
          <div
            id="normalPlay"
            className="menuItem"
            onClick={() => {
              if (trackId !== null) playTrack(trackId);
            }}
          >
            <img id="menuPlayFromIcon" className="menuIcon" src="/skip.svg" />
            Play from Here
          </div>
        )}
        <div
          id="playNext"
          className="menuItem"
          onClick={() => {
            if (trackId !== null) playNext(trackId);
          }}
        >
          <img id="menuPlayNextIcon" className="menuIcon" src="/playNext.svg" />
          Play Next
        </div>
        <div
          id="addToQueue"
          className="menuItem"
          onClick={() => {
            if (trackId !== null) addToQueue(trackId);
          }}
        >
          <img
            id="menuAddToQueueIcon"
            className="menuIcon"
            src="/addToQueue.svg"
          />
          Add to Queue
        </div>
      </div>
    </div>
  );
}
