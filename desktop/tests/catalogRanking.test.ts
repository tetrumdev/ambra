import { describe, expect, test } from "bun:test";
import { matchingTrackArtist, categoryOrder, fallbackQuery, rankAlbums, rankArtists, textRelevance } from "../src/utils/catalogRanking";
import type { CatalogAlbum, CatalogArtist } from "../src/api/server";
const artist = (id: string, name: string, provider: "qobuz" | "tidal" = "qobuz"): CatalogArtist => ({ id, name, provider, imageUrl: null });
const album = (id: string, extra: Partial<CatalogAlbum> = {}): CatalogAlbum => ({ id, title: "HEROES & VILLAINS", artist: "Metro Boomin", provider: "qobuz", imageUrl: null, ...extra });
describe("catalog search", () => {
 test("spacing and punctuation match without artist-specific rules", () => {
  for (const [name, query] of [["e w p h", "ewph"], ["A B C D E", "abcde"], ["X.Y.Z.Q", "xyzq"]]) {
   expect(textRelevance(name, query)).toBe(5);
   expect(textRelevance(`Without Direction ${name}`, `without direction ${query}`)).toBe(5);
   expect(textRelevance(`${name} Another Song`, `${query} another song`)).toBe(5);
   expect(matchingTrackArtist(`${query} another song`, [{ name: "Another Song", artist: name }])).toBe(name);
  }
  expect(textRelevance("HEROES & VILLAINS", "heroes and villains")).toBe(5);
  expect(textRelevance("Beyoncé", "beyonce")).toBe(5);
 });
 test("minor typos rank below exact matches and unrelated words", () => {
  expect(textRelevance("Oceansize", "oceansyze")).toBe(2);
  expect(textRelevance("Ocean", "oceansiz")).toBe(0);
  expect(rankArtists([artist("1", "Oceansize"), artist("2", "Oceansiz")], "oceansiz")[0].id).toBe("2");
 });
 test("bounded retrieval fallback runs for a missing artist even with track hits", () => {
  for (const query of ["ewph", "abcde", "xyzq", "abcdefgh"]) {
   const spaced = [...query].join(" ");
   expect(fallbackQuery(query, [], true)).toBe(spaced);
   expect(fallbackQuery(query, [artist("1", spaced)], true)).toBeNull();
  }
  expect(fallbackQuery("a very long artist query", [], true)).toBeNull();
 });
 test("consolidates album editions before limiting results, retaining named versions", () => {
  const result = rankAlbums([album("1", { explicit: false, maximumBitDepth: 24 }), album("2", { explicit: true, maximumBitDepth: 16 }), album("3", { explicit: true, maximumBitDepth: 24 }), album("4", { version: "Instrumental" })], "heroes and villains");
  expect(result.map(a => a.id)).toEqual(["3", "4"]);
 });
 test("same title by a different artist remains separate", () => {
  expect(rankAlbums([album("1"), album("2", { artist: "Someone Else" })], "heroes and villains")).toHaveLength(2);
 });
 test("artist provider duplicates collapse but same-service namesakes remain", () => {
  expect(rankArtists([artist("q1", "Example"), artist("q2", "Example"), artist("t1", "Example", "tidal")], "example")).toHaveLength(2);
 });
});

test("Airbag song leads despite strong namesake band results", () => {
 const song = {name: "Airbag (Remastered)", artist: "Radiohead", album: "OK Computer", provider: "qobuz"};
 const others = ["Por Mil Noches", "Nunca Lo Olvides", "Broken"].map(name => ({name, artist: "Airbag", album: "Other", provider: "qobuz"}));
 expect(categoryOrder("airbag", [song, ...others], [artist("radiohead", "Radiohead"), artist("airbag", "Airbag")], [], [song, ...others])[0]).toBe("tracks");
});
test("artist intent leads when tracks corroborate the name", () => {
 expect(categoryOrder("oceansize", [{name: "Music For A Nurse", artist: "Oceansize", album: "Everyone Into Position"}], [artist("1", "Oceansize")], [album("2", {title: "Oceansize", artist: "Oh Wonder"})])[0]).toBe("artists");
});
test("album and song queries lead with their matching categories", () => {
 expect(categoryOrder("heroes and villains", [], [], [album("1")])[0]).toBe("albums");
 expect(categoryOrder("Music For A Nurse", [{name: "Music For A Nurse", artist: "Oceansize", album: "Everyone Into Position"}], [], [album("1")])[0]).toBe("tracks");
});

