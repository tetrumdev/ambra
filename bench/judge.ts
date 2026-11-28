/**
 * Scores what a screen showed against a query's label. Deliberately independent of the app's
 * matching code (its own folding, its own idea of a variant), so tuning the app can't quietly
 * move the yardstick.
 */
import type { CatalogAlbum, CatalogArtist } from "../desktop/src/api/server";
import type { Track } from "../desktop/src/types/music";
import type { Section, View } from "./pipelines";

type Names = string | string[];
export type Label = {
  id: string; split: "dev" | "holdout"; q: string; cat: string[]; lead: Section; ok?: Section[];
  t?: { t?: Names; a?: Names; album?: string; v?: string; clean?: boolean; with?: Names; words?: (string | string[])[]; composer?: string };
  al?: { t?: Names; a?: Names; words?: string[] };
  ar?: { n: Names; known?: Names };
  no?: { s: Section; a?: string; t?: string }[];
};

const list = (value: Names | undefined) => value === undefined ? [] : Array.isArray(value) ? value : [value];

export function norm(value: string) {
  const folded = value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase()
    .replace(/['’‘`´]/g, "").replace(/\$/g, "s").replace(/(?<=\p{L})!(?=\p{L})/gu, "i").replace(/!/g, "")
    .replace(/\b(\p{L})\.(?=\p{L}\.)/gu, "$1").replace(/&|\+/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  return folded || value.trim().toLowerCase();
}

/** A title without its bracketed notes, " - …" suffix or guest credit. */
export function baseTitle(value: string) {
  const stripped = value.replace(/\s*[([{][^)\]}]*[)\]}]/g, " ").replace(/\s+[-–—]\s+.*$/, "").replace(/\s+(feat\.?|ft\.?|featuring)\s+.*$/i, "");
  return norm(stripped.trim() ? stripped : value);
}

const EDITION = /\b(deluxe|remaster(ed)?|anniversary|expanded|edition|version|bonus|reissue|explicit|super|legacy|special|collector'?s?|\d{4})\b/i;
/** An album title without edition notes; "(Live)" and the like stay, they're other records. */
export function albumBase(value: string) {
  const stripped = value.replace(/\s*[([]([^)\]]*)[)\]]/g, (whole, note: string) => EDITION.test(note) || /taylor.?s version/i.test(note) ? " " : whole)
    .replace(/\s+[-–—:]\s+([^-–—:]+)$/, (whole, note: string) => EDITION.test(note) ? "" : whole);
  return norm(stripped.trim() ? stripped : value);
}

const VARIANTS = ["live", "remix", "acoustic", "instrumental", "edit", "demo", "karaoke", "cover", "acapella", "unplugged", "sped up", "slowed", "mix"];
/** The kinds of alternate take a track's notes name. */
export function variantOf(track: Track) {
  const notes = norm([...(track.name.match(/[([{][^)\]}]*[)\]}]|\s[-–—]\s.*$/g) ?? []), track.version ?? ""].join(" "));
  return VARIANTS.filter(word => new RegExp(`\\b${word}\\b`).test(notes) && !(word === "mix" && /\boriginal mix\b/.test(notes)));
}

const JUNK = /\b(karaoke|tribute|in the style of|made famous|originally performed|lullaby|lullabies|8 bit|8bit|music box|piano version|for babies|for kids|nightcore|sped up|slowed|backing track|cover version|cover)\b/;
export function junkText(...values: string[]) { return JUNK.test(norm(values.join(" "))); }
const junkTrack = (track: Track) => junkText(track.name, track.version ?? "", track.artist, track.album);
const junkAlbum = (album: CatalogAlbum) => junkText(album.title, album.artist, album.version ?? "");

export function credits(track: Track) {
  const names = [track.artist, ...track.artists.map(artist => artist.name)];
  const guests = track.name.match(/(?:feat\.?|ft\.?|featuring|with)\s+([^)\]]+)/i)?.[1];
  if (guests) names.push(guests);
  return new Set(names.flatMap(name => [name, ...name.split(/\s*(?:,|&|\band\b|\bx\b|\bfeat\.?|\bft\.?|\bwith\b)\s*/i)]).map(norm).filter(Boolean));
}
const albumCredits = (album: CatalogAlbum) => new Set([album.artist, ...(album.artists ?? []).map(artist => artist.name)]
  .flatMap(name => [name, ...name.split(/\s*(?:,|&|\band\b)\s*/i)]).map(norm).filter(Boolean));

