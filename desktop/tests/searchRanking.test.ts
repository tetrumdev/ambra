import { expect, test } from "bun:test";
import type { Track } from "../src/types/music";
import { groupSearchResults, rankSearchResults } from "../src/utils/searchRanking";

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
  const clean = track("qobuz", "clean", { explicit: false });
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
