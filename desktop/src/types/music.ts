export type MusicProvider = "local" | "tidal" | "qobuz" | "spotify";

export type TrackArtist = {
  providerId: string;
  name: string;
  imageUrl: string | null;
};

export type PlaybackKind = "direct" | "dash";

export type GlobalTrackId = string;
export type LibraryTrackId = number;
export type QueueId = number;
export type QueueSourceEntryId = number;
export type ShufflePackageId = string;

/** Source audio properties reported by the decoder, before output conversion. */
export type AudioQuality = {
  codec: string;
  sampleRateHz: number;
  bitDepth: number | null;
  channels: number;
  bitrateKbps: number | null;
  bitrateIsEstimate: boolean;
  /** The level change volume normalization applies; absent while the song plays unchanged. */
  normalizationGainDb?: number | null;
  captureFormat?: { codec: string; sampleFormat: string; sampleRate: number; channels: number };
  requestedQuality?: string;
  sourceFormatVerified?: boolean;
  playbackBackend?: "librespot" | "soloist";
};

export type Track = {
  globalId: GlobalTrackId;
  /** Verified owner of cached server metadata; absent for device files and legacy entries. */
  serverIdentity?: string;
  provider: MusicProvider;
  providerTrackId: string;
  playbackKind: PlaybackKind;
  audio: string;
  cover: string;
  /** Full-resolution artwork when `cover` is a smaller derived copy (local files). */
  fullCover?: string;
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
  /** Encoded bitrate reported by the playback manifest, when available. */
  bitrateKbps?: number | null;
  maximumSamplingRateKHz: number | null;
  maximumBitDepth: number | null;
};

export type LibraryTrack = Track & {
  libraryId: LibraryTrackId;
};

export type Playlist = {
  id: string;
  name: string;
  trackIds: GlobalTrackId[];
  provider?: Exclude<MusicProvider, "local">;
  remoteId?: string;
  editable?: boolean;
  trackCount?: number;
  /** Consecutive songs bound to always play together, in order, even when shuffled. */
  packages?: GlobalTrackId[][];
};

export type QueueSource = {
  kind: "library" | "playlist" | "search";
  id: string;
  entryId: QueueSourceEntryId;
};

export type QueueItem = {
  track: Track;
  source: QueueSource;
  shufflePackageId: ShufflePackageId | null;
};

export type QueueContext = {
  source: Omit<QueueSource, "entryId">;
  entries: QueueItem[];
};

export type QueueEntry = QueueItem & {
  queueId: QueueId;
};

export type QueueHistoryEntry = QueueItem & {
  historyId: string;
  playedAt: string;
};

export type ScannedTrack = {
  audio: string;
  cover: string | null;
  /** Small derived copy of `cover`, generated in the background. */
  thumbnail?: string | null;
  name: string;
  album: string;
  artist: string;
  trackNumber: number | null;
  durationSeconds: number;
};

export type Deck = 0 | 1;
