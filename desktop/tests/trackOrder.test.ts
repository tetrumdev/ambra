import { describe, expect, test } from "bun:test";
import {
  moveAlbumToEndInOrder,
  trackPosition,
} from "../src/utils/trackOrder";

describe("moveAlbumToEndInOrder", () => {
  test("moves an existing track into its album position", () => {
    const track = (id: string, trackNumber: number | null) => ({
      id,
      discNumber: 1,
      trackNumber,
    });
    const current = [track("5", 5), track("other", null)];
    const album = [1, 2, 3, 4, 5].map((number) =>
      track(String(number), number),
    );

    expect(moveAlbumToEndInOrder(current, album).map(({ id }) => id)).toEqual([
      "other",
      "1",
      "2",
      "3",
      "4",
      "5",
    ]);
  });

  test("resolves a stable track ID after its position shifts", () => {
    const tracks = [{ id: "1" }, { id: "2" }, { id: "5" }];

    expect(trackPosition(tracks, "5")).toBe(2);
  });
});
