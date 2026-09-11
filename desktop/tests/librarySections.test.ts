import { describe, expect, test } from "bun:test";
import { libraryAlbums, libraryArtists } from "../src/utils/librarySections";
import { track } from "./searchFixture";

describe("library sections", () => {
  test("groups tracks into albums using provider album identity", () => {
    const tracks = [
      track("tidal:1", "tidal", { albumId: "10", name: "One" }),
      track("tidal:2", "tidal", { albumId: "10", name: "Two" }),
      track("qobuz:3", "qobuz", { albumId: "10", name: "Three" }),
    ];

    expect(
      libraryAlbums(tracks)
        .map((album) => album.trackCount)
        .sort(),
    ).toEqual([1, 2]);
  });

  test("groups artist credits and counts their albums and tracks", () => {
    const artist = { providerId: "7", name: "Karnivool", imageUrl: null };
    const tracks = [
      track("qobuz:1", "qobuz", {
        albumId: "a",
        artists: [artist],
      }),
      track("qobuz:2", "qobuz", {
        albumId: "b",
        artists: [artist],
      }),
    ];

    expect(libraryArtists(tracks)).toEqual([
      {
        id: "qobuz:7",
        name: "Karnivool",
        imageUrl: null,
        albumCount: 2,
        trackCount: 2,
      },
    ]);
  });
});
