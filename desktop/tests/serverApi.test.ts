import { describe, expect, test } from "bun:test";
import { playableTrack, type RemoteTrack } from "../src/api/server";

const spotifyTrack: RemoteTrack = {
  id: "spotify:4uLU6hMCjMI75M1A2tKUQC",
  provider: "spotify",
  providerTrackId: "4uLU6hMCjMI75M1A2tKUQC",
  title: "Never Gonna Give You Up",
  version: null,
  primaryArtist: {
    providerId: "0gxyHStUsqpMadRV0Di1Qt",
    name: "Rick Astley",
    imageUrl: "https://i.scdn.co/image/artist",
  },
  artists: [
    {
      providerId: "0gxyHStUsqpMadRV0Di1Qt",
      name: "Rick Astley",
      imageUrl: "https://i.scdn.co/image/artist",
    },
  ],
  album: {
    providerId: "6eUW0wxWtzkFdaEFsTJto6",
    title: "Whenever You Need Somebody",
    version: null,
    artists: [
      {
        providerId: "0gxyHStUsqpMadRV0Di1Qt",
        name: "Rick Astley",
        imageUrl: "https://i.scdn.co/image/artist",
      },
    ],
    coverUrl: "https://i.scdn.co/image/cover",
    releaseDate: "1987-11-16",
    label: "RCA Records",
    genres: ["pop"],
    upc: "196871067880",
  },
  durationSeconds: 213,
  trackNumber: 1,
  discNumber: 1,
  explicit: false,
  isrc: "GBARL9300135",
  copyright: "1987 RCA Records",
  quality: "Ogg Vorbis 320 kbps",
  maximumSamplingRateKHz: 44.1,
  maximumBitDepth: null,
  playback: {
    kind: "direct",
    url: "/api/providers/spotify/tracks/4uLU6hMCjMI75M1A2tKUQC/stream",
  },
};

describe("playableTrack", () => {
  test("maps provider-neutral Spotify artwork, artist, album, and metadata", () => {
    const track = playableTrack(spotifyTrack);

    expect(track.provider).toBe("spotify");
    expect(track.cover).toBe("https://i.scdn.co/image/cover");
    expect(track.nativeCover).toBe("https://i.scdn.co/image/cover");
    expect(track.artist).toBe("Rick Astley");
    expect(track.artists).toEqual(spotifyTrack.artists);
    expect(track.album).toBe("Whenever You Need Somebody");
    expect(track.albumArtists).toEqual(spotifyTrack.album!.artists);
    expect(track.releaseDate).toBe("1987-11-16");
    expect(track.isrc).toBe("GBARL9300135");
    expect(track.quality).toBe("Ogg Vorbis 320 kbps");
    expect(track.audio).toEndWith(spotifyTrack.playback.url);
  });
});
