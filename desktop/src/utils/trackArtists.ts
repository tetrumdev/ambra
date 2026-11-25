import type { Track } from "../types/music";

export function trackArtistCredits(track: Track) {
  return track.artists.length ? track.artists : [{ providerId: track.artist, name: track.artist, imageUrl: null }];
}

/** Every credited artist, for places that show plain text. */
export function trackArtistNames(track: Track) {
  return track.artists.length
    ? track.artists.map((artist) => artist.name).join(", ")
    : track.artist;
}
