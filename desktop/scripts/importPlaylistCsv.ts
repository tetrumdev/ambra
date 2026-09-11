import { Database } from "bun:sqlite";
import { groupSearchResults, rankSearchResults } from "../src/utils/searchRanking";
import type { Track } from "../src/types/music";

type CsvRow = { title: string; artist: string; album: string; playlist: string; isrc: string; qobuzId: string };
type RemoteTrack = Record<string, any>;
const server = "http://127.0.0.1:8787";

function csvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = "", quoted = false;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (character === '"') {
      if (quoted && text[index + 1] === '"') { field += '"'; index++; }
      else quoted = !quoted;
    } else if (character === "," && !quoted) { row.push(field); field = ""; }
    else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && text[index + 1] === "\n") index++;
      row.push(field); field = "";
      if (row.some(Boolean)) rows.push(row);
      row = [];
    } else field += character;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function playable(track: RemoteTrack): Track {
  const versioned = (name: string, version: string | null) => version && !name.toLowerCase().includes(version.toLowerCase()) ? `${name} (${version})` : name;
  return {
    globalId: track.id, provider: track.provider, providerTrackId: track.providerTrackId,
    playbackKind: track.playback.kind, audio: `${server}${track.playback.url}`,
    cover: track.album?.coverUrl ?? "/ambra.png", nativeCover: track.album?.coverUrl ?? null,
    name: versioned(track.title, track.version), version: track.version,
    album: versioned(track.album?.title ?? "Unknown Album", track.album?.version ?? null),
    albumVersion: track.album?.version ?? null, albumId: track.album?.providerId ?? null,
    albumArtists: track.album?.artists ?? [], artist: track.primaryArtist.name, artists: track.artists,
    trackNumber: track.trackNumber, discNumber: track.discNumber, durationSeconds: track.durationSeconds,
    releaseDate: track.album?.releaseDate ?? null, explicit: track.explicit, isrc: track.isrc,
    copyright: track.copyright, label: track.album?.label ?? null, genres: track.album?.genres ?? [],
    upc: track.album?.upc ?? null, quality: track.quality,
    maximumSamplingRateKHz: track.maximumSamplingRateKHz, maximumBitDepth: track.maximumBitDepth,
  };
}

async function search(query: string, provider: "tidal" | "qobuz") {
  const parameters = new URLSearchParams({ query, provider, limit: "20" });
  const response = await fetch(`${server}/api/search/catalog?${parameters}`, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`${provider} search returned ${response.status}`);
  const body = await response.json() as { tracks: RemoteTrack[] };
  return body.tracks.map(playable);
}

async function trackMetadata(provider: "tidal" | "qobuz", trackId: string) {
  const response = await fetch(`${server}/api/providers/${provider}/tracks/${trackId}/metadata`, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`${provider} metadata returned ${response.status}`);
  return playable(await response.json() as RemoteTrack);
}

