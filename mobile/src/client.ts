import Constants from "expo-constants";
import * as SecureStore from "expo-secure-store";
import { AppState } from "react-native";
import { normalizePackages } from "./queueModel";
import { parseTrackLyrics, type TrackLyrics } from "../../desktop/src/utils/lyricsWire";
import { SessionClock } from "./sessionClock";

/**
 * The remote's line to the Ambra server: pairing, following the core's session
 * (server/src/session.rs), sending it commands, and registering this phone as an output.
 */

export const SERVER_PORT = 38147;
const ADDRESS_KEY = "ambra.server";
/** Every address this server has answered at, the one in use first. */
const ADDRESSES_KEY = "ambra.addresses";
const IDENTITY_KEY = "ambra.serverIdentity";
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
let token: string | null = null;
let addresses: string[] = [];
/** Who the paired server is, so another address is only trusted if the same server answers there. */
type Identity = { id: string; name: string; port: number };
let identity: Identity | null = null;

const parsed = <T>(text: string | null): T | null => {
  try { return text ? JSON.parse(text) as T : null; } catch { return null; }
};

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
  const [address, saved, known, who] = await Promise.all([ADDRESS_KEY, TOKEN_KEY, ADDRESSES_KEY, IDENTITY_KEY].map(key => SecureStore.getItemAsync(key)));
  if (address) baseUrl = address;
  token = saved;
  identity = parsed<Identity>(who);
  addresses = [...new Set([...(address ? [address] : []), ...(parsed<string[]>(known) ?? [])])];
  if (address && saved && !identity) await identifyLegacyPairing(saved);
  // Metro may now be reachable over Tailscale while the saved server address is still
  // on home Wi-Fi. Resolve the paired server before opening long polls or sending presence.
  if (address && saved && identity) await reconnect();
  return { address: baseUrl || null, paired: !!(address && saved) };
}

async function forget() {
  token = null;
  await SecureStore.deleteItemAsync(TOKEN_KEY);
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

/** `url` on this server with this device's token, for images. */
export function serverUrl(path: string) {
  return `${baseUrl}${path}${token ? `${path.includes("?") ? "&" : "?"}access_token=${encodeURIComponent(token)}` : ""}`;
}

/** Lists use the server's bounded thumbnail instead of decoding original album artwork. */
export function thumbnailArtwork(track: Track | null | undefined) {
  if (!track || track.provider === "local" || !track.nativeCover?.startsWith("https://")) return track?.cover || null;
  const query = new URLSearchParams({ provider: track.provider, url: track.nativeCover });
  return serverUrl(`/api/artwork/thumbnail?${query}`);
}

// Saved queues hold server URLs as the saving computer knew them (desktop/src/api/serverConnection.ts).
const SAVED_SERVER_URL = /http:\/\/[^/"\\\s]+:\d+(\/api\/[^"\\\s]*)/g;
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

async function identify(address: string): Promise<Identity | null> {
  const timeout = AbortSignal.timeout(3000);
  try {
    const info = await (await fetch(`${address}/api/server/info`, { signal: timeout })).json() as { service?: string; id?: string; name?: string; port?: number };
    return info.service === "ambra" && info.id ? { id: info.id, name: info.name ?? "", port: info.port ?? SERVER_PORT } : null;
  } catch {
    return null;
  }
}

/** Older pairings saved only an address and token, so ID-based recovery cannot run yet. */
async function identifyLegacyPairing(savedToken: string) {
  const development = suggestedAddress();
  // Metro supplies the running app's code and is already trusted with its credentials.
  // Only the saved host and that development host may receive a legacy pairing's token.
  const known = [...new Set([baseUrl, ...(development ? [normalizeAddress(development)] : [])])];
  const found = await Promise.any(known.map(async address => {
    const info = await identify(address);
    if (!info) throw new Error("Not an Ambra server");
    const response = await fetch(`${address}/api/endpoints`, {
      headers: { Authorization: `Bearer ${savedToken}` }, signal: AbortSignal.timeout(3000),
    });
    if (!response.ok || !Array.isArray(await response.json())) throw new Error("Not this phone's paired server");
    return { address, info };
  })).catch(() => null);
  if (!found) return;
  identity = found.info;
  await SecureStore.setItemAsync(IDENTITY_KEY, JSON.stringify(identity));
  await switchAddress(found.address);
}

/**
 * Where else the server might answer: saved addresses, the development host the phone
 * already reaches, and the machine's MagicDNS name. Each must prove the same server ID.
 */
function candidates() {
  const machine = identity?.name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  const development = suggestedAddress();
  const developmentAddress = development ? normalizeAddress(development).replace(/:\d+$/, `:${identity?.port ?? SERVER_PORT}`) : "";
  return [...new Set([baseUrl, ...addresses, developmentAddress, ...(machine ? [`http://${machine}:${identity!.port}`] : [])])].filter(Boolean);
}

async function switchAddress(address: string) {
  baseUrl = address;
  addresses = [address, ...addresses.filter(known => known !== address)].slice(0, 6);
  // Artwork and media URLs were written against the old address.
  if (view) {
    view = JSON.parse(rebased(JSON.stringify(view))) as SessionView;
    for (const listener of listeners) listener();
  }
  await Promise.all([SecureStore.setItemAsync(ADDRESS_KEY, address), SecureStore.setItemAsync(ADDRESSES_KEY, JSON.stringify(addresses))]);
}

