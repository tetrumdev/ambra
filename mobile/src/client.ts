import * as SecureStore from "expo-secure-store";
import { AppState } from "react-native";
import { diag, diagEvery } from "./diagnostics";
import { parseTrackLyrics, type TrackLyrics } from "../../desktop/src/utils/lyricsWire";
import { networkCall, nativeNetworkAvailable } from "../modules/ambra-network/src";
import { SessionClock } from "./sessionClock";
import { artworkPalettePath, parseArtworkPalette } from "../../desktop/src/utils/artworkPalette";
import { applyQueuePatch, queuePatchApplies, type QueuePatch } from "../../desktop/src/utils/queuePatch";
import { readJsonLines } from "../../desktop/src/utils/jsonLines";

/**
 * The remote's line to the Ambra server: pairing, following the core's session
 * (server/src/session.rs), sending it commands, and registering this phone as an output.
 */

const ADDRESS_KEY = "ambra.server";
/** Public identity and endpoint hints from explicit pairing. */
const PAYLOAD_KEY = "ambra.pairingPayload.v1";
const TOKEN_KEY = "ambra.token";
const CLIENT_KEY = "ambra.client";
/** Expo Go has no native bridge: it reaches the server's LAN address directly with its token. */
const DIRECT_KEY = "ambra.direct.v1";
const SESSION_KEY = "ambra.session";
/** A connection type to use alone (desktop's Server settings); none means automatic. */
const METHOD_KEY = "ambra.connectionMethod";
export const connectionMethods = ["Lan", "Public", "HyperDHT", "TcpPunch", "Tailcat"] as const;
export type ConnectionMethod = typeof connectionMethods[number];
let method: ConnectionMethod | null = null;
export const connectionMethod = () => method;
/** Uses only `next` from now on (or chooses automatically), reconnecting at once. */
export async function setConnectionMethod(next: ConnectionMethod | null) {
  method = next;
  await (next ? SecureStore.setItemAsync(METHOD_KEY, next) : SecureStore.deleteItemAsync(METHOD_KEY));
  if (!directMode) await restore();
}
/** The server's default port, where its LAN address answers plain HTTP. */
const DEFAULT_PORT = 38147;

/** True in Expo Go and other builds without the native networking module. */
export const directMode = !nativeNetworkAvailable;

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
export type Endpoint = {
  id: string;
  name: string;
  devices: { id: string; name: string; isDefault: boolean }[];
  selectedDeviceId: string | null;
  /** The app's last report; `syncV1` means it can play in step with other outputs. */
  status?: { syncV1?: boolean; satellitesV1?: boolean; volume?: number } | null;
};
/** Named groups of outputs a session plays on together (desktop's stages). */
export type Stage = { id: string; name: string; outputs: Output[]; volumes?: Record<string, number>; targetLufs?: number };
/** A server runs several sessions, each with its own queue and outputs. */
export type Session = {
  id: string;
  name: string;
  playing: boolean;
  output: Output | null;
  outputs?: Output[];
  track: { title?: string; artist?: string; album?: string; cover?: string } | null;
  stages?: Stage[];
  activeStage?: string;
};
export const MAIN_SESSION = "main";
export const GENERAL_STAGE = "general";
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
  /** Every output playing in step, the leading one first. Missing from older servers. */
  outputs?: Output[];
  audioQuality?: { bitDepth?: number | null; sampleRate?: number | null; codec?: string | null; label?: string | null } | null;
  /** What the output was asked to play, as the core sent it. */
  loadedSource?: string | null;
  queueRevision: number;
  queue: QueueSnapshot;
};
/** The queue is left out when the remote already has that revision. */
type ArrivingView = Omit<SessionView, "queue"> & { queue?: SessionView["queue"]; queuePatch?: QueuePatch };

export class Unpaired extends Error {}

let baseUrl = "";
/** The device token, sent by this app itself only in direct mode; the native bridge adds it otherwise. */
let directToken: string | null = null;
let session = MAIN_SESSION;
let pairingPayload: string | null = null;
let connectionEpoch = 0;
let pairingStorage = Promise.resolve();

function writePairing<T>(work: () => Promise<T>): Promise<T> {
  const pending = pairingStorage.then(work);
  pairingStorage = pending.then(() => {}, () => {});
  return pending;
}

function assertConnection(epoch: number) {
  if (epoch !== connectionEpoch) throw Object.assign(new Error("The server connection changed. Try again."), { name: "AbortError" });
}

/** A fresh native bridge must fetch its own queue before the player displays a song. */
function resetSession() {
  connectionEpoch++;
  baseUrl = "";
  directToken = null;
  view = null;
  viewAt = Date.now();
  playbackClock.reset();
  syncClock.reset();
  show();
}

