import { expect, test } from "bun:test";
import { albumForTrack, artistForTrack, tracksForEntity } from "../src/utils/browse";
import { track } from "./searchFixture";

const credit = { providerId: "artist", name: "Karnivool", imageUrl: null };
const song = (id: string, overrides = {}) => track(`qobuz:${id}`, "qobuz", { albumId: "album", artists: [credit], albumArtists: [credit], ...overrides });
test("album views preserve edition identity and order discs before track numbers", () => {
  const first = song("1", { discNumber: 1, trackNumber: 2 });
  const second = song("2", { discNumber: 2, trackNumber: 1 });
  const other = song("3", { albumId: "another-edition" });
  expect(tracksForEntity({ kind: "album", album: albumForTrack(first) }, [second, other, first]).map(track => track.globalId)).toEqual([first.globalId, second.globalId]);
});
test("artist views include album credits and exclude same-name artists with other IDs", () => {
  const first = song("1");
  const compilation = song("2", { artists: [{ ...credit, providerId: "guest" }] });
  const namesake = song("3", { artists: [{ ...credit, providerId: "namesake" }], albumArtists: [] });
  expect(tracksForEntity({ kind: "artist", artist: artistForTrack(first) }, [first, compilation, namesake]).map(track => track.globalId)).toEqual([first.globalId, compilation.globalId]);
});
