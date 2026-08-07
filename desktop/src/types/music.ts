export type MusicProvider =
  | "local"
  | "tidal"
  | "qobuz"
  | "spotify"
  | "youtubeMusic";

export type TrackArtist = {
  providerId: string;
  name: string;
};

export type PlaybackKind = "direct" | "dash";

export type Track = {
  id: string;
  provider: MusicProvider;
  providerTrackId: string;
  playbackKind: PlaybackKind;
  audio: string;
  cover: string;
  nativeCover: string | null;
  name: string;
  album: string;
  albumId: string | null;
  artist: string;
  artists: TrackArtist[];
  trackNumber: number | null;
  discNumber: number | null;
  durationSeconds: number;
  releaseDate: string | null;
  explicit: boolean;
  isrc: string | null;
  quality: string | null;
};

export type ScannedTrack = {
  audio: string;
  cover: string | null;
  name: string;
  album: string;
  artist: string;
  trackNumber: number | null;
  durationSeconds: number;
};

export type Deck = 0 | 1;
