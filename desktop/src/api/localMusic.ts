import { invoke, isTauri } from "@tauri-apps/api/core";
import { serverBaseUrl, serverUrl } from "./serverConnection";
import type { Track } from "../types/music";
import { reconcileTracks } from "../utils/trackReconcile";

/** Resolve the server's permanent media paths for this device, including its access token. */
export function localMusicTrack(track: Track): Track {
  const media = (url: string) => url.startsWith("/api/") ? serverUrl(url) : url;
  return {
    ...track,
    audio: media(track.audio),
    cover: media(track.cover),
    fullCover: track.fullCover ? media(track.fullCover) : undefined,
    nativeCover: track.nativeCover ? media(track.nativeCover) : null,
  };
}

/** The server's list as last received, for the server and access it was received with. */
let listing: { from: string; tag: string; tracks: Track[] } | null = null;

/** Merge changed tracks in the server's content ID order. */
export function mergeLocalMusic(previous: Track[], changed: Track[]): Track[] {
  if (changed.length === 0) return previous;
  const tracks: Track[] = [];
  let next = 0;
  for (const track of previous) {
    while (next < changed.length && changed[next].globalId < track.globalId) {
      tracks.push(changed[next++]);
    }
    tracks.push(changed[next]?.globalId === track.globalId ? changed[next++] : track);
  }
  while (next < changed.length) tracks.push(changed[next++]);
  return tracks;
}

/** Current servers return a delta. Older servers retain the conditional full-list API. */
export async function loadLocalMusic(signal: AbortSignal, incremental = false): Promise<{ tracks: Track[]; cursor?: string }> {
  const from = serverUrl("/api/music/local/tracks");
  const known = listing?.from === from ? listing : null;
  const query = new URLSearchParams(incremental ? { since: known?.tag ?? "" } : { known: known?.tag ?? "" });
  const response = await fetch(`${serverBaseUrl}/api/music/local/tracks?${query}`, {
    signal, cache: "no-store",
  });
  if (!response.ok) throw new Error(`Could not load local music (${response.status})`);
  const body = await response.json() as Track[] | { tag?: string; cursor?: string; reset?: boolean; tracks?: Track[] };
  signal.throwIfAborted();
  if (Array.isArray(body)) return { tracks: body.map(localMusicTrack) };
  const cursor = body.cursor ?? body.tag;
  const changed = body.tracks?.map(localMusicTrack) ?? [];
  const tracks = known && body.cursor && !body.reset ? mergeLocalMusic(known.tracks, changed)
    : !body.tracks && known ? known.tracks : reconcileTracks(known?.tracks ?? [], changed);
  if (cursor) listing = { from, tag: cursor, tracks };
  return { tracks, cursor: body.cursor };
}

export function localMusicSnapshot() {
  return listing?.from === serverUrl("/api/music/local/tracks") ? listing : null;
}

export async function importLocalMusic(): Promise<Track[]> {
  if (!isTauri()) throw new Error("Import local music from the desktop app.");
  return (await invoke<Track[]>("import_local_music")).map(localMusicTrack);
}
