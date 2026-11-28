import { artistCredits, fold, matchTrack, titleParts, variantFactor } from "./searchMatch";
import { serviceRank } from "./servicePreference";
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
  return [...new Set(normalized(annotations.join(" ")).match(/\b(live|acoustic|instrumental|acapella|capella|cappella|karaoke|tribute|remix|rmx|mix|edit|demo|session|cover|dub|rework)\b/g) ?? [])].sort().join(" ");
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

const credits = new WeakMap<Track, Set<string>>();

/**
 * Each credited artist, without a parenthesized alias: services credit the same act as
 * "groove chronicles" and "Groove Chronicles (Noodles)", or list remixers and guests
 * alongside the lead artist that another service credits alone. A joint credit also counts
 * as each of its acts: one service's "Pete Rock & C.L. Smooth" is another's two artists.
 */
function artistNames(track: Track) {
  let names = credits.get(track);
  if (!names) {
    names = artistCredits(track.artists.length ? track.artists.map(artist => artist.name) : [track.artist]);
    credits.set(track, names);
  }
  return names;
}

/** An ISRC without the hyphens some services write it with ("GB-SZC-07-00012"). */
function isrcCode(track: Track) {
  return (track.isrc ?? "").replace(/[^a-z0-9]/gi, "").toUpperCase();
}

function shareArtist(left: Track, right: Track) {
  const names = artistNames(left);
  return [...artistNames(right)].some(name => names.has(name));
}

