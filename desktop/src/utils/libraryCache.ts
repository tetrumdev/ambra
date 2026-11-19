import type { GlobalTrackId, Track } from "../types/music";
import { invoke } from "@tauri-apps/api/core";
import {
  getPersistentItem,
  removePersistentItem,
  setPersistentItem,
} from "./persistentStorage";
import { forStorage, fromStorage, serverCacheKey, subscribeServerConnection, serverConnectionSignal, serverConnection } from "../api/serverConnection";

const STREAMING_LIBRARY_CACHE_KEY = "ambra.streaming-library.v1";
const STREAMING_CACHE_SAVE_DELAY_MS = 1000;
const REMOVED_LIBRARY_TRACKS_KEY = "ambra.removed-library-tracks.v1";

type CachedTrack = Omit<Track, "globalId"> & {
  globalId?: string;
  id?: string;
};

function isCachedTrack(value: unknown): value is CachedTrack {
  if (typeof value !== "object" || value === null) return false;

  const track = value as Partial<CachedTrack>;
  return (
    (typeof track.globalId === "string" || typeof track.id === "string") &&
    typeof track.provider === "string" &&
    track.provider !== "local" &&
    typeof track.providerTrackId === "string" &&
    (track.playbackKind === "direct" || track.playbackKind === "dash") &&
    typeof track.audio === "string" &&
    typeof track.cover === "string" &&
    typeof track.name === "string" &&
    typeof track.album === "string" &&
    typeof track.artist === "string" &&
    Array.isArray(track.artists) &&
    typeof track.durationSeconds === "number"
  );
}

export type CachedServerLibrary = { tracks: Track[]; cursor?: string; retry?: boolean };

export function parseCachedServerLibrary(value: string | null): CachedServerLibrary {
  if (value === null) return { tracks: [] };

  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return { tracks: normalizeCachedTracks(parsed) };
    const tracks = normalizeCachedTracks(parsed.tracks);
    // A cursor is valid only with the complete snapshot it describes.
    const cursor = Array.isArray(parsed.tracks) && parsed.tracks.length === tracks.length
      && typeof parsed.cursor === "string" ? parsed.cursor : undefined;
    return { tracks, cursor, retry: parsed.retry === true };
  } catch {
    return { tracks: [] };
  }
}

/** Keeps the valid cached streaming tracks, filling in fields older caches lack. */
export function normalizeCachedTracks(parsed: unknown): Track[] {
  return Array.isArray(parsed)
    ? parsed.filter(isCachedTrack).map((track) => {
        const { id: legacyId, ...cachedTrack } = track;

        return {
          ...cachedTrack,
          globalId: track.globalId ?? legacyId!,
          nativeCover:
            typeof track.nativeCover === "string"
              ? track.nativeCover
              : track.cover,
          version: track.version ?? null,
          albumVersion: track.albumVersion ?? null,
          albumArtists: Array.isArray(track.albumArtists)
            ? track.albumArtists.map((artist) => ({
                ...artist,
                imageUrl: artist.imageUrl ?? null,
              }))
            : [],
          artists: track.artists.map((artist) => ({
            ...artist,
            imageUrl: artist.imageUrl ?? null,
          })),
          copyright: track.copyright ?? null,
          label: track.label ?? null,
          genres: Array.isArray(track.genres) ? track.genres : [],
          upc: track.upc ?? null,
          maximumSamplingRateKHz: track.maximumSamplingRateKHz ?? null,
          maximumBitDepth: track.maximumBitDepth ?? null,
        };
      })
    : [];
}

export function loadCachedServerLibrary(): CachedServerLibrary {
  if (typeof localStorage === "undefined") return { tracks: [] };

  try {
    return parseCachedServerLibrary(
      fromStorage(getPersistentItem(serverCacheKey(STREAMING_LIBRARY_CACHE_KEY))),
    );
  } catch {
    return { tracks: [] };
  }
}

// The desktop app keeps this (potentially tens of megabytes) cache in a Rust-managed
// file: localStorage is size-limited, parsed synchronously, and was mirrored in full
// to disk on every change. The browser/dev build still uses localStorage.
function inDesktop() {
  return Boolean((globalThis as { isTauri?: boolean }).isTauri);
}

