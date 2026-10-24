import { textRelevance } from "./catalogRanking";
import type { Track } from "../types/music";

/**
 * Plain code-point order. `localeCompare` follows the platform's collation, which differs between
 * the macOS and Windows webviews, so the same results could be ordered differently on each.
 */
export function byCodePoint(a: string, b: string) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function normalized(value: string) {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function title(value: string) {
  return normalized(value
    // "(with John Legend)" credits a guest like "feat." does; a bare "with" is part of a title.
    .replace(/\s*[([]\s*(?:feat\.?|ft\.?|featuring|with)\s+[^)\]]*[)\]]/gi, "")
    .replace(/\s+(?:feat\.?|ft\.?|featuring)\s+.*$/gi, ""))
    .replace(/\b(?:19|20)\d{2}\s+remaster(?:ed)?\b|\bremaster(?:ed)?(?:\s+(?:19|20)\d{2})?\b|\balbum version\b|\boriginal version\b/g, " ")
    .replace(/\s+/g, " ").trim();
}

function remaster(track: Track) {
  return /\bremaster(?:ed)?\b/i.test(`${track.name} ${track.version ?? ""} ${track.album} ${track.albumVersion ?? ""}`);
}

// Only edition annotations count: a song called "Live Forever" is not a live performance.
function performance(track: Track) {
  const annotations = [track.version ?? "", ...(track.name.match(/\([^)]*\)|\[[^\]]*\]|\s[-–—]\s.*$/g) ?? [])];
  return [...new Set(normalized(annotations.join(" ")).match(/\b(live|acoustic|instrumental|karaoke|tribute|remix|mix|edit|demo|session|cover)\b/g) ?? [])].sort().join(" ");
}

function albumFamily(track: Track) {
  return albumTitleFamily(track.album);
}

/** An album title without edition notes, so a deluxe or remastered release matches its original. */
export function albumTitleFamily(albumTitle: string) {
  return normalized(albumTitle).replace(/\b(full dynamic range|deluxe|expanded|special|anniversary|legacy|collector s|edition|remaster|remastered|reissue)\b|\b(?:19|20)\d{2}\b/g, " ")
    .replace(/\s+/g, " ").trim();
}

/** Album families that are one album, such as "heroes villains" and "heroes villains heroes version". */
function relatedFamilies(a: string, b: string) {
  return Boolean(a && b && (a === b || a.startsWith(`${b} `) || b.startsWith(`${a} `)));
}

export function sameRecording(left: Track, right: Track) {
  if (left.globalId === right.globalId) return true;
  if (!normalized(left.artist) || normalized(left.artist) !== normalized(right.artist)) return false;
  if (performance(left) !== performance(right)) return false;
  const leftIsrc = normalized(left.isrc ?? "");
  const rightIsrc = normalized(right.isrc ?? "");
  if (leftIsrc && leftIsrc === rightIsrc) return true;
  if (!title(left.name) || title(left.name) !== title(right.name)) return false;
  if (left.durationSeconds <= 0 || right.durationSeconds <= 0) return false;
  const durationDifference = Math.abs(left.durationSeconds - right.durationSeconds);
  // Releases pad a track differently, which outweighs a percentage of a seconds-long grindcore song.
  const veryShort = left.durationSeconds < 30 && right.durationSeconds < 30;
  const tolerance = remaster(left) || remaster(right) ? 15 : veryShort ? 5 : Math.min(8, Math.max(2, left.durationSeconds * 0.02));
  if (durationDifference > tolerance) return false;
  // Differing identifiers require release evidence, not just a similar title and duration.
  if (leftIsrc && rightIsrc && leftIsrc !== rightIsrc) {
    const a = albumFamily(left), b = albumFamily(right);
    // Each edition of an album, like "HEROES & VILLAINS (Heroes Version)", can give the same
    // recording its own ISRC; a near-identical length shows it is the same take.
    const edition = relatedFamilies(a, b) && (remaster(left) || remaster(right) || durationDifference <= 2);
    return Boolean(a && b && (a === b || edition || compilation(left) || compilation(right) || single(left) || single(right)));
  }
  return true;
}

function compilation(track: Track) {
  // A soundtrack can be the original release; do not classify every soundtrack as a compilation.
  return /\b(greatest hits|best of|anthology|compilation|box set|rock anthems|various artists)\b/i.test(track.album)
    // A label sampler is credited to Various Artists rather than named like one.
    || (track.albumArtists ?? []).some(artist => /^various( artists)?$/i.test(artist.name.trim()));
}

/** A single named after the song, which carries the album's recording under its own release ID. */
function single(track: Track) {
  return albumFamily(track) === title(track.name);
}

function lossless(track: Track) {
  return /flac|lossless|alac/i.test(track.quality ?? "");
}

