import * as SecureStore from "expo-secure-store";
import { AppState } from "react-native";
import { normalizePackages } from "./queueModel";
import { parseTrackLyrics, type TrackLyrics } from "../../desktop/src/utils/lyricsWire";
import { networkCall, nativeNetworkAvailable } from "../modules/ambra-network/src";
import { SessionClock } from "./sessionClock";
import { artworkPalettePath, parseArtworkPalette } from "../../desktop/src/utils/artworkPalette";

/**
 * The remote's line to the Ambra server: pairing, following the core's session
 * (server/src/session.rs), sending it commands, and registering this phone as an output.
 */

const ADDRESS_KEY = "ambra.server";
/** Public identity and endpoint hints from explicit pairing. */
const PAYLOAD_KEY = "ambra.pairingPayload.v1";
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
  providerTrackId?: string;
  isrc?: string | null;
  version?: string | null;
};

export type QueueItem = {
  globalTrackId: string;
  source?: { kind: "library" | "playlist" | "search"; id: string; entryId: number };
  shufflePackageId?: string | null;
};
export type QueueSnapshot = {
  version?: 1;
  history?: (QueueItem & { historyId: string; playedAt: string })[];
  current: QueueItem | null;
  upcoming: QueueItem[];
  tracks?: Track[];
};
export type Output = { endpointId: string; deviceId: string; endpointName: string; deviceName: string };
export type Endpoint = { id: string; name: string; devices: { id: string; name: string; isDefault: boolean }[]; selectedDeviceId: string | null };
export type SessionView = {
  instanceId: string;
  revision: number;
  playing: boolean;
  positionSeconds: number;
  serverTimeMs?: number;
  duration: number;
  buffering: boolean;
  error: string | null;
  output: Output | null;
  outputOnline: boolean;
  queueRevision: number;
  queue: QueueSnapshot;
};
/** The queue is left out when the remote already has that revision. */
type ArrivingView = Omit<SessionView, "queue"> & { queue?: SessionView["queue"] };

export class Unpaired extends Error {}

let baseUrl = "";
let pairingPayload: string | null = null;
let connectionEpoch = 0;

function assertConnection(epoch: number) {
  if (epoch !== connectionEpoch) throw Object.assign(new Error("The server connection changed. Try again."), { name: "AbortError" });
}

/** A fresh native bridge must fetch its own queue before the player displays a song. */
function resetSession() {
  connectionEpoch++;
  baseUrl = "";
  view = null;
  viewAt = Date.now();
  playbackClock.reset();
  for (const listener of listeners) listener();
}

/** The server and token saved by an earlier pairing, if any. */
export async function restore() {
  resetSession();
  const epoch = connectionEpoch;
  const [address, saved, payload] = await Promise.all([ADDRESS_KEY, TOKEN_KEY, PAYLOAD_KEY].map(key => SecureStore.getItemAsync(key)));
  assertConnection(epoch);
  pairingPayload = payload;
  if (!saved || !payload || !nativeNetworkAvailable) {
    // Never silently pin a key based on the legacy random server ID.
    baseUrl = "";
    return { address: payload ?? address, paired: false };
  }
  const opened = await networkCall<{ baseUrl: string }>("open", { payload, token: saved });
  assertConnection(epoch);
  baseUrl = opened.baseUrl;
  return { address: payload, paired: true };
}

export const networkStatus = () => networkCall<{ state: string; method?: string; error?: string }>("status");

async function forget() {
  resetSession();
  await SecureStore.deleteItemAsync(TOKEN_KEY);
  await networkCall("close");
}

export async function clientId() {
  let id = await SecureStore.getItemAsync(CLIENT_KEY);
  if (!id) {
    // Only tells this phone's requests apart; the server issues the secret token.
    id = `phone-${Array.from({ length: 4 }, () => Math.floor(Math.random() * 2 ** 32).toString(16).padStart(8, "0")).join("")}`;
    await SecureStore.setItemAsync(CLIENT_KEY, id);
  }
  return id;
}

/** A URL on the selected server's capability-protected native bridge. */
export function serverUrl(path: string) {
  return `${baseUrl}${path}`;
}

/** Lists use the server's bounded thumbnail instead of decoding original album artwork. */
export function thumbnailArtwork(track: Track | null | undefined) {
  if (!track || track.provider === "local" || !track.nativeCover?.startsWith("https://")) return track?.cover || null;
  const query = new URLSearchParams({ provider: track.provider, url: track.nativeCover });
  return serverUrl(`/api/artwork/thumbnail?${query}`);
}

