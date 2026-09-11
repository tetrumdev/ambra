import { expect, test } from "bun:test";
import { matchingArtistImage } from "../src/utils/artistImages";
import type { CatalogArtist } from "../src/api/server";
const artists: CatalogArtist[] = [
  { id: "tidal:1", provider: "tidal", name: "Example", imageUrl: "one.jpg" },
  { id: "tidal:2", provider: "tidal", name: "Example", imageUrl: "two.jpg" },
];
test("does not guess between artists with the same name", () => {
  expect(matchingArtistImage("Example", artists)).toBeNull();
  expect(matchingArtistImage("Other", artists)).toBeNull();
});
test("uses a unique streaming-service artist match", () => {
  expect(matchingArtistImage("example", artists.slice(0, 1))).toBe("one.jpg");
});

test("keeps Radiohead artwork when track credits lack pictures and similarly named artists exist", () => {
  expect(matchingArtistImage("Radiohead", [
    { id: "qobuz:43840", provider: "qobuz", name: "Radiohead", imageUrl: "radiohead.jpg" },
    { id: "qobuz:23467545", provider: "qobuz", name: "Radiohead -", imageUrl: null },
    { id: "qobuz:43840", provider: "qobuz", name: "Radiohead", imageUrl: null },
  ])).toBe("radiohead.jpg");
});