function requestedEdition(track: Track, query: string) {
  const terms = normalized(query).split(" ");
  const edition = normalized(`${track.name} ${track.version ?? ""} ${track.album} ${track.albumVersion ?? ""}`);
  const album = normalized(track.album);
  const albumMatch = album.length > 3 && album !== title(track.name) && normalized(query).includes(album) ? 10 : 0;
  return albumMatch + terms.filter(term => /^(live|acoustic|instrumental|remix|demo|clean|remaster|remastered)$/.test(term))
    .reduce((score, term) => score + Number(edition.split(" ").includes(term)), 0);
}

/** The album's own title, with no edition such as "(Heroes Version)" after it. */
function plainEdition(track: Track) {
  return !track.albumVersion && normalized(track.album) === albumFamily(track);
}

/**
 * Which copy stands for a recording. A total order, so the same song shows the same copy
 * whatever was searched and whichever service answered first.
 */
function compareEdition(left: Track, right: Track, query: string) {
  return requestedEdition(left, query) - requestedEdition(right, query)
    || Number(left.explicit) - Number(right.explicit)
    || Number(compilation(right)) - Number(compilation(left))
    || Number(albumFamily(right) === title(right.name)) - Number(albumFamily(left) === title(left.name))
    || Number(lossless(left)) - Number(lossless(right))
    || (left.maximumBitDepth ?? (lossless(left) ? 16 : 0)) - (right.maximumBitDepth ?? (lossless(right) ? 16 : 0))
    || (left.maximumSamplingRateKHz ?? (lossless(left) ? 44.1 : 0)) - (right.maximumSamplingRateKHz ?? (lossless(right) ? 44.1 : 0))
    || Number(remaster(left)) - Number(remaster(right))
    // The album itself over one of its editions, and a plainly titled copy over one that
    // spells out its guests, which variant releases tend to.
    || Number(plainEdition(left)) - Number(plainEdition(right))
    || right.name.trim().length - left.name.trim().length
    || byCodePoint(right.releaseDate ?? "9999", left.releaseDate ?? "9999")
    // Nothing tells the copies apart; settle it the same way every time.
    || byCodePoint(right.albumId ?? "", left.albumId ?? "")
    || byCodePoint(right.globalId, left.globalId);
}

function soundQuality(track: Track) {
  const isLossless = lossless(track);
  return [Number(isLossless), track.maximumBitDepth ?? (isLossless ? 16 : 0), track.maximumSamplingRateKHz ?? (isLossless ? 44.1 : 0)];
}

/**
 * The best-sounding copy of the same recording with the same explicitness; the original wins ties.
 * Among equally good copies, one on the song's own album wins, then any that isn't a compilation,
 * so a song isn't moved to a regional greatest-hits disc just because it was found first.
 */
export function bestQualityRecording(original: Track, candidates: Track[]) {
  const release = (track: Track) => [Number(albumFamily(track) === albumFamily(original)), Number(!compilation(track))];
  const compare = (a: number[], b: number[]) => a.map((value, index) => value - b[index]).find(difference => difference !== 0) ?? 0;
  let best = original;
  for (const candidate of candidates) {
    if (candidate.provider === "local" || candidate.explicit !== original.explicit || !sameRecording(original, candidate)) continue;
    const quality = compare(soundQuality(candidate), soundQuality(best));
    if (quality > 0 || (quality === 0 && best !== original && compare(release(candidate), release(best)) > 0)) best = candidate;
  }
  return best;
}

/** Whether two album titles are one album, counting editions such as "OK Computer OKNOTOK 1997 2017". */
export function sameAlbumFamily(left: Track, right: Track) {
  return relatedFamilies(albumFamily(left), albumFamily(right));
}

function released(track: Track) {
  return track.releaseDate && /^\d{4}/.test(track.releaseDate) ? track.releaseDate : null;
}

/** A regional pressing, such as "Greatest Hits In Japan", which is rarely the release anyone means. */
function regional(track: Track) {
  return /\b(in japan|japan(ese)? (edition|version)|\(japan\)|us edition|uk edition|international (edition|version))\b/i.test(`${track.album} ${track.albumVersion ?? ""}`);
}

const compareScores = (a: number[], b: number[]) => a.map((value, index) => value - b[index]).find(difference => difference !== 0) ?? 0;

/** Bit depth and sample rate decide whether a DAC must switch between two songs. */
export function sameFormat(left: Track, right: Track) {
  return compareScores(soundQuality(left), soundQuality(right)) === 0;
}

/** Lossless first, then bit depth, then sample rate. */
export function compareSoundQuality(left: Track, right: Track) {
  return compareScores(soundQuality(left), soundQuality(right));
}

