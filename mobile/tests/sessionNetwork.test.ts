import { afterAll, beforeEach, expect, mock, test } from "bun:test";

const foreground = new Set<(state: string) => void>();
mock.module("expo-secure-store", () => ({
  getItemAsync: async (key: string) => key === "ambra.token" ? "isolated-test-token" : "isolated-test-payload",
  setItemAsync: async () => {}, deleteItemAsync: async () => {},
}));
mock.module("react-native", () => ({ AppState: {
  addEventListener: (_event: string, listener: (state: string) => void) => {
    foreground.add(listener); return { remove: () => foreground.delete(listener) };
  },
} }));
mock.module("../modules/ambra-network/src", () => ({
  nativeNetworkAvailable: true,
  networkCall: async () => ({ baseUrl: "http://isolated.test" }),
}));
const client = await import("../src/client");
const originalFetch = globalThis.fetch;
afterAll(() => { globalThis.fetch = originalFetch; });
beforeEach(async () => { await client.restore(); });
const snapshot = (instanceId = "first", queue = true) => ({
  instanceId, revision: 2, queueRevision: 7, playing: false, positionSeconds: 0,
  duration: 0, buffering: false, error: null, output: null, outputOnline: false,
  ...(queue ? { queue: { version: 1, current: null, upcoming: [], tracks: [] } } : {}),
});
const respond = (value: unknown) => new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });

test("ownership refresh omits unchanged queue and fetches a full snapshot after server replacement", async () => {
  const paths: string[] = [];
  let replacement = false;
  globalThis.fetch = (async (url: string | URL | Request) => {
    const path = new URL(String(url)).pathname + new URL(String(url)).search;
    paths.push(path);
    return respond(snapshot(replacement ? "replacement" : "first", !path.includes("queue=")));
  }) as typeof fetch;
  const stop = new AbortController();
  await client.refreshSession(stop.signal);
  await client.refreshSession(stop.signal);
  expect(paths).toEqual(["/api/session", "/api/session?queue=7"]);
  expect(client.sessionView()?.queue.tracks).toEqual([]);
  replacement = true;
  await client.refreshSession(stop.signal);
  expect(paths.slice(-2)).toEqual(["/api/session?queue=7", "/api/session"]);
  expect(client.sessionView()?.instanceId).toBe("replacement");
});

test("polling removes foreground abort listeners on every successful poll and teardown", async () => {
  const added = AbortSignal.prototype.addEventListener;
  const removed = AbortSignal.prototype.removeEventListener;
  const listeners = new Map<AbortSignal, Set<unknown>>();
  AbortSignal.prototype.addEventListener = function(type, listener, options) {
    if (type === "abort") {
      const set = listeners.get(this) ?? new Set(); set.add(listener); listeners.set(this, set);
    }
    return added.call(this, type, listener, options);
  };
  AbortSignal.prototype.removeEventListener = function(type, listener, options) {
    if (type === "abort") listeners.get(this)?.delete(listener);
    return removed.call(this, type, listener, options);
  };
  const stop = new AbortController();
  let polls = 0;
  globalThis.fetch = (async () => {
    polls++;
    if (polls === 100) stop.abort();
    return respond(snapshot());
  }) as typeof fetch;
  try {
    await client.follow(stop.signal);
    expect(polls).toBe(100);
    expect([...listeners.values()].reduce((sum, set) => sum + set.size, 0)).toBe(0);
    expect(foreground.size).toBe(0);
  } finally {
    AbortSignal.prototype.addEventListener = added;
    AbortSignal.prototype.removeEventListener = removed;
  }
});
