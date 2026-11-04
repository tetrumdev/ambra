import { convertFileSrc, invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useSyncExternalStore } from "react";
import type { RemoteTrack } from "../api/server";
import { getServerConnection, serverBaseUrl, serverConnectionSignal, subscribeServerConnection } from "../api/serverConnection";
import type { GlobalTrackId, Track } from "../types/music";
import { remoteTrack } from "./remoteTrack";

/**
 * Songs downloaded to this device (played from their encrypted copies, without a server)
 * and to the server (played from its copy, without their service). `server/src/api/downloads.rs`
 * and `src-tauri/src/downloads.rs` keep them.
 */

/** Each service gives the best it has at or below the chosen quality. */
export type DownloadQuality = "max" | "hiRes" | "cd" | "lossy";
export const downloadQualities: { id: DownloadQuality; label: string }[] = [
  { id: "max", label: "Highest (up to 24-bit / 192 kHz)" },
  { id: "hiRes", label: "Hi-Res (up to 24-bit / 96 kHz)" },
  { id: "cd", label: "CD (16-bit / 44.1 kHz)" },
  { id: "lossy", label: "Lossy (up to 320 kbps)" },
];

export type DownloadEntry = {
  id: GlobalTrackId;
  provider: string;
  providerTrackId: string;
  container: string;
  requestedQuality: DownloadQuality;
  qualityLabel: string;
  sampleRateKHz: number | null;
  bitDepth: number | null;
  sizeBytes: number;
  downloadedAt: number;
  metadata: RemoteTrack;
  /** This device's player source (`ambra-offline:…`); absent for the server's copies. */
  source?: string;
  coverPath?: string | null;
};

export type DownloadJob = {
  id: number;
  target: "server" | "client";
  clientId: string | null;
  targetName: string;
  quality: DownloadQuality;
  total: number;
  done: number;
  failed: number;
  current: string | null;
  error: string | null;
  finished: boolean;
  createdAt: number;
};

export type DownloadClient = { id: string; name: string };

type DownloadState = {
  local: ReadonlyMap<GlobalTrackId, DownloadEntry>;
  server: ReadonlySet<GlobalTrackId>;
  jobs: DownloadJob[];
};

let state: DownloadState = { local: new Map(), server: new Set(), jobs: [] };
const listeners = new Set<() => void>();
const DOWNLOADABLE = new Set(["tidal", "qobuz", "spotify"]);

