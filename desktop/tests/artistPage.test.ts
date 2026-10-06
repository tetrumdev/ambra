import { expect, test } from "bun:test";
import { artistBiography, artistReleaseSections } from "../src/utils/artistPage";
import type { CatalogAlbum } from "../src/api/server";
const album = (id: string, releaseType: string, releaseDate: string): CatalogAlbum => ({ id, provider: "qobuz", title: id, artist: "Artist", imageUrl: null, releaseType, releaseDate });
test("release sections use provider types, deduplicate IDs, and place new releases first", () => {
  const old = album("old", "album", "1997-01-01");
  const recent = album("recent", "album", "2024-01-01");
  const sections = artistReleaseSections([old, album("ep", "epSingle", "2020-01-01"), recent, old, album("live", "live", "2022-01-01")]);
  expect(sections.map(section => section.title)).toEqual(["Albums", "EPs & singles", "Live"]);
  expect(sections[0].albums.map(album => album.id)).toEqual(["recent", "old"]);
});
test("artist biography renders paragraphs as text, excluding script and style content", () => {
  expect(artistBiography('<p>First &amp; second.</p><p>Next.</p><script>danger()</script><style>p{}</style>')).toEqual(["First & second.", "Next."]);
});
