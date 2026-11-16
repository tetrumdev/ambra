import { expect, test } from "bun:test";
import type { Track } from "../src/types/music";
import { rankAlbums, rankArtists } from "../src/utils/catalogRanking";
import { queryVariants } from "../src/utils/searchMatch";
import { groupSearchResults, rankSearchGroups, rankSearchResults } from "../src/utils/searchRanking";

function track(provider: Track["provider"], id: string, values: Partial<Track> = {}): Track {
  return {
    globalId: `${provider}:${id}`, provider, providerTrackId: id, playbackKind: "direct",
    audio: "", cover: "", nativeCover: null, name: "Deadly Verses", version: null,
    album: "Deadly Verses", albumVersion: null, albumId: "album", albumArtists: [],
    artist: "Gangsta Pat", artists: [], trackNumber: null, discNumber: null,
    durationSeconds: 216, releaseDate: "1995-05-19", explicit: true, isrc: "US25T9920791",
    copyright: null, label: null, genres: [], upc: null,
    quality: "FLAC 16-bit/44.1 kHz", maximumBitDepth: 16, maximumSamplingRateKHz: 44.1,
    ...values,
  };
}
const spotify = (id: string, values: Partial<Track> = {}) => track("spotify", id, {
  quality: "Ogg Vorbis 320 kbps", maximumBitDepth: null, ...values,
});

test("Deadly Verses leads with its lossless album copy instead of Spotify's Da Dro reissue", () => {
  const lossless = track("qobuz", "5369292", { name: "Deadly Verses (feat. The Villian)" });
  const reissue = spotify("2oQbFp4879XcYaOXQmNHsN", {
    album: "Da Dro", durationSeconds: 215, isrc: "USASN0700794", releaseDate: "2004-01-01",
  });
  const other = track("tidal", "15273357", {
    album: "And Da Street Muthafuckers", isrc: "USTB11200066",
  });
  for (const candidates of [
    [lossless, reissue, other], [reissue, other, lossless], [other, lossless, reissue],
    [lossless, other, reissue], [reissue, lossless, other], [other, reissue, lossless],
  ]) {
    const result = rankSearchResults(candidates, "gangsta pat deadly verses");
    expect(result[0].provider).not.toBe("spotify");
    const recording = groupSearchResults([lossless, reissue], "deadly verses");
    expect(recording).toHaveLength(1);
    expect(recording[0].track.globalId).toBe(lossless.globalId);
  }
});

test("lossless audio wins over release placement for copies of the same recording", () => {
  const album = spotify("album", { album: "Original Album" });
  const compilation = track("qobuz", "compilation", { album: "Greatest Hits" });
  expect(groupSearchResults([album, compilation], "Deadly Verses")[0].track).toBe(compilation);
});

test("bit depth and sample rate win before a release named after the song is penalized", () => {
  const cd = track("tidal", "cd", { album: "Another Album" });
  const highResolution = track("qobuz", "hires", {
    quality: "FLAC 24-bit/96 kHz", maximumBitDepth: 24, maximumSamplingRateKHz: 96,
  });
  expect(groupSearchResults([cd, highResolution], "Deadly Verses")[0].track).toBe(highResolution);
});

test("an equally good original album is not mistaken for a single because its title matches the song", () => {
  const original = track("qobuz", "original");
  const reissue = track("tidal", "reissue", { album: "Da Dro", releaseDate: "2004-01-01" });
  for (const copies of [[original, reissue], [reissue, original]]) {
    expect(groupSearchResults(copies, "Deadly Verses")[0].track).toBe(original);
  }
});

test("quality does not put an unrelated song ahead of the requested artist and title", () => {
  const match = spotify("match");
  const unrelated = track("qobuz", "unrelated", { artist: "Other Artist", isrc: "OTHER" });
  expect(rankSearchResults([unrelated, match], "Gangsta Pat Deadly Verses")[0]).toBe(match);
});

test("an explicitly requested release and explicitness still take precedence", () => {
  const requested = spotify("requested", { album: "Requested Album" });
  const other = track("qobuz", "other", { album: "Other Album" });
  expect(groupSearchResults([other, requested], "Deadly Verses Requested Album")[0].track).toBe(requested);
  // A clean edit is its own audio, with its own ISRC.
  const clean = track("qobuz", "clean", { explicit: false, isrc: "US25T9920792" });
  expect(groupSearchResults([clean, requested], "Deadly Verses")[0].track).toBe(requested);
});