/**
 * The copy a playlist should keep. Never a worse-sounding one: a song only moves for a better
 * copy, or for an equally good one when it sits on a compilation or regional pressing and the
 * other doesn't. Among equally good new copies, a proper album beats a compilation or regional
 * pressing, then one on the song's current album, then the earliest release. Copies alike in all
 * of that are settled by ID, so the answer doesn't depend on which service replied first.
 */
export function bestPlaylistCopy(original: Track, candidates: Track[]) {
  const release = (track: Track) => [Number(!compilation(track) && !regional(track)), Number(sameAlbumFamily(track, original)),
    -Number((released(track) ?? "9999").slice(0, 4))];
  const settle = (a: Track, b: Track) => byCodePoint(released(a) ?? "9999", released(b) ?? "9999") || byCodePoint(a.globalId, b.globalId);
  let best = original;
  for (const candidate of candidates) {
    if (candidate.provider === "local" || candidate.explicit !== original.explicit || !sameRecording(original, candidate)) continue;
    const quality = compareSoundQuality(candidate, best);
    if (quality > 0) best = candidate;
    else if (quality === 0) {
      // The current copy only gives way to a proper album; any other tie keeps it.
      const order = compareScores(release(candidate), release(best));
      const wins = best === original
        ? release(candidate)[0] > release(original)[0]
        : order > 0 || (order === 0 && settle(candidate, best) < 0);
      if (wins) best = candidate;
    }
  }
  return best;
}

function relevance(track: Track, query: string) {
  const search = normalized(query);
  if (!search) return 0;
  const name = title(track.name), artist = normalized(track.artist), album = normalized(track.album);
  const combined = `${name} ${artist}`;
  const tokens = [...new Set(search.split(" "))];
  if (combined === search || `${artist} ${name}` === search) return 5;
  if (name === search || artist === search || textRelevance(track.artist, query) === 5 || textRelevance(track.name, query) === 5) return 4;
  if (tokens.every(token => combined.split(" ").includes(token))) return 3;
  if (tokens.every(token => combined.includes(token))) return 2;
  if (tokens.every(token => `${combined} ${album}`.includes(token))) return 1;
  return Math.min(2, textRelevance(`${track.name} ${track.artist}`, query));
}

export type RecordingGroup = {
  track: Track;
  alternatives: Track[];
  relevance: number;
  fusionScore: number;
};

export function groupSearchResults(tracks: Track[], query: string): RecordingGroup[] {
  const groups: RecordingGroup[] = [];
  const byIdentity = new Map<string, RecordingGroup[]>();
  const providerRanks = new Map<Track["provider"], number>();
  const providerGroups = new Map<Track["provider"], Set<RecordingGroup>>();
  const seenIds = new Set<string>();
  for (const track of tracks) {
    if (seenIds.has(track.globalId)) continue;
    seenIds.add(track.globalId);
    const keys = [`title:${normalized(track.artist)}:${title(track.name)}`];
    if (track.isrc) keys.push(`isrc:${normalized(track.isrc)}`);
    const candidates = new Set(keys.flatMap(key => byIdentity.get(key) ?? []));
    let group = [...candidates].find(candidate => candidate.alternatives.every(other => sameRecording(other, track)));
    if (!group) {
      group = { track, alternatives: [], relevance: 0, fusionScore: 0 };
      groups.push(group);
    }
    group.alternatives.push(track);
    group.relevance = Math.max(group.relevance, relevance(track, query));
    if (compareEdition(track, group.track, query) > 0) group.track = track;
    for (const key of keys) {
      const bucket = byIdentity.get(key) ?? [];
      if (!bucket.includes(group)) bucket.push(group);
      byIdentity.set(key, bucket);
    }
    const contributed = providerGroups.get(track.provider) ?? new Set<RecordingGroup>();
    if (!contributed.has(group)) {
      const rank = (providerRanks.get(track.provider) ?? 0) + 1;
      providerRanks.set(track.provider, rank);
      group.fusionScore += 1 / (60 + rank);
      contributed.add(group);
      providerGroups.set(track.provider, contributed);
    }
  }
  return groups;
}

export function rankSearchGroups(tracks: Track[], query: string) {
  return groupSearchResults(tracks, query)
    .filter(group => group.relevance > 0)
    // Among equally relevant results, a copy found only on compilations follows the album's own.
    .sort((a, b) => b.relevance - a.relevance || Number(compilation(a.track)) - Number(compilation(b.track))
      || b.fusionScore - a.fusionScore || byCodePoint(a.track.globalId, b.track.globalId));
}

export function rankSearchResults(tracks: Track[], query: string) {
  return rankSearchGroups(tracks, query).map(group => group.track);
}

/** Every copy of every recording, each recording's chosen copy first, for "show all". */
export function everyCopy(groups: RecordingGroup[]) {
  return groups.flatMap(group => [group.track, ...group.alternatives.filter(copy => copy !== group.track)]);
}
