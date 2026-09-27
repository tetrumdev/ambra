import { describe, expect, test } from "bun:test";
import { track } from "./searchFixture";
import {
  mergeVisibleTrackOrder,
  moveTrackId,
  nextTrackSort,
  sortCollectionTracks,
} from "../src/utils/trackCollectionOrder";

describe("track collection ordering", () => {
  test("column sorting cycles descending, ascending, then date-added order", () => {
    const descending = nextTrackSort(null, "artist");
    const ascending = nextTrackSort(descending, "artist");

    expect(descending).toEqual({ key: "artist", direction: "descending" });
    expect(ascending).toEqual({ key: "artist", direction: "ascending" });
    expect(nextTrackSort(ascending, "artist")).toBeNull();
    expect(nextTrackSort(ascending, "album")).toEqual({
      key: "album",
      direction: "descending",
    });
  });

  test("sorts text and duration while preserving date-added ties", () => {
    const added = [
      track("first", "local", { artist: "Beta", durationSeconds: 120 }),
      track("second", "local", { artist: "alpha", durationSeconds: 180 }),
      track("third", "local", { artist: "Alpha", durationSeconds: 180 }),
    ];

    expect(
      sortCollectionTracks(added, {
        key: "artist",
        direction: "descending",
      }).map((item) => item.globalId),
    ).toEqual(["second", "third", "first"]);
    expect(
      sortCollectionTracks(added, {
        key: "duration",
        direction: "descending",
      }).map((item) => item.globalId),
    ).toEqual(["first", "second", "third"]);
    expect(sortCollectionTracks(added, { key: "artist", direction: "ascending" }).map(item => item.globalId))
      .toEqual(["first", "second", "third"]);
    expect(sortCollectionTracks(added, { key: "duration", direction: "ascending" }).map(item => item.globalId))
      .toEqual(["second", "third", "first"]);
    expect(sortCollectionTracks(added, null)).toBe(added);
  });

  test("moves a dragged track and preserves unavailable stored entries", () => {
    const visible = moveTrackId(["a", "b", "c"], "a", "c", "after");
    expect(visible).toEqual(["b", "c", "a"]);
    expect(mergeVisibleTrackOrder(["a", "missing", "b", "c"], visible))
      .toEqual(["b", "missing", "c", "a"]);
  });
});