const oblivious = { name: "Oblivious", artist: "Aztec Camera", album: "High Land, Hard Rain" };
const karaoke = album("karaoke", { title: "Oblivious (Karaoke Version Originally Performed by Aztec Camera)", artist: "Singer’s Best" });
for (const query of ["oblivious aztec camera", "aztec camera oblivious", "oblivious aztec cam"]) {
 test(`song and credited artist beat incidental karaoke album text: ${query}`, () => {
  expect(categoryOrder(query, [oblivious], [artist("camera", "Camera")], [karaoke])[0]).toBe("tracks");
 });
}
test("remastered song retains title and artist intent", () => {
 expect(categoryOrder("oblivious aztec camera", [{...oblivious, name: "Oblivious (Remastered 2001)"}], [], [karaoke])[0]).toBe("tracks");
});
test("album plus credited artist also contributes to section intent", () => {
 expect(categoryOrder("high land hard rain aztec camera", [oblivious], [], [album("original", {title: "High Land, Hard Rain", artist: "Aztec Camera"})])[0]).toBe("albums");
});
test("explicit karaoke queries still find karaoke albums", () => {
 expect(categoryOrder("oblivious karaoke", [oblivious], [], [karaoke])[0]).toBe("albums");
});

test("song-and-artist credit leads the artist list", () => {
 const camera = artist("camera", "Camera");
 const aztec = artist("aztec", "Aztec Camera");
 expect(rankArtists([camera, aztec], "oblivious aztec camera", [oblivious])[0]).toEqual(aztec);
 expect(matchingTrackArtist("aztec camera oblivious", [oblivious])).toBe("Aztec Camera");
});
test("artist inference excludes incidental cover credits and title-only ambiguity", () => {
 expect(matchingTrackArtist("oblivious aztec camera", [{name: karaoke.title, artist: karaoke.artist}])).toBeNull();
 expect(matchingTrackArtist("oblivious", [oblivious])).toBeNull();
});

test("a song beats namesake artists regardless of low-ranked artist matches", () => {
 const radiohead = {name: "Paranoid Android (Remastered)", artist: "Radiohead", album: "OK Computer"};
 const tail = Array.from({length: 20}, (_, i) => ({name: `Other song ${i}`, artist: "Paranoid Android", album: "Unrelated"}));
 expect(categoryOrder("paranoid android", [radiohead, ...tail], [artist("namesake", "Paranoid Android")], [album("single", {title: "Paranoid Android", artist: "Radiohead"})])[0]).toBe("tracks");
 expect(rankArtists([artist("namesake", "Paranoid Android"), artist("radiohead", "Radiohead")], "paranoid android", [radiohead])[0].name).toBe("Radiohead");
});
test("album context follows the leading song instead of karaoke keyword stuffing", () => {
 const original = album("original", {title: "High Land, Hard Rain", artist: "Aztec Camera"});
 expect(rankAlbums([karaoke, original], "oblivious aztec camera", [oblivious])[0]).toEqual(original);
});
test("artist intent survives a same-named album and unrelated song matches", () => {
 expect(categoryOrder("oceansize", [{name: "Music For A Nurse", artist: "Oceansize", album: "Everyone Into Position"}, {name: "Oceansize", artist: "Oh Wonder", album: "Oceansize"}], [artist("o", "Oceansize")], [album("o", {title: "Oceansize", artist: "Oh Wonder"})])[0]).toBe("artists");
});
test("album intent is supported by a leading track from that album", () => {
 expect(categoryOrder("heroes and villains", [{name: "Superhero", artist: "Metro Boomin", album: "HEROES & VILLAINS"}], [artist("h", "Heroes and Villains")], [album("h")])[0]).toBe("albums");
});
test("different remaster label formats preserve song intent", () => {
 for (const name of ["Paranoid Android (Remastered)", "Paranoid Android - 2017 Remaster", "Paranoid Android [2017 Remastered]"]) {
  expect(categoryOrder("paranoid android", [{name, artist: "Radiohead", album: "OK Computer"}], [artist("p", "Paranoid Android")], [])[0]).toBe("tracks");
 }
});

test("native album evidence survives song-title reranking across services", () => {
 const albumTracks = ["Paranoid Android", "No Surprises", "Karma Police"].map(name => ({name, artist: "Radiohead", album: "OK Computer OKNOTOK 1997 2017", provider: "qobuz"}));
 const namesake = {name: "Ok Computer", artist: "Lemaitre", album: "Ok Computer", provider: "tidal"};
 expect(categoryOrder("ok computer", [namesake, ...albumTracks], [artist("ok", "Ok Computer")], [album("ok", {title: "OK Computer", artist: "Radiohead"})], [...albumTracks, namesake])[0]).toBe("albums");
});
test("higher audio resolution cannot promote an unrelated equally matching album", () => {
 const nativeFirst = album("first", {artist: "First Artist", explicit: false, maximumBitDepth: 16});
 const nativeSecond = album("second", {artist: "Second Artist", explicit: true, maximumBitDepth: 24});
 expect(rankAlbums([nativeFirst, nativeSecond], "heroes and villains")[0]).toEqual(nativeFirst);
});
test("artist searches rank that artist's albums ahead of unrelated same-title releases", () => {
 const own = album("own", {title: "Effloresce", artist: "Oceansize"});
 const unrelated = album("other", {title: "Oceansize", artist: "Oh Wonder"});
 expect(rankAlbums([unrelated, own], "oceansize", [{name: "Catalyst", artist: "Oceansize", album: "Effloresce"}])[0]).toEqual(own);
});
