import { useSyncExternalStore } from "react";
import type { CatalogAlbum, CatalogArtist, RemoteTrack, ServiceAuthStatus } from "../../desktop/src/api/server";
import type { ServicePlaylist } from "../../desktop/src/api/playlists";
import type { Playlist, Track } from "../../desktop/src/types/music";
import { remoteTrack } from "../../desktop/src/utils/remoteTrack";
import { mergeVisibleTrackOrder } from "../../desktop/src/utils/trackCollectionOrder";
import { phoneMediaUrl, rebased, request } from "./client";
import { normalizePackages } from "./queueModel";
import { editState, readState, stateValue } from "./sharedState";
import { services, type Service } from "./servicePreferences";

/**
 * The library as desktop shows it (`desktop/src/hooks/useMusicLibrary.ts`, `usePlaylists.ts`):
 * the server's saved songs in the saved order without removed ones, AMBRA playlists from
 * shared state, and each signed-in service's own playlists.
 */

const PLAYLISTS_KEY = "ambra.playlists.v1";
const ORDER_KEY = "ambra.library-order.v1";
const REMOVED_KEY = "ambra.removed-library-tracks.v1";
const HISTORY_KEY = "ambra.listening-history.v1";
/** MEGA keeps its fixed ID on every device. */
export const MEGA_PLAYLIST_ID = "1255df67-7977-4f0e-8e69-23420d41c563";

export type ServicePlaylists = Record<Service, ServicePlaylist[]>;
export type HistoryEntry = { track: Track; lastPlayedAt: number; playCount?: number };
export type LibrarySnapshot = {
  tracks: Track[];
  playlists: Playlist[];
  /** Songs saved with AMBRA playlists, by ID, including ones no longer in the library. */
  playlistTracks: ReadonlyMap<string, Track>;
  servicePlaylists: ServicePlaylists;
  connected: ServiceAuthStatus | null;
  history: HistoryEntry[];
  loading: boolean;
  error: string | null;
  loadedAt: number;
};

const emptyServices = (): ServicePlaylists => ({ tidal: [], qobuz: [], spotify: [] });
let snapshot: LibrarySnapshot = {
  tracks: [], playlists: [], playlistTracks: new Map(), servicePlaylists: emptyServices(),
  connected: null, history: [], loading: true, error: null, loadedAt: 0,
};
const listeners = new Set<() => void>();
function publish(change: Partial<LibrarySnapshot>) {
  snapshot = { ...snapshot, ...change };
  for (const listener of listeners) listener();
}
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const librarySnapshot = () => snapshot;
export const useLibrary = () => useSyncExternalStore(subscribe, librarySnapshot);

export const playableTrack = (track: RemoteTrack) => remoteTrack(track, phoneMediaUrl);

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

function parsePlaylists(raw: string | null) {
  const saved = parseJson<{ playlists?: Playlist[]; tracks?: Track[] }>(raw, {});
  const playlists = (saved.playlists ?? []).filter(item => item && typeof item.id === "string" && typeof item.name === "string" && Array.isArray(item.trackIds)).map(item => {
    const stored = Array.isArray(item.packages) ? item.packages.filter(pack => Array.isArray(pack) && pack.every(id => typeof id === "string")) : [];
    const { trackIds, packages } = normalizePackages([...new Set(item.trackIds)], stored);
    return { ...item, trackIds, ...(packages.length ? { packages } : {}) };
  });
  const tracks = new Map((saved.tracks ?? []).filter(track => track && typeof track.globalId === "string").map(track => [track.globalId, track]));
  return { playlists, tracks };
}

