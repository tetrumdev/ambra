import { playableTrack, serverBaseUrl, type RemoteTrack, type StreamingProvider } from "./server";
import type { Track } from "../types/music";

export type ServicePlaylist = { id: string; name: string; editable: boolean; trackCount: number };
export type ServicePlaylistContents = {
  playlist: ServicePlaylist;
  entries: { id: string; trackId: string }[];
  revision: string;
  tracks: Track[];
  unavailableCount: number;
};

async function request(provider: StreamingProvider, id?: string, init?: RequestInit) {
  const response = await fetch(`${serverBaseUrl}/api/providers/${provider}/playlists${id ? `/${encodeURIComponent(id)}` : ""}`, {
    ...init,
    cache: "no-store",
    signal: init?.signal ?? AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(body?.error ?? `Playlist sync failed (HTTP ${response.status}).`);
  }
  return response.json();
}

export async function servicePlaylists(provider: StreamingProvider, signal?: AbortSignal): Promise<ServicePlaylist[]> {
  return request(provider, undefined, { signal });
}

export async function servicePlaylistContents(provider: StreamingProvider, id: string, signal?: AbortSignal): Promise<ServicePlaylistContents> {
  const result = await request(provider, id, { signal }) as Omit<ServicePlaylistContents, "tracks"> & { tracks: RemoteTrack[] };
  return { ...result, tracks: result.tracks.map(playableTrack) };
}

export async function changeServicePlaylist(provider: StreamingProvider, id: string, change: { action: "add"; track: Track } | { action: "remove"; trackIds: string[]; revision: string }): Promise<void> {
  await request(provider, id, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(change) });
}
