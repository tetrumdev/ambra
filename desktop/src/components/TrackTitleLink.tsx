import { albumForTrack, type BrowseEntity } from "../utils/browse";
import type { Track } from "../types/music";

export function TrackTitleLink({ track, onOpenEntity, className, id }: {
  track: Track;
  onOpenEntity: (entity: BrowseEntity) => void;
  className?: string;
  id?: string;
}) {
  return (
    <button type="button" id={id} className={className ? `entityLink ${className}` : "entityLink"}
      data-tooltip={track.name} data-tooltip-overflow=""
      onClick={event => {
        event.stopPropagation();
        onOpenEntity({ kind: "album", album: albumForTrack(track), revealTrack: { trackId: track.globalId } });
      }}>
      {track.name}
    </button>
  );
}
