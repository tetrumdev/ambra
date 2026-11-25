import { Fragment } from "react";
import { artistForTrack, type BrowseEntity } from "../utils/browse";
import type { Track } from "../types/music";
import { trackArtistCredits } from "../utils/trackArtists";

/** One link per credited artist, so duets and features each open their own page. */
export function ArtistLinks({
  track,
  onOpenEntity,
  className = "entityLink",
}: {
  track: Track;
  onOpenEntity: (entity: BrowseEntity) => void;
  className?: string;
}) {
  return (
    <>
      {trackArtistCredits(track).map((artist, index) => (
        <Fragment key={`${artist.providerId}:${artist.name}`}>
          {index > 0 && <span className="artistSeparator">, </span>}
          <button
            type="button"
            className={className}
            onClick={(event) => {
              event.stopPropagation();
              onOpenEntity({ kind: "artist", artist: artistForTrack(track, artist) });
            }}
          >
            {artist.name}
          </button>
        </Fragment>
      ))}
    </>
  );
}
