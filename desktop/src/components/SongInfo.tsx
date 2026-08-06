import type { Track } from "../types/music";
import "./SongInfo.css";

type SongInfoProps = {
  track: Track;
};

export function SongInfo({ track }: SongInfoProps) {
  return (
    <div id="songInfo">
      <span id="songName">{track.name}</span>
      <span id="albumName">
        <span className="label">On </span>
        <span className="value">{track.album}</span>
      </span>
      <span id="artistName">
        <span className="label">Performed by </span>
        <span className="value">{track.artist}</span>
      </span>
    </div>
  );
}
