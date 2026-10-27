import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { editUpcoming, enqueueEntries, playlistEntries, shuffledEntries } from "../../mobile/src/queueModel";
import type { QueueSnapshot, SessionView, Track } from "../../mobile/src/client";
import { refreshLyricPlayback } from "../../mobile/src/lyricsPlayback";

mock.module("../../mobile/node_modules/expo-constants", () => ({ default: { expoConfig: { hostUri: "100.64.0.10:8081" } } }));
let legacyPairing = false;
const savedValues: [string, string][] = [];
mock.module("../../mobile/node_modules/expo-secure-store", () => ({
  getItemAsync: async (key: string) => legacyPairing && key === "ambra.pairingPayload.v1" ? null : ({
    "ambra.server": "http://phone-server:38147",
    "ambra.pairingPayload.v1": "ambra://pair/test-pinned-key",
    "ambra.addresses": JSON.stringify(["http://phone-server:38147", "http://100.64.0.9:38147"]),
    "ambra.serverIdentity": JSON.stringify({ id: "home", name: "EWPHPC", port: 38147 }),
  } as Record<string, string>)[key] ?? "phone-token",
  deleteItemAsync: async () => {},
  setItemAsync: async (key: string, value: string) => { savedValues.push([key, value]); },
}));
const nativeCalls: { operation: string; args: unknown }[] = [];
mock.module("../../mobile/modules/ambra-network/src", () => ({
  nativeNetworkAvailable: true,
  networkCall: async (operation: string, args: unknown) => { nativeCalls.push({ operation, args }); return { baseUrl: "http://phone-server:38147", state: "ConnectedLocal" }; },
}));
mock.module("../../mobile/node_modules/react-native", () => ({ AppState: { addEventListener: () => ({ remove() {} }) } }));
const { changeQueue, command, coverPalette, currentTrack, endpoints, megaPlaylist, phoneMediaUrl, refreshSession, restore, requestPairing, serverAddress, sessionView, sessionViewAge, trackLyrics } = await import("../../mobile/src/client");
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
    expect((init?.headers as Record<string, string>).Authorization).toBeUndefined();
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
  expect(loaded.tracks[0].cover).toBe("http://phone-server:38147/api/cover");
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
  expect(phoneMediaUrl("http://desktop:38147/api/song/playlist.m3u8?quality=lossless&access_token=old")).toBe("http://phone-server:38147/api/song/playlist.m3u8?quality=lossless");
  expect(phoneMediaUrl("/api/music/local/files/song.flac")).toBe("http://phone-server:38147/api/music/local/files/song.flac");
  expect(phoneMediaUrl("https://cdn.example/song.flac")).toBe("https://cdn.example/song.flac");
  expect(() => phoneMediaUrl("C:/Music/song.flac")).toThrow("only on the computer");
});

test("output discovery uses the paired server and includes complete endpoint and device identities", async () => {
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
    expect(String(input)).toBe("http://phone-server:38147/api/endpoints");
    expect((init?.headers as Record<string, string>).Authorization).toBeUndefined();
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
    expect((init?.headers as Record<string, string>).Authorization).toBeUndefined();
    if (path === "/api/session/clock") return response({ serverTimeMs: Date.now() - 123456 });
    expect(path).toBe("/api/session");
    return response({ ...session(16, 5, queue), playing: true, positionSeconds: 90, serverTimeMs: Date.now() - 123456 - 400 });
  }) as typeof fetch;
  const playback = await refreshLyricPlayback(new AbortController().signal, true);
  expect(calls.filter(path => path === "/api/session/clock")).toHaveLength(3);
  expect(calls.at(-1)).toBe("/api/session");
  expect(sessionView()?.positionSeconds).toBe(90);
  expect(sessionViewAge()).toBeGreaterThanOrEqual(0.35);
  expect(sessionViewAge()).toBeLessThan(1);
  expect(playback?.view).toBe(sessionView());
  expect(playback?.ageSeconds).toBeGreaterThanOrEqual(0.35);
  calls.length = 0;
  await refreshSession(new AbortController().signal, { clock: "recent" });
  expect(calls).toEqual(["/api/session"]);
  calls.length = 0;
  await refreshSession(new AbortController().signal);
  expect(calls).toEqual(["/api/session"]);
});