const artist = (name: string) => ({ providerId: "", name, imageUrl: null });

test("one recording credited differently on Spotify joins its lossless copy and does not lead", () => {
  const stone = { name: "Stone Cold", album: "Stonecold / Hold On", isrc: "GBFNM9700001", explicit: false };
  const qobuz = track("qobuz", "stone", { ...stone, artist: "Groove Chronicles (Noodles)", artists: [artist("Groove Chronicles (Noodles)")], durationSeconds: 338 });
  const tidal = track("tidal", "stone", { ...stone, artist: "Groove Chronicles (Noodles)", artists: [artist("Groove Chronicles (Noodles)")], durationSeconds: 337 });
  const lossy = spotify("stone", { ...stone, artist: "groove chronicles", artists: [artist("groove chronicles")], durationSeconds: 337 });
  const holdOn = track("qobuz", "hold", { ...stone, name: "Hold On", isrc: "GBFNM9700002", artist: "Groove Chronicles (Noodles)", artists: [artist("Groove Chronicles (Noodles)")], durationSeconds: 313 });
  const groups = groupSearchResults([lossy, qobuz, tidal, holdOn], "Groove Chronicles - Stone Cold");
  expect(groups).toHaveLength(2);
  const result = rankSearchResults([lossy, qobuz, tidal, holdOn], "Groove Chronicles - Stone Cold");
  expect(result).toHaveLength(2);
  expect(result[0].provider).not.toBe("spotify");
  expect(result[0].name).toBe("Stone Cold");
});

test("a remix crediting its remixers on Spotify joins the copy that credits the lead artist alone", () => {
  const values = { album: "Coming Up For Air (feat. Sarah Whittaker-Gilbey)", isrc: "GBDUE0400307", durationSeconds: 431, explicit: false };
  const qobuz = track("qobuz", "koma", { ...values, name: "Coming Up For Air [feat. Sarah Whittaker-Gilbey] (Koma & Bones Remix)", artist: "Rennie Pilgrem", artists: [artist("Rennie Pilgrem")] });
  const lossy = spotify("koma", { ...values, name: "Coming Up For Air - Koma & Bones Remix",
    artist: "Rennie Pilgrem, Sarah Whittaker-Gilbey, Koma, Bones",
    artists: ["Rennie Pilgrem", "Sarah Whittaker-Gilbey", "Koma", "Bones"].map(artist) });
  const groups = groupSearchResults([lossy, qobuz], "rennie pilgrem coming up for air");
  expect(groups).toHaveLength(1);
  expect(groups[0].track.provider).toBe("qobuz");
});

test("a shared ISRC with no artist in common stays apart", () => {
  const left = track("qobuz", "a", { artists: [artist("Gangsta Pat")] });
  const right = spotify("b", { artist: "Someone Else", artists: [artist("Someone Else")] });
  expect(groupSearchResults([left, right], "deadly verses")).toHaveLength(2);
});

// Search results as the services returned them for the queries below.
const troy = { name: "They Reminisce Over You (T.R.O.Y.)", album: "Mecca And The Soul Brother", isrc: "USEE10000148", durationSeconds: 287, explicit: false, releaseDate: "1992-06-09" };
const peteRock = {
  qobuz: track("qobuz", "troy", { ...troy, artist: "PETE ROCK & C.L. SMOOTH", artists: [artist("PETE ROCK & C.L. SMOOTH")], durationSeconds: 286 }),
  tidal: track("tidal", "troy", { ...troy, artist: "Pete Rock", artists: [artist("Pete Rock"), artist("C.L. SMOOTH")], quality: "FLAC", maximumBitDepth: null, maximumSamplingRateKHz: null }),
  spotify: spotify("troy", { ...troy, artist: "Pete Rock & C.L. Smooth", artists: [artist("Pete Rock & C.L. Smooth")], durationSeconds: 286, explicit: true }),
};
const lullaby = track("qobuz", "lullaby", { name: "They Reminisce Over You  (T.R.O.Y)", artist: "The Lullabeats", artists: [artist("The Lullabeats")],
  album: "90's Hip Hop 4 Babies, Vol. 2", isrc: "FRPZ92203230", durationSeconds: 114, explicit: false,
  quality: "FLAC 24-bit/48 kHz", maximumBitDepth: 24, maximumSamplingRateKHz: 48 });
