import "./TracksView.css";

import { useState, type FormEvent } from "react";
import type { GlobalTrackId, LibraryTrack } from "../types/music";

type LibraryViewProps = {
  tracks: LibraryTrack[];
  playTrack: (trackId: GlobalTrackId) => void;
  addAlbum: (url: string) => Promise<boolean>;
  isAddingAlbum: boolean;
  addAlbumError: string | null;
};

export function TracksView({
  tracks,
  playTrack,
  addAlbum,
  isAddingAlbum,
  addAlbumError,
}: LibraryViewProps) {
  const [albumUrl, setAlbumUrl] = useState("");
  const totalDurationSeconds = tracks.reduce(
    (total, track) => total + track.durationSeconds,
    0,
  );

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

  return (
    <div className="tracksView">
      <div className="libraryHeader">
        <h1 className="libraryTitle">My Library</h1>
        <div className="libraryInfo">
          <p className="numOfTracks">{formatUnit(tracks.length, "track")}</p>
          <p className="playlistLength">
            {formatUnit(hours, "hour")}, {formatUnit(minutes, "minute")},{" "}
            {formatUnit(seconds, "second")}
          </p>
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
        <div className="libraryItem" key={track.libraryId}>
          <div className="coverImgContainer">
            <img
              src={track.cover}
              alt={`${track.album} album cover`}
              className="coverImg"
              onClick={() => playTrack(track.globalId)}
            />
          </div>
          <span className="trackName">{track.name}</span>
          <span className="artistName">{track.artist}</span>
          <span className="albumName">{track.album}</span>
          <span className="trackDuration">
            {formatTime(track.durationSeconds)}
          </span>
        </div>
      ))}
    </div>
  );
}
