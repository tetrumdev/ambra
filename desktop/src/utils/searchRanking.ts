import { textRelevance } from "./catalogRanking";
import type { Track } from "../types/music";

function normalized(value: string) {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function title(value: string) {
  return normalized(value
    .replace(/\s*[([](?:feat\.?|ft\.?|featuring)\s+[^)\]]*[)\]]/gi, "")
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
  return normalized(track.album).replace(/\b(deluxe|expanded|special|anniversary|legacy|collector s|edition|remaster|remastered|reissue)\b|\b(?:19|20)\d{2}\b/g, " ")
    .replace(/\s+/g, " ").trim();
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
  const tolerance = remaster(left) || remaster(right) ? 15 : Math.min(8, Math.max(2, left.durationSeconds * 0.02));
  if (durationDifference > tolerance) return false;
  // Differing identifiers require release evidence, not just a similar title and duration.
  if (leftIsrc && rightIsrc && leftIsrc !== rightIsrc) {
    const a = albumFamily(left), b = albumFamily(right);
    return Boolean(a && b && (a === b || compilation(left) || compilation(right) || ((remaster(left) || remaster(right)) && (a.startsWith(`${b} `) || b.startsWith(`${a} `)))));
  }
  return true;
}

function compilation(track: Track) {
  // A soundtrack can be the original release; do not classify every soundtrack as a compilation.
  return /\b(greatest hits|best of|anthology|compilation|box set|rock anthems|various artists)\b/i.test(track.album);
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

function compareEdition(left: Track, right: Track, query: string) {
  return requestedEdition(left, query) - requestedEdition(right, query)
    || Number(left.explicit) - Number(right.explicit)
    || Number(compilation(right)) - Number(compilation(left))
    || Number(albumFamily(right) === title(right.name)) - Number(albumFamily(left) === title(left.name))
    || Number(lossless(left)) - Number(lossless(right))
    || (left.maximumBitDepth ?? (lossless(left) ? 16 : 0)) - (right.maximumBitDepth ?? (lossless(right) ? 16 : 0))
    || (left.maximumSamplingRateKHz ?? (lossless(left) ? 44.1 : 0)) - (right.maximumSamplingRateKHz ?? (lossless(right) ? 44.1 : 0))
    || Number(remaster(left)) - Number(remaster(right))
    || right.globalId.localeCompare(left.globalId);
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

export function deduplicateSearchResults(tracks: Track[]) {
  // Grouping preserves the native order of a single provider's recordings.
  return groupSearchResults(tracks, "").map(group => group.track);
}

export function rankSearchResults(tracks: Track[], query: string) {
  return groupSearchResults(tracks, query)
    .filter(group => group.relevance > 0)
    .sort((a, b) => b.relevance - a.relevance || b.fusionScore - a.fusionScore || a.track.globalId.localeCompare(b.track.globalId))
    .map(group => group.track);
}