const cumbia = track("qobuz", "cumbia", { name: "They Reminisce Over You (T.R.O.Y.)", artist: "Quantic", artists: [artist("Quantic"), artist("Los Miticos Del Ritmo")],
  album: "Hip Hop En Cumbia EP", isrc: "GBEUE1002200", durationSeconds: 123, explicit: false });
const instrumental = track("qobuz", "instrumental", { ...troy, name: "They Reminisce over You (T.R.O.Y.)", version: "Instrumental Version",
  artist: "PETE ROCK & C.L. SMOOTH", artists: [artist("PETE ROCK & C.L. SMOOTH")], isrc: "USEE11100364", durationSeconds: 296 });
const takeYouThere = track("tidal", "take", { name: "Take You There", artist: "Pete Rock", artists: [artist("Pete Rock"), artist("C.L. SMOOTH")],
  album: "The Main Ingredient", isrc: "USEE19400168", durationSeconds: 285, explicit: false });

test("a pasted \"Artist – Title (Subtitle)\" finds the song however each service punctuates its credits", () => {
  const found = [instrumental, peteRock.qobuz, peteRock.tidal, takeYouThere, peteRock.spotify, lullaby];
  const groups = rankSearchGroups(found, "Pete Rock & CL Smooth – They Reminisce Over You (T.R.O.Y.)");
  // One song from three services, credited as an act on two and as two artists on the third.
  expect(groups[0].track).toBe(peteRock.qobuz);
  expect(groups[0].alternatives).toHaveLength(3);
  // Its instrumental follows it; another song by the artist and another artist's cover are not it.
  expect(groups.map(group => group.track)).toEqual([peteRock.qobuz, instrumental]);
});

test("a title alone leads with the recording the services agree on, not the best-sounding cover", () => {
  for (const found of [
    [peteRock.qobuz, cumbia, lullaby, peteRock.tidal, peteRock.spotify],
    [lullaby, cumbia, peteRock.spotify, peteRock.tidal, peteRock.qobuz],
  ]) {
    const result = rankSearchResults(found, "They Reminisce Over You (T.R.O.Y.)");
    expect(result[0]).toBe(peteRock.qobuz);
    // A lullaby rendition is a match, and the last one.
    expect(result.at(-1)).toBe(lullaby);
  }
});

test("an unflagged lossless copy of explicit audio is not passed over as a clean edit", () => {
  const group = groupSearchResults([peteRock.spotify, peteRock.qobuz], "they reminisce over you")[0];
  expect(group.track).toBe(peteRock.qobuz);
});

test("an ISRC written with hyphens joins the copy written without", () => {
  const kirk = { name: "Mr Kirk's Nightmare", artist: "4hero", artists: [artist("4hero")], album: "Reinforced Presents Callin For Reinforcements", durationSeconds: 382, explicit: false };
  const lossy = spotify("kirk", { ...kirk, isrc: "GB-SZC-07-00012" });
  const lossless = track("qobuz", "kirk", { ...kirk, isrc: "GBSZC0700012" });
  const groups = rankSearchGroups([lossy, lossless], "4hero mr kirk's nightmare");
  expect(groups).toHaveLength(1);
  expect(groups[0].track).toBe(lossless);
  // "4 hero" and "kirks" are the same words.
  expect(rankSearchResults([lossy, lossless], "4 hero mr kirks nightmare")[0]).toBe(lossless);
});

test("a remix follows the song unless the query asks for it, and a misspelling still finds the song", () => {
  const song = track("qobuz", "song", { name: "Get Lucky", artist: "Daft Punk", artists: [artist("Daft Punk")], album: "Random Access Memories", isrc: "A" });
  const remix = track("tidal", "remix", { name: "Get Lucky (Daft Punk Remix)", artist: "Daft Punk", artists: [artist("Daft Punk")], album: "Get Lucky", isrc: "B", durationSeconds: 630 });
  expect(rankSearchResults([remix, song], "daft punk get lucky")[0]).toBe(song);
  expect(rankSearchResults([song, remix], "daft punk get lucky remix")[0]).toBe(remix);
  expect(rankSearchResults([remix, song], "daft pnuk get lucky (official audio)")[0]).toBe(song);
});