function publish(next: Partial<DownloadState>) {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useDownloads() {
  return useSyncExternalStore(subscribe, () => state);
}

/** This device's player source for the song, when it's downloaded here. */
export function offlineSource(id: GlobalTrackId): string | null {
  return state.local.get(id)?.source ?? null;
}

export function isDownloadedOnServer(id: GlobalTrackId) {
  return state.server.has(id);
}

/** Only songs from a streaming service can be downloaded; device files already are local. */
export function isDownloadable(id: GlobalTrackId) {
  return DOWNLOADABLE.has(id.split(":", 1)[0]);
}

/** A downloaded song as the app shows it, with its saved cover, for use without a server. */
export function offlineTrack(entry: DownloadEntry): Track {
  const track = remoteTrack(entry.metadata, path => `${serverBaseUrl}${path}`);
  const cover = entry.coverPath ? convertFileSrc(entry.coverPath) : null;
  return {
    ...track,
    quality: entry.qualityLabel,
    maximumSamplingRateKHz: entry.sampleRateKHz ?? track.maximumSamplingRateKHz,
    maximumBitDepth: entry.bitDepth ?? track.maximumBitDepth,
    ...(cover ? { cover, nativeCover: cover } : {}),
  };
}

export async function refreshLocalDownloads() {
  if (!isTauri()) return;
  try {
    const entries = await invoke<DownloadEntry[]>("offline_downloads");
    publish({ local: new Map(entries.map(entry => [entry.id, entry])) });
  } catch { /* Downloads are unavailable on this device; nothing plays from them. */ }
}

let jobPoll: ReturnType<typeof setTimeout> | undefined;

export async function refreshServerDownloads() {
  clearTimeout(jobPoll);
  if (!getServerConnection()?.server && isTauri()) {
    publish({ server: new Set(), jobs: [] });
    return;
  }
  try {
    const response = await fetch(`${serverBaseUrl}/api/downloads`, {
      cache: "no-store",
      signal: AbortSignal.any([serverConnectionSignal(), AbortSignal.timeout(10_000)]),
    });
    if (!response.ok) return;
    const body = await response.json() as { entries: DownloadEntry[]; jobs: DownloadJob[] };
    publish({ server: new Set(body.entries.map(entry => entry.id)), jobs: body.jobs });
    // Follows running downloads until they finish.
    if (body.jobs.some(job => !job.finished)) jobPoll = setTimeout(() => void refreshServerDownloads(), 2000);
  } catch { /* Offline: keep what was last known. */ }
}

let started = false;
/** Loads what's downloaded and follows changes; call once at startup. */
export function startDownloads() {
  if (started) return;
  started = true;
  void refreshLocalDownloads();
  void refreshServerDownloads();
  if (isTauri()) void listen("offline-downloads-changed", () => void refreshLocalDownloads());
  subscribeServerConnection(() => void refreshServerDownloads());
}

async function errorMessage(response: Response) {
  const body = await response.json().catch(() => null) as { error?: string } | null;
  return body?.error ?? `The server answered ${response.status}`;
}

/** The apps open on this server right now, which can be chosen to download to. */
export async function downloadClients(signal?: AbortSignal): Promise<DownloadClient[]> {
  const response = await fetch(`${serverBaseUrl}/api/downloads/clients`, {
    cache: "no-store",
    signal: AbortSignal.any([serverConnectionSignal(), AbortSignal.timeout(5000), ...(signal ? [signal] : [])]),
  });
  if (!response.ok) throw new Error(await errorMessage(response));
  return response.json();
}

export type DownloadTarget = { kind: "server" } | { kind: "clients"; clientIds: string[] };

export async function requestDownloads(trackIds: GlobalTrackId[], quality: DownloadQuality, target: DownloadTarget): Promise<DownloadJob[]> {
  const tracks = trackIds.filter(isDownloadable).map(id => {
    const separator = id.indexOf(":");
    return { provider: id.slice(0, separator), providerTrackId: id.slice(separator + 1) };
  });
  if (!tracks.length) throw new Error("None of these songs can be downloaded");
  const response = await fetch(`${serverBaseUrl}/api/downloads`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      tracks,
      quality,
      target: target.kind,
      clientIds: target.kind === "clients" ? target.clientIds : [],
    }),
    signal: AbortSignal.any([serverConnectionSignal(), AbortSignal.timeout(15_000)]),
  });
  if (!response.ok) throw new Error(await errorMessage(response));
  const { jobs } = await response.json() as { jobs: DownloadJob[] };
  void refreshServerDownloads();
  return jobs;
}

export async function removeLocalDownloads(ids: GlobalTrackId[]) {
  await invoke("remove_offline_downloads", { ids });
  await refreshLocalDownloads();
}

export async function removeServerDownloads(ids: GlobalTrackId[]) {
  const response = await fetch(`${serverBaseUrl}/api/downloads/remove`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids }),
    signal: AbortSignal.any([serverConnectionSignal(), AbortSignal.timeout(10_000)]),
  });
  if (!response.ok) throw new Error(await errorMessage(response));
  await refreshServerDownloads();
}

type DialogRequest = { trackIds: GlobalTrackId[]; title: string };
let dialogRequest: DialogRequest | null = null;
const dialogListeners = new Set<() => void>();

/** Opens the download menu for these songs. */
export function openDownloadDialog(trackIds: GlobalTrackId[], title: string) {
  dialogRequest = { trackIds: [...new Set(trackIds.filter(isDownloadable))], title };
  for (const listener of dialogListeners) listener();
}

export function closeDownloadDialog() {
  dialogRequest = null;
  for (const listener of dialogListeners) listener();
}

export function useDownloadDialogRequest() {
  return useSyncExternalStore(listener => {
    dialogListeners.add(listener);
    return () => { dialogListeners.delete(listener); };
  }, () => dialogRequest);
}