let refreshing: Promise<void> | null = null;
/** Loads everything again; screens show the last snapshot meanwhile. */
export function refreshLibrary(): Promise<void> {
  refreshing ??= (async () => {
    publish({ loading: true });
    try {
      const [library, imported, state, connected] = await Promise.all([
        request<{ tracks: RemoteTrack[] }>("/api/library", { timeoutMs: 60_000 }),
        // Music imported from devices into the server's own library, as desktop lists it.
        request<Track[]>("/api/music/local/tracks", { timeoutMs: 30_000 }).catch(() => [] as Track[]),
        readState(undefined, true),
        request<ServiceAuthStatus>("/api/auth/status", { timeoutMs: 10_000 }).catch(() => null),
      ]);
      const order = parseJson<string[]>(stateValue(state, ORDER_KEY), []);
      const removed = new Set(parseJson<string[]>(stateValue(state, REMOVED_KEY), []));
      const positions = new Map(order.map((id, index) => [id, index]));
      const local = (JSON.parse(rebased(JSON.stringify(imported))) as Track[]).filter(track => track && typeof track.globalId === "string");
      const tracks = [...library.tracks.map(playableTrack), ...local]
        .filter(track => !removed.has(track.globalId))
        .sort((a, b) => (positions.get(a.globalId) ?? Infinity) - (positions.get(b.globalId) ?? Infinity));
      const { playlists, tracks: playlistTracks } = parsePlaylists(stateValue(state, PLAYLISTS_KEY));
      const history = parseJson<{ entries?: HistoryEntry[] }>(stateValue(state, HISTORY_KEY), {}).entries ?? [];
      publish({ tracks, playlists, playlistTracks, connected, history, error: null, loadedAt: Date.now() });
      // Service playlists load after, so the library shows without waiting on every service.
      const lists = emptyServices();
      await Promise.all(services.filter(service => connected?.[service]).map(async service => {
        lists[service] = await request<ServicePlaylist[]>(`/api/providers/${service}/playlists`, { timeoutMs: 60_000 }).catch(() => []);
      }));
      publish({ servicePlaylists: lists });
    } catch (reason) {
      publish({ error: reason instanceof Error ? reason.message : "Couldn't load your library." });
    } finally {
      publish({ loading: false });
      refreshing = null;
    }
  })();
  return refreshing;
}

/** Songs of an AMBRA playlist, in its order; songs that can't be found are left out. */
export function playlistSongs(playlist: Playlist, library = snapshot): Track[] {
  const inLibrary = new Map(library.tracks.map(track => [track.globalId, track]));
  return playlist.trackIds.flatMap(id => inLibrary.get(id) ?? library.playlistTracks.get(id) ?? []);
}

export type ServicePlaylistContents = {
  playlist: ServicePlaylist;
  entries: { id: string; trackId: string }[];
  revision: string;
  tracks: Track[];
  unavailableCount: number;
};

export async function servicePlaylistContents(provider: Service, id: string, signal?: AbortSignal): Promise<ServicePlaylistContents> {
  const result = await request<Omit<ServicePlaylistContents, "tracks"> & { tracks: RemoteTrack[] }>(`/api/providers/${provider}/playlists/${encodeURIComponent(id)}`, { signal, timeoutMs: 60_000 });
  return { ...result, tracks: result.tracks.map(playableTrack) };
}

const uuid = () => "10000000-1000-4000-8000-100000000000".replace(/[018]/g, digit =>
  (Number(digit) ^ (Math.floor(Math.random() * 256) & (15 >> (Number(digit) / 4)))).toString(16));

type SavedPlaylists = { version: 1; playlists: Playlist[]; tracks: Track[] };
function editPlaylists(change: (saved: SavedPlaylists) => SavedPlaylists) {
  return editState(PLAYLISTS_KEY, raw => {
    const saved = parseJson<SavedPlaylists>(raw, { version: 1, playlists: [], tracks: [] });
    return JSON.stringify(change({ version: 1, playlists: saved.playlists ?? [], tracks: saved.tracks ?? [] }));
  }).then(refreshLibrary);
}

function withTracks(saved: SavedPlaylists, tracks: Track[]) {
  const known = new Set(saved.tracks.map(track => track.globalId));
  return [...saved.tracks, ...tracks.filter(track => !known.has(track.globalId))];
}

export function addToPlaylist(playlistId: string, tracks: Track[]) {
  return editPlaylists(saved => ({
    ...saved,
    tracks: withTracks(saved, tracks),
    playlists: saved.playlists.map(playlist => playlist.id === playlistId
      ? { ...playlist, trackIds: [...new Set([...playlist.trackIds, ...tracks.map(track => track.globalId)])] }
      : playlist),
  }));
}

export function createPlaylist(name: string, tracks: Track[] = []) {
  const trimmed = name.trim();
  if (!trimmed) return Promise.reject(new Error("Give the playlist a name."));
  return editPlaylists(saved => ({
    ...saved,
    tracks: withTracks(saved, tracks),
    playlists: [...saved.playlists, { id: uuid(), name: trimmed, trackIds: [...new Set(tracks.map(track => track.globalId))] }],
  }));
}

