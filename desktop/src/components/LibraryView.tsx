import { TrackCollectionView, type TrackCollectionViewProps } from "./TrackCollectionView";

type LibraryViewProps = Omit<TrackCollectionViewProps, "title" | "removalLabel">;

export function LibraryView(props: LibraryViewProps) {
  return <TrackCollectionView {...props} title="My Library" removalLabel="Remove from Library" />;
}