/** The server and token saved by an earlier pairing, if any. */
export async function restore() {
  resetSession();
  const epoch = connectionEpoch;
  await pairingStorage;
  assertConnection(epoch);
  const [address, saved, payload, direct, chosen, chosenMethod] = await Promise.all([ADDRESS_KEY, TOKEN_KEY, PAYLOAD_KEY, DIRECT_KEY, SESSION_KEY, METHOD_KEY].map(key => SecureStore.getItemAsync(key)));
  assertConnection(epoch);
  session = chosen || MAIN_SESSION;
  method = connectionMethods.find(known => known === chosenMethod) ?? null;
  pairingPayload = payload;
  if (directMode) {
    const pairing = parseDirect(direct);
    if (!pairing) return { address: payload ?? address, paired: false };
    baseUrl = pairing.base;
    directToken = pairing.token;
    return { address: pairing.base, paired: true };
  }
  if (!saved || !payload || !nativeNetworkAvailable) {
    // Never silently pin a key based on the legacy random server ID.
    baseUrl = "";
    return { address: payload ?? address, paired: false };
  }
  const opened = await networkCall<{ baseUrl: string }>("open", { payload, token: saved, method });
  assertConnection(epoch);
  baseUrl = opened.baseUrl;
  return { address: payload, paired: true };
}

type NetworkStatus = { state: string; method?: string; error?: string; tailcatPath?: { kind: "unknown" | "direct" | "derp"; region?: number } };
export async function networkStatus(): Promise<NetworkStatus> {
  if (!directMode) return networkCall<NetworkStatus>("status");
  if (!baseUrl) return { state: "Offline", error: "Not paired" };
  try {
    const response = await fetch(`${baseUrl}/api/health`, { signal: deadline(4000) });
    return response.ok ? { state: "Connected", method: "Direct LAN" } : { state: "Offline", error: `The server answered ${response.status}` };
  } catch {
    return { state: "Offline", error: "Can't reach the server on this network" };
  }
}

/** Aborts after `ms`, or with `signal`; React Native lacks AbortSignal.timeout and .any. */
function deadline(ms: number, signal?: AbortSignal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  signal?.addEventListener("abort", () => controller.abort());
  controller.signal.addEventListener("abort", () => clearTimeout(timer));
  return controller.signal;
}

function parseDirect(raw: string | null): { base: string; token: string } | null {
  try {
    const value = raw ? JSON.parse(raw) as { base?: unknown; token?: unknown } : null;
    return typeof value?.base === "string" && typeof value.token === "string" ? { base: value.base, token: value.token } : null;
  } catch { return null; }
}

async function forget() {
  resetSession();
  if (directMode) { await writePairing(() => SecureStore.deleteItemAsync(DIRECT_KEY)); return; }
  await writePairing(() => SecureStore.deleteItemAsync(TOKEN_KEY));
  await networkCall("close");
}

/** The session this app follows; requests for the first one name none, as older servers expect. */
export const currentSession = () => session;
function inSession(path: string) {
  return session === MAIN_SESSION ? path : `${path}${path.includes("?") ? "&" : "?"}session=${encodeURIComponent(session)}`;
}

/** Follows another of the server's sessions from now on; this phone remembers the choice. */
export function setSession(id: string) {
  if (id === session) return;
  session = id;
  void (id === MAIN_SESSION ? SecureStore.deleteItemAsync(SESSION_KEY) : SecureStore.setItemAsync(SESSION_KEY, id)).catch(() => {});
  view = null;
  viewAt = Date.now();
  playbackClock.reset();
  wakeFollower();
  show();
}

/** The server's sessions; none from a server too old to run more than one. */
export async function sessions(signal?: AbortSignal): Promise<Session[]> {
  try {
    return JSON.parse(rebased(JSON.stringify(await request<Session[]>("/api/sessions", { signal, timeoutMs: 10_000 })))) as Session[];
  } catch (error) {
    if ((error as { status?: number }).status === 404) return [];
    throw error;
  }
}
export const createSession = (name: string) => request<Session>("/api/sessions", { method: "POST", body: JSON.stringify({ name }) });
export const setStages = (id: string, stages: Stage[], active?: string) =>
  request<Session[]>(`/api/sessions/${encodeURIComponent(id)}/stages`, { method: "POST", body: JSON.stringify({ stages, active }) });

/** Every output a session plays on, the leading one first. */
export function playingOutputs(current: { output: Output | null; outputs?: Output[] } | null | undefined): Output[] {
  if (!current) return [];
  return current.outputs ?? (current.output ? [current.output] : []);
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
  if (!directToken) return `${baseUrl}${path}`;
  // Media elements can't send headers; the server also takes the token as a query parameter.
  return `${baseUrl}${path}${path.includes("?") ? "&" : "?"}access_token=${encodeURIComponent(directToken)}`;
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
/** Saved text with its server URLs moved onto this phone's bridge. */
export function rebased(text: string) {
  return text
    .replace(SAVED_SERVER_URL, (_, path: string) => serverUrl(path.replace(TOKEN_IN_QUERY, "$1").replace(/[?&]$/, "")))
    .replace(/"(\/api\/music\/local\/files\/[^"\\\s]+)/g, (_, path: string) => `"${serverUrl(path)}`);
}

