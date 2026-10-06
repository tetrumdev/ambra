import { albumForTrack, artistForTrack, type BrowseEntity } from "../utils/browse";
import type { Track } from "../types/music";
import "./SongInfo.css";

type SongInfoProps = {
  track: Track | undefined;
  onOpenEntity: (entity: BrowseEntity) => void;
};

export function SongInfo({ track, onOpenEntity }: SongInfoProps) {
  return (
    <div id="songInfo">
      <span id="songName" data-tooltip={track?.name} data-tooltip-overflow="">{track?.name ?? "Nothing Playing"}</span>
      {track && (
        <>
          <span id="albumName">
            <span className="label">On </span>
            <button type="button" className="entityLink value" onClick={() => onOpenEntity({ kind: "album", album: albumForTrack(track) })}>{track.album}</button>
          </span>
          <span id="artistName">
            <span className="label">Performed by </span>
            <button type="button" className="entityLink value" onClick={() => onOpenEntity({ kind: "artist", artist: artistForTrack(track) })}>{track.artist}</button>
          </span>
        </>
      )}
    </div>
  );
}
