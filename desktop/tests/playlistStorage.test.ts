import { expect, test } from "bun:test";
import { addPlaylistTrack, emptyPlaylists, parsePlaylistSnapshot, savePlaylistSnapshot, PLAYLIST_STORAGE_KEY } from "../src/utils/playlistStorage";
import { removePlaylistTracks, playlistTracks } from "../src/utils/playlists";
import { track } from "./searchFixture";

const song = track("tidal:playlist-song", "tidal");

test("saved search-only song restores without library or search results", () => {
  const initial = { ...emptyPlaylists(), playlists: [{ id: "p", name: "Favorites", trackIds: [] }] };
  const added = addPlaylistTrack(initial, "p", song);
  const restored = parsePlaylistSnapshot(JSON.stringify(added));
  expect(restored.playlists[0].name).toBe("Favorites");
  expect(playlistTracks(restored.playlists[0], restored.tracks)).toEqual([song]);
  expect(initial.playlists[0].trackIds).toEqual([]);
});

test("adding twice does not duplicate membership and refreshes metadata", () => {
  const initial = { ...emptyPlaylists(), playlists: [{ id: "p", name: "Favorites", trackIds: [] }] };
  const once = addPlaylistTrack(initial, "p", song);
  const twice = addPlaylistTrack(once, "p", { ...song, quality: "FLAC" });
  expect(twice.playlists[0].trackIds).toEqual([song.globalId]);
  expect(twice.tracks).toHaveLength(1);
  expect(twice.tracks[0].quality).toBe("FLAC");
  expect(addPlaylistTrack(twice, "missing", song)).toBe(twice);
});

test("persists removals while preserving songs referenced by other playlists", () => {
  const original = { ...emptyPlaylists(), playlists: [
    { id: "a", name: "A", trackIds: [song.globalId] },
    { id: "b", name: "B", trackIds: [song.globalId] },
  ], tracks: [song, track("qobuz:unused", "qobuz")] };
  const updated = { ...original, playlists: removePlaylistTracks(original.playlists, "a", [song.globalId]) };
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  let saved = "";
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    setItem: (key: string, value: string) => { expect(key).toBe(PLAYLIST_STORAGE_KEY); saved = value; },
  } });
  try {
    const savedSnapshot = savePlaylistSnapshot(updated);
    const restored = parsePlaylistSnapshot(saved);
    expect(restored.playlists[0].trackIds).toEqual([]);
    expect(restored.playlists[1].trackIds).toEqual([song.globalId]);
    expect(restored.tracks).toEqual([song]);
    expect(savedSnapshot).toEqual(restored);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});

test("missing storage starts empty and invalid storage is rejected", () => {
  expect(parsePlaylistSnapshot(null)).toEqual(emptyPlaylists());
  expect(() => parsePlaylistSnapshot("broken")).toThrow();
  expect(() => parsePlaylistSnapshot('{"version":2,"playlists":[],"tracks":[]}')).toThrow();
  expect(() => parsePlaylistSnapshot('{"version":1,"playlists":[{}],"tracks":[]}')).toThrow();
  expect(() => parsePlaylistSnapshot('{"version":1,"playlists":[],"tracks":[{}]}')).toThrow();
});
