import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { editUpcoming, enqueueEntries, playlistEntries, shuffledEntries } from "../../mobile/src/queueModel";
import type { QueueSnapshot, SessionView, Track } from "../../mobile/src/client";

mock.module("../../mobile/node_modules/expo-constants", () => ({ default: { expoConfig: { hostUri: "100.64.0.10:8081" } } }));
let legacyPairing = false;
const savedValues: [string, string][] = [];
mock.module("../../mobile/node_modules/expo-secure-store", () => ({
  getItemAsync: async (key: string) => legacyPairing && ["ambra.addresses", "ambra.serverIdentity"].includes(key) ? null : ({
    "ambra.server": "http://phone-server:38147",
    "ambra.addresses": JSON.stringify(["http://phone-server:38147", "http://100.64.0.9:38147"]),
    "ambra.serverIdentity": JSON.stringify({ id: "home", name: "EWPHPC", port: 38147 }),
  } as Record<string, string>)[key] ?? "phone-token",
  deleteItemAsync: async () => {},
  setItemAsync: async (key: string, value: string) => { savedValues.push([key, value]); },
}));
mock.module("../../mobile/node_modules/react-native", () => ({ AppState: { addEventListener: () => ({ remove() {} }) } }));
const { changeQueue, command, coverPalette, endpoints, megaPlaylist, phoneMediaUrl, refreshSession, restore, serverAddress, sessionView, sessionViewAge, trackLyrics } = await import("../../mobile/src/client");
const originalFetch = globalThis.fetch;
beforeAll(async () => {
  globalThis.fetch = mock(async (input: string | URL | Request) => response({
    service: "ambra", id: String(input).startsWith("http://phone-server:") ? "home" : "someone-else", name: "EWPHPC", port: 38147,
  })) as typeof fetch;
  await restore();
});
afterAll(() => { globalThis.fetch = originalFetch; });

const track: Track = { globalId: "a", provider: "qobuz", name: "Song", artist: "Artist", album: "Album", cover: "http://old-server:38147/api/cover?access_token=old-token", nativeCover: null, durationSeconds: 180 };
const item = { globalTrackId: "a", source: { kind: "playlist" as const, id: "mega", entryId: 1 }, shufflePackageId: null };
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
const session = (revision: number, queueRevision: number, queue: QueueSnapshot): SessionView => ({ instanceId: "test-server", revision, queueRevision, queue, playing: false, positionSeconds: 0, duration: 180, buffering: false, error: null, output: { endpointId: "desktop", deviceId: "speakers", endpointName: "Desktop", deviceName: "Speakers" }, outputOnline: true });

test("lyrics lookups authenticate to the paired server, send recording identifiers, and validate the response", async () => {
  const data = { status: "instrumental", instrumental: true, sync: "none", hasWordSync: false, plainLyrics: null, lines: [], source: null, originalFormat: null, offsetMs: 0, language: null, singers: [], failedProviders: [] };
  let payload: unknown = data;
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    expect(url.origin).toBe("http://phone-server:38147");
    expect(url.pathname).toBe("/api/lyrics");
    expect(url.searchParams.get("trackName")).toBe("Song");
    expect(url.searchParams.get("artistName")).toBe("Artist");
    expect(url.searchParams.get("albumName")).toBe("Album");
    expect(url.searchParams.get("isrc")).toBe("USAAA2600001");
    expect(url.searchParams.get("version")).toBe("Live");
    expect(url.searchParams.get("spotifyId")).toBe("1".repeat(22));
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer phone-token");
    return response(payload);
  }) as typeof fetch;
  const song = { ...track, provider: "spotify", providerTrackId: "1".repeat(22), isrc: "USAAA2600001", version: "Live" };
  expect(await trackLyrics(song, new AbortController().signal)).toEqual(data);
  payload = { ...data, offsetMs: Infinity };
  await expect(trackLyrics(song, new AbortController().signal)).rejects.toThrow("Invalid lyrics response");
});