export function renamePlaylist(playlistId: string, name: string) {
  const trimmed = name.trim();
  if (!trimmed) return Promise.reject(new Error("Give the playlist a name."));
  return editPlaylists(saved => ({ ...saved, playlists: saved.playlists.map(playlist => playlist.id === playlistId ? { ...playlist, name: trimmed } : playlist) }));
}

export function deletePlaylist(playlistId: string) {
  return editPlaylists(saved => ({ ...saved, playlists: saved.playlists.filter(playlist => playlist.id !== playlistId) }));
}

export function removeFromPlaylist(playlistId: string, trackIds: string[]) {
  const removed = new Set(trackIds);
  return editPlaylists(saved => ({
    ...saved,
    playlists: saved.playlists.map(playlist => playlist.id !== playlistId ? playlist : {
      ...playlist,
      trackIds: playlist.trackIds.filter(id => !removed.has(id)),
      ...(playlist.packages ? { packages: playlist.packages.map(pack => pack.filter(id => !removed.has(id))).filter(pack => pack.length > 1) } : {}),
    }),
  }));
}

/** An AMBRA copy of any playlist, named as desktop names duplicates. */
export function duplicatePlaylist(name: string, tracks: Track[]) {
  return createPlaylist(`${name} (Copy)`, tracks);
}

export async function addToServicePlaylist(provider: Service, playlistId: string, track: Track) {
  await request(`/api/providers/${provider}/playlists/${encodeURIComponent(playlistId)}`, {
    method: "POST", body: JSON.stringify({ action: "add", track }), timeoutMs: 60_000,
  });
}

export async function removeFromServicePlaylist(provider: Service, playlistId: string, entryIds: string[], revision: string) {
  await request(`/api/providers/${provider}/playlists/${encodeURIComponent(playlistId)}`, {
    method: "POST", body: JSON.stringify({ action: "remove", trackIds: entryIds, revision }), timeoutMs: 60_000,
  });
}

export async function renameServicePlaylist(provider: Service, playlistId: string, name: string) {
  await request(`/api/providers/${provider}/playlists/${encodeURIComponent(playlistId)}`, {
    method: "POST", body: JSON.stringify({ action: "rename", name: name.trim() }), timeoutMs: 60_000,
  });
  await refreshLibrary();
}

export async function deleteServicePlaylist(provider: Service, playlistId: string) {
  await request(`/api/providers/${provider}/playlists/${encodeURIComponent(playlistId)}`, { method: "DELETE", timeoutMs: 60_000 });
  await refreshLibrary();
}

export async function addToLibrary(track: Track) {
  await request(`/api/library/tracks`, { method: "POST", body: JSON.stringify({ provider: track.provider, providerTrackId: track.providerTrackId }), timeoutMs: 60_000 });
  await editState(REMOVED_KEY, raw => {
    const removed = parseJson<string[]>(raw, []);
    return removed.includes(track.globalId) ? JSON.stringify(removed.filter(id => id !== track.globalId)) : raw;
  });
  await editState(ORDER_KEY, raw => {
    const order = parseJson<string[]>(raw, []);
    return JSON.stringify([...order.filter(id => id !== track.globalId), track.globalId]);
  });
  await refreshLibrary();
}

export async function removeFromLibrary(tracks: Track[]) {
  const ids = new Set(tracks.map(track => track.globalId));
  // As desktop does: hidden at once by a shared tombstone, then forgotten by the server.
  await editState(REMOVED_KEY, raw => JSON.stringify([...new Set([...parseJson<string[]>(raw, []), ...ids])]));
  publish({ tracks: snapshot.tracks.filter(track => !ids.has(track.globalId)) });
  const streaming = tracks.filter(track => track.provider !== "local");
  if (streaming.length) {
    await request(`/api/library/tracks/remove`, {
      method: "POST",
      body: JSON.stringify({ tracks: streaming.map(({ provider, providerTrackId }) => ({ provider, providerTrackId })) }),
      timeoutMs: 30_000,
    }).catch(() => {});
  }
}

export const inLibrary = (id: string) => snapshot.tracks.some(track => track.globalId === id);

