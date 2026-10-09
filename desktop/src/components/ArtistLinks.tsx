import { Fragment } from "react";
import { artistForTrack, type BrowseEntity } from "../utils/browse";
import type { Track } from "../types/music";

/** Every credited artist, for places that show plain text. */
export function trackArtistNames(track: Track) {
  return track.artists.length
    ? track.artists.map((artist) => artist.name).join(", ")
    : track.artist;
}

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
  const artists = track.artists.length ? track.artists : [undefined];
  return (
    <>
      {artists.map((artist, index) => (
        <Fragment key={artist ? `${artist.providerId}:${artist.name}` : index}>
          {index > 0 && ", "}
          <button
            type="button"
            className={className}
            onClick={(event) => {
              event.stopPropagation();
              onOpenEntity({ kind: "artist", artist: artistForTrack(track, artist) });
            }}
          >
            {artist?.name ?? track.artist}
          </button>
        </Fragment>
      ))}
    </>
  );
}
