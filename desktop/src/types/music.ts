export type Track = {
  id: string;
  audio: string;
  cover: string;
  name: string;
  album: string;
  artist: string;
  trackNumber: number | null;
};

export type ScannedTrack = Omit<Track, "id" | "cover"> & {
  cover: string | null;
};

export type Deck = 0 | 1;