async function desktopInvoke<T>(command: string, args?: Record<string, unknown>) {
  return invoke<T>(command, args);
}

/**
 * Load the cached streaming library from the desktop backend. On first launch
 * after upgrading it migrates the old localStorage copy into the backend file and
 * deletes it, which frees storage quota and stops syncing a redundant copy.
 */
export async function loadStreamingCache(): Promise<CachedServerLibrary> {
  if (!inDesktop()) return { tracks: [] };
  const signal = serverConnectionSignal();
  const key = serverCacheKey(STREAMING_LIBRARY_CACHE_KEY);
  const serverIdentity = serverConnection?.server?.publicKey;
  let encoded = await desktopInvoke<string | null>("load_streaming_cache", { serverIdentity });
  signal.throwIfAborted();
  encoded = fromStorage(encoded);
  const legacy = fromStorage(getPersistentItem(key));
  if (encoded === null && legacy !== null) {
    encoded = legacy;
    await desktopInvoke("save_streaming_cache", { json: legacy, serverIdentity });
    signal.throwIfAborted();
  }
  if (legacy !== null) removePersistentItem(key);
  return parseCachedServerLibrary(encoded);
}

let pendingStreamingLibrary: CachedServerLibrary | null = null;
let streamingSaveTimer: ReturnType<typeof setTimeout> | undefined;

subscribeServerConnection(() => {
  clearTimeout(streamingSaveTimer);
  pendingStreamingLibrary = null;
});

function flushStreamingCache() {
  streamingSaveTimer = undefined;
  const library = pendingStreamingLibrary;
  pendingStreamingLibrary = null;
  if (library === null) return;
  const json = forStorage(encodeLibrary(library));
  const key = serverCacheKey(STREAMING_LIBRARY_CACHE_KEY);
  void desktopInvoke("save_streaming_cache", { json, serverIdentity: serverConnection?.server?.publicKey })
    .then(() => {
      if (getPersistentItem(key) !== null) {
        removePersistentItem(key);
      }
    })
    .catch((error) => console.warn("Could not save the streaming library cache:", error));
}

function encodeLibrary({ tracks, cursor, retry }: CachedServerLibrary) {
  const streaming = tracks.filter(track => track.provider !== "local");
  return JSON.stringify(cursor === undefined ? streaming : { tracks: streaming, cursor, retry });
}

export function saveCachedServerLibrary(library: CachedServerLibrary) {
  if (inDesktop()) {
    // Coalesce bursts (e.g. adding an album track by track) into one write.
    pendingStreamingLibrary = library;
    clearTimeout(streamingSaveTimer);
    streamingSaveTimer = setTimeout(flushStreamingCache, STREAMING_CACHE_SAVE_DELAY_MS);
    return;
  }
  if (typeof localStorage === "undefined") return;

  try {
    setPersistentItem(
      serverCacheKey(STREAMING_LIBRARY_CACHE_KEY),
      forStorage(encodeLibrary(library)),
    );
  } catch {
    // A storage quota or privacy setting should not prevent library playback.
  }
}

export function parseRemovedLibraryTrackIds(
  value: string | null,
): GlobalTrackId[] {
  if (value === null) return [];

  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];

    return [...new Set(parsed.filter((trackId) => typeof trackId === "string"))];
  } catch {
    return [];
  }
}

export function loadRemovedLibraryTrackIds(): Set<GlobalTrackId> {
  if (typeof localStorage === "undefined") return new Set();

  try {
    return new Set(
      parseRemovedLibraryTrackIds(
        getPersistentItem(REMOVED_LIBRARY_TRACKS_KEY),
      ),
    );
  } catch {
    return new Set();
  }
}

export function saveRemovedLibraryTrackIds(trackIds: Set<GlobalTrackId>) {
  if (typeof localStorage === "undefined") return;

  try {
    setPersistentItem(
      REMOVED_LIBRARY_TRACKS_KEY,
      JSON.stringify([...trackIds]),
    );
  } catch {
    // A storage quota or privacy setting should not prevent library playback.
  }
}
