import Constants from "expo-constants";
import { Platform } from "react-native";
import { useSyncExternalStore } from "react";
import type { Track } from "../../desktop/src/types/music";
import { networkCall, nativeNetworkAvailable } from "../modules/ambra-network/src";
import { remoteTrack } from "../../desktop/src/utils/remoteTrack";
import { Unpaired, clientId, request } from "./client";

/**
 * Downloads, as desktop offers them (`desktop/src/utils/offlineDownloads.ts`): to the server,
 * or to any open app, this phone included. This phone keeps its downloads encrypted in the
 * native bridge, which also plays them back through a loopback address without a server.
 */

/** Each service gives the best it has at or below the chosen quality. */
export type DownloadQuality = "max" | "hiRes" | "cd" | "lossy";
export const downloadQualities: { id: DownloadQuality; label: string }[] = [
  { id: "max", label: "Highest (up to 24-bit / 192 kHz)" },
  { id: "hiRes", label: "Hi-Res (up to 24-bit / 96 kHz)" },
  { id: "cd", label: "CD (16-bit / 44.1 kHz)" },
  { id: "lossy", label: "Lossy (up to 320 kbps)" },
];

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
};
export type DownloadClient = { id: string; name: string };

/** A song downloaded to this phone, with the loopback URLs that play it and show its cover. */
export type PhoneDownload = {
  id: string;
  provider: string;
  providerTrackId: string;
  requestedQuality: DownloadQuality;
  qualityLabel: string;
  sizeBytes: number;
  metadata: import("../../desktop/src/api/server").RemoteTrack;
  url: string;
  coverUrl: string | null;
};

type Downloads = {
  phone: ReadonlyMap<string, PhoneDownload>;
  server: ReadonlySet<string>;
  jobs: DownloadJob[];
  /** What this phone is downloading right now. */
  active: { done: number; total: number; current: string | null } | null;
};

let state: Downloads = { phone: new Map(), server: new Set(), jobs: [], active: null };
const listeners = new Set<() => void>();
function publish(change: Partial<Downloads>) {
  state = { ...state, ...change };
  for (const listener of listeners) listener();
}
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const downloadsSnapshot = () => state;
export const useDownloads = () => useSyncExternalStore(subscribe, downloadsSnapshot);

const DOWNLOADABLE = new Set(["tidal", "qobuz", "spotify"]);
export const isDownloadable = (id: string) => DOWNLOADABLE.has(id.split(":", 1)[0]);
export const onPhone = (id: string) => state.phone.has(id);
export const onServer = (id: string) => state.server.has(id);
/** This phone's loopback URL for the song, when it's downloaded here. */
export const phoneDownloadUrl = (id: string) => state.phone.get(id)?.url ?? null;

export async function refreshPhoneDownloads() {
  if (!nativeNetworkAvailable) return;
  try {
    const entries = await networkCall<PhoneDownload[]>("offline_list");
    publish({ phone: new Map(entries.map(entry => [entry.id, entry])) });
  } catch { /* Downloads are unavailable on this phone; nothing plays from them. */ }
}

export async function removePhoneDownloads(ids: string[]) {
  await networkCall("offline_remove", { ids });
  await refreshPhoneDownloads();
}

let jobPoll: ReturnType<typeof setTimeout> | undefined;
export async function refreshServerDownloads() {
  clearTimeout(jobPoll);
  try {
    const body = await request<{ entries: { id: string }[]; jobs: DownloadJob[] }>("/api/downloads", { timeoutMs: 10_000 });
    publish({ server: new Set(body.entries.map(entry => entry.id)), jobs: body.jobs });
    if (body.jobs.some(job => !job.finished)) jobPoll = setTimeout(() => void refreshServerDownloads(), 2000);
  } catch { /* Offline: keep what was last known. */ }
}

export async function removeServerDownloads(ids: string[]) {
  await request("/api/downloads/remove", { method: "POST", body: JSON.stringify({ ids }), timeoutMs: 10_000 });
  await refreshServerDownloads();
}

export const downloadClients = (signal?: AbortSignal) => request<DownloadClient[]>("/api/downloads/clients", { signal, timeoutMs: 8000 });

export type DownloadTarget = { kind: "server" } | { kind: "clients"; clientIds: string[] };
export async function requestDownloads(tracks: Pick<Track, "globalId" | "provider" | "providerTrackId">[], quality: DownloadQuality, target: DownloadTarget) {
  const chosen = tracks.filter(track => isDownloadable(track.globalId));
  if (!chosen.length) throw new Error("None of these songs can be downloaded");
  const { jobs } = await request<{ jobs: DownloadJob[] }>("/api/downloads", {
    method: "POST",
    body: JSON.stringify({
      tracks: chosen.map(({ provider, providerTrackId }) => ({ provider, providerTrackId })),
      quality,
      target: target.kind,
      clientIds: target.kind === "clients" ? target.clientIds : [],
    }),
    timeoutMs: 15_000,
  });
  void refreshServerDownloads();
  return jobs;
}

