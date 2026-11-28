/**
 * The Ambra server as the benchmark sees it: recorded responses served after a simulated
 * latency. Fixtures are what the real server answered (`bun run search:bench record`), one
 * gzipped JSON file per query; a request recorded under another query is reused. With `live` set, a
 * request nobody recorded is sent to the real server once and saved.
 */
import fs from "node:fs";
import path from "node:path";
import { VirtualClock, wallClock } from "./clock";

export type Kind = "providers" | "catalog" | "tracks" | "albumTracks" | "playback" | "other";
export type Fixture = { status: number; body: unknown; ms: number };
export type RequestLog = { at: number; kind: Kind; provider: string; key: string; status: number; recorded: boolean };
export type Profile = "fast" | "typical" | "slow-spotify" | "fail-qobuz";
export const profiles: Profile[] = ["fast", "typical", "slow-spotify", "fail-qobuz"];

export const fixtureDir = path.join(import.meta.dir, "fixtures");

/** One cache identity per request, as the server keys its search caches (query lowercased and trimmed). */
export function requestKey(url: string) {
  const parsed = new URL(url, "http://bench.test");
  const route = parsed.pathname.replace(/^\/capability/, "");
  const params = [...parsed.searchParams].map(([name, value]) => [name, name === "query" ? value.trim().toLowerCase() : value])
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  return `${route}?${new URLSearchParams(params)}`;
}

export function requestKind(key: string): Kind {
  if (key.startsWith("/api/search/providers")) return "providers";
  if (key.startsWith("/api/search/catalog")) return "catalog";
  if (key.startsWith("/api/search/tracks")) return "tracks";
  if (/^\/api\/providers\/\w+\/albums\/[^/]+\/tracks/.test(key)) return "albumTracks";
  if (/^\/api\/providers\/tidal\/tracks\/[^/]+\/playback/.test(key)) return "playback";
  return "other";
}

function requestProvider(key: string) {
  return new URLSearchParams(key.split("?")[1] ?? "").get("provider") ?? key.match(/^\/api\/providers\/(\w+)\//)?.[1] ?? "";
}

const SECRET_PARAM = /([?&](?:access_token|token|sig|signature|Signature|Policy|Key-Pair-Id|Expires|hdnea|hdnts)=)[^&"\s]*/g;
/** Fields never needed by search and either long or account-bound. */
function scrub(value: unknown): unknown {
  if (typeof value === "string") return value.replace(SECRET_PARAM, "$1REDACTED");
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).filter(([name]) => name !== "copyright").map(([name, item]) => [name, scrub(item)]));
  }
  return value;
}

export class FixtureStore {
  private files = new Map<string, Map<string, Fixture>>();
  private all = new Map<string, Fixture>();
  private dirty = new Set<string>();

  constructor() {
    fs.mkdirSync(fixtureDir, { recursive: true });
    for (const name of fs.readdirSync(fixtureDir).filter(name => name.endsWith(".json.gz")).sort()) {
      const text = new TextDecoder().decode(Bun.gunzipSync(fs.readFileSync(path.join(fixtureDir, name))));
      const entries = new Map(Object.entries(JSON.parse(text) as Record<string, Fixture>));
      this.files.set(name.slice(0, -".json.gz".length), entries);
      for (const [key, fixture] of entries) if (!this.all.has(key)) this.all.set(key, fixture);
    }
  }

  get(id: string, key: string) {
    return this.files.get(id)?.get(key) ?? this.all.get(key);
  }

  set(id: string, key: string, fixture: Fixture) {
    const clean = { ...fixture, body: scrub(fixture.body) };
    if (!this.files.has(id)) this.files.set(id, new Map());
    this.files.get(id)!.set(key, clean);
    if (!this.all.has(key)) this.all.set(key, clean);
    this.dirty.add(id);
  }

  /** Every recorded body for a query: the pool its expected items are looked for in. */
  bodies(id: string) { return [...this.files.get(id)?.values() ?? []].map(fixture => fixture.body); }

