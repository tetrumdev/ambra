import "./TracksView.css";

import type { Track } from "../types/music";

type LibraryViewProps = {
  tracks: Track[];
  playTrack: (trackIndex: number) => void;
};

export function TracksView({ tracks, playTrack }: LibraryViewProps) {
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
      </div>
      {tracks.map((track, index) => (
        <div className="libraryItem" key={track.id}>
          <div className="trackImgContainer">
            <img
              src={track.cover}
              alt={`${track.album} album cover`}
              className="coverImg"
              onClick={() => playTrack(index)}
            />
          </div>
          <span className="trackName">{track.name}</span>
          <span className="artistName">{track.artist}</span>
          <span className="albumName">{track.album}</span>
        </div>
      ))}
    </div>
  );
}