/** Text for shared state: bridge URLs lose this phone's capability and token, as desktop saves them. */
export function forSharing(text: string) {
  return text.replace(SAVED_SERVER_URL, url => url.replace(TOKEN_IN_QUERY, "$1").replace(/[?&]$/, "").replace(/\/[a-f0-9]{64}(?=\/api\/)/, ""));
}

/** The current server address, which changes when the phone moves between networks. */
export const serverAddress = () => baseUrl;

/** Uses the same provider lookup and wire validation as desktop, through the paired server. */
export async function trackLyrics(track: Track, signal: AbortSignal): Promise<TrackLyrics> {
  const query = new URLSearchParams({ trackName: track.name, artistName: track.artist, albumName: track.album, durationSeconds: String(track.durationSeconds) });
  if (track.isrc) query.set("isrc", track.isrc);
  if (track.version) query.set("version", track.version);
  if (track.provider === "spotify" && track.providerTrackId) query.set("spotifyId", track.providerTrackId);
  // Names the recording, so lyrics come back with line endings from the server's vocal analysis.
  if (track.providerTrackId && ["tidal", "qobuz", "spotify"].includes(track.provider)) {
    query.set("provider", track.provider);
    query.set("trackId", track.providerTrackId);
  }
  return parseTrackLyrics(await request<unknown>(`/api/lyrics?${query}`, { signal, timeoutMs: 30_000 }));
}

/**
 * Whether the server last answered. The bridge can say it's connected over a link that died
 * without closing; only requests getting through (or not) show that.
 */
let answeredAt = 0;
let unansweredAt = 0;
export const serverAnswering = () => answeredAt >= unansweredAt;
const reachabilityListeners = new Set<() => void>();
/** Hears the server start or stop answering, the moment a request shows it. */
export function subscribeReachability(listener: () => void) {
  reachabilityListeners.add(listener);
  return () => { reachabilityListeners.delete(listener); };
}
function answered(yes: boolean) {
  const before = serverAnswering();
  if (yes !== before) diag("client.answered", { yes });
  if (yes) { answeredAt = Date.now(); offlineWanted = false; }
  else unansweredAt = Date.now();
  if (serverAnswering() !== before) for (const listener of reachabilityListeners) listener();
}
/** The bridge answers for a server it can't reach with these. */
const unreachable = (status: number) => status === 502 || status === 503 || status === 504;
/**
 * A request that got no answer at all. React Native's fetch throws a TypeError; Expo's (installed
 * as the global fetch) throws a plain Error reading "fetch failed: <reason>", such as iOS's
 * "Could not connect to the server." when the connection is gone after a sleep.
 */
const noAnswer = (error: unknown) => error instanceof TypeError || (error instanceof Error && error.message.startsWith("fetch failed"));
function heard(status?: number) {
  answered(status === undefined || !unreachable(status));
}

// Connection policy and retry live in Rust. A possibly delivered mutation is never replayed.
export async function request<T>(path: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<T> {
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
      headers: { ...(init.body ? { "Content-Type": "application/json" } : {}), ...(directToken ? { Authorization: `Bearer ${directToken}` } : {}) },
    });
    assertConnection(epoch);
    heard(response.status);
    if (response.status === 401) {
      await forget();
      throw new Unpaired("This phone isn't paired with the server");
    }
    const body = await response.json().catch(() => null) as (T & { error?: string }) | null;
    assertConnection(epoch);
    if (!response.ok) throw Object.assign(new Error(body?.error ?? `The server answered ${response.status}`), { status: response.status, body });
    return body as T;
  } catch (error) {
    if (!init.signal?.aborted) diag("client.request_failed", { path: path.split("?")[0], error: String(error), timedOut: timeout.signal.aborted });
    // No answer at all, rather than one the caller stopped waiting for.
    if (!init.signal?.aborted && (timeout.signal.aborted || noAnswer(error))) {
      answered(false);
      // No answer may mean a connection that died without closing; the bridge checks and replaces it.
      if (!directMode) void networkCall("resume").catch(() => {});
    }
    // Our own deadline, not the caller giving up: say so instead of the fetch's "request has been canceled".
    if (timeout.signal.aborted && !init.signal?.aborted) throw new Error("The server took too long to answer. Check your connection and try again.");
    if (!init.signal?.aborted && noAnswer(error)) throw new Error("Couldn't reach the server. Check your connection and try again.");
    throw error;
  } finally {
    clearTimeout(timer);
    init.signal?.removeEventListener("abort", abort);
  }
}

export type PairingStarted = { requestId: string; code: string };

