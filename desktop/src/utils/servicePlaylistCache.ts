import { invoke } from "@tauri-apps/api/core";
import type { StreamingProvider } from "../api/server";
import type { ServicePlaylistContents } from "../api/playlists";
import type { Playlist } from "../types/music";
import { normalizeCachedTracks } from "./libraryCache";
import { getPersistentItem, setPersistentItem } from "./persistentStorage";

const CACHE_KEY = "ambra.service-playlists.v1";
const SAVE_DELAY_MS = 1000;

/**
 * Raised when the server describes tracks differently, so contents cached before then are
 * fetched again. 2: publishers, producers and band members are no longer listed as artists.
 */
export const TRACK_DETAILS_VERSION = 2;

export type CachedPlaylistContents = ServicePlaylistContents & {
  /** When these contents were last fetched from the service, in epoch milliseconds. */
  fetchedAt: number;
  /** The `TRACK_DETAILS_VERSION` they were fetched under; absent before versions were kept. */
  detailsVersion?: number;
};

/** Whether cached contents predate how the server now describes tracks. */
export function outdatedContents(cached: CachedPlaylistContents | undefined) {
  return cached !== undefined && (cached.detailsVersion ?? 1) < TRACK_DETAILS_VERSION;
}

export type ServicePlaylistCache = {
  version: 1;
  groups: { provider: StreamingProvider; playlists: Playlist[] }[];
  contents: Record<string, CachedPlaylistContents>;
};

const providers: readonly string[] = ["spotify", "qobuz", "tidal"];

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isPlaylist(value: unknown): value is Playlist {
  return record(value) && typeof value.id === "string" && typeof value.name === "string"
    && typeof value.remoteId === "string" && providers.includes(String(value.provider));
}

function parseContents(value: unknown): CachedPlaylistContents | null {
  if (!record(value) || !record(value.playlist) || typeof value.revision !== "string"
    || typeof value.fetchedAt !== "number" || !Array.isArray(value.entries) || !Array.isArray(value.tracks)) return null;
  return {
    playlist: value.playlist as ServicePlaylistContents["playlist"],
    entries: value.entries.filter(entry => record(entry) && typeof entry.id === "string" && typeof entry.trackId === "string") as ServicePlaylistContents["entries"],
    revision: value.revision,
    tracks: normalizeCachedTracks(value.tracks),
    unavailableCount: typeof value.unavailableCount === "number" ? value.unavailableCount : 0,
    fetchedAt: value.fetchedAt,
    ...(typeof value.detailsVersion === "number" ? { detailsVersion: value.detailsVersion } : {}),
  };
}

function parse(encoded: string | null): ServicePlaylistCache | null {
  if (encoded === null) return null;
  try {
    const value: unknown = JSON.parse(encoded);
    if (!record(value) || value.version !== 1 || !Array.isArray(value.groups) || !record(value.contents)) return null;
    const groups = value.groups.flatMap(group => record(group) && providers.includes(String(group.provider)) && Array.isArray(group.playlists)
      ? [{ provider: group.provider as StreamingProvider, playlists: group.playlists.filter(isPlaylist).map(playlist => ({ ...playlist, trackIds: [] })) }]
      : []);
    const contents: Record<string, CachedPlaylistContents> = {};
    for (const [id, item] of Object.entries(value.contents)) {
      const parsed = parseContents(item);
      if (parsed) contents[id] = parsed;
    }
    return { version: 1, groups, contents };
  } catch {
    return null;
  }
}

// Like the streaming library, the desktop app keeps this potentially large copy in a
// Rust-managed cache file rather than size-limited localStorage.
function inDesktop() {
  return Boolean((globalThis as { isTauri?: boolean }).isTauri);
}

export async function loadServicePlaylistCache(): Promise<ServicePlaylistCache | null> {
  try {
    return parse(inDesktop()
      ? await invoke<string | null>("load_service_playlist_cache")
      : getPersistentItem(CACHE_KEY));
  } catch {
    return null;
  }
}

let pending: ServicePlaylistCache | null = null;
let saveTimer: ReturnType<typeof setTimeout> | undefined;

function flush() {
  saveTimer = undefined;
  const cache = pending;
  pending = null;
  if (cache === null) return;
  // Contents of playlists the services no longer list are dropped.
  const listed = new Set(cache.groups.flatMap(group => group.playlists.map(playlist => playlist.id)));
  const json = JSON.stringify({
    ...cache,
    groups: cache.groups.map(group => ({ ...group, playlists: group.playlists.map(playlist => ({ ...playlist, trackIds: [] })) })),
    contents: Object.fromEntries(Object.entries(cache.contents).filter(([id]) => listed.has(id))),
  });
  if (inDesktop()) {
    void invoke("save_service_playlist_cache", { json })
      .catch(error => console.warn("Could not save the playlist cache:", error));
    return;
  }
  try {
    setPersistentItem(CACHE_KEY, json);
  } catch {
    // A storage quota or privacy setting should not prevent playlist playback.
  }
}

/** Coalesces bursts of playlist loads into one write. */
export function saveServicePlaylistCache(cache: ServicePlaylistCache) {
  pending = cache;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, SAVE_DELAY_MS);
}
