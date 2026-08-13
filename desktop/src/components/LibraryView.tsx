import "./LibraryView.css";
import type { GlobalTrackId, LibraryTrack } from "../types/music";
import { TrackList } from "./TrackList";

type LibraryViewProps = {
  tracks: LibraryTrack[];
  playTrack: (trackId: GlobalTrackId) => void;
  playStandalone: (trackId: GlobalTrackId) => void;
  addToQueue: (trackId: GlobalTrackId) => void;
  playNext: (trackId: GlobalTrackId) => void;
  deleteTrack: (trackId: GlobalTrackId) => void;
  deleteTracks: (trackIds: GlobalTrackId[]) => void;
  registerScrollElement: (element: HTMLDivElement | null) => void;
};

export function LibraryView({
  tracks,
  playTrack,
  playStandalone,
  addToQueue,
  playNext,
  deleteTrack,
  deleteTracks,
  registerScrollElement,
}: LibraryViewProps) {
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

  return (
    <div className="libraryView smoothScroll" ref={registerScrollElement}>
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
      </div>
      <TrackList
        tracks={tracks}
        playTrack={playTrack}
        playStandalone={playStandalone}
        addToQueue={addToQueue}
        playNext={playNext}
        deleteTrack={deleteTrack}
        deleteTracks={deleteTracks}
      />
    </div>
  );
}