test("swirl palettes accept older servers, weighted colors, and cover-only saved tracks", async () => {
  const colors = ["#112233", "#445566", "#778899", "#aabbcc"];
  let requested = "";
  let result: unknown = colors;
  globalThis.fetch = mock(async (input: string | URL | Request) => { requested = String(input); return response(result); }) as typeof fetch;
  expect(await coverPalette("qobuz", "https://static.qobuz.com/first.jpg")).toEqual({ colors, weights: [0.25, 0.25, 0.25, 0.25] });
  result = { colors: [...colors].reverse(), weights: [0.4, 0.3, 0.2, 0.1] };
  expect(await coverPalette("qobuz", null, "https://static.qobuz.com/second.jpg")).toEqual(result);
  expect(new URL(requested).searchParams.get("url")).toBe("https://static.qobuz.com/second.jpg");
  expect(new URL(requested).searchParams.get("weighted")).toBe("true");
  await coverPalette("qobuz", null, "http://old-server:38147/api/artwork/thumbnail?provider=qobuz&url=https%3A%2F%2Fstatic.qobuz.com%2Fthird.jpg");
  expect(new URL(requested).searchParams.get("url")).toBe("https://static.qobuz.com/third.jpg");
  result = { colors, weights: [0, 0, 0, 0] };
  expect(await coverPalette("qobuz", "https://static.qobuz.com/bad.jpg")).toBeNull();
  result = { colors: ["#ffffff"], weights: [1] };
  expect(await coverPalette("qobuz", "https://static.qobuz.com/bad.jpg")).toBeNull();
});

test("local swirl colors come from the paired server's artwork file, never an arbitrary URL", async () => {
  const file = `${"a".repeat(64)}.jpg`;
  const result = { colors: ["#112233", "#445566", "#778899", "#aabbcc"], weights: [1, 0, 0, 0] };
  let requested = "";
  globalThis.fetch = mock(async (input: string | URL | Request) => { requested = String(input); return response(result); }) as typeof fetch;
  expect(await coverPalette("local", `/api/music/local/files/${file}`)).toEqual(result);
  expect(requested).toBe(`http://phone-server:38147/api/music/local/files/${file}/palette`);
  expect(await coverPalette("local", "file:///private/cover.jpg")).toBeNull();
});

test("MEGA loads the saved playlist order and rebases artwork onto the paired server", async () => {
  globalThis.fetch = mock(async () => response({ values: { "ambra.playlists.v1": JSON.stringify({ version: 1, playlists: [{ id: "mega", name: "MEGA", trackIds: ["missing", "a"] }], tracks: [track] }) } })) as typeof fetch;
  const loaded = await megaPlaylist(new AbortController().signal);
  expect(loaded.tracks.map(song => song.globalId)).toEqual(["a"]);
  expect(loaded.unavailableCount).toBe(1);
  expect(loaded.tracks[0].cover).toBe("http://phone-server:38147/api/cover?access_token=phone-token");
});

test("MEGA tidies bound songs like desktop, so they sit together and shuffle as one", async () => {
  const songs = ["a", "b", "c", "d", "e"].map(globalId => ({ ...track, globalId }));
  // Saved out of date: "e" sits apart from "b", and the second package lost a song.
  const playlists = [{ id: "mega", name: "MEGA", trackIds: ["a", "b", "c", "d", "e"], packages: [["e", "b"], ["d", "gone"]] }];
  globalThis.fetch = mock(async () => response({ values: { "ambra.playlists.v1": JSON.stringify({ version: 1, playlists, tracks: songs }) } })) as typeof fetch;
  const loaded = await megaPlaylist(new AbortController().signal);
  expect(loaded.tracks.map(song => song.globalId)).toEqual(["a", "b", "e", "c", "d"]);
  expect(loaded.playlist.packages).toEqual([["b", "e"]]);
  const shuffled = shuffledEntries(playlistEntries(loaded.playlist, loaded.tracks), () => 0).map(item => item.globalTrackId);
  expect(shuffled.indexOf("e")).toBe(shuffled.indexOf("b") + 1);
});

test("phone media URLs rebase to the paired server without forwarding another device's token", () => {
  expect(phoneMediaUrl("http://desktop:38147/api/song/playlist.m3u8?quality=lossless&access_token=old")).toBe("http://phone-server:38147/api/song/playlist.m3u8?quality=lossless&access_token=phone-token");
  expect(phoneMediaUrl("/api/music/local/files/song.flac")).toBe("http://phone-server:38147/api/music/local/files/song.flac?access_token=phone-token");
  expect(phoneMediaUrl("https://cdn.example/song.flac")).toBe("https://cdn.example/song.flac");
  expect(() => phoneMediaUrl("C:/Music/song.flac")).toThrow("only on the computer");
});

