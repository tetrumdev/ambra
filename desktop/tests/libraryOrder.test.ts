import { expect, test } from "bun:test";
import { appendLibraryOrder, orderLibraryTracks } from "../src/utils/libraryOrder";
import { addPlaylistTrack, emptyPlaylists } from "../src/utils/playlistStorage";
import { removePlaylistTracks } from "../src/utils/playlists";
import { track } from "./searchFixture";
test("re-added streaming song follows local songs after restoring order", () => {
  const tracks = [{ globalId: "a" }, { globalId: "b" }, { globalId: "local:c" }];
  const saved = appendLibraryOrder(tracks, [], ["a"]);
  expect(orderLibraryTracks(tracks, JSON.parse(JSON.stringify(saved))).map(t => t.globalId)).toEqual(["b", "local:c", "a"]);
});
test("playlist removal and re-add append at the end", () => {
  const song = track("a", "tidal");
  const snapshot = { ...emptyPlaylists(), playlists: [{id: "p", name: "P", trackIds: ["a", "b"]}], tracks: [song] };
  const removed = { ...snapshot, playlists: removePlaylistTracks(snapshot.playlists, "p", ["a"]) };
  expect(addPlaylistTrack(removed, "p", song).playlists[0].trackIds).toEqual(["b", "a"]);
});
