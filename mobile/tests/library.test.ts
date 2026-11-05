import { afterAll, beforeEach, expect, mock, test } from "bun:test";

const store = new Map<string, string>([["ambra.token", "test-token"], ["ambra.pairingPayload.v1", "test-pairing"]]);
mock.module("expo-secure-store", () => ({
  getItemAsync: async (key: string) => store.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => { store.set(key, value); },
  deleteItemAsync: async (key: string) => { store.delete(key); },
}));
mock.module("expo-constants", () => ({ default: { deviceName: "Test phone" } }));
mock.module("react-native", () => ({ AppState: { addEventListener: () => ({ remove() {} }) }, Platform: { OS: "ios" } }));
let downloads: unknown[] = [];
mock.module("../modules/ambra-network/src", () => ({
  nativeNetworkAvailable: true,
  networkCall: async (operation: string) => operation === "offline_list" ? downloads : { baseUrl: "http://127.0.0.1:9000/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
}));
const client = await import("../src/client");
const sharedState = await import("../src/sharedState");
const library = await import("../src/library");
const phone = await import("../src/downloads");
const fetch = globalThis.fetch;
afterAll(() => { globalThis.fetch = fetch; });
beforeEach(async () => { await client.restore(); sharedState.forgetState(); });
const respond = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });

test("a playlist edit made at the same time as another device's is made again on top of theirs", async () => {
  const writes: { revision: number; changes: Record<string, string> }[] = [];
  let saved = { revision: 4, values: { "ambra.playlists.v1": JSON.stringify({ version: 1, playlists: [{ id: "a", name: "A", trackIds: ["tidal:1"] }], tracks: [] }) } };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/api/state") && init?.method === "POST") {
      const patch = JSON.parse(String(init.body));
      writes.push(patch);
      if (writes.length === 1) {
        // Another device added a song meanwhile.
        saved = { revision: 5, values: { "ambra.playlists.v1": JSON.stringify({ version: 1, playlists: [{ id: "a", name: "A", trackIds: ["tidal:1", "tidal:2"] }], tracks: [] }) } };
        return respond({ error: "conflict", keys: ["ambra.playlists.v1"], revision: 5, changes: {} }, 409);
      }
      return respond({ revision: 6, changes: {} });
    }
    if (url.endsWith("/api/state")) return respond(saved);
    return respond({ tracks: [] });
  }) as typeof globalThis.fetch;
  await library.renamePlaylist("a", "Renamed");
  expect(writes).toHaveLength(2);
  expect(writes[1].revision).toBe(5);
  const result = JSON.parse(writes[1].changes["ambra.playlists.v1"]);
  expect(result.playlists[0]).toMatchObject({ name: "Renamed", trackIds: ["tidal:1", "tidal:2"] });
});

test("songs saved to shared state carry server paths, never this phone's bridge capability", () => {
  const bridge = "http://127.0.0.1:9000/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const shared = client.forSharing(JSON.stringify({ audio: `${bridge}/api/providers/tidal/tracks/1/stream?access_token=secret` }));
  expect(shared).not.toContain("aaaaaaaa");
  expect(shared).not.toContain("secret");
  expect(JSON.parse(shared).audio).toBe("http://127.0.0.1:9000/api/providers/tidal/tracks/1/stream");
});

test("library artists and albums group songs as desktop's library sections do", () => {
  const track = (id: string, album: string, artist: string) => ({
    globalId: `tidal:${id}`, provider: "tidal", providerTrackId: id, playbackKind: "direct", audio: "", cover: `${album}.jpg`, nativeCover: null,
    name: id, version: null, album, albumVersion: null, albumId: album, albumArtists: [], artist,
    artists: [{ providerId: artist, name: artist, imageUrl: null }], trackNumber: 1, discNumber: 1, durationSeconds: 1, releaseDate: "2020-01-01",
    explicit: false, isrc: null, copyright: null, label: null, genres: [], upc: null, quality: null, maximumSamplingRateKHz: null, maximumBitDepth: null,
  }) as unknown as import("../../desktop/src/types/music").Track;
  const tracks = [track("1", "One", "Ada"), track("2", "One", "Ada"), track("3", "Two", "Ben")];
  expect(library.libraryArtists(tracks).map(artist => [artist.name, artist.albumCount, artist.trackCount])).toEqual([["Ada", 1, 2], ["Ben", 1, 1]]);
  expect(library.libraryAlbums(tracks).map(album => [album.id, album.title, album.trackCount])).toEqual([["tidal:One", "One", 2], ["tidal:Two", "Two", 1]]);
});