test("output discovery uses the paired server and includes complete endpoint and device identities", async () => {
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
    expect(String(input)).toBe("http://phone-server:38147/api/endpoints");
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer phone-token");
    return response([{ id: "desktop", name: "Desktop", devices: [{ id: "speakers", name: "Speakers", isDefault: true }], selectedDeviceId: "speakers" }]);
  }) as typeof fetch;
  expect((await endpoints(new AbortController().signal))[0].devices[0].id).toBe("speakers");
});

test("a queue conflict rebases additions, strips saved tokens, and completes before transport commands", async () => {
  const calls: string[] = [];
  let writes = 0;
  const initial: QueueSnapshot = { version: 1, history: [], current: item, upcoming: [], tracks: [track] };
  const concurrent = { ...initial, upcoming: [{ ...item, globalTrackId: "other-device" }] };
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/api/session")) return response(session(10, 2, initial));
    if (url.includes("/command")) { calls.push("pause"); return response(session(13, 4, concurrent)); }
    calls.push("queue");
    writes++;
    const body = JSON.parse(String(init?.body));
    expect(String(init?.body)).not.toContain("access_token");
    if (writes === 1) return response({ error: "conflict", session: session(11, 3, concurrent) }, 409);
    expect(body.base).toBe(3);
    expect(body.queue.upcoming.map((entry: { globalTrackId: string }) => entry.globalTrackId)).toEqual(["other-device", "a"]);
    return response(session(12, 4, body.queue));
  }) as typeof fetch;
  await Promise.all([changeQueue(queue => enqueueEntries(queue, [item], [track])), command("pause")]);
  expect(calls).toEqual(["queue", "queue", "pause"]);
});

test("a conflicted positional edit refuses to remove a different row and later commands still work", async () => {
  let writes = 0;
  let paused = false;
  globalThis.fetch = mock(async (input: string | URL | Request) => {
    if (String(input).includes("/command")) { paused = true; return response(session(15, 5, { version: 1, history: [], current: item, upcoming: [], tracks: [track] })); }
    writes++;
    return response({ error: "conflict", session: session(14, 5, { version: 1, history: [], current: item, upcoming: [item], tracks: [track] }) }, 409);
  }) as typeof fetch;
  await expect(changeQueue((queue, revision) => editUpcoming(queue, revision, 4, 0, "remove"))).rejects.toThrow("changed on another device");
  expect(writes).toBe(1);
  await command("pause");
  expect(paused).toBe(true);
});

test("lyric re-sync authenticates clock samples, refreshes playback, and leaves playback controls untouched", async () => {
  const calls: string[] = [];
  const queue: QueueSnapshot = { version: 1, history: [], current: item, upcoming: [], tracks: [track] };
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    calls.push(path);
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer phone-token");
    if (path === "/api/session/clock") return response({ serverTimeMs: Date.now() - 123456 });
    expect(path).toBe("/api/session");
    return response({ ...session(16, 5, queue), playing: true, positionSeconds: 90, serverTimeMs: Date.now() - 123456 - 400 });
  }) as typeof fetch;
  await refreshSession(new AbortController().signal, { clock: "force" });
  expect(calls.filter(path => path === "/api/session/clock")).toHaveLength(3);
  expect(calls.at(-1)).toBe("/api/session");
  expect(sessionView()?.positionSeconds).toBe(90);
  expect(sessionViewAge()).toBeGreaterThanOrEqual(0.35);
  expect(sessionViewAge()).toBeLessThan(1);
  calls.length = 0;
  await refreshSession(new AbortController().signal, { clock: "recent" });
  expect(calls).toEqual(["/api/session"]);
  calls.length = 0;
  await refreshSession(new AbortController().signal);
  expect(calls).toEqual(["/api/session"]);
});