test("opening lyrics keeps refresh errors asynchronous and aborting an opening sends no requests", async () => {
  const abort = new AbortController();
  abort.abort();
  globalThis.fetch = mock(async () => { throw new Error("Must not fetch an abandoned opening"); }) as typeof fetch;
  expect(await refreshLyricPlayback(abort.signal)).toBeNull();
  expect(globalThis.fetch).not.toHaveBeenCalled();
  globalThis.fetch = mock(async () => { throw new TypeError("Network request failed"); }) as typeof fetch;
  let opening: ReturnType<typeof refreshLyricPlayback> | undefined;
  expect(() => { opening = refreshLyricPlayback(new AbortController().signal); }).not.toThrow();
  await expect(opening!).rejects.toThrow("Network request failed");
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

test("startup delegates selected identity and token to Rust without probing other hosts", async () => {
  nativeCalls.length = 0;
  globalThis.fetch = mock(async () => { throw new Error("No JavaScript discovery allowed"); }) as typeof fetch;
  expect(await restore()).toEqual({ address: "ambra://pair/test-pinned-key", paired: true });
  expect(nativeCalls).toEqual([{ operation: "open", args: { payload: "ambra://pair/test-pinned-key", token: "phone-token" } }]);
  expect(serverAddress()).toBe("http://phone-server:38147");
});

test("a failed mutation is sent once and keeps the logical server bridge", async () => {
  const calls: string[] = [];
  globalThis.fetch = mock(async (input: string | URL | Request) => { calls.push(String(input)); throw new TypeError("Network request failed"); }) as typeof fetch;
  await expect(command("pause")).rejects.toThrow("Network request failed");
  expect(calls).toHaveLength(1);
  expect(serverAddress()).toBe("http://phone-server:38147");
});

test("legacy pairing requires explicit key migration and never sends credentials to discovery hints", async () => {
  legacyPairing = true; savedValues.length = 0; nativeCalls.length = 0;
  globalThis.fetch = mock(async () => { throw new Error("Legacy token must not be sent"); }) as typeof fetch;
  try {
    expect(await restore()).toEqual({ address: "http://phone-server:38147", paired: false });
    expect(nativeCalls).toEqual([]); expect(savedValues).toEqual([]);
  } finally { legacyPairing = false; }
});

test("a new P2P bridge clears the old song and ignores a late response body from the previous connection", async () => {
  const previous: QueueSnapshot = { version: 1, history: [], current: item, upcoming: [], tracks: [track] };
  globalThis.fetch = mock(async () => response(session(100, 50, previous))) as typeof fetch;
  await refreshSession(new AbortController().signal);
  expect(currentTrack(sessionView())?.name).toBe("Song");
  let finishBody!: (value: SessionView) => void;
  let bodyStarted!: () => void;
  const started = new Promise<void>(resolve => { bodyStarted = resolve; });
  globalThis.fetch = mock(async () => ({ status: 200, ok: true, json: () => {
    bodyStarted(); return new Promise<SessionView>(resolve => { finishBody = resolve; });
  } })) as typeof fetch;
  const late = refreshSession(new AbortController().signal).then(() => null, error => error);
  await started;
  await restore();
  expect(sessionView()).toBeNull();
  const freshTrack = { ...track, globalId: "fresh", name: "Current P2P song" };
  const fresh: QueueSnapshot = { ...previous, current: { ...item, globalTrackId: "fresh" }, tracks: [freshTrack] };
  globalThis.fetch = mock(async () => response({ ...session(1, 1, fresh), instanceId: "fresh-server" })) as typeof fetch;
  await refreshSession(new AbortController().signal);
  finishBody(session(101, 50, previous));
  expect((await late).name).toBe("AbortError");
  expect(currentTrack(sessionView())?.name).toBe("Current P2P song");
});

test("old unauthorized replies and queued controls cannot close or change a newly opened P2P connection", async () => {
  let finishRequest!: (value: Response) => void;
  let requestStarted!: () => void;
  const started = new Promise<void>(resolve => { requestStarted = resolve; });
  globalThis.fetch = mock(async () => { requestStarted(); return new Promise<Response>(resolve => { finishRequest = resolve; }); }) as typeof fetch;
  const active = command("play").then(() => null, error => error);
  await started;
  const queued = command("next").then(() => null, error => error);
  nativeCalls.length = 0;
  await restore();
  finishRequest(response({ error: "Old bridge closed" }, 401));
  expect((await active).name).toBe("AbortError");
  expect((await queued).name).toBe("AbortError");
  expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  expect(nativeCalls.some(call => call.operation === "close")).toBe(false);
  expect(sessionView()).toBeNull();
});

test("explicit pairing to another server clears the old session before using its native bridge", async () => {
  globalThis.fetch = mock(async () => response({ requestId: "new-request", code: "123456" })) as typeof fetch;
  expect(await requestPairing("ambra://pair/new-pinned-key", "Phone")).toEqual({ requestId: "new-request", code: "123456" });
  expect(sessionView()).toBeNull();
  expect(nativeCalls.at(-1)).toEqual({ operation: "open", args: { payload: "ambra://pair/new-pinned-key" } });
});