let identifying = false;
let reconnecting: Promise<void> | null = null;
let probedAt = 0;
/** After the server stops answering, switch to whichever known address the same server answers at first. */
function reconnect() {
  const id = identity?.id;
  if (!id || Date.now() - probedAt < 3000) return reconnecting ?? Promise.resolve();
  reconnecting ??= (async () => {
    const found = await Promise.any(candidates().map(async address => {
      if ((await identify(address))?.id !== id) throw new Error("Not this server");
      return address;
    })).catch(() => null);
    // Throttle failed discovery, but let a newly failed route recover immediately even
    // when it was healthy during startup (or the previous request).
    probedAt = found ? 0 : Date.now();
    if (found && found !== baseUrl) await switchAddress(found);
  })().finally(() => { reconnecting = null; });
  return reconnecting;
}

async function request<T>(path: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<T> {
  const address = baseUrl;
  try {
    return await send<T>(path, init);
  } catch (error) {
    // Only an unreachable server moves addresses; anything it answered stands.
    if (init.signal?.aborted || error instanceof Unpaired || (error as { status?: number }).status !== undefined) throw error;
    await reconnect();
    if (init.signal?.aborted) throw error;
    // A read is safe to repeat; a command might have reached the server, so it's left to the person.
    if (baseUrl !== address && (init.method ?? "GET") === "GET") return send<T>(path, init);
    throw error;
  }
}

async function send<T>(path: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<T> {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), init.timeoutMs ?? 20_000);
  const abort = () => timeout.abort();
  init.signal?.addEventListener("abort", abort);
  if (init.signal?.aborted) timeout.abort();
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
  baseUrl = normalizeAddress(address);
  token = null;
  // A new pairing may be a different server; nothing earlier stands in for it.
  identity = null;
  addresses = [];
  const started = await request<PairingStarted>("/api/pair/request", {
    method: "POST",
    body: JSON.stringify({ clientId: await clientId(), clientName: name.slice(0, 64) }),
    timeoutMs: 8000,
  });
  identity = await identify(baseUrl);
  await Promise.all([
    SecureStore.setItemAsync(IDENTITY_KEY, JSON.stringify(identity)),
    switchAddress(baseUrl),
  ]);
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
        // Phones paired before servers were identified learn it once, while the address still works.
        if (!identity && !identifying) {
          identifying = true;
          void identify(baseUrl).then(found => {
            identifying = false;
            if (!found || identity) return;
            identity = found;
            void SecureStore.setItemAsync(IDENTITY_KEY, JSON.stringify(found));
          });
        }
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

let commandChain: Promise<unknown> = Promise.resolve();
function inOrder<T>(work: () => Promise<T>): Promise<T> {
  const result = commandChain.then(work, work);
  commandChain = result.catch(() => {});
  return result;
}

export function command(action: string, details: Record<string, unknown> = {}) {
  return inOrder(async () => {
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
  accept(await request<ArrivingView>("/api/session", { signal, timeoutMs: 10_000 }));
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
  return inOrder(async () => {
    for (let attempt = 0; attempt < 4; attempt++) {
      if (!view) accept(await request<ArrivingView>("/api/session"));
      const current = view!;
      const queue = change(current.queue, current.queueRevision);
      try {
        accept(await request<ArrivingView>("/api/session/queue", {
          method: "POST",
          // Media URLs carry this phone's token in memory, never in shared saved state.
          body: JSON.stringify({ base: current.queueRevision, queue, ...(play ? { playTrackId: queue.current?.globalTrackId } : {}) })
            .replace(SAVED_SERVER_URL, url => url.replace(TOKEN_IN_QUERY, "$1").replace(/[?&]$/, "")),
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

export type Palette = { colors: string[]; weights: number[] };

/** The cover's colors as the server measures them, for the swirl. */
export async function coverPalette(provider: string, url: string | null, cover?: string): Promise<Palette | null> {
  let path: string;
  if (provider === "local") {
    // Only content-addressed artwork in the paired server's library can be sampled.
    const file = [url, cover].map(source => {
      try { return new URL(source ?? "", baseUrl).pathname.match(/^\/api\/music\/local\/files\/([a-f0-9]{64}\.[a-z0-9]{1,8})$/)?.[1]; } catch { return null; }
    }).find(Boolean);
    if (!file) return null;
    path = `/api/music/local/files/${file}/palette`;
  } else {
    // Older saved tracks can have only a display URL, including a server artwork proxy.
    if (!url?.startsWith("https://")) {
      try {
        const displayed = new URL(cover ?? "", baseUrl);
        url = displayed.searchParams.get("url") ?? (displayed.protocol === "https:" ? displayed.href : null);
      } catch { return null; }
    }
    if (!url?.startsWith("https://")) return null;
    path = `/api/artwork/palette?${new URLSearchParams({ provider, url, weighted: "true" })}`;
  }
  try {
    const result = await request<Palette | string[]>(path);
    const palette = Array.isArray(result) ? { colors: result, weights: result.map(() => 1 / result.length) } : result;
    if (!palette || palette.colors?.length !== 4 || palette.weights?.length !== 4
      || !palette.colors.every(color => /^#[0-9a-f]{6}$/i.test(color))
      || !palette.weights.every(weight => Number.isFinite(weight) && weight >= 0)
      || !palette.weights.some(weight => weight > 0)) return null;
    return palette;
  } catch { return null; }
}