// Saved queues hold server URLs as the saving computer knew them (desktop/src/api/serverConnection.ts).
const SAVED_SERVER_URL = /http:\/\/[^/"\\\s]+:\d+(?:\/[a-f0-9]{64})?(\/api\/[^"\\\s]*)/g;
const TOKEN_IN_QUERY = /([?&])access_token=[^&#"\\]*&?/;
function rebased(text: string) {
  return text
    .replace(SAVED_SERVER_URL, (_, path: string) => serverUrl(path.replace(TOKEN_IN_QUERY, "$1").replace(/[?&]$/, "")))
    .replace(/"(\/api\/music\/local\/files\/[^"\\\s]+)/g, (_, path: string) => `"${serverUrl(path)}`);
}

/** The current server address, which changes when the phone moves between networks. */
export const serverAddress = () => baseUrl;

/** Uses the same provider lookup and wire validation as desktop, through the paired server. */
export async function trackLyrics(track: Track, signal: AbortSignal): Promise<TrackLyrics> {
  const query = new URLSearchParams({ trackName: track.name, artistName: track.artist, albumName: track.album, durationSeconds: String(track.durationSeconds) });
  if (track.isrc) query.set("isrc", track.isrc);
  if (track.version) query.set("version", track.version);
  if (track.provider === "spotify" && track.providerTrackId) query.set("spotifyId", track.providerTrackId);
  return parseTrackLyrics(await request<unknown>(`/api/lyrics?${query}`, { signal, timeoutMs: 30_000 }));
}

// Connection policy and retry live in Rust. A possibly delivered mutation is never replayed.
async function request<T>(path: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<T> {
  return send<T>(path, init);
}

async function send<T>(path: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<T> {
  const epoch = connectionEpoch;
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), init.timeoutMs ?? 20_000);
  const abort = () => timeout.abort();
  init.signal?.addEventListener("abort", abort);
  if (init.signal?.aborted) timeout.abort();
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      ...init,
      signal: timeout.signal,
      headers: { ...(init.body ? { "Content-Type": "application/json" } : {}) },
    });
    assertConnection(epoch);
    if (response.status === 401) {
      await forget();
      throw new Unpaired("This phone isn't paired with the server");
    }
    const body = await response.json().catch(() => null) as (T & { error?: string }) | null;
    assertConnection(epoch);
    if (!response.ok) throw Object.assign(new Error(body?.error ?? `The server answered ${response.status}`), { status: response.status, body });
    return body as T;
  } catch (error) {
    // Our own deadline, not the caller giving up: say so instead of the fetch's "request has been canceled".
    if (timeout.signal.aborted && !init.signal?.aborted) throw new Error("The server took too long to answer. Check your connection and try again.");
    throw error;
  } finally {
    clearTimeout(timer);
    init.signal?.removeEventListener("abort", abort);
  }
}

export type PairingStarted = { requestId: string; code: string };

/** `name` is how the server lists this phone, e.g. in its outputs. */
export async function requestPairing(address: string, name: string) {
  if (!address.trim().startsWith("ambra://pair/")) throw new Error("Paste the pairing link from ambra-server pair qr. Legacy addresses need re-pairing.");
  pairingPayload = address.trim();
  resetSession();
  const epoch = connectionEpoch;
  const opened = await networkCall<{ baseUrl: string }>("open", { payload: pairingPayload });
  assertConnection(epoch);
  baseUrl = opened.baseUrl;
  return request<PairingStarted>("/api/pair/request", {
    method: "POST", body: JSON.stringify({ clientId: await clientId(), clientName: name.slice(0, 64) }), timeoutMs: 30_000,
  });
}

/** Resolves once someone approves the code at the server. */
export async function awaitPairing(requestId: string, signal: AbortSignal) {
  const epoch = connectionEpoch;
  while (!signal.aborted) {
    const status = await request<{ status: string; token?: string }>(`/api/pair/request/${requestId}`, { signal });
    if (status.status === "approved" && status.token) {
      await SecureStore.setItemAsync(TOKEN_KEY, status.token);
      await SecureStore.setItemAsync(PAYLOAD_KEY, pairingPayload!);
      assertConnection(epoch);
      if (signal.aborted) return;
      resetSession();
      const pairedEpoch = connectionEpoch;
      const opened = await networkCall<{ baseUrl: string }>("open", { payload: pairingPayload, token: status.token });
      assertConnection(pairedEpoch);
      baseUrl = opened.baseUrl;
      return;
    }
    if (status.status !== "pending") throw new Error(status.status === "denied" ? "The server refused this phone." : "The code expired.");
    await new Promise(resolve => setTimeout(resolve, 1500));
  }
}

