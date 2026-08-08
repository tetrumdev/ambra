import type { Track } from "../types/music";
import "./BigscreenArtwork.css";

type ArtworkProps = {
  track: Track;
};

export function AlbumArtwork({ track }: ArtworkProps) {
  return (
    <div id="albumCover">
      <img
        key={track.audio}
        src={track.cover}
        alt={`${track.album} album cover`}
        id="albumCoverImg"
      />
    </div>
  );
}

export function BackgroundArtwork({ track }: ArtworkProps) {
  return (
    <div id="backgroundFX" aria-hidden="true">
      <img
        key={track.audio}
        src={track.cover}
        alt=""
        id="backgroundFXImg"
      />
    </div>
  );
}
