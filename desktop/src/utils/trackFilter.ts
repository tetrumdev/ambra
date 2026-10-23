import type { Track } from "../types/music";

/** Case and accent insensitive, so "beyonce" finds "Beyoncé". */
function fold(text: string) {
  return text.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLocaleLowerCase();
}

// Built once per track object; filtering a large library on every keystroke reuses it.
const searchableText = new WeakMap<Track, string>();

function trackText(track: Track) {
  let text = searchableText.get(track);
  if (text === undefined) {
    text = fold([
      track.name, track.version, track.artist,
      ...track.artists.map(artist => artist.name), ...track.albumArtists.map(artist => artist.name),
      track.album, track.albumVersion, track.releaseDate?.slice(0, 4), ...track.genres, track.label, track.quality,
    ].filter(Boolean).join("\n"));
    searchableText.set(track, text);
  }
  return text;
}

export function filterTerms(query: string) {
  return fold(query).split(/\s+/).filter(Boolean);
}

/** Every term must appear somewhere in the song's details, in any order. */
export function trackMatches(track: Track, terms: readonly string[]) {
  if (!terms.length) return true;
  const text = trackText(track);
  return terms.every(term => text.includes(term));
}
