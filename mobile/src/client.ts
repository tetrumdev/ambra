import Constants from "expo-constants";
import * as SecureStore from "expo-secure-store";
import { AppState } from "react-native";

/**
 * The remote's line to the Ambra server: pairing, following the core's session
 * (server/src/session.rs) and sending it commands. The phone plays nothing itself.
 */

export const SERVER_PORT = 38147;
const ADDRESS_KEY = "ambra.server";
const TOKEN_KEY = "ambra.token";
const CLIENT_KEY = "ambra.client";

export type Track = {
  globalId: string;
  provider: string;
  name: string;
  artist: string;
  album: string;
  cover: string;
  fullCover?: string;
  nativeCover: string | null;
  durationSeconds: number;
};

type QueueItem = { globalTrackId: string };
export type SessionView = {
  instanceId: string;
  revision: number;
  playing: boolean;
  positionSeconds: number;
  duration: number;
  buffering: boolean;
  error: string | null;
  output: { endpointName: string; deviceName: string } | null;
  outputOnline: boolean;
  queueRevision: number;
  queue: { current: QueueItem | null; upcoming: QueueItem[]; tracks?: Track[] };
};
/** The queue is left out when the remote already has that revision. */
type ArrivingView = Omit<SessionView, "queue"> & { queue?: SessionView["queue"] };

export class Unpaired extends Error {}

let baseUrl = "";
let token: string | null = null;

/** In development the server usually runs on the computer serving the app, so start there. */
export function suggestedAddress() {
  const host = Constants.expoConfig?.hostUri?.split(":")[0];
  return host ? `${host}:${SERVER_PORT}` : "";
}

export function normalizeAddress(address: string) {
  const trimmed = address.trim().replace(/\/+$/, "");
  const withScheme = /^https?:\/\//.test(trimmed) ? trimmed : `http://${trimmed}`;
  return /:\d+$/.test(withScheme) ? withScheme : `${withScheme}:${SERVER_PORT}`;
}

/** The server and token saved by an earlier pairing, if any. */
export async function restore() {
  const [address, saved] = await Promise.all([SecureStore.getItemAsync(ADDRESS_KEY), SecureStore.getItemAsync(TOKEN_KEY)]);
  if (address) baseUrl = address;
  token = saved;
  return { address, paired: !!(address && saved) };
}

async function forget() {
  token = null;
  await SecureStore.deleteItemAsync(TOKEN_KEY);
}

async function clientId() {
  let id = await SecureStore.getItemAsync(CLIENT_KEY);
  if (!id) {
    // Only tells this phone's requests apart; the server issues the secret token.
    id = `phone-${Array.from({ length: 4 }, () => Math.floor(Math.random() * 2 ** 32).toString(16).padStart(8, "0")).join("")}`;
    await SecureStore.setItemAsync(CLIENT_KEY, id);
  }
  return id;
}

/** `url` on this server with this device's token, for images. */
export function serverUrl(path: string) {
  return `${baseUrl}${path}${token ? `${path.includes("?") ? "&" : "?"}access_token=${encodeURIComponent(token)}` : ""}`;
}

// Saved queues hold server URLs as the saving computer knew them (desktop/src/api/serverConnection.ts).
const SAVED_SERVER_URL = /http:\/\/[^/"\\\s]+:\d+(\/api\/[^"\\\s]*)/g;
const TOKEN_IN_QUERY = /([?&])access_token=[^&#"\\]*&?/;
function rebased(text: string) {
  return text
    .replace(SAVED_SERVER_URL, (_, path: string) => serverUrl(path.replace(TOKEN_IN_QUERY, "$1").replace(/[?&]$/, "")))
    .replace(/"(\/api\/music\/local\/files\/[^"\\\s]+)/g, (_, path: string) => `"${serverUrl(path)}`);
}

async function request<T>(path: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<T> {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), init.timeoutMs ?? 20_000);
  const abort = () => timeout.abort();
  init.signal?.addEventListener("abort", abort);
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      ...init,
      signal: timeout.signal,
      headers: { ...(init.body ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    });
    if (response.status === 401) {
      await forget();
      throw new Unpaired("This phone isn't paired with the server");
    }
    const body = await response.json().catch(() => null) as (T & { error?: string }) | null;
    if (!response.ok) throw new Error(body?.error ?? `The server answered ${response.status}`);
    return body as T;
  } finally {
    clearTimeout(timer);
    init.signal?.removeEventListener("abort", abort);
  }
}