function normalized(value: string) {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function albumFamily(value: string) {
  return normalized(value)
    .replace(/\b(deluxe|expanded|special|anniversary|legacy|collector s|edition|remaster|remastered|reissue)\b|\b(?:19|20)\d{2}\b/g, " ")
    .replace(/\s+/g, " ").trim();
}

function fromRequestedAlbum(track: Track, requestedAlbum: string) {
  const actual = albumFamily(track.album), requested = albumFamily(requestedAlbum);
  return Boolean(actual && requested && (actual === requested || actual.startsWith(`${requested} `) || requested.startsWith(`${actual} `)));
}

async function resolveTidal(track: Track) {
  const parameters = new URLSearchParams({ durationSeconds: String(track.durationSeconds) });
  const response = await fetch(`${server}/api/providers/tidal/tracks/${track.providerTrackId}/playback?${parameters}`, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) return track;
  const details = await response.json() as any;
  return { ...track, audio: `${server}${details.playback.url}`, playbackKind: details.playback.kind,
    quality: details.quality, maximumSamplingRateKHz: details.maximumSamplingRateKHz,
    maximumBitDepth: details.maximumBitDepth };
}

async function resolveRow(row: CsvRow) {
  const query = `${row.title} ${row.artist} ${row.album}`;
  const requests: Array<Promise<Track | Track[]>> = [search(query, "tidal"), search(query, "qobuz")];
  if (row.qobuzId) requests.push(trackMetadata("qobuz", row.qobuzId));
  const pages = await Promise.allSettled(requests);
  let candidates = pages.flatMap(result => result.status === "fulfilled" ? (Array.isArray(result.value) ? result.value : [result.value]) : []);
  if (!candidates.some(track => track.isrc?.toUpperCase() === row.isrc.toUpperCase())) {
    const broadQuery = `${row.title} ${row.artist}`;
    const broader = await Promise.allSettled([search(broadQuery, "tidal"), search(broadQuery, "qobuz")]);
    candidates = [...candidates, ...broader.flatMap(result => result.status === "fulfilled" ? result.value : [])];
  }
  if (!candidates.length) return undefined;
  const isrc = row.isrc.trim().toUpperCase();
  let matches = isrc ? candidates.filter(track => track.isrc?.toUpperCase() === isrc) : [];
  if (!matches.length) {
    matches = candidates.filter(track => normalized(track.artist) === normalized(row.artist) && normalized(track.name).startsWith(normalized(row.title)));
  }
  if (!matches.length) matches = rankSearchResults(candidates, `${row.title} ${row.artist}`).slice(0, 1);
  const requestedAlbumMatches = matches.filter(track => fromRequestedAlbum(track, row.album));
  if (requestedAlbumMatches.length) matches = requestedAlbumMatches;
  matches = await Promise.all(matches.map(track => track.provider === "tidal" ? resolveTidal(track) : track));
  return groupSearchResults(matches, query)[0]?.track;
}

const [csvPath, databasePath, playlistName = "MEGA"] = process.argv.slice(2);
if (!csvPath || !databasePath) throw new Error("Usage: importPlaylistCsv.ts CSV DATABASE [PLAYLIST]");
const parsed = csvRows(await Bun.file(csvPath).text());
const headers = parsed.shift()!.map(value => value.trim());
const rows: CsvRow[] = parsed.map(values => ({
  title: values[headers.indexOf("Track name")].trim(), artist: values[headers.indexOf("Artist name")].trim(), album: values[headers.indexOf("Album")].trim(),
  playlist: values[headers.indexOf("Playlist name")].trim(), isrc: values[headers.indexOf("ISRC")].trim(), qobuzId: values[headers.indexOf("Qobuz - id")]?.trim() ?? "",
})).filter(row => row.playlist === playlistName);

const resolved: Array<Track | undefined> = new Array(rows.length);
let cursor = 0, completed = 0;
await Promise.all(Array.from({ length: 4 }, async () => {
  while (cursor < rows.length) {
    const index = cursor++;
    try { resolved[index] = await resolveRow(rows[index]); }
    catch (error) { console.error(`Failed: ${rows[index].title}: ${error}`); }
    completed++;
    if (completed % 10 === 0 || completed === rows.length) console.log(`Resolved ${completed}/${rows.length}`);
  }
}));
const missing = rows.filter((_, index) => !resolved[index]);
if (missing.length) {
  throw new Error(`Import aborted; unresolved (${missing.length}): ${missing.map(row => `${row.title} — ${row.artist}`).join("; ")}`);
}

const db = new Database(databasePath);
const stored = db.query("select value from ItemTable where key=?").get("ambra.playlists.v1") as { value: Uint8Array } | null;
const snapshot = stored ? JSON.parse(new TextDecoder("utf-16le").decode(stored.value)) : { version: 1, playlists: [], tracks: [] };
const chosen = resolved.filter((track): track is Track => Boolean(track));
const existing = snapshot.playlists.find((playlist: any) => playlist.name === playlistName);
const playlist = { id: existing?.id ?? crypto.randomUUID(), name: playlistName, trackIds: chosen.map(track => track.globalId) };
const playlists = [...snapshot.playlists.filter((item: any) => item.name !== playlistName), playlist];
const tracks = new Map<string, Track>(snapshot.tracks.map((track: Track) => [track.globalId, track]));
for (const track of chosen) tracks.set(track.globalId, track);
const used = new Set<string>(playlists.flatMap((item: any) => item.trackIds));
const next = { version: 1, playlists, tracks: [...tracks.values()].filter(track => used.has(track.globalId)) };
db.query("insert or replace into ItemTable(key,value) values(?,?)").run("ambra.playlists.v1", Buffer.from(JSON.stringify(next), "utf16le"));
db.close();
console.log(`Imported ${chosen.length}/${rows.length} tracks into ${playlistName}`);
