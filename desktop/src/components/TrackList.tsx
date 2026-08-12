import { useState } from "react";
import type { GlobalTrackId, Track } from "../types/music";
import { ClickMenu } from "./ClickMenu";

type TrackListProps = {
  tracks: Track[];
  playTrack: (trackId: GlobalTrackId) => void;
  playStandalone: (trackId: GlobalTrackId) => void;
  addToQueue: (trackId: GlobalTrackId) => void;
  playNext: (trackId: GlobalTrackId) => void;
};

function formatTime(time: number) {
  const totalSeconds = Math.max(0, Math.floor(time));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = String(Math.ceil(totalSeconds % 60)).padStart(2, "0");

  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`
    : `${minutes}:${seconds}`;
}

export function TrackList({
  tracks,
  playTrack,
  playStandalone,
  addToQueue,
  playNext,
}: TrackListProps) {
  const [hoveredTrackId, setHoveredTrackId] = useState<GlobalTrackId | null>(
    null,
  );
  const [menuPosition, setMenuPosition] = useState({ x: 0, y: 0 });
  const [menuTrackId, setMenuTrackId] = useState<GlobalTrackId | null>(null);
  const [menuIsShowing, setMenuIsShowing] = useState(false);

  function showClickMenu(event: React.MouseEvent, trackId: GlobalTrackId) {
    if (event.target !== event.currentTarget) return;

    setMenuPosition({ x: event.clientX, y: event.clientY });
    setMenuTrackId(trackId);
    setMenuIsShowing(true);
  }

  return (
    <>
      <ClickMenu
        menuIsShowing={menuIsShowing}
        hideClickMenu={() => setMenuIsShowing(false)}
        xPos={menuPosition.x}
        yPos={menuPosition.y}
        trackId={menuTrackId}
        playTrack={playTrack}
        playStandalone={playStandalone}
        addToQueue={addToQueue}
        playNext={playNext}
      />
      <div className="columnInfo">
        <span className="trackColumn">Track</span>
        <span className="artistColumn">Artist</span>
        <span className="albumColumn">Album</span>
        <span className="durationColumn">Duration</span>
      </div>
      {tracks.map((track) => (
        <div
          className="libraryItem"
          key={track.globalId}
          data-menu-open={
            menuIsShowing && menuTrackId === track.globalId ? "true" : undefined
          }
          onClick={(event) => showClickMenu(event, track.globalId)}
        >
          <div
            className="coverImgContainer"
            onMouseEnter={() => setHoveredTrackId(track.globalId)}
            onMouseLeave={() => setHoveredTrackId(null)}
          >
            <img
              src="/Play.svg"
              alt=""
              aria-hidden="true"
              className="coverPlayBtn"
              data-variant={
                hoveredTrackId === track.globalId
                  ? "btnEnabled"
                  : "btnDisabled"
              }
            />
            <img
              src={track.cover}
              alt={`${track.album} album cover`}
              className="coverImg"
              onClick={() => playTrack(track.globalId)}
            />
          </div>
          <span className="trackName trackDescriptor">{track.name}</span>
          <span className="artistName trackDescriptor">{track.artist}</span>
          <span className="albumName trackDescriptor">{track.album}</span>
          <span className="trackDuration trackDescriptor">
            {formatTime(track.durationSeconds)}
          </span>
        </div>
      ))}
    </>
  );
}