// Catalog pages, as desktop's artist and album views load them (desktop/src/api/server.ts).

function entityId(id: string, provider: string) {
  return encodeURIComponent(id.startsWith(`${provider}:`) ? id.slice(provider.length + 1) : id);
}

export async function albumTracks(album: CatalogAlbum, signal?: AbortSignal): Promise<Track[]> {
  if (album.provider === "local") return [];
  const page = await request<{ tracks: RemoteTrack[] }>(`/api/providers/${album.provider}/albums/${entityId(album.id, album.provider)}/tracks`, { signal, timeoutMs: 60_000 });
  return page.tracks.map(playableTrack);
}

export type ArtistProfile = { artist: CatalogArtist; biography: string | null; biographySource: string | null; popularTracks: Track[]; popularTracksError: string | null };
export async function artistProfile(artist: CatalogArtist, signal?: AbortSignal): Promise<ArtistProfile> {
  const profile = await request<Omit<ArtistProfile, "popularTracks"> & { popularTracks: RemoteTrack[] }>(`/api/providers/${artist.provider}/artists/${entityId(artist.id, artist.provider)}`, { signal, timeoutMs: 30_000 });
  return { ...profile, popularTracks: profile.popularTracks.map(playableTrack) };
}

export async function artistAlbums(artist: CatalogArtist, offset = 0, signal?: AbortSignal) {
  return request<{ albums: CatalogAlbum[]; nextOffset: number | null }>(`/api/providers/${artist.provider}/artists/${entityId(artist.id, artist.provider)}/albums?offset=${offset}&limit=30`, { signal, timeoutMs: 30_000 });
}

export type CatalogPage = { tracks: Track[]; artists: CatalogArtist[]; albums: CatalogAlbum[] };
export async function catalogSearch(query: string, provider: Service, signal?: AbortSignal): Promise<CatalogPage> {
  const parameters = new URLSearchParams({ query, provider, limit: "20" });
  const page = await request<{ tracks: RemoteTrack[]; artists?: CatalogArtist[]; albums?: CatalogAlbum[] }>(`/api/search/catalog?${parameters}`, { signal, timeoutMs: 25_000 });
  return { tracks: page.tracks.map(playableTrack), artists: page.artists ?? [], albums: page.albums ?? [] };
}

export type Discover = { tracks: Track[]; reasons: Record<string, string>; status: string };
export async function discover(signal?: AbortSignal): Promise<Discover> {
  const value = await request<{ tracks: (RemoteTrack | Track)[]; reasons: Record<string, string>; status: string }>("/api/recommendations/discover?limit=12", { signal, timeoutMs: 15_000 });
  return { ...value, tracks: value.tracks.map(track => "globalId" in track ? track : playableTrack(track)) };
}

/** Artists and albums in the library, grouped as desktop's library sections group them. */
export type LibraryArtist = CatalogArtist & { albumCount: number; trackCount: number };
export type LibraryAlbum = CatalogAlbum & { trackCount: number };

function albumKey(track: Track) {
  return `${track.provider}:${track.albumId ?? `${track.artist}:${track.album}:${track.albumVersion ?? ""}`}`;
}

export function libraryArtists(tracks: Track[]): LibraryArtist[] {
  const artists = new Map<string, LibraryArtist & { albums: Set<string> }>();
  for (const track of tracks) {
    const credited = track.artists.length ? track.artists : [{ providerId: track.artist, name: track.artist, imageUrl: null }];
    for (const artist of credited) {
      const id = `${track.provider}:${artist.providerId || artist.name}`;
      const current = artists.get(id) ?? { id, provider: track.provider, name: artist.name, imageUrl: artist.imageUrl, albumCount: 0, trackCount: 0, albums: new Set<string>() };
      current.imageUrl ??= artist.imageUrl;
      current.albums.add(albumKey(track));
      current.trackCount += 1;
      current.albumCount = current.albums.size;
      artists.set(id, current);
    }
  }
  return [...artists.values()].map(({ albums: _albums, ...artist }) => artist).sort((a, b) => a.name.localeCompare(b.name));
}

