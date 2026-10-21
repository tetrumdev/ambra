import type { GlobalTrackId, Track } from "../types/music";
import { invoke } from "@tauri-apps/api/core";
import {
  getPersistentItem,
  removePersistentItem,
  setPersistentItem,
} from "./persistentStorage";

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

export function parseCachedServerTracks(value: string | null): Track[] {
  if (value === null) return [];

  try {
    return normalizeCachedTracks(JSON.parse(value));
  } catch {
    return [];
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

export function loadCachedServerTracks(): Track[] {
  if (typeof localStorage === "undefined") return [];

  try {
    return parseCachedServerTracks(
      getPersistentItem(STREAMING_LIBRARY_CACHE_KEY),
    );
  } catch {
    return [];
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
export async function loadStreamingCache(): Promise<Track[]> {
  if (!inDesktop()) return [];
  let encoded = await desktopInvoke<string | null>("load_streaming_cache");
  const legacy = getPersistentItem(STREAMING_LIBRARY_CACHE_KEY);
  if (encoded === null && legacy !== null) {
    encoded = legacy;
    await desktopInvoke("save_streaming_cache", { json: legacy });
  }
  if (legacy !== null) removePersistentItem(STREAMING_LIBRARY_CACHE_KEY);
  return encoded === null ? [] : parseCachedServerTracks(encoded);
}

let pendingStreamingTracks: Track[] | null = null;
let streamingSaveTimer: ReturnType<typeof setTimeout> | undefined;

function flushStreamingCache() {
  streamingSaveTimer = undefined;
  const tracks = pendingStreamingTracks;
  pendingStreamingTracks = null;
  if (tracks === null) return;
  const json = JSON.stringify(tracks.filter((track) => track.provider !== "local"));
  void desktopInvoke("save_streaming_cache", { json })
    .then(() => {
      if (getPersistentItem(STREAMING_LIBRARY_CACHE_KEY) !== null) {
        removePersistentItem(STREAMING_LIBRARY_CACHE_KEY);
      }
    })
    .catch((error) => console.warn("Could not save the streaming library cache:", error));
}

export function saveCachedServerTracks(tracks: Track[]) {
  if (inDesktop()) {
    // Coalesce bursts (e.g. adding an album track by track) into one write.
    pendingStreamingTracks = tracks;
    clearTimeout(streamingSaveTimer);
    streamingSaveTimer = setTimeout(flushStreamingCache, STREAMING_CACHE_SAVE_DELAY_MS);
    return;
  }
  if (typeof localStorage === "undefined") return;

  try {
    setPersistentItem(
      STREAMING_LIBRARY_CACHE_KEY,
      JSON.stringify(tracks.filter((track) => track.provider !== "local")),
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
