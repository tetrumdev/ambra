import type { Playlist, Track } from "../types/music";
import { setPersistentItem } from "./persistentStorage";
import { normalizePackages } from "./playlistPackages";

export const PLAYLIST_STORAGE_KEY = "ambra.playlists.v1";
export type PlaylistSnapshot = { version: 1; playlists: Playlist[]; tracks: Track[] };
export const emptyPlaylists = (): PlaylistSnapshot => ({ version: 1, playlists: [], tracks: [] });

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isSavedTrack(value: unknown): value is Track {
  if (!record(value)) return false;
  return ["globalId", "providerTrackId", "audio", "cover", "name", "album", "artist"].every(key => typeof value[key] === "string")
    && ["local", "tidal", "qobuz", "spotify"].includes(String(value.provider))
    && ["direct", "dash"].includes(String(value.playbackKind))
    && typeof value.durationSeconds === "number" && Number.isFinite(value.durationSeconds)
    && [value.artists, value.albumArtists].every(artists => Array.isArray(artists) && artists.every(artist => record(artist) && typeof artist.name === "string" && typeof artist.providerId === "string"));
}

export function parsePlaylistSnapshot(raw: string | null): PlaylistSnapshot {
  if (!raw) return emptyPlaylists();
  const value: unknown = JSON.parse(raw);
  if (!record(value) || value.version !== 1 || !Array.isArray(value.playlists) || !Array.isArray(value.tracks)) {
    throw new Error("Unrecognized playlist data");
  }
  const ids = new Set<string>();
  const playlists = value.playlists.map(item => {
    if (!record(item) || typeof item.id !== "string" || !item.id || ids.has(item.id)
      || typeof item.name !== "string" || !item.name.trim() || !Array.isArray(item.trackIds)
      || !item.trackIds.every(id => typeof id === "string")) throw new Error("Invalid playlist data");
    ids.add(item.id);
    const trackIds = [...new Set(item.trackIds as string[])];
    // Packages are optional and only advisory; malformed ones are dropped rather than failing the load.
    const storedPackages = Array.isArray(item.packages)
      ? item.packages.filter((pack): pack is string[] => Array.isArray(pack) && pack.every(id => typeof id === "string"))
      : [];
    return withPackages({ id: item.id, name: item.name, trackIds }, storedPackages);
  });
  if (!value.tracks.every(isSavedTrack)) throw new Error("Invalid saved playlist track");
  return { version: 1, playlists, tracks: value.tracks };
}

/** The playlist with its packages tidied against its songs; no `packages` key when it has none. */
export function withPackages(playlist: Playlist, packages = playlist.packages ?? []): Playlist {
  const normalized = normalizePackages(playlist.trackIds, packages);
  const { packages: _previous, ...rest } = playlist;
  return normalized.packages.length
    ? { ...rest, trackIds: normalized.trackIds, packages: normalized.packages }
    : { ...rest, trackIds: normalized.trackIds };
}

export function addPlaylistTrack(snapshot: PlaylistSnapshot, playlistId: string, track: Track): PlaylistSnapshot {
  if (!snapshot.playlists.some(playlist => playlist.id === playlistId)) return snapshot;
  const tracks = new Map(snapshot.tracks.map(item => [item.globalId, item]));
  tracks.set(track.globalId, track);
  return {
    ...snapshot,
    tracks: [...tracks.values()],
    playlists: snapshot.playlists.map(playlist => playlist.id === playlistId && !playlist.trackIds.includes(track.globalId)
      ? { ...playlist, trackIds: [...playlist.trackIds, track.globalId] } : playlist),
  };
}

export function savePlaylistSnapshot(snapshot: PlaylistSnapshot, write = setPersistentItem): PlaylistSnapshot {
  const used = new Set(snapshot.playlists.flatMap(playlist => playlist.trackIds));
  const saved = { ...snapshot, tracks: snapshot.tracks.filter(track => used.has(track.globalId)) };
  write(PLAYLIST_STORAGE_KEY, JSON.stringify(saved));
  return saved;
}