export function libraryAlbums(tracks: Track[]): LibraryAlbum[] {
  const albums = new Map<string, LibraryAlbum>();
  for (const track of tracks) {
    const id = albumKey(track);
    const current = albums.get(id);
    if (current) { current.trackCount += 1; continue; }
    albums.set(id, {
      id: track.albumId ? `${track.provider}:${track.albumId.replace(`${track.provider}:`, "")}` : id,
      provider: track.provider,
      title: track.album,
      artist: track.albumArtists.map(artist => artist.name).join(", ") || track.artist,
      artists: track.albumArtists,
      imageUrl: track.cover,
      releaseDate: track.releaseDate,
      version: track.albumVersion,
      trackCount: 1,
    });
  }
  return [...albums.values()].sort((a, b) => a.title.localeCompare(b.title));
}

export type CreditGroup = { role: string; names: string[] };
/** Who made the recording, as desktop's Credits dialog shows it. */
export async function trackCredits(track: Track, signal?: AbortSignal): Promise<{ source: string | null; credits: CreditGroup[] }> {
  if (track.provider === "local") return { source: null, credits: [] };
  return request("/api/credits/track", {
    method: "POST", signal, timeoutMs: 30_000,
    body: JSON.stringify({ provider: track.provider, trackId: track.providerTrackId, isrc: track.isrc, title: track.name, artist: track.artist }),
  });
}

/** Moves a song in an AMBRA playlist; bound songs are tidied back together as desktop does. */
export function reorderPlaylist(playlistId: string, visibleIds: string[]) {
  return editPlaylists(saved => ({
    ...saved,
    playlists: saved.playlists.map(playlist => {
      if (playlist.id !== playlistId) return playlist;
      const merged = mergeVisibleTrackOrder(playlist.trackIds, visibleIds);
      const { trackIds, packages } = normalizePackages(merged, playlist.packages ?? []);
      return { ...playlist, trackIds, ...(packages.length ? { packages } : {}) };
    }),
  }));
}

/** Moves a song in the library's shared order, as dragging does on desktop. */
export async function reorderLibrary(visibleIds: string[]) {
  const ids = new Set(visibleIds);
  // Shown at once; the server keeps the order every device uses.
  const positions = new Map(visibleIds.map((id, index) => [id, index]));
  publish({ tracks: [...snapshot.tracks].sort((a, b) => ids.has(a.globalId) && ids.has(b.globalId) ? positions.get(a.globalId)! - positions.get(b.globalId)! : 0) });
  await editState(ORDER_KEY, raw => {
    const order = parseJson<string[]>(raw, []);
    const known = new Set(order);
    const full = [...order, ...snapshot.tracks.map(track => track.globalId).filter(id => !known.has(id))];
    return JSON.stringify(mergeVisibleTrackOrder(full, visibleIds));
  });
}

/** Swaps songs in an AMBRA playlist for better copies (Improve Playlist), keeping their places. */
export function replacePlaylistTracks(playlistId: string, replacements: Map<string, Track>) {
  const swap = (id: string) => replacements.get(id)?.globalId ?? id;
  return editPlaylists(saved => ({
    ...saved,
    tracks: withTracks(saved, [...replacements.values()]),
    playlists: saved.playlists.map(playlist => playlist.id !== playlistId ? playlist : {
      ...playlist,
      trackIds: [...new Set(playlist.trackIds.map(swap))],
      ...(playlist.packages ? { packages: playlist.packages.map(pack => pack.map(swap)) } : {}),
    }),
  }));
}

/** TIDAL search names only a tier; its playback details give the exact format. */
export async function withPlayback(track: Track, signal?: AbortSignal): Promise<Track> {
  if (track.provider !== "tidal") return track;
  const details = await request<{ quality: string; maximumSamplingRateKHz: number | null; maximumBitDepth: number | null; bitrateKbps?: number | null; playback: { kind: "direct" | "dash"; url: string } }>(
    `/api/providers/tidal/tracks/${encodeURIComponent(track.providerTrackId)}/playback?durationSeconds=${track.durationSeconds}`, { signal, timeoutMs: 30_000 });
  return { ...track, audio: phoneMediaUrl(details.playback.url), playbackKind: details.playback.kind, quality: details.quality,
    bitrateKbps: details.bitrateKbps ?? null, maximumSamplingRateKHz: details.maximumSamplingRateKHz, maximumBitDepth: details.maximumBitDepth };
}
