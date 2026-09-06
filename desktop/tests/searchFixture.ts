import type { MusicProvider, Track } from "../src/types/music";
export function track(
  globalId: string,
  provider: MusicProvider,
  overrides: Partial<Track> = {},
): Track {
  return {
    globalId,
    provider,
    providerTrackId: globalId.split(":")[1] ?? globalId,
    playbackKind: "direct",
    audio: "",
    cover: "",
    nativeCover: null,
    name: "Deadman",
    version: null,
    album: "Sound Awake",
    albumVersion: null,
    albumId: null,
    albumArtists: [],
    artist: "Karnivool",
    artists: [],
    trackNumber: 7,
    discNumber: 1,
    durationSeconds: 724,
    releaseDate: null,
    explicit: false,
    isrc: "AUKN00900007",
    copyright: null,
    label: null,
    genres: [],
    upc: null,
    quality: null,
    maximumSamplingRateKHz: null,
    maximumBitDepth: null,
    ...overrides,
  };
}

