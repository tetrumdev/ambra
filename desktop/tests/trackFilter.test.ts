import { describe, expect, test } from "bun:test";
import type { Track } from "../src/types/music";
import { filterTerms, trackMatches } from "../src/utils/trackFilter";

const track = (name: string, artist: string, album: string): Track => ({
  name, artist, album, version: null, albumVersion: null, releaseDate: null, genres: [], label: null, quality: null,
  artists: [{ providerId: "", name: artist, imageUrl: null }], albumArtists: [],
} as unknown as Track);

const matches = (query: string, songs: Track[]) => songs.filter(song => trackMatches(song, filterTerms(query))).map(song => song.name);

describe("page filter", () => {
  const songs = [
    track("Black Hole Sun", "Soundgarden", "Superunknown"),
    track("Black", "Pearl Jam", "Ten"),
    track("Paint It, Black", "The Rolling Stones", "Forty Licks"),
    track("Blackest Eyes", "Porcupine Tree", "In Absentia"),
    track("Bigmouth Strikes Again", "The Smiths", "The Queen Is Dead"),
  ];

  test("each term finds the start of a word, not any letters inside one", () => {
    expect(matches("black h", songs)).toEqual(["Black Hole Sun"]);
    expect(matches("black ho", songs)).toEqual(["Black Hole Sun"]);
    expect(matches("black", songs)).toEqual(["Black Hole Sun", "Black", "Paint It, Black", "Blackest Eyes"]);
    expect(matches("mouth", songs)).toEqual([]);
  });

  test("words after punctuation, and accents, still match", () => {
    expect(matches("black paint", songs)).toEqual(["Paint It, Black"]);
    expect(matches("rolling", [track("Gimme Shelter", "The Rolling Stones", "Let It Bleed")])).toEqual(["Gimme Shelter"]);
    expect(matches("beyonce", [track("Halo", "Beyoncé", "I Am... Sasha Fierce")])).toEqual(["Halo"]);
    expect(matches("dc", [track("Thunderstruck", "AC/DC", "The Razors Edge")])).toEqual(["Thunderstruck"]);
  });
});
