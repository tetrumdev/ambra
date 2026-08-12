import "./TracksView.css";
import { useState, type FormEvent } from "react";
import type { GlobalTrackId, LibraryTrack } from "../types/music";
import { TrackList } from "./TrackList";

type LibraryViewProps = {
  tracks: LibraryTrack[];
  playTrack: (trackId: GlobalTrackId) => void;
  playStandalone: (trackId: GlobalTrackId) => void;
  addToQueue: (trackId: GlobalTrackId) => void;
  playNext: (trackId: GlobalTrackId) => void;
  addAlbum: (url: string) => Promise<boolean>;
  isAddingAlbum: boolean;
  addAlbumError: string | null;
  registerScrollElement: (element: HTMLDivElement | null) => void;
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
  registerScrollElement,
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

  async function submitAlbum(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const url = albumUrl.trim();
    if (!url || isAddingAlbum) return;

    if (await addAlbum(url)) setAlbumUrl("");
  }

  return (
    <div className="tracksView smoothScroll" ref={registerScrollElement}>
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
      <TrackList
        tracks={tracks}
        playTrack={playTrack}
        playStandalone={playStandalone}
        addToQueue={addToQueue}
        playNext={playNext}
      />
    </div>
  );
}
