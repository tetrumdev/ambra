export type MusicProvider =
  | "local"
  | "tidal"
  | "qobuz"
  | "spotify"
  | "youtubeMusic";

export type TrackArtist = {
  providerId: string;
  name: string;
  imageUrl: string | null;
};

export type PlaybackKind = "direct" | "dash";

export type GlobalTrackId = string;
export type LibraryTrackId = number;
export type QueueId = number;

export type Track = {
  globalId: GlobalTrackId;
  provider: MusicProvider;
  providerTrackId: string;
  playbackKind: PlaybackKind;
  audio: string;
  cover: string;
  nativeCover: string | null;
  name: string;
  version: string | null;
  album: string;
  albumVersion: string | null;
  albumId: string | null;
  albumArtists: TrackArtist[];
  artist: string;
  artists: TrackArtist[];
  trackNumber: number | null;
  discNumber: number | null;
  durationSeconds: number;
  releaseDate: string | null;
  explicit: boolean;
  isrc: string | null;
  copyright: string | null;
  label: string | null;
  genres: string[];
  upc: string | null;
  quality: string | null;
  maximumSamplingRateKHz: number | null;
  maximumBitDepth: number | null;
};

export type LibraryTrack = Track & {
  libraryId: LibraryTrackId;
};

export type QueueEntry = {
  queueId: QueueId;
  track: LibraryTrack;
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