let view: SessionView | null = null;
let viewAt = Date.now();
const playbackClock = new SessionClock();
const listeners = new Set<() => void>();

export const sessionView = () => view;
/** Seconds since the view's position was true. */
export const sessionViewAge = () => playbackClock.age(view?.serverTimeMs, viewAt, Date.now());

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
  if (view?.instanceId !== next.instanceId) playbackClock.reset();
  view = { ...rest, queue };
  viewAt = Date.now();
  for (const listener of listeners) listener();
  return true;
}

/** Keeps the view current until `signal` aborts; rejects with `Unpaired` if the token stops working. */
export async function follow(signal: AbortSignal) {
  let wake = new AbortController();
  // iOS suspends the app in the background; coming back asks again at once for the true position.
  const subscription = AppState.addEventListener("change", state => { if (state === "active") { wake.abort(); void networkCall("resume").catch(() => {}); } });
  try {
    while (!signal.aborted) {
      const since = view ? `?since=${view.revision}&wait=25&queue=${view.queueRevision}` : "";
      const stop = new AbortController();
      const abort = () => stop.abort();
      signal.addEventListener("abort", abort);
      const wakeSignal = wake.signal;
      wakeSignal.addEventListener("abort", abort);
      if (signal.aborted || wakeSignal.aborted) stop.abort();
      try {
        const next = await request<ArrivingView>(`/api/session${since}`, { signal: stop.signal, timeoutMs: 35_000 });
        if (!accept(next)) accept(await request<ArrivingView>("/api/session", { signal }));

      } catch (error) {
        if (error instanceof Unpaired) throw error;
        if (!wake.signal.aborted && !signal.aborted) await new Promise(resolve => setTimeout(resolve, 2000));
      } finally {
        signal.removeEventListener("abort", abort);
        wakeSignal.removeEventListener("abort", abort);
      }
      if (wake.signal.aborted) wake = new AbortController();
    }
  } finally {
    subscription.remove();
  }
}

let commandChain: Promise<unknown> = Promise.resolve();
function inOrder<T>(work: () => Promise<T>): Promise<T> {
  const result = commandChain.then(work, work);
  commandChain = result.catch(() => {});
  return result;
}

export function command(action: string, details: Record<string, unknown> = {}) {
  const epoch = connectionEpoch;
  return inOrder(async () => {
    assertConnection(epoch);
    accept(await request<ArrivingView>(`/api/session/command${view ? `?queue=${view.queueRevision}` : ""}`, {
      method: "POST",
      body: JSON.stringify({ action, ...details }),
    }));
  });
}

export function endpoints(signal: AbortSignal) {
  return request<Endpoint[]>("/api/endpoints", { signal, timeoutMs: 10_000 });
}

export function endpointRequest<T>(id: string, path: string, init: RequestInit = {}) {
  // Reports may take as long as the server waits before calling an output offline (OFFLINE_AFTER).
  return request<T>(`/api/endpoints/${encodeURIComponent(id)}/${path}`, { ...init, timeoutMs: path.startsWith("commands") ? 30_000 : 8000 });
}

/** Re-anchor lyrics to a fresh session and compensate for delivery delay, as desktop does. */
export async function refreshSession(signal: AbortSignal, options: { clock?: "recent" | "force" } = {}) {
  if (options.clock && !view) accept(await request<ArrivingView>("/api/session", { signal, timeoutMs: 10_000 }));
  const instance = view?.instanceId;
  if (options.clock && (options.clock === "force" || !playbackClock.recent(Date.now()))) {
    await Promise.all(Array.from({ length: 3 }, async () => {
      const sent = Date.now();
      try {
        const report = await request<{ serverTimeMs: number }>("/api/session/clock", { signal, timeoutMs: 3000 });
        if (!signal.aborted && instance === view?.instanceId) playbackClock.sample(report.serverTimeMs, sent, Date.now());
      } catch (error) { if (signal.aborted) throw error; } // Older servers still support a fresh position report.
    }));
  }
  const path = `/api/session${view ? `?queue=${view.queueRevision}` : ""}`;
  if (!accept(await request<ArrivingView>(path, { signal, timeoutMs: 10_000 }))) {
    accept(await request<ArrivingView>("/api/session", { signal, timeoutMs: 10_000 }));
  }
}