/** `name` is how the server lists this phone, e.g. in its outputs. */
export async function requestPairing(address: string, name: string, signal?: AbortSignal) {
  if (directMode) {
    resetSession();
    const epoch = connectionEpoch;
    const base = await findDirectServer(address.trim(), signal);
    assertConnection(epoch);
    baseUrl = base;
    pairingPayload = base;
    const id = await clientId();
    assertConnection(epoch);
    return request<PairingStarted>("/api/pair/request", {
      method: "POST", body: JSON.stringify({ clientId: id, clientName: name.slice(0, 64) }), timeoutMs: 30_000, signal,
    });
  }
  if (!address.trim().startsWith("ambra://pair/")) throw new Error("Paste the pairing link from ambra-server pair qr. Legacy addresses need re-pairing.");
  pairingPayload = address.trim();
  resetSession();
  const epoch = connectionEpoch;
  const opened = await networkCall<{ baseUrl: string }>("open", { payload: pairingPayload, method });
  assertConnection(epoch);
  if (signal?.aborted) throw Object.assign(new Error("Pairing canceled"), { name: "AbortError" });
  baseUrl = opened.baseUrl;
  const id = await clientId();
  assertConnection(epoch);
  return request<PairingStarted>("/api/pair/request", {
    method: "POST", body: JSON.stringify({ clientId: id, clientName: name.slice(0, 64) }), timeoutMs: 30_000, signal,
  });
}

/**
 * Direct mode's server address: a typed one (`192.168.1.20` or `http://host:port`), or the pairing
 * link's LAN hints tried on the server's HTTP port, keeping the one whose public key matches.
 */
