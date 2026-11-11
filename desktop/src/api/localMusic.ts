import { invoke, isTauri } from "@tauri-apps/api/core";
import { serverBaseUrl, serverUrl } from "./serverConnection";
import type { Track } from "../types/music";

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

/**
 * The server's local music. Asked for every few seconds, so the server is told which list
 * this app has and answers with only its tag while the library is still that one; the same
 * array is then returned again.
 */
export async function loadLocalMusic(signal?: AbortSignal): Promise<Track[]> {
  const from = serverUrl("/api/music/local/tracks");
  const known = listing?.from === from ? listing : null;
  const response = await fetch(`${serverBaseUrl}/api/music/local/tracks?known=${encodeURIComponent(known?.tag ?? "")}`, { signal: signal ?? AbortSignal.timeout(10_000), cache: "no-store" });
  if (!response.ok) throw new Error(`Could not load local music (${response.status})`);
  const body = await response.json() as Track[] | { tag: string; tracks?: Track[] };
  // Older servers answer with the bare list every time.
  if (Array.isArray(body)) return body.map(localMusicTrack);
  if (!body.tracks && known) return known.tracks;
  const tracks = (body.tracks ?? []).map(localMusicTrack);
  listing = { from, tag: body.tag, tracks };
  return tracks;
}

export async function importLocalMusic(): Promise<Track[]> {
  if (!isTauri()) throw new Error("Import local music from the desktop app.");
  return (await invoke<Track[]>("import_local_music")).map(localMusicTrack);
}