  save() {
    for (const id of this.dirty) {
      const entries = [...this.files.get(id)!].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
      // Gzipped JSON: raw pages repeat every artist and cover URL, so they pack about ten times smaller.
      fs.writeFileSync(path.join(fixtureDir, `${id}.json.gz`), Bun.gzipSync(`${JSON.stringify(Object.fromEntries(entries))}\n`, { level: 9 }));
    }
    this.dirty.clear();
  }
}

/** Deterministic jitter in [0.85, 1.2], from the request itself. */
function jitter(seed: string) {
  let hash = 2166136261;
  for (const char of seed) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return 0.85 + ((hash >>> 0) % 1000) / 1000 * 0.35;
}

const FAST: Record<Kind, number> = { providers: 15, catalog: 150, tracks: 150, albumTracks: 120, playback: 100, other: 50 };
/** Used when a recorded latency is missing (a request recorded before latencies were). */
const TYPICAL: Record<Kind, number> = { providers: 20, catalog: 700, tracks: 700, albumTracks: 400, playback: 300, other: 50 };

function latency(profile: Profile, kind: Kind, provider: string, key: string, fixture: Fixture | undefined) {
  if (profile === "fast") return Math.round(FAST[kind] * jitter(key));
  const recorded = fixture?.ms ?? TYPICAL[kind];
  if (profile === "slow-spotify" && provider === "spotify" && kind !== "providers") return recorded + 4000;
  if (profile === "fail-qobuz" && provider === "qobuz" && kind !== "providers") return 400;
  return recorded;
}

function response(status: number, body: unknown) {
  const text = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300, status, statusText: String(status), headers: new Headers({ "content-type": "application/json" }),
    json: async () => JSON.parse(text), text: async () => text, clone() { return response(status, body); },
  } as unknown as Response;
}

export type Network = {
  log: RequestLog[];
  misses: Set<string>;
  begin(id: string, profile: Profile): void;
};

/** Installs the stub `fetch`. `live` is the real server's base URL, for filling in requests nobody recorded. */
export function installNetwork(clock: VirtualClock, store: FixtureStore, live: string | null): Network {
  const network: Network = { log: [], misses: new Set(), begin(id, profile) { current = id; currentProfile = profile; network.log = []; } };
  let current = "";
  let currentProfile: Profile = "typical";
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const signal = init?.signal ?? undefined;
    const key = requestKey(url);
    const kind = requestKind(key);
    const provider = requestProvider(key);
    if (kind === "other") return response(404, { error: "not part of search" });
    signal?.throwIfAborted();
    let fixture = store.get(current, key);
    if (!fixture && live) {
      const started = wallClock.now();
      const work = realFetch(`${live}${key}`).then(async real => {
        const text = await real.text();
        let body: unknown = text;
        try { body = JSON.parse(text); } catch { /* kept as text */ }
        fixture = { status: real.status, body, ms: Math.round(wallClock.now() - started) };
        store.set(current, key, fixture);
      }).catch(error => { console.warn(`live request failed: ${key}: ${error}`); });
      clock.block(work);
      await work;
    }
    if (!fixture) network.misses.add(`${current} ${key}`);
    const failing = currentProfile === "fail-qobuz" && provider === "qobuz" && kind !== "providers";
    const status = failing ? 502 : fixture?.status ?? 404;
    const body = failing ? { error: "Qobuz is unavailable" } : fixture?.body ?? { error: "not recorded" };
    const entry: RequestLog = { at: clock.now, kind, provider, key, status, recorded: !!fixture };
    network.log.push(entry);
    const delay = latency(currentProfile, kind, provider, key, fixture);
    return new Promise<Response>((resolve, reject) => {
      const abort = () => { clearTimeout(timer); reject(signal?.reason ?? new DOMException("The operation was aborted.", "AbortError")); };
      const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(response(status, body)); }, delay);
      signal?.addEventListener("abort", abort, { once: true });
    });
  }) as typeof fetch;
  return network;
}
