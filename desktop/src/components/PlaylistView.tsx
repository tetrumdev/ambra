import type { Playlist } from "../types/music";
import { TrackCollectionView, type TrackCollectionViewProps } from "./TrackCollectionView";
import { TrackArtwork } from "./TrackArtwork";

type PlaylistViewProps = Omit<
  TrackCollectionViewProps,
  "title" | "removalLabel" | "collapsibleHeader" | "headerArtwork"
> & {
  playlist: Playlist;
};

export function PlaylistView({ playlist, ...props }: PlaylistViewProps) {
  return (
    <TrackCollectionView
      {...props}
      title={playlist.name}
      removalLabel="Remove from Playlist"
      collapsibleHeader
      headerArtwork={
        <div className="playlistArtworkGrid" aria-hidden="true">
          {Array.from({ length: 4 }, (_, index) => {
            const track = props.tracks[index];
            return track ? (
              <TrackArtwork
                key={`${track.globalId}:${index}`}
                track={track}
                alt=""
              />
            ) : (
              <span key={`empty:${index}`} />
            );
          })}
        </div>
      }
    />
  );
}