test("lyric re-sync still refreshes position when an older server has no clock endpoint", async () => {
  const queue: QueueSnapshot = { version: 1, history: [], current: item, upcoming: [], tracks: [track] };
  globalThis.fetch = mock(async (input: string | URL | Request) => {
    if (new URL(String(input)).pathname === "/api/session/clock") return response({ error: "Not found" }, 404);
    return response({ ...session(17, 5, queue), positionSeconds: 95 });
  }) as typeof fetch;
  await refreshSession(new AbortController().signal, { clock: "force" });
  expect(sessionView()?.positionSeconds).toBe(95);
  expect(sessionViewAge()).toBeLessThan(1);
});

// These tests move the client to another address.
test("away from home, reads move to an address where the same server answers, such as Tailscale", async () => {
  const asked: string[] = [];
  globalThis.fetch = mock(async (input: string | URL | Request) => {
    const url = String(input);
    asked.push(url);
    if (url.startsWith("http://phone-server:38147")) throw new TypeError("Network request failed");
    // Another server on the tailnet with the same machine name must not be trusted.
    if (url === "http://ewphpc:38147/api/server/info") return response({ service: "ambra", id: "someone-else", name: "EWPHPC", port: 38147 });
    if (url === "http://100.64.0.9:38147/api/server/info") return response({ service: "ambra", id: "home", name: "EWPHPC", port: 38147 });
    if (url === "http://100.64.0.9:38147/api/endpoints") return response([{ id: "desktop", name: "Desktop", devices: [], selectedDeviceId: null }]);
    throw new Error(`Unexpected ${url}`);
  }) as typeof fetch;
  expect((await endpoints(new AbortController().signal))[0].id).toBe("desktop");
  expect(serverAddress()).toBe("http://100.64.0.9:38147");
  expect(asked).toContain("http://ewphpc:38147/api/server/info");
  expect(phoneMediaUrl("/api/song.flac")).toBe("http://100.64.0.9:38147/api/song.flac?access_token=phone-token");
});

test("startup recovers through Metro's reachable host before registering phone output", async () => {
  const asked: string[] = [];
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    asked.push(url);
    if (url.endsWith("/api/server/info")) {
      expect(init?.headers).toBeUndefined();
      return response({ service: "ambra", id: url.startsWith("http://100.64.0.10:") ? "home" : "someone-else", name: "EWPHPC", port: 38147 });
    }
    expect(url).toBe("http://100.64.0.10:38147/api/endpoints");
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer phone-token");
    return response([]);
  }) as typeof fetch;
  expect(await restore()).toEqual({ address: "http://100.64.0.10:38147", paired: true });
  expect(asked).toContain("http://100.64.0.10:38147/api/server/info");
  await endpoints(new AbortController().signal);
});

test("a legacy pairing learns its server through the trusted development host using its existing token", async () => {
  legacyPairing = true;
  savedValues.length = 0;
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (!url.startsWith("http://100.64.0.10:")) throw new TypeError("Home Wi-Fi is unreachable");
    if (url.endsWith("/api/server/info")) {
      expect(init?.headers).toBeUndefined();
      return response({ service: "ambra", id: "home", name: "EWPHPC", port: 38147 });
    }
    expect(url).toBe("http://100.64.0.10:38147/api/endpoints");
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer phone-token");
    return response([]);
  }) as typeof fetch;
  try {
    expect(await restore()).toEqual({ address: "http://100.64.0.10:38147", paired: true });
    expect(savedValues).toContainEqual(["ambra.serverIdentity", JSON.stringify({ id: "home", name: "EWPHPC", port: 38147 })]);
    expect(savedValues.some(([key]) => key === "ambra.token")).toBe(false);
  } finally { legacyPairing = false; }
});

test("legacy recovery rejects a development host that does not accept the existing pairing", async () => {
  legacyPairing = true;
  savedValues.length = 0;
  globalThis.fetch = mock(async (input: string | URL | Request) => {
    const url = String(input);
    if (!url.startsWith("http://100.64.0.10:")) throw new TypeError("Home Wi-Fi is unreachable");
    if (url.endsWith("/api/server/info")) return response({ service: "ambra", id: "other", name: "Other", port: 38147 });
    return response({ error: "Not paired" }, 401);
  }) as typeof fetch;
  try {
    expect(await restore()).toEqual({ address: "http://phone-server:38147", paired: true });
    expect(savedValues).toEqual([]);
  } finally { legacyPairing = false; }
});
