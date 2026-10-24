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

export async function loadLocalMusic(signal?: AbortSignal): Promise<Track[]> {
  const response = await fetch(`${serverBaseUrl}/api/music/local/tracks`, { signal: signal ?? AbortSignal.timeout(10_000), cache: "no-store" });
  if (!response.ok) throw new Error(`Could not load local music (${response.status})`);
  return (await response.json() as Track[]).map(localMusicTrack);
}

export async function importLocalMusic(): Promise<Track[]> {
  if (!isTauri()) throw new Error("Import local music from the desktop app.");
  return (await invoke<Track[]>("import_local_music")).map(localMusicTrack);
}