export type PairingStarted = { requestId: string; code: string };

export async function requestPairing(address: string) {
  baseUrl = normalizeAddress(address);
  token = null;
  const started = await request<PairingStarted>("/api/pair/request", {
    method: "POST",
    body: JSON.stringify({ clientId: await clientId(), clientName: "iPhone" }),
    timeoutMs: 8000,
  });
  await SecureStore.setItemAsync(ADDRESS_KEY, baseUrl);
  return started;
}

/** Resolves once someone approves the code at the server. */
export async function awaitPairing(requestId: string, signal: AbortSignal) {
  while (!signal.aborted) {
    const status = await request<{ status: string; token?: string }>(`/api/pair/request/${requestId}`, { signal });
    if (status.status === "approved" && status.token) {
      token = status.token;
      await SecureStore.setItemAsync(TOKEN_KEY, status.token);
      return;
    }
    if (status.status !== "pending") throw new Error(status.status === "denied" ? "The server refused this phone." : "The code expired.");
    await new Promise(resolve => setTimeout(resolve, 1500));
  }
}

let view: SessionView | null = null;
let viewAt = Date.now();
const listeners = new Set<() => void>();

export const sessionView = () => view;
/** Seconds since the view's position was true. */
export const sessionViewAge = () => (Date.now() - viewAt) / 1000;

export function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function accept(next: ArrivingView) {
  if (view && next.instanceId === view.instanceId && next.revision < view.revision) return true;
  const { queue: arrived, ...rest } = next;
  // Left out as unchanged; a different server or revision has to be asked for in full.
  if (arrived === undefined && (!view || view.instanceId !== next.instanceId || view.queueRevision !== next.queueRevision)) return false;
  const queue = arrived === undefined ? view!.queue : JSON.parse(rebased(JSON.stringify(arrived))) as SessionView["queue"];
  view = { ...rest, queue };
  viewAt = Date.now();
  for (const listener of listeners) listener();
  return true;
}

/** Keeps the view current until `signal` aborts; rejects with `Unpaired` if the token stops working. */
export async function follow(signal: AbortSignal) {
  let wake = new AbortController();
  // iOS suspends the app in the background; coming back asks again at once for the true position.
  const subscription = AppState.addEventListener("change", state => { if (state === "active") wake.abort(); });
  try {
    while (!signal.aborted) {
      const since = view ? `?since=${view.revision}&wait=25&queue=${view.queueRevision}` : "";
      const stop = new AbortController();
      const abort = () => stop.abort();
      signal.addEventListener("abort", abort);
      wake.signal.addEventListener("abort", abort);
      try {
        const next = await request<ArrivingView>(`/api/session${since}`, { signal: stop.signal, timeoutMs: 35_000 });
        if (!accept(next)) accept(await request<ArrivingView>("/api/session", { signal }));
      } catch (error) {
        if (error instanceof Unpaired) throw error;
        if (!wake.signal.aborted && !signal.aborted) await new Promise(resolve => setTimeout(resolve, 2000));
      } finally {
        signal.removeEventListener("abort", abort);
      }
      if (wake.signal.aborted) wake = new AbortController();
    }
  } finally {
    subscription.remove();
  }
}

export async function command(action: string, details: Record<string, unknown> = {}) {
  accept(await request<ArrivingView>(`/api/session/command${view ? `?queue=${view.queueRevision}` : ""}`, {
    method: "POST",
    body: JSON.stringify({ action, ...details }),
  }));
}

export function currentTrack(current: SessionView | null): Track | null {
  const id = current?.queue.current?.globalTrackId;
  return (id && current?.queue.tracks?.find(track => track.globalId === id)) || null;
}

export type Palette = { colors: string[]; weights: number[] };

/** The cover's colors as the server measures them, for the swirl. */
export async function coverPalette(provider: string, url: string | null): Promise<Palette | null> {
  if (provider === "local" || !url?.startsWith("https://")) return null;
  const query = new URLSearchParams({ provider, url, weighted: "true" });
  return request<Palette>(`/api/artwork/palette?${query}`).catch(() => null);
}
