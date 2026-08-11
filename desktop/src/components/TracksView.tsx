import "./TracksView.css";
import { ClickMenu } from "./ClickMenu";

import { useState, type FormEvent } from "react";
import type { GlobalTrackId, LibraryTrack } from "../types/music";

type LibraryViewProps = {
  tracks: LibraryTrack[];
  playTrack: (trackId: GlobalTrackId) => void;
  playStandalone: (trackId: GlobalTrackId) => void;
  addToQueue: (trackId: GlobalTrackId) => void;
  playNext: (trackId: GlobalTrackId) => void;
  addAlbum: (url: string) => Promise<boolean>;
  isAddingAlbum: boolean;
  addAlbumError: string | null;
};

export function TracksView({
  tracks,
  playTrack,
  playStandalone,
  addToQueue,
  playNext,
  addAlbum,
  isAddingAlbum,
  addAlbumError,
}: LibraryViewProps) {
  const [albumUrl, setAlbumUrl] = useState("");
  const [hoveredTrackId, setHoveredTrackId] = useState<GlobalTrackId | null>(
    null,
  );
  const totalDurationSeconds = tracks.reduce(
    (total, track) => total + track.durationSeconds,
    0,
  );

  const [xPos, setXPos] = useState(0);
  const [yPos, setYPos] = useState(0);
  const [menuIsShowing, setMenuIsShowing] = useState(false);
  const [menuTrackId, setMenuTrackId] = useState<GlobalTrackId | null>(null);

  const hours = Math.floor(totalDurationSeconds / 3600);
  const minutes = Math.floor((totalDurationSeconds % 3600) / 60);
  const seconds = Math.floor(totalDurationSeconds % 60);

  function formatUnit(value: number, unit: string) {
    return `${value} ${unit}${value === 1 ? "" : "s"}`;
  }

  function formatTime(time: number) {
    const totalSeconds = Math.max(0, Math.floor(time));

    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = String(Math.ceil(totalSeconds % 60)).padStart(2, "0");
    if (hours > 0) {
      return `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`;
    } else {
      return `${minutes}:${seconds}`;
    }
  }

  async function submitAlbum(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const url = albumUrl.trim();
    if (!url || isAddingAlbum) return;

    if (await addAlbum(url)) setAlbumUrl("");
  }

  function showPlayOption(trackId: GlobalTrackId) {
    setHoveredTrackId(trackId);
  }

  function hidePlayOption() {
    setHoveredTrackId(null);
  }

  function showClickMenu(event: React.MouseEvent, trackId: GlobalTrackId) {
    if (event.target !== event.currentTarget) return;

    setXPos(event.clientX);
    setYPos(event.clientY);
    setMenuTrackId(trackId);
    setMenuIsShowing(true);
  }

  function hideClickMenu() {
    setMenuIsShowing(false);
  }

  return (
    <div className="tracksView">
      <ClickMenu
        menuIsShowing={menuIsShowing}
        hideClickMenu={hideClickMenu}
        xPos={xPos}
        yPos={yPos}
        trackId={menuTrackId}
        playTrack={playTrack}
        playStandalone={playStandalone}
        addToQueue={addToQueue}
        playNext={playNext}
      />
      <div className="libraryHeader">
        <h1 className="libraryTitle">My Library</h1>
        <div className="libraryInfo">
          <span className="numOfTracks">
            {formatUnit(tracks.length, "track")}
          </span>
          <span className="separator">•</span>
          <span className="playlistLength">
            {formatUnit(hours, "hour")}, {formatUnit(minutes, "minute")},{" "}
            {formatUnit(seconds, "second")}
          </span>
        </div>
        <form className="albumLinkForm" onSubmit={submitAlbum}>
          <input
            type="url"
            value={albumUrl}
            onChange={(event) => setAlbumUrl(event.target.value)}
            placeholder="Paste Tidal, Qobuz, or Spotify album URL"
            aria-label="Streaming album link"
            aria-invalid={addAlbumError !== null}
            disabled={isAddingAlbum}
          />
          <button
            type="submit"
            aria-label="Add streaming album"
            disabled={isAddingAlbum}
          >
            +
          </button>
        </form>
        {addAlbumError && (
          <p className="albumLinkError" role="alert">
            {addAlbumError}
          </p>
        )}
      </div>
      <div className="columnInfo">
        <span className="trackColumn">Track</span>
        <span className="artistColumn">Artist</span>
        <span className="albumColumn">Album</span>
        <span className="durationColumn">Duration</span>
      </div>
      {tracks.map((track) => (
        <div
          className="libraryItem"
          key={track.libraryId}
          data-menu-open={
            menuIsShowing && menuTrackId === track.globalId ? "true" : undefined
          }
          onClick={(event) => showClickMenu(event, track.globalId)}
        >
          <div
            className="coverImgContainer"
            onMouseEnter={() => showPlayOption(track.globalId)}
            onMouseLeave={hidePlayOption}
          >
            <img
              src="/Play.svg"
              alt=""
              aria-hidden="true"
              className="coverPlayBtn"
              data-variant={
                hoveredTrackId === track.globalId ? "btnEnabled" : "btnDisabled"
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
    </div>
  );
}