/** Keep the core's source unchanged in reports; authenticate/rebase only the native media URL. */
export function phoneMediaUrl(source: string) {
  if (source.startsWith("/api/") || /^https?:\/\/[^/]+\/api\//.test(source)) {
    const path = source.slice(source.indexOf("/api/"));
    const [pathname, query = ""] = path.split("?");
    const parameters = new URLSearchParams(query);
    parameters.delete("access_token");
    const remaining = parameters.toString();
    return serverUrl(`${pathname}${remaining ? `?${remaining}` : ""}`);
  }
  if (/^https?:\/\//.test(source)) return source;
  throw new Error("This file is only on the computer. Import it into the server library to play it on your phone.");
}

/** Apply against the latest queue; rebase on conflicts without losing another device's edits. */
export function changeQueue(change: (queue: QueueSnapshot, revision: number) => QueueSnapshot, play = false) {
  const epoch = connectionEpoch;
  return inOrder(async () => {
    assertConnection(epoch);
    for (let attempt = 0; attempt < 4; attempt++) {
      if (!view) accept(await request<ArrivingView>("/api/session"));
      const current = view!;
      const queue = change(current.queue, current.queueRevision);
      try {
        accept(await request<ArrivingView>("/api/session/queue", {
          method: "POST",
          // Media URLs carry only an ephemeral bridge capability, removed from shared state.
          body: JSON.stringify({ base: current.queueRevision, queue, ...(play ? { playTrackId: queue.current?.globalTrackId } : {}) })
            .replace(SAVED_SERVER_URL, url => url.replace(TOKEN_IN_QUERY, "$1").replace(/[?&]$/, "").replace(/\/[a-f0-9]{64}(?=\/api\/)/, "")),
        }));
        return;
      } catch (error) {
        const conflict = error as { status?: number; body?: { session?: ArrivingView } };
        if (conflict.status !== 409) throw error;
        accept(conflict.body?.session ?? await request<ArrivingView>("/api/session"));
      }
    }
    throw new Error("The queue keeps changing on another device. Please try again.");
  });
}

export type MobilePlaylist = { id: string; name: string; trackIds: string[]; packages?: string[][] };
export type PlaylistContents = { playlist: MobilePlaylist; tracks: Track[]; unavailableCount: number };

/** This first library view deliberately opens MEGA, using the desktop's saved order and tracks. */
export async function megaPlaylist(signal: AbortSignal): Promise<PlaylistContents> {
  // All shared state comes at once; even compressed it's the largest request, so it may take a while over a relay.
  const state = await request<{ values: Record<string, string> }>("/api/state", { signal, timeoutMs: 60_000 });
  const encoded = state.values["ambra.playlists.v1"];
  const saved = encoded ? JSON.parse(rebased(encoded)) as { playlists: MobilePlaylist[]; tracks: Track[] } : null;
  const found = saved?.playlists.find(item => item.id === "1255df67-7977-4f0e-8e69-23420d41c563")
    ?? saved?.playlists.find(item => item.name.trim().toLowerCase() === "mega");
  if (!found) throw new Error("MEGA isn't on this server yet. Open it on desktop and sync your playlists, then retry.");
  // Tidied exactly as desktop loads it (utils/playlistStorage.ts), so bound songs sit together
  // in the list and every package shuffles as one, even if the saved one is out of date.
  const stored = Array.isArray(found.packages) ? found.packages.filter(pack => Array.isArray(pack) && pack.every(id => typeof id === "string")) : [];
  const { trackIds, packages } = normalizePackages([...new Set(found.trackIds)], stored);
  const playlist: MobilePlaylist = { ...found, trackIds, packages };
  const byId = new Map(saved!.tracks.map(track => [track.globalId, track]));
  const tracks = playlist.trackIds.flatMap(id => byId.get(id) ?? []);
  return { playlist, tracks, unavailableCount: playlist.trackIds.length - tracks.length };
}

export function currentTrack(current: SessionView | null): Track | null {
  const id = current?.queue.current?.globalTrackId;
  return (id && current?.queue.tracks?.find(track => track.globalId === id)) || null;
}

export type Palette = import("../../desktop/src/utils/artworkPalette").ArtworkPalette;

/** The cover's colors as the server measures them, for the swirl. */
export async function coverPalette(provider: string, url: string | null, cover?: string): Promise<Palette | null> {
  const path = artworkPalettePath(provider, url, cover);
  if (!path) return null;
  try {
    return parseArtworkPalette(await request<unknown>(path));
  } catch { return null; }
}
