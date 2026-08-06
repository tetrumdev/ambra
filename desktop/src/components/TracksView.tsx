import "./TracksView.css";

import { Track } from "../types/music";

type LibraryViewProps = {
  tracks: Track[];
};

export function TracksView({ tracks }: LibraryViewProps) {
  const totalDurationSeconds = tracks.reduce(
    (total, track) => total + track.durationSeconds,
    0,
  );

  return (
    <div className="tracksView">
      <div className="libraryHeader">
        <h1 className="libraryTitle">My Library</h1>
        <div className="libraryInfo">
          <p className="numOfTracks">{tracks.length} tracks</p>
          <p className="playlistLength">
            {Math.floor(totalDurationSeconds / 3600)} hours{" "}
            {Math.floor(totalDurationSeconds / 60)} minutes{" "}
            {Math.floor(totalDurationSeconds % 60)} seconds
          </p>
        </div>
      </div>
      {tracks.map((track) => (
        <div className="libraryItem" key={track.id}>
          <img src={track.cover} className="coverImg" />
          <span className="trackName">{track.name}</span>
          <span className="artistName">{track.artist}</span>
          <span className="albumName">{track.album}</span>
        </div>
      ))}
    </div>
  );
}
