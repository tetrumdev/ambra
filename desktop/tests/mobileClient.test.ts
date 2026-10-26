import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { editUpcoming, enqueueEntries, playlistEntries, shuffledEntries } from "../../mobile/src/queueModel";
import type { QueueSnapshot, SessionView, Track } from "../../mobile/src/client";

mock.module("../../mobile/node_modules/expo-constants", () => ({ default: { expoConfig: {} } }));
mock.module("../../mobile/node_modules/expo-secure-store", () => ({
  getItemAsync: async (key: string) => ({
    "ambra.server": "http://phone-server:38147",
    "ambra.addresses": JSON.stringify(["http://phone-server:38147", "http://100.64.0.9:38147"]),
    "ambra.serverIdentity": JSON.stringify({ id: "home", name: "EWPHPC", port: 38147 }),
  } as Record<string, string>)[key] ?? "phone-token",
  deleteItemAsync: async () => {},
  setItemAsync: async () => {},
}));
mock.module("../../mobile/node_modules/react-native", () => ({ AppState: { addEventListener: () => ({ remove() {} }) } }));
const { changeQueue, command, endpoints, megaPlaylist, phoneMediaUrl, restore, serverAddress } = await import("../../mobile/src/client");
const originalFetch = globalThis.fetch;
beforeAll(async () => { await restore(); });
afterAll(() => { globalThis.fetch = originalFetch; });

const track: Track = { globalId: "a", provider: "qobuz", name: "Song", artist: "Artist", album: "Album", cover: "http://old-server:38147/api/cover?access_token=old-token", nativeCover: null, durationSeconds: 180 };
const item = { globalTrackId: "a", source: { kind: "playlist" as const, id: "mega", entryId: 1 }, shufflePackageId: null };
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
const session = (revision: number, queueRevision: number, queue: QueueSnapshot): SessionView => ({ instanceId: "test-server", revision, queueRevision, queue, playing: false, positionSeconds: 0, duration: 180, buffering: false, error: null, output: { endpointId: "desktop", deviceId: "speakers", endpointName: "Desktop", deviceName: "Speakers" }, outputOnline: true });

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

// Last: it moves the client to another address.
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
