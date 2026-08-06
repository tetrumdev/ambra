import "./LibraryView.css";

import { Track } from "../types/music";

type LibraryViewProps = {
  tracks: Track[];
};

export function LibraryView({ tracks }: LibraryViewProps) {
  return (
    <div id="library-view">
      {tracks.map((track) => (
        <p key={track.audio}>{track.name}</p>
      ))}
    </div>
  );
}
