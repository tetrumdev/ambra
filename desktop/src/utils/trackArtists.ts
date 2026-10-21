import type { Track } from "../types/music";

/** Every credited artist, for places that show plain text. */
export function trackArtistNames(track: Track) {
  return track.artists.length
    ? track.artists.map((artist) => artist.name).join(", ")
    : track.artist;
}
