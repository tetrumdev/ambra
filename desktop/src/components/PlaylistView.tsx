import type { Playlist, Track } from "../types/music";
import { TrackCollectionView, type TrackCollectionViewProps } from "./TrackCollectionView";
import { TrackArtwork } from "./TrackArtwork";

type PlaylistViewProps = Omit<
  TrackCollectionViewProps,
  "title" | "removalLabel" | "collapsibleHeader" | "headerArtwork"
> & {
  playlist: Playlist;
  artworkTracks: Track[];
};

export function PlaylistView({ playlist, artworkTracks, ...props }: PlaylistViewProps) {
  return (
    <TrackCollectionView
      {...props}
      title={playlist.name}
      showProviderIcon
      removalLabel="Remove from Playlist"
      collapsibleHeader
      headerArtwork={
        <div className="playlistArtworkGrid" aria-hidden="true">
          {Array.from({ length: 4 }, (_, index) => {
            const track = artworkTracks[index];
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