type ClientJob = { id: number; tracks: { provider: string; providerTrackId: string }[]; quality: DownloadQuality };

const pause = (ms: number, signal: AbortSignal) => new Promise<void>(resolve => {
  const timer = setTimeout(resolve, ms);
  signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
});

/** Downloads one song in the native bridge and waits until it's saved or has failed. */
async function downloadOne(track: ClientJob["tracks"][number], quality: DownloadQuality, signal: AbortSignal) {
  const { id } = await networkCall<{ id: string }>("offline_download", { provider: track.provider, providerTrackId: track.providerTrackId, quality });
  while (!signal.aborted) {
    await pause(1000, signal);
    const job = (await networkCall<Record<string, { state: string; error: string | null }>>("offline_jobs"))[id];
    if (!job || job.state === "done") return;
    if (job.state === "failed") throw new Error(job.error ?? "The download failed");
  }
}

/**
 * While the app is open and paired, this phone can be chosen to download to, like any
 * desktop app. Its long poll is what tells the server it's open.
 */
export function followPhoneDownloads(): () => void {
  const abort = new AbortController();
  const queue: ClientJob[] = [];
  let working = false;
  void refreshPhoneDownloads();
  void refreshServerDownloads();

  const work = async (id: string) => {
    if (working) return;
    working = true;
    try {
      while (queue.length && !abort.signal.aborted) {
        const job = queue.shift()!;
        let done = 0, failed = 0, error: string | null = null;
        const report = (current: string | null, finished: boolean) => {
          publish({ active: finished ? null : { done: done + failed, total: job.tracks.length, current } });
          void request(`/api/downloads/clients/${id}/progress`, {
            method: "POST", body: JSON.stringify({ jobId: job.id, done, failed, current, error, finished }), timeoutMs: 10_000,
          }).catch(() => {});
        };
        for (const track of job.tracks) {
          if (abort.signal.aborted) return;
          report(`${track.provider}:${track.providerTrackId}`, false);
          try { await downloadOne(track, job.quality, abort.signal); done++; }
          catch (reason) { failed++; error = reason instanceof Error ? reason.message : String(reason); }
          await refreshPhoneDownloads();
        }
        report(null, true);
      }
    } finally { working = false; }
  };

  void (async () => {
    if (!nativeNetworkAvailable) return;
    const id = await clientId();
    const name = (Constants.deviceName || (Platform.OS === "ios" ? "iPhone" : "Android phone")).slice(0, 64);
    while (!abort.signal.aborted) {
      try {
        const jobs = await request<ClientJob[]>(`/api/downloads/clients/${id}/jobs?wait=25&name=${encodeURIComponent(name)}`, { signal: abort.signal, timeoutMs: 40_000 });
        if (jobs.length) { queue.push(...jobs); void work(id); }
      } catch (error) {
        if (error instanceof Unpaired || abort.signal.aborted) return;
        await pause(5000, abort.signal);
      }
    }
  })();
  return () => abort.abort();
}

/** Opens this phone's downloads at startup, before any server connection. */
export async function startPhoneDownloads() {
  if (!nativeNetworkAvailable) return;
  await networkCall("offline_open").catch(() => {});
  await refreshPhoneDownloads();
}

/** This phone's copy of the song a server media URL plays, when it has one. */
export function phoneUrlForSource(source: string): string | null {
  const path = source.slice(Math.max(0, source.indexOf("/api/"))).split(/[?#]/)[0];
  const match = /^\/api\/providers\/([^/]+)\/tracks\/([^/]+)\//.exec(path) ?? /^\/api\/downloads\/play\/([^/]+)\/([^/]+)$/.exec(path);
  return match ? phoneDownloadUrl(`${match[1]}:${decodeURIComponent(match[2])}`) : null;
}

/** A phone download as the app shows it, with its saved cover, for use without a server. */
export function phoneTrack(entry: PhoneDownload): Track {
  const track = remoteTrack(entry.metadata, path => path);
  return {
    ...track,
    audio: entry.url,
    quality: entry.qualityLabel,
    ...(entry.coverUrl ? { cover: entry.coverUrl, nativeCover: entry.coverUrl, fullCover: entry.coverUrl } : {}),
  };
}