const named = (wanted: Names | undefined, have: Set<string>) => list(wanted).some(name => have.has(norm(name)));
const words = (text: string, groups: (string | string[])[]) => {
  const value = ` ${norm(text)} `;
  return groups.every(group => list(group).some(word => value.includes(` ${norm(word)} `)));
};

/** Whether a track is the label's song: title, artist, the asked-for variant and guest. */
export function trackHit(track: Track, label: NonNullable<Label["t"]>) {
  if (label.words) {
    if (!words(`${track.name} ${track.version ?? ""} ${track.album}`, label.words)) return false;
  } else if (!list(label.t).some(title => baseTitle(title) === baseTitle(track.name))) return false;
  if (label.a && !named(label.a, credits(track))) return false;
  if (label.with && !named(label.with, credits(track))) return false;
  const variant = variantOf(track);
  if (label.v ? !variant.includes(label.v) : !label.words && variant.length > 0) return false;
  if (label.clean && track.explicit) return false;
  return !(!label.v && !label.words && junkTrack(track));
}

export function albumHit(album: CatalogAlbum, label: NonNullable<Label["al"]>) {
  if (label.words) { if (!words(album.title, label.words)) return false; }
  else if (!list(label.t).some(title => albumBase(title) === albumBase(album.title) || norm(title) === norm(album.title))) return false;
  return !label.a || named(label.a, albumCredits(album));
}

export function artistHit(artist: CatalogArtist, names: Names) {
  return list(names).some(name => norm(name) === norm(artist.name));
}

/** The label for each section, derived where the query only names one kind of thing. */
function sectionLabels(label: Label) {
  const artistNames = label.ar?.n ?? label.t?.a ?? label.al?.a;
  const byArtist = list(label.ar?.n ?? label.t?.a ?? label.al?.a);
  return {
    tracks: label.t ? { hit: (track: Track) => trackHit(track, label.t!), related: (track: Track) => !junkTrack(track) && named(byArtist, credits(track)) }
      : label.ar ? { hit: (track: Track) => trackHit(track, { t: label.ar!.known ?? [], a: label.ar!.n }), related: (track: Track) => !junkTrack(track) && named(byArtist, credits(track)) }
        : null,
    albums: label.al ? { hit: (album: CatalogAlbum) => albumHit(album, label.al!), related: (album: CatalogAlbum) => !junkAlbum(album) && named(byArtist, albumCredits(album)) }
      : label.t?.album ? { hit: (album: CatalogAlbum) => albumHit(album, { t: label.t!.album, a: label.t!.a }), related: (album: CatalogAlbum) => !junkAlbum(album) && named(byArtist, albumCredits(album)) }
        : null,
    artists: artistNames ? { hit: (artist: CatalogArtist) => artistHit(artist, artistNames), related: () => false } : null,
  };
}

function dcg(grades: number[]) { return grades.reduce((sum, grade, index) => sum + (2 ** grade - 1) / Math.log2(index + 2), 0); }

/** Lossless by its own words: services call it FLAC, LOSSLESS or HI_RES_LOSSLESS. */
export const losslessCopy = (track: Track) => /flac|lossless|alac|hi.?res/i.test(track.quality ?? "") || ["tidal", "qobuz"].includes(track.provider) && !track.quality?.match(/aac|mp3|ogg|vorbis/i);
const COMPILATION = /\b(greatest hits|best of|collection|anthology|essential|essentials|hits|gold|platinum|now thats|very best|singles|the definitive|playlist|80s|90s|00s|workout|party|classics|ultimate)\b/;
export const compilationCopy = (track: Track) => COMPILATION.test(norm(track.album)) || track.albumArtists.some(artist => /^various/i.test(artist.name));
const sameSong = (a: Track, b: Track) => baseTitle(a.name) === baseTitle(b.name) && [...credits(a)].some(name => credits(b).has(name))
  && variantOf(a).join() === variantOf(b).join() && Math.abs(a.durationSeconds - b.durationSeconds) <= 4;