test("results the query's words don't explain keep the services' own order", () => {
  const first = track("tidal", "first", { name: "アイドル", artist: "YOASOBI", artists: [artist("YOASOBI")], isrc: "A" });
  const second = track("tidal", "second", { name: "夜に駆ける", artist: "YOASOBI", artists: [artist("YOASOBI")], isrc: "B" });
  expect(rankSearchResults([first, second], "sad anime opening")).toEqual([first, second]);
});

const catalogArtist = (provider: "qobuz" | "tidal" | "spotify", name: string) => ({ id: `${provider}:${name}`, provider, name, imageUrl: null });
const catalogAlbum = (provider: "qobuz" | "tidal" | "spotify", title: string, by: string) => ({ id: `${provider}:${title}`, provider, title, artist: by, imageUrl: null });

test("artists and albums a service pads its results with are left out", () => {
  const query = "Pete Rock & CL Smooth – They Reminisce Over You (T.R.O.Y.)";
  const songs = [{ name: troy.name, artist: "PETE ROCK & C.L. SMOOTH", album: troy.album }];
  const artists = rankArtists(["Lost Boyz", "Pete Rock", "Camp Lo", "CL Smooth"].map(name => catalogArtist("tidal", name)), query, songs);
  expect(artists.map(found => found.name)).toEqual(["Pete Rock", "CL Smooth"]);
  const albums = rankAlbums([
    catalogAlbum("tidal", "Cabin In The Sky", "De La Soul"), catalogAlbum("tidal", "Mecca And The Soul Brother", "Pete Rock, CL Smooth"),
    catalogAlbum("qobuz", "Mecca And The Soul Brother", "PETE ROCK & C.L. SMOOTH"), catalogAlbum("tidal", "They Reminisce Over You (T.R.O.Y.)", "Pete Rock, C.L. SMOOTH"),
  ], query, songs);
  expect(albums.map(found => found.title)).toEqual(["They Reminisce Over You (T.R.O.Y.)", "Mecca And The Soul Brother"]);
  // One album on two services, whichever way each credits the pair.
  expect(albums[1].versions).toHaveLength(2);
});

test("an artist still being typed is the one the leading songs are by", () => {
  const artists = rankArtists([catalogArtist("qobuz", "KENDRICK LAM"), catalogArtist("tidal", "Kendrick Lamar"), catalogArtist("tidal", "Lamont")],
    "kendrick lam", [{ name: "luther", artist: "Kendrick Lamar", album: "GNX" }]);
  expect(artists.map(found => found.name)).toEqual(["Kendrick Lamar", "KENDRICK LAM"]);
});

test("a service is asked again without the punctuation it may stumble on", () => {
  expect(queryVariants("Pete Rock & CL Smooth – They Reminisce Over You (T.R.O.Y.)")).toEqual([
    "Pete Rock & CL Smooth They Reminisce Over You T.R.O.Y.",
    "Pete Rock & CL Smooth They Reminisce Over You",
    "They Reminisce Over You T.R.O.Y.",
  ]);
  expect(queryVariants("pete rock")).toEqual([]);
});

test("the explicit edit wins over a better-sounding clean one unless the query says clean", () => {
  const explicit = spotify("explicit", { explicit: true });
  const clean = track("qobuz", "clean edit", { explicit: false, isrc: "US25T9920792" });
  for (const copies of [[explicit, clean], [clean, explicit]]) {
    expect(groupSearchResults(copies, "gangsta pat deadly verses")[0].track).toBe(explicit);
    expect(groupSearchResults(copies, "gangsta pat deadly verses clean")[0].track).toBe(clean);
    // "clean" asks for an edit; it is not a word the song has to explain.
    expect(rankSearchResults(copies, "gangsta pat deadly verses clean")).toEqual([clean]);
  }
});
