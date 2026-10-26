import { connectFromBrowser, fromStorage, serverBaseUrl } from "../api/serverConnection";
import type { CoreView } from "../api/core";
import type { Track } from "../types/music";

/**
 * The phone remote's line to the server it was served from: pairing, following the core's
 * session and sending it commands. It plays nothing itself.
 */

const TOKEN_KEY = "ambra.remote.token";
const CLIENT_KEY = "ambra.remote.client";

export type RemoteView = Omit<CoreView, "queue"> & { queue: CoreView["queue"] };
type ArrivingView = Omit<CoreView, "queue"> & { queue?: CoreView["queue"] };

export class Unpaired extends Error {}

export const pairedToken = () => localStorage.getItem(TOKEN_KEY);

export function connect() {
  connectFromBrowser(location.origin, pairedToken());
}

function clientId() {
  let id = localStorage.getItem(CLIENT_KEY);
  if (!id) {
    // Not randomUUID: the remote is served over plain http on the network, where only getRandomValues exists.
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    id = `remote-${Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("")}`;
    localStorage.setItem(CLIENT_KEY, id);
  }
  return id;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${serverBaseUrl}${path}`, init);
  if (response.status === 401) {
    localStorage.removeItem(TOKEN_KEY);
    connect();
    throw new Unpaired("This device isn't paired");
  }
  const body = await response.json().catch(() => null) as (T & { error?: string }) | null;
  if (!response.ok) throw new Error(body?.error ?? `The server answered ${response.status}`);
  return body as T;
}

export type PairingStarted = { requestId: string; code: string };

export async function requestPairing() {
  return request<PairingStarted>("/api/pair/request", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientId: clientId(), clientName: "iPhone remote" }),
  });
}

/** Waits for the request to be approved at the server; resolves once paired. */
export async function awaitPairing(requestId: string, signal: AbortSignal) {
  while (!signal.aborted) {
    const status = await request<{ status: string; token?: string }>(`/api/pair/request/${requestId}`, { signal });
    if (status.status === "approved" && status.token) {
      localStorage.setItem(TOKEN_KEY, status.token);
      connect();
      return;
    }
    if (status.status !== "pending") throw new Error(status.status === "denied" ? "The server refused this device." : "The code expired.");
    await new Promise(resolve => setTimeout(resolve, 1500));
  }
}

let view: RemoteView | null = null;
let viewAt = performance.now();
const listeners = new Set<() => void>();

export const remoteView = () => view;
/** Seconds since the view's position was true. */
export const remoteViewAge = () => (performance.now() - viewAt) / 1000;

export function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function accept(next: ArrivingView) {
  if (view && next.instanceId === view.instanceId && next.revision < view.revision) return false;
  const { queue: arrived, ...rest } = next;
  // The queue is left out when unchanged; a different server or revision needs it asked for.
  if (arrived === undefined && (!view || view.instanceId !== next.instanceId || view.queueRevision !== next.queueRevision)) return false;
  const queue = arrived === undefined ? view!.queue : JSON.parse(fromStorage(JSON.stringify(arrived))) as CoreView["queue"];
  view = { ...JSON.parse(fromStorage(JSON.stringify(rest))) as Omit<CoreView, "queue">, queue };
  viewAt = performance.now();
  for (const listener of listeners) listener();
  return true;
}

/** Keeps the view current until `signal` aborts; rejects with `Unpaired` if the token stops working. */
export async function follow(signal: AbortSignal) {
  let wake = new AbortController();
  // A phone suspends pages in the background; coming back asks again at once for the true position.
  const visible = () => { if (!document.hidden) wake.abort(); };
  document.addEventListener("visibilitychange", visible);
  try {
    while (!signal.aborted) {
      const since = view ? `?since=${view.revision}&wait=25&queue=${view.queueRevision}` : "";
      try {
        const next = await request<ArrivingView>(`/api/session${since}`, { signal: AbortSignal.any([signal, wake.signal, AbortSignal.timeout(35_000)]) });
        if (!accept(next)) accept(await request<ArrivingView>("/api/session", { signal }));
      } catch (error) {
        if (error instanceof Unpaired) throw error;
        if (!wake.signal.aborted) await new Promise(resolve => setTimeout(resolve, 2000));
      }
      if (wake.signal.aborted) wake = new AbortController();
    }
  } finally {
    document.removeEventListener("visibilitychange", visible);
  }
}

export async function command(action: string, details: Record<string, unknown> = {}) {
  accept(await request<ArrivingView>(`/api/session/command${view ? `?queue=${view.queueRevision}` : ""}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, ...details }),
  }));
}

export function currentTrack(current: RemoteView | null): Track | null {
  const id = current?.queue.current?.globalTrackId;
  return (id && current?.queue.tracks?.find(track => track.globalId === id)) || null;
}
