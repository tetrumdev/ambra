import { invoke, isTauri } from "@tauri-apps/api/core";

/**
 * The current optional server and the token a paired device sends.
 *
 * Saved data never holds a token or a fixed server address: server URLs inside it are
 * stripped of their token when written (`forStorage`) and moved onto this run's server,
 * with this device's token, when read (`fromStorage`). A library saved by the server
 * machine as `http://127.0.0.1:38147/…` therefore plays on a joined laptop as
 * `http://192.168.1.20:38147/…?access_token=…`.
 */
export type ServerLinkMode = "host" | "join";
export type WhenServerAway = "wait" | "fallback";
export type JoinedServer = { id: string; name: string; address: string; publicKey?: string | null };
export type ServerConnection = {
  mode: ServerLinkMode;
  baseUrl: string;
  token: string | null;
  fallback: boolean;
  server: JoinedServer | null;
  whenAway: WhenServerAway;
  decided: boolean;
  clientName: string;
  /** This app's ID on the server, under which its outputs appear to other devices. */
  clientId: string;
};

const builtInBaseUrl = (import.meta.env.VITE_AMBRA_SERVER_URL ?? "http://127.0.0.1:9").replace(/\/$/, "");
export let serverBaseUrl = builtInBaseUrl;
export let serverOnline = false;
export function setServerOnline(online: boolean) { serverOnline = online; }
export let serverConnection: ServerConnection | null = null;
let token: string | null = null;
let reading = 0;
let requests = new AbortController();
const listeners = new Set<() => void>();
export const getServerConnection = () => serverConnection;
export function subscribeServerConnection(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export const serverConnectionSignal = () => requests.signal;

const TOKEN_PARAMETER = "access_token";
// A server URL as saved in JSON: plain http, an explicit port, and an /api/ path.
const SAVED_SERVER_URL = /http:\/\/[^/"\\\s]+:\d+(?:\/[a-f0-9]{64})?\/api\/[^"\\\s]*/g;
const TOKEN_IN_QUERY = /([?&])access_token=[^&#"\\]*&?/;

function withoutToken(url: string) {
  return url.replace(TOKEN_IN_QUERY, (_, separator: string) => separator).replace(/[?&](?=#|$)/, "");
}

function withToken(url: string) {
  const bare = withoutToken(url);
  if (!token) return bare;
  const hash = bare.indexOf("#");
  const [path, fragment] = hash < 0 ? [bare, ""] : [bare.slice(0, hash), bare.slice(hash)];
  return `${path}${path.includes("?") ? "&" : "?"}${TOKEN_PARAMETER}=${encodeURIComponent(token)}${fragment}`;
}

/** `url` on this run's server, carrying the token where media elements need it. */
export function withServerAccess(url: string) {
  return url.startsWith(`${serverBaseUrl}/`) ? withToken(url) : url;
}

/** A path on this run's server, ready for `<img>`, `<audio>` or the native player. */
export function serverUrl(path: string) {
  return withServerAccess(`${serverBaseUrl}${path}`);
}

function rebase(url: string) {
  const path = url.slice(url.indexOf("/api/"));
  return withToken(`${serverBaseUrl}${path}`);
}

/** Saved text with its server URLs moved onto this run's server and given this device's token. */
export function fromStorage<T extends string | null>(text: T): T {
  return (text === null ? text : text.replace(SAVED_SERVER_URL, rebase)
    .replace(/(?<=")\/api\/music\/local\/files\/[^"\\\s]+/g, path => serverUrl(path))) as T;
}

/** Text to save: server URLs keep their address but lose the token. */
export function forStorage(text: string) {
  return text.replace(SAVED_SERVER_URL, url => withoutToken(url).replace(/\/[a-f0-9]{64}(?=\/api\/)/, ""));
}

let fetchWrapped = false;
function sendTokenWithFetch() {
  if (fetchWrapped) return;
  fetchWrapped = true;
  const original = window.fetch.bind(window);
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith(`${serverBaseUrl}/`)) return original(input, init);
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    init = { ...init, signal: signal ? AbortSignal.any([signal, requests.signal]) : requests.signal };
    if (!token) return original(input, init);
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    if (!headers.has("Authorization")) headers.set("Authorization", `Bearer ${token}`);
    return original(input, { ...init, headers });
  }) as typeof fetch;
}

/** Learns this run's server from the desktop app; call before anything talks to the server. */
export async function connectToServer() {
  if (!isTauri()) return;
  const current = ++reading;
  const connection = await invoke<ServerConnection>("server_connection");
  if (current !== reading || JSON.stringify(connection) === JSON.stringify(serverConnection)) return;
  requests.abort();
  requests = new AbortController();
  serverOnline = false;
  serverConnection = connection;
  // A development build aimed at a particular server keeps it while hosting.
  if (connection.mode === "join" || !import.meta.env.VITE_AMBRA_SERVER_URL) {
    serverBaseUrl = connection.baseUrl.replace(/\/$/, "");
  }
  token = connection.fallback ? null : connection.token;
  sendTokenWithFetch();
  for (const listener of listeners) listener();
}

/** Outside the desktop app (the phone remote): talk to `baseUrl` as a paired device. */
export function connectFromBrowser(baseUrl: string, accessToken: string | null) {
  serverBaseUrl = baseUrl.replace(/\/$/, "");
  token = accessToken;
  sendTokenWithFetch();
}

/** For tests: pretend to be joined to `baseUrl` with `accessToken`. */
export function setServerForTesting(baseUrl: string, accessToken: string | null) {
  serverBaseUrl = baseUrl;
  token = accessToken;
}

/** Cache keys always include verified server identity. Old unattributed caches remain available for rollback. */
export function serverCacheKey(key: string) {
  return `${key}.server.${serverConnection?.server?.publicKey ?? serverBaseUrl}`;
}

/** Local playlists can cache remote metadata, but may only rebase it onto the same verified server. */
export function forDeviceStorage(text: string) {
  const identity = serverConnection?.server?.publicKey;
  if (!identity) return forStorage(text);
  try {
    return forStorage(JSON.stringify(JSON.parse(text), (_key, value) =>
      value && typeof value === "object" && typeof value.globalId === "string"
        && typeof value.audio === "string" && value.audio.startsWith(`${serverBaseUrl}/`) && !value.serverIdentity
        ? { ...value, serverIdentity: identity } : value));
  } catch { return forStorage(text); }
}
export function fromDeviceStorage(text: string | null) {
  if (!text || !text.includes('"serverIdentity"')) return text;
  try {
    return JSON.stringify(JSON.parse(text, (_key, value) =>
      value && typeof value === "object" && value.serverIdentity
        && value.serverIdentity === serverConnection?.server?.publicKey
        ? JSON.parse(fromStorage(JSON.stringify(value))) : value));
  } catch { return text; }
}