async function findDirectServer(address: string, signal?: AbortSignal): Promise<string> {
  let candidates: string[];
  let key: string | null = null;
  if (address.startsWith("ambra://pair/")) {
    const encoded = address.slice("ambra://pair/".length).replace(/-/g, "+").replace(/_/g, "/");
    let payload: { publicKey?: string; localAddresses?: string[] };
    try { payload = JSON.parse(atob(encoded + "=".repeat((4 - encoded.length % 4) % 4))); } catch { throw new Error("That pairing link is damaged. Copy it again."); }
    key = payload.publicKey ?? null;
    // IPv6 hints come as [addr]:port; their brackets stay for the URL.
    const hosts = [...new Set((payload.localAddresses ?? []).map(hint => hint.replace(/:\d+$/, "")))];
    candidates = hosts.map(host => `http://${host}:${DEFAULT_PORT}`);
    if (!candidates.length) throw new Error("This pairing link has no address on your network. Type the server's address instead, like 192.168.1.20.");
  } else {
    const typed = (/^https?:\/\//.test(address) ? address : `http://${address}`).replace(/\/+$/, "");
    candidates = [/:\d+$/.test(typed) ? typed : `${typed}:${DEFAULT_PORT}`];
  }
  const found = await Promise.any(candidates.map(async base => {
    const response = await fetch(`${base}/api/server/info`, { signal: deadline(4000, signal) });
    const info = await response.json() as { service?: string; publicKey?: string };
    if (info.service !== "ambra" || (key && info.publicKey !== key)) throw new Error("Not this server");
    return base;
  })).catch(() => null);
  if (!found) throw new Error("Couldn't find the server on this Wi-Fi. Check that LAN sharing is on and the phone is on the same network.");
  return found;
}

/** Resolves once someone approves the code at the server. */
export async function awaitPairing(requestId: string, signal: AbortSignal) {
  let epoch = connectionEpoch;
  const payload = pairingPayload;
  const assertActive = () => {
    assertConnection(epoch);
    if (signal.aborted) throw Object.assign(new Error("Pairing canceled"), { name: "AbortError" });
  };
  while (!signal.aborted) {
    const status = await request<{ status: string; token?: string }>(`/api/pair/request/${requestId}`, { signal });
    assertActive();
    if (status.status === "approved" && status.token && directMode) {
      assertActive();
      await writePairing(() => SecureStore.setItemAsync(DIRECT_KEY, JSON.stringify({ base: payload, token: status.token })));
      assertActive();
      directToken = status.token;
      return;
    }
    if (status.status === "approved" && status.token) {
      await writePairing(async () => {
        assertActive();
        const previous = await Promise.all([TOKEN_KEY, PAYLOAD_KEY].map(key => SecureStore.getItemAsync(key)));
        assertActive();
        try {
          await SecureStore.setItemAsync(TOKEN_KEY, status.token!);
          assertActive();
          await SecureStore.setItemAsync(PAYLOAD_KEY, payload!);
          assertActive();
          resetSession();
          epoch = connectionEpoch;
          const opened = await networkCall<{ baseUrl: string }>("open", { payload, token: status.token, method });
          assertActive();
          baseUrl = opened.baseUrl;
        } catch (error) {
          await Promise.all([TOKEN_KEY, PAYLOAD_KEY].map((key, index) => previous[index] === null ? SecureStore.deleteItemAsync(key) : SecureStore.setItemAsync(key, previous[index]!)));
          throw error;
        }
      });
      return;
    }
    if (status.status !== "pending") throw new Error(status.status === "denied" ? "The server refused this phone." : "The code expired. Connect again for a new one.");
    await new Promise(resolve => setTimeout(resolve, 1500));
  }
}

let view: SessionView | null = null;
let viewAt = Date.now();
const playbackClock = new SessionClock();
/**
 * The server's clock for playing in step with other outputs, on this phone's monotonic clock
 * (`performance.now`), which unlike the wall clock never jumps.
 */
const syncClock = new SessionClock();
/** One timed round trip to the server's clock. A reading far off the estimate means the server restarted. */
export async function sampleSyncClock(signal?: AbortSignal) {
  const sent = performance.now();
  const report = await request<{ serverTimeMs: number }>(inSession("/api/session/clock"), { signal, timeoutMs: 3000 });
  const received = performance.now();
  const known = syncClock.offset(received);
  const offset = report.serverTimeMs - (sent + received) / 2;
  if (known !== null && Math.abs(known - offset) > 1000 + (received - sent)) syncClock.reset();
  syncClock.sample(report.serverTimeMs, sent, received);
  diag("client.sync_clock_sample", { serverTimeMs: report.serverTimeMs, roundTripMs: received - sent, offsetMs: syncClock.offset(received) });
}
/** The server's clock less this phone's monotonic one, or null before any round trip. */
export const syncClockOffset = () => syncClock.offset(performance.now());
const listeners = new Set<() => void>();

/**
 * While this phone is the output and plays the server's song, its own player says whether
 * it plays and where, rather than a server that may be out of reach.
 */
export type LocalPlayback = { playing: boolean; buffering: boolean; positionSeconds: number; at: number };
let local: LocalPlayback | null = null;
let shown: SessionView | null = null;
/**
 * Plays, pauses or seeks on this phone's own player; false when it isn't the one to. A function
 * means the command still goes to the server, and is told the server's answer (null if none).
 */
let localControl: ((action: string, details: Record<string, unknown>) => boolean | ((answer: SessionView | null) => void)) | null = null;

function show() {
  shown = view && local ? { ...view, playing: local.playing, buffering: local.buffering, positionSeconds: local.positionSeconds } : view;
  for (const listener of listeners) listener();
}

/** Whether this phone is playing the server's song itself right now. */
export const playingHere = () => !!local?.playing;

export function setLocalPlayback(next: LocalPlayback | null) {
  if (!next && !local) return;
  diag("client.local_playback", { next });
  local = next;
  show();
}

export function setLocalControl(control: typeof localControl) { localControl = control; }

/** Phone-only playback of downloads while the server can't be reached (`offlineSession.ts`). */
type Offline = {
  view(): SessionView;
  age(): number;
  command(action: string, details: Record<string, unknown>): Promise<void>;
  change(change: (queue: QueueSnapshot, revision: number) => QueueSnapshot, play: boolean): Promise<void>;
};
let offline: Offline | null = null;
const offlineWaiters = new Set<(session: Offline) => void>();
export function setOfflineSession(next: Offline | null) {
  offline = next;
  if (next) for (const waiter of offlineWaiters) waiter(next);
  show();
}
/** A play or skip found the server gone: downloads take over at once, not after the usual wait. */
let offlineWanted = false;
export const wantsOffline = () => offlineWanted;
/** The queue as the server last showed it, for downloads to carry on from. */
export const lastServerQueue = () => view?.queue ?? null;
/**
 * Replays a listener's play or skip on the phone alone when the server didn't answer it (App.tsx
 * switches to downloads); the error stands when the server did answer, or nothing is downloaded.
 */
async function offlineInstead<T>(reason: unknown, work: (session: Offline) => Promise<T>): Promise<T> {
  if (reason instanceof Unpaired || serverAnswering()) throw reason;
  offlineWanted = true;
  for (const listener of reachabilityListeners) listener();
  const session = offline ?? await new Promise<Offline | null>(resolve => {
    const done = (found: Offline | null) => { clearTimeout(timer); offlineWaiters.delete(done); resolve(found); };
    const timer = setTimeout(() => done(null), 2000);
    offlineWaiters.add(done);
  });
  if (!session) throw reason;
  return work(session);
}
export const offlineActive = () => offline !== null;
/** Lets the offline session announce its changes to everything following the session. */
export const notifySession = () => show();

export const sessionView = () => offline ? offline.view() : shown;
/** Seconds since the view's position was true. */
export function sessionViewAge() {
  if (offline) return offline.age();
  const now = Date.now();
  if (local && view) return Math.max(0, (now - local.at) / 1000);
  const offset = playbackClock.offset(now);
  const age = offset !== null && view?.serverTimeMs !== undefined ? (now + offset - view.serverTimeMs) / 1000 : null;
  // As desktop's `coreViewAge`: an estimate from before a sleep or a server restart can be far off; arrival is safe.
  const arrived = Math.max(0, (now - viewAt) / 1000);
  return age !== null && age >= 0 && age <= arrived + 1 ? age : arrived;
}

const positionListeners = new Set<() => void>();
/** Hears a view that moved only its position; `subscribe` isn't told, so screens don't redraw for it. */
export function subscribePosition(listener: () => void) {
  positionListeners.add(listener);
  return () => { positionListeners.delete(listener); };
}
const POSITION_FIELDS = new Set(["queue", "revision", "positionSeconds", "serverTimeMs"]);
function sameApartFromPosition(current: SessionView, next: Record<string, unknown>) {
  for (const key of new Set([...Object.keys(current), ...Object.keys(next)])) {
    if (POSITION_FIELDS.has(key)) continue;
    const left = (current as Record<string, unknown>)[key];
    const right = next[key];
    if (left !== right && JSON.stringify(left) !== JSON.stringify(right)) return false;
  }
  return true;
}

export function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function accept(next: ArrivingView) {
  if (view && next.instanceId === view.instanceId && next.revision < view.revision) return true;
  const { queue: arrived, queuePatch: patch, ...rest } = next;
  // Left out as unchanged, or sent as the step the server took through the queue this phone
  // has; a different server or any other revision has to be asked for in full.
  const known = view && view.instanceId === next.instanceId ? view : null;
  const patched = arrived === undefined && known && queuePatchApplies(patch, known.queueRevision, next.queueRevision);
  if (arrived === undefined && !patched && known?.queueRevision !== next.queueRevision) return false;
  const queue = arrived !== undefined ? JSON.parse(rebased(JSON.stringify(arrived))) as SessionView["queue"]
    : patched ? applyQueuePatch(known.queue, patch) : known!.queue;
  if (view?.instanceId !== next.instanceId) playbackClock.reset();
  viewAt = Date.now();
  // As on desktop, the stream sends the position four times a second: a view that differs only
  // there updates the current one in place, for readers that sample it, and nothing redraws.
  // TEMPORARY diagnostics: what the server says, and how old this phone thinks it is.
  const viewFields = () => ({ revision: rest.revision, positionSeconds: rest.positionSeconds, serverTimeMs: rest.serverTimeMs, playing: rest.playing, buffering: rest.buffering, duration: rest.duration, loadedSource: rest.loadedSource?.replace(/[?#].*$/, "").slice(-80) ?? null, output: rest.output?.deviceName ?? null, local: local ? { ...local } : null, ageSeconds: sessionViewAge() });
  if (view && queue === view.queue && sameApartFromPosition(view, rest)) {
    for (const target of new Set([view, shown])) {
      if (!target) continue;
      target.revision = rest.revision;
      target.serverTimeMs = rest.serverTimeMs;
      if (target === view || !local) target.positionSeconds = rest.positionSeconds;
    }
    diagEvery("view_position", 1000, "client.view_position", viewFields());
    for (const listener of positionListeners) listener();
    return true;
  }
  view = { ...rest, queue };
  diag("client.view", viewFields());
  show();
  return true;
}

/** A stream that sends nothing for this long has stalled on the way and is opened again. */
const STREAM_SILENCE_MS = 15_000;

/**
 * Desktop's `followStream`: one whole view per line, the session as it is and then as it
 * changes, positions included. False when this server (or this fetch) has no stream.
 */
async function followStream(stop: AbortSignal): Promise<boolean> {
  const epoch = connectionEpoch;
  const asked = session;
  const silence = new AbortController();
  const quit = () => silence.abort();
  stop.addEventListener("abort", quit);
  if (stop.aborted) quit();
  let timer = setTimeout(quit, STREAM_SILENCE_MS);
  let lines = 0;
  const alive = () => { heard(); clearTimeout(timer); timer = setTimeout(quit, STREAM_SILENCE_MS); };
  try {
    const known = view ? `queue=${view.queueRevision}&patches=1` : "patches=1";
    const response = await fetch(`${baseUrl}${inSession(`/api/session/stream?${known}`)}`, {
      signal: silence.signal,
      headers: directToken ? { Authorization: `Bearer ${directToken}` } : {},
    });
    assertConnection(epoch);
    heard(response.status);
    if (response.status === 401) {
      await forget();
      throw new Unpaired("This phone isn't paired with the server");
    }
    if (response.status === 404 && asked !== MAIN_SESSION) { setSession(MAIN_SESSION); return true; }
    if (response.status === 404 || !response.body) return false;
    if (!response.ok) throw Object.assign(new Error(`The server answered ${response.status}`), { status: response.status });
    await readJsonLines<ArrivingView>(response.body, next => {
      lines++;
      if (epoch !== connectionEpoch || asked !== session) { quit(); return; }
      // A queue this phone can't patch is asked for whole, as desktop does.
      if (!accept(next)) void request<ArrivingView>(inSession("/api/session")).then(accept, () => {});
    }, alive);
    return true;
  } catch (error) {
    // Gone quiet: it is opened again, like one the server ended. One that never sent the
    // session at all is held up on the way (a proxy keeping the body back): ask instead.
    if (silence.signal.aborted && !stop.aborted) { answered(false); return lines > 0; }
    if (!stop.aborted && noAnswer(error)) answered(false);
    throw error;
  } finally {
    clearTimeout(timer);
    stop.removeEventListener("abort", quit);
  }
}

/** One timed round trip to the server's clock, for carrying positions forward from when the server took them. */
async function samplePlaybackClock(signal?: AbortSignal) {
  const instance = view?.instanceId;
  const sent = Date.now();
  const report = await request<{ serverTimeMs: number }>(inSession("/api/session/clock"), { signal, timeoutMs: 3000 });
  const received = Date.now();
  if (!signal?.aborted && instance === view?.instanceId) {
    playbackClock.sample(report.serverTimeMs, sent, received);
    diag("client.clock_sample", { serverTimeMs: report.serverTimeMs, roundTripMs: received - sent, offsetMs: playbackClock.offset(received) });
  }
}

/** Desktop's `syncServerClock`: a few readings one after another, then one every 15 seconds while open. */
function keepPlaybackClock(signal: AbortSignal) {
  void (async () => {
    for (let index = 0; !signal.aborted; index++) {
      if (AppState.currentState === "active") await samplePlaybackClock(signal).catch(() => {});
      await new Promise(resolve => setTimeout(resolve, index < 4 ? 0 : 15_000));
    }
  })();
}

/** Keeps the view current until `signal` aborts; rejects with `Unpaired` if the token stops working. */
export async function follow(signal: AbortSignal) {
  let wake = new AbortController();
  // iOS suspends the app in the background; coming back asks again at once for the true position.
  wakeFollower = () => wake.abort();
  // The connection may have died while suspended: ask again once it's known to answer (or replaced).
  const subscription = AppState.addEventListener("change", state => {
    diag("client.app_state", { state });
    // In the background the stream's four positions a second would wake the phone for screens no
    // one sees: it's followed by asking for changes instead, and the stream opens again on return.
    if (state === "background") { wake.abort(); return; }
    if (state !== "active") return;
    if (directMode) wake.abort();
    else void networkCall("resume").catch(() => {}).finally(() => wake.abort());
  });
  keepPlaybackClock(signal);
  // Older servers have no stream; they're followed by asking again for each change instead.
  let streams = true;
  try {
    while (!signal.aborted) {
      const since = view ? `?since=${view.revision}&wait=30&queue=${view.queueRevision}&patches=1` : "";
      const stop = new AbortController();
      const abort = () => stop.abort();
      signal.addEventListener("abort", abort);
      const wakeSignal = wake.signal;
      wakeSignal.addEventListener("abort", abort);
      if (signal.aborted || wakeSignal.aborted) stop.abort();
      try {
        const background = AppState.currentState === "background";
        if (!streams || background || !await followStream(stop.signal)) {
          if (!background) streams = false;
          const asked = session;
          const next = await request<ArrivingView>(inSession(`/api/session${since}`), { signal: stop.signal, timeoutMs: 35_000 });
          if (asked === session && !accept(next)) accept(await request<ArrivingView>(inSession("/api/session"), { signal }));
        }
      } catch (error) {
        diag("client.follow_error", { error: String(error), status: (error as { status?: number }).status ?? null });
        if (error instanceof Unpaired) throw error;
        // The session was removed on another device: back to the first one.
        if ((error as { status?: number }).status === 404 && session !== MAIN_SESSION) setSession(MAIN_SESSION);
        else if (!wake.signal.aborted && !signal.aborted) await new Promise(resolve => setTimeout(resolve, 2000));
      } finally {
        signal.removeEventListener("abort", abort);
        wakeSignal.removeEventListener("abort", abort);
      }
      if (wake.signal.aborted) wake = new AbortController();
    }
  } finally {
    wakeFollower = () => {};
    subscription.remove();
  }
}
let wakeFollower = () => {};

let commandChain: Promise<unknown> = Promise.resolve();
function inOrder<T>(work: () => Promise<T>): Promise<T> {
  const result = commandChain.then(work, work);
  commandChain = result.catch(() => {});
  return result;
}

export function command(action: string, details: Record<string, unknown> = {}) {
  if (offline) return offline.command(action, details);
  const handled = localControl?.(action, details);
  if (handled === true) return Promise.resolve();
  const settle = typeof handled === "function" ? handled : null;
  const epoch = connectionEpoch;
  return inOrder(async () => {
    assertConnection(epoch);
    accept(await request<ArrivingView>(inSession(`/api/session/command${view ? `?queue=${view.queueRevision}&patches=1` : ""}`), {
      method: "POST",
      body: JSON.stringify({ action, ...details }),
    }));
  }).then(() => { settle?.(view); }, reason => { settle?.(null); return offlineInstead(reason, session => session.command(action, details)); });
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
  if (options.clock && !view) accept(await request<ArrivingView>(inSession("/api/session"), { signal, timeoutMs: 10_000 }));
  const instance = view?.instanceId;
  if (options.clock && (options.clock === "force" || !playbackClock.recent(Date.now()))) {
    // One after another: readings taken together hold each other up, and only quick ones count.
    for (let index = 0; index < 3 && instance === view?.instanceId; index++) {
      try { await samplePlaybackClock(signal); }
      catch (error) { if (signal.aborted) throw error; } // Older servers still support a fresh position report.
    }
  }
  const path = inSession(`/api/session${view ? `?queue=${view.queueRevision}&patches=1` : ""}`);
  if (!accept(await request<ArrivingView>(path, { signal, timeoutMs: 10_000 }))) {
    accept(await request<ArrivingView>(inSession("/api/session"), { signal, timeoutMs: 10_000 }));
  }
}

/** Keep the core's source unchanged in reports; authenticate/rebase only the native media URL. */
/** The server path of a song's audio, without credentials, or null for audio elsewhere. */
export function phoneMediaPath(source: string) {
  if (!source.startsWith("/api/") && !/^https?:\/\/[^/]+\/api\//.test(source)) return null;
  const path = source.slice(source.indexOf("/api/"));
  const [pathname, query = ""] = path.split("?");
  const parameters = new URLSearchParams(query);
  parameters.delete("access_token");
  const remaining = parameters.toString();
  return `${pathname}${remaining ? `?${remaining}` : ""}`;
}

/** Downloads a song through the native bridge before the player needs it. */
export function prefetchMedia(source: string) {
  const path = phoneMediaPath(source);
  if (path && nativeNetworkAvailable) void networkCall("prefetch", { path }).catch(() => {});
}

export function phoneMediaUrl(source: string) {
  const path = phoneMediaPath(source);
  if (path) return serverUrl(path);
  if (/^https?:\/\//.test(source)) return source;
  throw new Error("This file is only on the computer. Import it into the server library to play it on your phone.");
}

/** Apply against the latest queue; rebase on conflicts without losing another device's edits. */
export function changeQueue(change: (queue: QueueSnapshot, revision: number) => QueueSnapshot, play = false) {
  if (offline) return offline.change(change, play);
  // A new song (or a shuffle) starts like a skip: the old one stops on this phone at once.
  const held = play ? localControl?.("startTrack", {}) : false;
  const settle = typeof held === "function" ? held : null;
  const epoch = connectionEpoch;
  return inOrder(async () => {
    assertConnection(epoch);
    for (let attempt = 0; attempt < 4; attempt++) {
      if (!view) accept(await request<ArrivingView>(inSession("/api/session")));
      const current = view!;
      const queue = change(current.queue, current.queueRevision);
      try {
        accept(await request<ArrivingView>(inSession("/api/session/queue"), {
          method: "POST",
          // Media URLs carry only an ephemeral bridge capability, removed from shared state.
          body: JSON.stringify({ base: current.queueRevision, queue, ...(play ? { playTrackId: queue.current?.globalTrackId } : {}) })
            .replace(SAVED_SERVER_URL, url => url.replace(TOKEN_IN_QUERY, "$1").replace(/[?&]$/, "").replace(/\/[a-f0-9]{64}(?=\/api\/)/, "")),
        }));
        return;
      } catch (error) {
        const conflict = error as { status?: number; body?: { session?: ArrivingView } };
        if (conflict.status !== 409) throw error;
        accept(conflict.body?.session ?? await request<ArrivingView>(inSession("/api/session")));
      }
    }
    throw new Error("The queue keeps changing on another device. Please try again.");
  }).then(() => { settle?.(view); }, reason => { settle?.(null); return offlineInstead(reason, session => session.change(change, play)); });
}

export type MobilePlaylist = { id: string; name: string; trackIds: string[]; packages?: string[][] };
export type PlaylistContents = { playlist: MobilePlaylist; tracks: Track[]; unavailableCount: number };

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

/** TEMPORARY diagnostics: sends phone events to the server's log, outside the reachability bookkeeping. */
export async function sendDiagnostics(events: Record<string, unknown>[]) {
  if (!baseUrl) throw new Error("Not connected");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(`${baseUrl}/api/diagnostics`, {
      method: "POST", signal: controller.signal,
      headers: { "Content-Type": "application/json", ...(directToken ? { Authorization: `Bearer ${directToken}` } : {}) },
      body: JSON.stringify({ source: "phone", events }),
    });
    if (!response.ok) throw new Error(`The server answered ${response.status}`);
  } finally { clearTimeout(timer); }
}

/** TEMPORARY diagnostics: what the native bridge recorded since the last call. */
export const drainBridgeDiagnostics = () => nativeNetworkAvailable && !directMode ? networkCall<Record<string, unknown>[]>("diagnostics") : Promise.resolve([]);