export type Score = {
  leadPredicted: Section; leadHit: boolean;
  top1: boolean;
  section: Record<Section, { mrr: number; ndcg: number | null; top1: boolean } | null>;
  forbidden: boolean;
  duplicates: number;
  duplicatesBySection: Record<Section, string[]>;
  copyOk: boolean | null;
  editionOk: boolean | null;
  consistency: { album: boolean | null; artist: boolean | null; artistTracks: boolean | null; artistAlbums: boolean | null };
  disambiguation: boolean | null;
  empty: boolean;
};

/** What makes two entries the same thing to a listener: duplicates, and items nDCG counts once. */
const itemKey = {
  tracks: (track: Track) => `${baseTitle(track.name)}|${norm(track.artist)}|${variantOf(track).join()}`,
  albums: (album: CatalogAlbum) => `${albumBase(album.title)}|${norm(album.artist)}|${norm(album.version ?? "")}`,
  artists: (artist: CatalogArtist) => norm(artist.name),
};

export function score(label: Label, view: View, pool: { tracks: Track[]; albums: CatalogAlbum[]; artists: CatalogArtist[] }): Score {
  const labels = sectionLabels(label);
  const visible: Record<Section, unknown[]> = { tracks: view.tracks, albums: view.albums, artists: view.artists };
  const empty = !view.tracks.length && !view.albums.length && !view.artists.length;
  const leadPredicted = view.order[0];
  const section = {} as Score["section"];
  for (const name of ["tracks", "albums", "artists"] as Section[]) {
    const judge = labels[name] as { hit: (item: unknown) => boolean; related: (item: unknown) => boolean } | null;
    if (!judge) { section[name] = null; continue; }
    const items = visible[name].slice(0, 10);
    const rank = items.findIndex(item => judge.hit(item));
    // Each distinct song, album or name counts once, on screen and in the ideal list alike:
    // a second recording of the expected song is not a second relevant result.
    const key = itemKey[name] as (item: unknown) => string;
    const counted = new Set<string>();
    const grades = items.slice(0, 5).map(item => {
      const k = key(item);
      if (counted.has(k)) return 0;
      counted.add(k);
      return judge.hit(item) ? 2 : judge.related(item) ? 1 : 0;
    });
    const best = new Map<string, number>();
    for (const item of pool[name] as unknown[]) best.set(key(item), Math.max(best.get(key(item)) ?? 0, judge.hit(item) ? 2 : judge.related(item) ? 1 : 0));
    const available = [...best.values()].sort((a, b) => b - a).slice(0, 5);
    const ideal = dcg(available);
    section[name] = { mrr: rank < 0 ? 0 : 1 / (rank + 1), ndcg: ideal > 0 ? dcg(grades) / ideal : null, top1: rank === 0 };
  }
  const leadHit = [label.lead, ...label.ok ?? []].includes(leadPredicted) && !empty;
  const top1 = !empty && !!section[leadPredicted]?.top1;

  // Junk, and what the label rules out, among each section's first five.
  const asksJunk = junkText(label.q);
  const forbidden = view.tracks.slice(0, 5).some(track => !asksJunk && junkTrack(track))
    || view.albums.slice(0, 5).some(album => !asksJunk && junkAlbum(album))
    || (label.no ?? []).some(rule => rule.s === "tracks"
      ? view.tracks.slice(0, 5).some(track => (!rule.a || credits(track).has(norm(rule.a))) && (!rule.t || baseTitle(track.name) === baseTitle(rule.t)))
      : rule.s === "albums" ? view.albums.slice(0, 5).some(album => (!rule.a || albumCredits(album).has(norm(rule.a))) && (!rule.t || albumBase(album.title) === albumBase(rule.t)))
        : view.artists.slice(0, 5).some(artist => !rule.a || norm(artist.name) === norm(rule.a)));

  // The same song, album or name twice among the first ten of a section.
  const dupes = <T>(items: T[], key: (item: T) => string) => {
    const seen = new Set<string>();
    const repeated: string[] = [];
    for (const item of items.slice(0, 10)) { const k = key(item); if (seen.has(k)) repeated.push(k); seen.add(k); }
    return repeated;
  };
  const duplicatesBySection = {
    tracks: dupes(view.tracks, itemKey.tracks),
    albums: dupes(view.albums, itemKey.albums),
    artists: dupes(view.artists, itemKey.artists),
  };
  const duplicates = duplicatesBySection.tracks.length + duplicatesBySection.albums.length + duplicatesBySection.artists.length;

  // The copy shown for the song asked for: lossless, on a proper album, explicit unless asked clean.
  let copyOk: boolean | null = null;
  const leader = view.tracks[0];
  if (label.t && leader && trackHit(leader, label.t)) {
    const copies = [...view.allTracks, ...view.candidates].filter(copy => sameSong(copy, leader));
    const checks: boolean[] = [];
    if (copies.some(losslessCopy)) checks.push(losslessCopy(leader));
    if (copies.some(copy => !compilationCopy(copy))) checks.push(!compilationCopy(leader));
    if (label.t.album && copies.some(copy => albumBase(copy.album) === albumBase(label.t!.album!))) checks.push(albumBase(leader.album) === albumBase(label.t.album));
    if (label.t.clean) checks.push(!leader.explicit);
    else if (copies.some(copy => copy.explicit)) checks.push(leader.explicit);
    copyOk = checks.every(Boolean);
  }
  // The album's copy: lossless when a lossless one exists, and its plain edition unless one is asked for.
  let editionOk: boolean | null = null;
  const album = view.albums[0];
  const albumLabel = label.al ?? (label.t?.album ? { t: label.t.album, a: label.t.a } : null);
  if (albumLabel && album && albumHit(album, albumLabel)) {
    const copies = [album, ...album.versions ?? []];
    const asked = /\b(deluxe|remaster|anniversary|expanded|edition|live|super)\b/.test(norm(label.q));
    const plain = (copy: CatalogAlbum) => !/\b(deluxe|anniversary|expanded|super|live|collector|bonus)\b/.test(norm(`${copy.title} ${copy.version ?? ""}`));
    const checks: boolean[] = [];
    if (copies.some(copy => copy.provider !== "spotify")) checks.push(album.provider !== "spotify");
    if (!asked && copies.some(plain)) checks.push(plain(album));
    editionOk = checks.every(Boolean);
  }

  // Sections that agree: the leading song's album and artist are in their sections; an artist
  // asked for brings their songs and albums.
  const consistency: Score["consistency"] = { album: null, artist: null, artistTracks: null, artistAlbums: null };
  if (label.t && leader && trackHit(leader, label.t)) {
    const own = (candidate: CatalogAlbum) => albumBase(candidate.title) === albumBase(leader.album) && [...albumCredits(candidate)].some(name => credits(leader).has(name));
    if (pool.albums.some(own)) consistency.album = view.albums.slice(0, 5).some(own);
    const by = (artist: CatalogArtist) => norm(artist.name) === norm(leader.artist);
    if (pool.artists.some(by)) consistency.artist = view.artists.slice(0, 5).some(by);
  }
  if (label.ar) {
    const theirs = (track: Track) => named(label.ar!.n, credits(track));
    const theirAlbums = (candidate: CatalogAlbum) => named(label.ar!.n, albumCredits(candidate));
    if (pool.tracks.some(theirs)) consistency.artistTracks = view.tracks.slice(0, 5).some(theirs);
    if (pool.albums.some(theirAlbums)) consistency.artistAlbums = view.albums.slice(0, 5).some(theirAlbums);
  }

  // The right one of several same-named artists: the one credited on their known songs.
  let disambiguation: boolean | null = null;
  if (label.ar?.known) {
    const ids = new Set<string>();
    for (const track of pool.tracks) {
      if (!list(label.ar.known).some(title => baseTitle(title) === baseTitle(track.name))) continue;
      for (const artist of track.artists) if (artistHit({ name: artist.name } as CatalogArtist, label.ar.n) && artist.providerId) ids.add(`${track.provider}:${artist.providerId.replace(/^\w+:/, "")}`);
    }
    if (ids.size) {
      const top = view.artists[0];
      const own = top ? [top, ...top.sources ?? []].map(source => `${source.provider}:${source.id.replace(/^\w+:/, "")}`) : [];
      disambiguation = !!top && artistHit(top, label.ar.n) && own.some(id => ids.has(id));
    }
  }
  return { leadPredicted, leadHit, top1, section, forbidden, duplicates, duplicatesBySection, copyOk, editionOk, consistency, disambiguation, empty };
}
