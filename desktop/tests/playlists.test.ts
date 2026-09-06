import { expect, test } from "bun:test";
import { playlistTracks, removePlaylistTracks } from "../src/utils/playlists";
import { collectionQueueContext, contextEntriesFrom } from "../src/utils/queueModel";
import type { Playlist } from "../src/types/music";
import { track } from "./searchFixture";

const first = track("tidal:first", "tidal");
const second = track("qobuz:second", "qobuz");
const playlists: Playlist[] = [
  { id: "one", name: "One", trackIds: [second.globalId, first.globalId] },
  { id: "two", name: "Two", trackIds: [first.globalId] },
];

test("single removal affects only the chosen playlist, preserving catalog and other memberships", () => {
  const result = removePlaylistTracks(playlists, "one", [first.globalId]);
  expect(result[0].trackIds).toEqual([second.globalId]);
  expect(result[1]).toBe(playlists[1]);
  expect(playlists[0].trackIds).toEqual([second.globalId, first.globalId]);
  expect(playlistTracks(result[1], [first, second])).toEqual([first]);
});

test("bulk removal and an unknown playlist ID are safe", () => {
  expect(removePlaylistTracks(playlists, "one", [first.globalId, second.globalId])[0].trackIds).toEqual([]);
  expect(removePlaylistTracks(playlists, "missing", [first.globalId])).toEqual(playlists);
});

test("playlist resolves from catalog independently of library membership and keeps its own order", () => {
  expect(playlistTracks(playlists[0], [first, second])).toEqual([second, first]);
  // A temporarily unavailable song is skipped without deleting its membership.
  expect(playlistTracks(playlists[0], [first])).toEqual([first]);
  expect(playlists[0].trackIds).toHaveLength(2);
});

test("playlist playback and play-from-here use playlist order and provenance", () => {
  const context = collectionQueueContext(playlistTracks(playlists[0], [first, second]), { kind: "playlist", id: "one" });
  expect(context.entries.map(entry => entry.track.globalId)).toEqual([second.globalId, first.globalId]);
  expect(context.entries.every(entry => entry.source.kind === "playlist" && entry.source.id === "one")).toBe(true);
  expect(contextEntriesFrom(context, first.globalId).map(entry => entry.track.globalId)).toEqual([first.globalId]);
});
