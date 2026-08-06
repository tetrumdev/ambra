export type Track = {
  audio: string;
  cover: string;
  name: string;
  album: string;
  artist: string;
  trackNumber: number | null;
};

export type ScannedTrack = Omit<Track, "cover"> & {
  cover: string | null;
};

export type Deck = 0 | 1;
