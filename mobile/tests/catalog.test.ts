import { afterAll, beforeEach, expect, mock, test } from "bun:test";

const store = new Map<string, string>([["ambra.token", "test-token"], ["ambra.pairingPayload.v1", "test-pairing"]]);
let failWrites = false;
mock.module("expo-secure-store", () => ({
  getItemAsync: async (key: string) => store.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => { if (failWrites) throw new Error("Storage unavailable"); store.set(key, value); },
  deleteItemAsync: async (key: string) => { store.delete(key); },
}));
mock.module("react-native", () => ({ AppState: { addEventListener: () => ({ remove() {} }) } }));
mock.module("../modules/ambra-network/src", () => ({ nativeNetworkAvailable: true, networkCall: async () => ({ baseUrl: "http://phone.test/capability" }) }));
const client = await import("../src/client");
const preferences = await import("../src/servicePreferences");
const catalog = await import("../src/catalog");
const fetch = globalThis.fetch;
afterAll(() => { globalThis.fetch = fetch; });
beforeEach(async () => { failWrites = false; await client.restore(); });
const respond = (value: unknown) => new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
const remote = (provider: string, id = "1") => ({
  id: `${provider}:${id}`, provider, providerTrackId: id, title: "Blue", version: null,
  primaryArtist: { providerId: "artist", name: "Same Artist", imageUrl: null }, artists: [{ providerId: "artist", name: "Same Artist", imageUrl: null }],
  album: { providerId: "album", title: "Album", version: null, artists: [], coverUrl: null, releaseDate: null, label: null, genres: [], upc: null },
  durationSeconds: 180, trackNumber: 1, discNumber: 1, explicit: false, isrc: "USABC1234567", copyright: null, quality: "LOSSLESS", maximumSamplingRateKHz: 44.1, maximumBitDepth: 16,
  playback: { kind: "direct", url: `/api/providers/${provider}/tracks/${id}/stream` },
});

test("service preferences preserve defaults and reject corrupt values without disabling local music", () => {
  expect(preferences.parseServicePreferences(null)).toEqual({ tidal: true, qobuz: true, spotify: true });
  expect(preferences.parseServicePreferences("bad json")).toEqual({ tidal: true, qobuz: true, spotify: true });
  expect(preferences.parseServicePreferences('{"spotify":false,"tidal":"false"}')).toEqual({ tidal: true, qobuz: true, spotify: false });
  expect(preferences.serviceAllowed("local", { tidal: false, qobuz: false, spotify: false })).toBe(true);
});

test("phone switches persist independently and failed storage writes keep the last saved choice", async () => {
  await preferences.loadServicePreferences();
  await Promise.all([preferences.setServiceEnabled("spotify", false), preferences.setServiceEnabled("qobuz", false)]);
  expect(preferences.servicePreferences()).toEqual({ tidal: true, qobuz: false, spotify: false });
  expect(JSON.parse(store.get("ambra.mobile.services.v1")!)).toEqual(preferences.servicePreferences());
  failWrites = true;
  await expect(preferences.setServiceEnabled("tidal", false)).rejects.toThrow("Storage unavailable");
  expect(preferences.servicePreferences().tidal).toBe(true);
  failWrites = false;
  await preferences.setServiceEnabled("qobuz", true);
  expect(preferences.servicePreferences().qobuz).toBe(true);
});

test("Ambra search merges recordings across connected services and skips disabled services", async () => {
  const requested: string[] = [];
  globalThis.fetch = (async (url: string | URL | Request) => {
    const parsed = new URL(String(url));
    if (parsed.pathname.endsWith("/providers")) return respond({ providers: ["spotify", "tidal", "qobuz"] });
    const provider = parsed.searchParams.get("provider")!;
    requested.push(provider);
    return respond({ tracks: [remote(provider)], nextOffset: null });
  }) as typeof fetch;
  const abort = new AbortController();
  const latest: { value: import("../../desktop/src/utils/searchSession").SearchSnapshot | null } = { value: null };
  const session = await catalog.openSearch("Blue", { tidal: true, qobuz: true, spotify: false }, "all", abort.signal, next => { latest.value = next; });
  await session!.loadMore();
  for (let attempt = 0; attempt < 40 && (!latest.value || latest.value.isSearching); attempt++) await Bun.sleep(5);
  expect(requested.sort()).toEqual(["qobuz", "tidal"]);
  expect(latest.value!.results).toHaveLength(1);
  expect(latest.value!.allResults).toHaveLength(2);
  expect(latest.value!.results[0].audio).toStartWith("http://phone.test/capability/api/providers/");
  expect(latest.value!.results[0].artist).toBe("Same Artist");
  abort.abort();
});

test("invalid cursors fail rather than repeating pages forever", async () => {
  globalThis.fetch = (async () => respond({ tracks: [], nextOffset: 0 })) as unknown as typeof fetch;
  await expect(catalog.searchPage("Blue", "tidal", new AbortController().signal, 0, 20)).rejects.toThrow("invalid search results");
});

test("canceled discovery cannot start searches or publish stale results", async () => {
  let finish!: (value: Response) => void;
  globalThis.fetch = (() => new Promise<Response>(resolve => { finish = resolve; })) as unknown as typeof fetch;
  const abort = new AbortController();
  const updates: unknown[] = [];
  const searching = catalog.openSearch("old query", { tidal: true, qobuz: true, spotify: true }, "all", abort.signal, next => updates.push(next));
  abort.abort();
  finish(respond({ providers: ["tidal"] }));
  expect(await searching).toBeNull();
  expect(updates).toEqual([]);
});