test("a song downloaded to this phone plays from its copy, whichever server URL names it", async () => {
  downloads = [{ id: "tidal:42", provider: "tidal", providerTrackId: "42", url: "http://127.0.0.1:7000/secret/tidal-42.flac", coverUrl: null, metadata: {}, requestedQuality: "max", qualityLabel: "FLAC", sizeBytes: 1 }];
  await phone.refreshPhoneDownloads();
  expect(phone.phoneUrlForSource("/api/providers/tidal/tracks/42/stream")).toBe("http://127.0.0.1:7000/secret/tidal-42.flac");
  expect(phone.phoneUrlForSource("http://phone.test/capability/api/providers/tidal/tracks/42/playlist.m3u8?access_token=x")).toBe("http://127.0.0.1:7000/secret/tidal-42.flac");
  expect(phone.phoneUrlForSource("/api/downloads/play/tidal/42")).toBe("http://127.0.0.1:7000/secret/tidal-42.flac");
  expect(phone.phoneUrlForSource("/api/providers/tidal/tracks/43/stream")).toBeNull();
  expect(phone.isDownloadable("local:song")).toBe(false);
});

function stateServer(values: Record<string, string>) {
  const writes: Record<string, string>[] = [];
  let revision = 1;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/api/state") && init?.method === "POST") {
      const patch = JSON.parse(String(init.body));
      writes.push(patch.changes);
      Object.assign(values, patch.changes);
      return respond({ revision: ++revision, changes: {} });
    }
    if (url.endsWith("/api/state")) return respond({ revision, values });
    if (url.endsWith("/api/music/local/tracks")) return respond([]);
    return respond({ tracks: [] });
  }) as typeof globalThis.fetch;
  return writes;
}

test("dragging a song in a playlist saves the new order and keeps bound songs together", async () => {
  const writes = stateServer({ "ambra.playlists.v1": JSON.stringify({ version: 1, playlists: [{ id: "p", name: "P", trackIds: ["a", "b", "c", "d"], packages: [["b", "c"]] }], tracks: [] }) });
  // "d" dropped first; the bound pair stays as one.
  await library.reorderPlaylist("p", ["d", "a", "b", "c"]);
  const saved = JSON.parse(writes.at(-1)!["ambra.playlists.v1"]);
  expect(saved.playlists[0].trackIds).toEqual(["d", "a", "b", "c"]);
  expect(saved.playlists[0].packages).toEqual([["b", "c"]]);
});

test("dragging a library song saves the shared library order every device uses", async () => {
  const writes = stateServer({ "ambra.library-order.v1": JSON.stringify(["a", "b", "c"]) });
  await library.reorderLibrary(["c", "a", "b"]);
  expect(JSON.parse(writes.at(-1)!["ambra.library-order.v1"])).toEqual(["c", "a", "b"]);
});

test("Improve Playlist swaps songs for their better copies in place, bound songs included", async () => {
  const writes = stateServer({ "ambra.playlists.v1": JSON.stringify({ version: 1, playlists: [{ id: "p", name: "P", trackIds: ["tidal:1", "tidal:2"], packages: [["tidal:1", "tidal:2"]] }], tracks: [] }) });
  const better = (id: string) => ({ globalId: id, provider: "qobuz", providerTrackId: id.slice(6) }) as unknown as import("../../desktop/src/types/music").Track;
  await library.replacePlaylistTracks("p", new Map([["tidal:1", better("qobuz:9")], ["tidal:2", better("qobuz:8")]]));
  const saved = JSON.parse(writes.at(-1)!["ambra.playlists.v1"]);
  expect(saved.playlists[0].trackIds).toEqual(["qobuz:9", "qobuz:8"]);
  expect(saved.playlists[0].packages).toEqual([["qobuz:9", "qobuz:8"]]);
  expect(saved.tracks.map((track: { globalId: string }) => track.globalId)).toEqual(["qobuz:9", "qobuz:8"]);
});
