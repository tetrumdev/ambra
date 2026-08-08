import { describe, expect, test } from "bun:test";
import {
  moveAlbumToEndInOrder,
  trackPosition,
} from "../src/utils/trackOrder";

describe("moveAlbumToEndInOrder", () => {
  test("moves an existing track into its album position", () => {
    const track = (globalId: string, trackNumber: number | null) => ({
      globalId,
      discNumber: 1,
      trackNumber,
    });
    const current = [track("5", 5), track("other", null)];
    const album = [1, 2, 3, 4, 5].map((number) =>
      track(String(number), number),
    );

    expect(
      moveAlbumToEndInOrder(current, album).map(({ globalId }) => globalId),
    ).toEqual(["other", "1", "2", "3", "4", "5"]);
  });

  test("resolves a stable track ID after its position shifts", () => {
    const tracks = [
      { globalId: "1" },
      { globalId: "2" },
      { globalId: "5" },
    ];

    expect(trackPosition(tracks, "5")).toBe(2);
  });
});
