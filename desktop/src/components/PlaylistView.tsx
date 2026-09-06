import type { Playlist } from "../types/music";
import { TrackCollectionView, type TrackCollectionViewProps } from "./TrackCollectionView";

type PlaylistViewProps = Omit<TrackCollectionViewProps, "title" | "removalLabel"> & {
  playlist: Playlist;
};

export function PlaylistView({ playlist, ...props }: PlaylistViewProps) {
  return <TrackCollectionView {...props} title={playlist.name} removalLabel="Remove from Playlist" />;
}
