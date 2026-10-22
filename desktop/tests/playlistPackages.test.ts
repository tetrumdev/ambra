import { describe, expect, test } from "bun:test";
import {
  bindPackage,
  groupPackagedTracks,
  movePackaged,
  normalizePackages,
  packageDrop,
  unbindPackages,
} from "../src/utils/playlistPackages";
import { parsePlaylistSnapshot } from "../src/utils/playlistStorage";
import { collectionQueueContext, shuffledContextEntries } from "../src/utils/queueModel";
import type { Track } from "../src/types/music";

const track = (globalId: string) => ({ globalId, name: globalId }) as Track;

describe("packages", () => {
  test("binding gathers songs together where the first one sits", () => {
    const result = bindPackage(["a", "airbag", "b", "paranoid", "c"], [], ["paranoid", "airbag"]);
    expect(result.trackIds).toEqual(["a", "airbag", "paranoid", "b", "c"]);
    expect(result.packages).toEqual([["airbag", "paranoid"]]);
  });

  test("binding takes in a package one of the songs already belongs to", () => {
    const result = bindPackage(["a", "b", "c", "d"], [["b", "c"]], ["a", "c"]);
    expect(result.packages).toEqual([["a", "b", "c"]]);
  });

  test("unbinding dissolves the whole package", () => {
    expect(unbindPackages(["a", "b", "c"], [["a", "b", "c"]], ["b"]).packages).toEqual([]);
  });

  test("removing songs drops packages left with one", () => {
    expect(normalizePackages(["a", "c"], [["a", "b"], ["c", "x", "y"]]).packages).toEqual([]);
  });

  test("shuffling keeps a package together and in order", () => {
    const tracks = ["a", "airbag", "paranoid", "b", "c", "d"].map(track);
    const context = collectionQueueContext(tracks, { kind: "playlist", id: "p" }, [["airbag", "paranoid"]]);
    for (let run = 0; run < 50; run += 1) {
      const order = shuffledContextEntries(context.entries).map((entry) => entry.track.globalId);
      expect(order.indexOf("paranoid")).toBe(order.indexOf("airbag") + 1);
    }
  });

  test("a package's first song moves the whole package, never into another", () => {
    const packages = [["b", "c"], ["e", "f", "g"]];
    expect(packageDrop(packages, "b", { trackId: "f", position: "before" })).toEqual({ trackId: "e", position: "before" });
    expect(packageDrop(packages, "b", { trackId: "g", position: "before" })).toEqual({ trackId: "g", position: "after" });
    expect(packageDrop(packages, "b", { trackId: "c", position: "after" })).toBeNull();
    expect(movePackaged(["a", "b", "c", "d"], packages, "b", { trackId: "d", position: "after" })).toEqual(["a", "d", "b", "c"]);
  });

  test("other packaged songs only reorder within their package", () => {
    const packages = [["e", "f", "g"]];
    expect(packageDrop(packages, "g", { trackId: "a", position: "before" })).toBeNull();
    expect(packageDrop(packages, "g", { trackId: "e", position: "before" })).toEqual({ trackId: "e", position: "before" });
    expect(movePackaged(["a", "e", "f", "g"], packages, "g", { trackId: "e", position: "before" })).toEqual(["a", "g", "e", "f"]);
  });

  test("a sorted view keeps each package together", () => {
    const sorted = ["d", "paranoid", "a", "airbag"].map(track);
    expect(groupPackagedTracks(sorted, [["airbag", "paranoid"]]).map((item) => item.globalId)).toEqual(["d", "airbag", "paranoid", "a"]);
  });

  test("saved packages survive loading", () => {
    const raw = JSON.stringify({
      version: 1,
      playlists: [{ id: "p", name: "Mix", trackIds: ["a", "b", "c"], packages: [["b", "c"], ["zzz"]] }],
      tracks: [],
    });
    expect(parsePlaylistSnapshot(raw).playlists[0]).toEqual({ id: "p", name: "Mix", trackIds: ["a", "b", "c"], packages: [["b", "c"]] });
  });
});