export function sameRecording(left: Track, right: Track) {
  if (left.globalId === right.globalId) return true;
  const leftIsrc = isrcCode(left);
  const rightIsrc = isrcCode(right);
  // An ISRC names one recording. Services spell its credits differently, so one shared
  // artist is enough to rule out a mislabeled code.
  if (leftIsrc && leftIsrc === rightIsrc && shareArtist(left, right)) return true;
  if (!shareArtist(left, right)) return false;
  if (performance(left) !== performance(right)) return false;
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

/**
 * One song as a search result: the same recording, or a copy nothing sets apart but its
 * identifier, such as a reissue on another album. Looser than `sameRecording`, which a
 * playlist relies on to never swap a song for a different take.
 */
export function sameSong(left: Track, right: Track) {
  if (sameRecording(left, right)) return true;
  if (!shareArtist(left, right) || performance(left) !== performance(right)) return false;
  if (!title(left.name) || title(left.name) !== title(right.name)) return false;
  return left.durationSeconds > 0 && right.durationSeconds > 0 && Math.abs(left.durationSeconds - right.durationSeconds) <= 3;
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

export function lossless(track: Track) {
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
/** Whether the query asks for the clean edit by name; otherwise the explicit one is always meant. */
export function asksForClean(query: string) {
  return /\bclean\b/i.test(query);
}

/**
 * Which copies are the explicit audio. One ISRC is one piece of audio and services flag it
 * differently, so a copy is explicit when any copy with its ISRC is: an unflagged lossless
 * copy of explicit audio isn't a clean edit.
 */
export function explicitAudio(copies: Track[]) {
  const flagged = new Set(copies.filter(copy => copy.explicit).map(isrcCode).filter(Boolean));
  return (copy: Track) => copy.explicit || flagged.has(isrcCode(copy));
}

function compareEdition(left: Track, right: Track, query: string, explicit = (track: Track) => track.explicit) {
  // The explicit edit always wins, before sound quality, unless the query says "clean".
  const wanted = asksForClean(query) ? -1 : 1;
  return requestedEdition(left, query) - requestedEdition(right, query)
    || wanted * (Number(explicit(left)) - Number(explicit(right)))
    // Audio quality wins before release placement. A song sharing its album's title is not proof of a single.
    || compareSoundQuality(left, right)
    || Number(compilation(right)) - Number(compilation(left))
    || Number(remaster(left)) - Number(remaster(right))
    // The album itself over one of its editions, and a plainly titled copy over one that
    // spells out its guests, which variant releases tend to.
    || Number(plainEdition(left)) - Number(plainEdition(right))
    // One release on several services in equal quality: the preferred service's copy, or the
    // same service the album would open from, never whichever answered differently.
    || serviceRank(left.provider) - serviceRank(right.provider)
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
 * With `replace`, the original can't stay (its service is signed out): it's only the yardstick,
 * and the best candidate is chosen even if it sounds worse.
 */
export function bestPlaylistCopy(original: Track, candidates: Track[], replace = false) {
  const release = (track: Track) => [Number(!compilation(track) && !regional(track)), Number(sameAlbumFamily(track, original)),
    -Number((released(track) ?? "9999").slice(0, 4))];
  const settle = (a: Track, b: Track) => byCodePoint(released(a) ?? "9999", released(b) ?? "9999") || byCodePoint(a.globalId, b.globalId);
  let best: Track | undefined = replace ? undefined : original;
  for (const candidate of candidates) {
    if (candidate.provider === "local" || candidate.explicit !== original.explicit || !sameRecording(original, candidate)) continue;
    if (!best) { best = candidate; continue; }
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
  return best ?? original;
}

export type RecordingGroup = {
  track: Track;
  alternatives: Track[];
  /** 0 to 1: how well the song answers the query, by its best-matching copy. */
  relevance: number;
  /** Agreement between services: more of them returning the song, and nearer the top, is more. */
  fusionScore: number;
};

/** `variantFactor` of someone else's rendition of a song. */
const REMAKE = 0.55;
/** Reciprocal-rank constant: small, so a service's first results count far more than its tenth. */
const FUSION_RANK = 10;

export function groupSearchResults(tracks: Track[], query: string): RecordingGroup[] {
  const groups = new Set<RecordingGroup>();
  const groupOf = new Map<Track, RecordingGroup>();
  const byIdentity = new Map<string, Track[]>();
  const seenIds = new Set<string>();
  for (const track of tracks) {
    if (seenIds.has(track.globalId)) continue;
    seenIds.add(track.globalId);
    const keys = [...artistNames(track)].map(name => `title:${name}:${title(track.name)}`);
    const isrc = isrcCode(track);
    if (isrc) keys.push(`isrc:${isrc}`);
    // A shared ISRC joins a copy to its recording however a service titled it. Otherwise it
    // must be the same song as a copy already gathered, and near the first one's length, so
    // a chain of near misses can't drift into another take.
    const joined = [...new Set(keys.flatMap(key => byIdentity.get(key) ?? []).map(other => groupOf.get(other)!))]
      .filter(candidate => candidate.alternatives.some(other => isrc && isrc === isrcCode(other) && shareArtist(other, track))
        || (Math.abs(candidate.alternatives[0].durationSeconds - track.durationSeconds) <= 15
          && candidate.alternatives.some(other => sameSong(other, track))));
    const group = joined[0] ?? { track, alternatives: [], relevance: 0, fusionScore: 0 };
    groups.add(group);
    // A copy that belongs to two groups shows they were one song all along.
    for (const other of joined.slice(1)) {
      groups.delete(other);
      for (const copy of other.alternatives) groupOf.set(copy, group);
      group.alternatives.push(...other.alternatives);
    }
    group.alternatives.push(track);
    groupOf.set(track, group);
    for (const key of keys) byIdentity.set(key, [...byIdentity.get(key) ?? [], track]);
  }
  const position = new Map(tracks.map((track, index) => [track, index]));
  const providerRanks = new Map<Track["provider"], number>();
  const ranked = new Map<RecordingGroup, Set<Track["provider"]>>();
  for (const group of groups) {
    // Found order, so the chosen copy doesn't depend on which groups merged.
    group.alternatives.sort((a, b) => position.get(a)! - position.get(b)!);
    group.track = group.alternatives[0];
    const explicit = explicitAudio(group.alternatives);
    for (const copy of group.alternatives) {
      group.relevance = Math.max(group.relevance, matchTrack(copy, query).score);
      if (compareEdition(copy, group.track, query, explicit) > 0) group.track = copy;
    }
  }
  // Each service ranks a song by where it first returned any copy of it.
  for (const track of tracks) {
    const group = groupOf.get(track);
    if (!group) continue;
    const services = ranked.get(group) ?? new Set();
    if (services.has(track.provider)) continue;
    services.add(track.provider);
    ranked.set(group, services);
    const rank = (providerRanks.get(track.provider) ?? 0) + 1;
    providerRanks.set(track.provider, rank);
    group.fusionScore += 1 / (FUSION_RANK + rank);
  }
  return [...groups];
}

/** Below this, nothing found says the query was understood as a title or an artist. */
const UNDERSTOOD = 0.3;
/** A song at least this good is one the query plainly names. */
export const STRONG_MATCH = 0.6;

/**
 * Songs in the order to show them.
 *
 * What was typed decides first: a song that explains the whole query, title and artist, leads.
 * Between songs that match equally, the one the services agree on leads (returned by more of
 * them, nearer the top), so the well-known recording comes before a cover with the same name.
 * A remix, live take or remake follows the song as released unless the query asks for it.
 * Sound quality never reorders different songs: it only picks which copy of a song is shown.
 *
 * Songs that match far worse than the best one are left out. When nothing matches the query's
 * words at all (lyrics, a description, another alphabet), the services' own order is kept.
 *
 * `held` adds to a song's score: a list already on screen holds its order against answers that
 * would only nudge it.
 */
export function rankSearchGroups(tracks: Track[], query: string, held: (group: RecordingGroup) => number = () => 0) {
  const groups = groupSearchResults(tracks, query);
  const best = Math.max(0, ...groups.map(group => group.relevance));
  const order = new Map(groups.map((group, index) => [group, index]));
  if (best < UNDERSTOOD) return groups.sort((a, b) => b.fusionScore - a.fusionScore || order.get(a)! - order.get(b)!);
  const services = new Set(tracks.map(track => track.provider)).size || 1;
  const cutoff = Math.max(UNDERSTOOD, best * 0.4);
  // How much of its artist's name the query spells, by the song's best-matching copy.
  const credit = new Map(groups.map(group => [group, Math.max(...group.alternatives.map(copy => matchTrack(copy, query).artist))]));
  // The query names a song and who it is by: "jay-z 99 problems".
  const byArtist = groups.some(group => group.relevance >= STRONG_MATCH && credit.get(group)! >= 0.99
    && group.alternatives.some(copy => matchTrack(copy, query).title >= 0.99));
  const rank = new Map(groups.map(group => {
    const { track } = group;
    const variant = variantFactor({ title: track.name, notes: track.version ? [track.version] : [],
      artists: track.artists.length ? track.artists.map(artist => artist.name) : [track.artist], album: track.album }, query);
    const agreement = group.fusionScore / (services / (FUSION_RANK + 1));
    // A song released many times over is usually the known one.
    const releases = Math.min(group.alternatives.length, 5) / 5;
    // Then a song by someone else that only mentions the artist, as covers do in their
    // titles ("99 Problems (Jay-Z)"), is not the one asked for.
    const mention = byArtist && credit.get(group)! < 0.5 ? 0.7 : 1;
    return [group, group.relevance * variant * mention + 0.2 * agreement + 0.02 * releases + held(group)];
  }));
  return groups
    .filter(group => group.relevance >= cutoff)
    .sort((a, b) => rank.get(b)! - rank.get(a)!
      // Among equal results, a copy found only on compilations follows the album's own.
      || Number(compilation(a.track)) - Number(compilation(b.track))
      || compareSoundQuality(b.track, a.track)
      || byCodePoint(a.track.globalId, b.track.globalId));
}

/**
 * The same order, with each song once before any song is repeated: another recording of a title
 * already listed by the same artist, in the same kind of version (a single or album version, a
 * second remaster, another remix), follows every other song instead of filling the first places
 * twice. Remakes (karaoke, piano covers, tributes) stay behind it all the same.
 */
export function distinctFirst(groups: RecordingGroup[], query: string) {
  const seen = new Set<string>();
  const repeated = groups.map(group => {
    const { track } = group;
    if (variantFactor({ title: track.name, notes: track.version ? [track.version] : [], artists: [track.artist], album: track.album }, query) <= REMAKE) return true;
    const key = `${fold(titleParts(group.track.name).base)}|${normalized(group.track.artist)}|${performance(group.track)}`;
    if (seen.has(key)) return true;
    seen.add(key);
    return false;
  });
  return [...groups.filter((_, index) => !repeated[index]), ...groups.filter((_, index) => repeated[index])];
}

export function rankSearchResults(tracks: Track[], query: string) {
  return rankSearchGroups(tracks, query).map(group => group.track);
}

/** Every copy of every recording, each recording's chosen copy first, for "show all". */
export function everyCopy(groups: RecordingGroup[]) {
  return groups.flatMap(group => [group.track, ...group.alternatives.filter(copy => copy !== group.track)]);
}
