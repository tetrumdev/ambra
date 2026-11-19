type PositionedTrack = {
  globalId: string;
  discNumber: number | null;
  trackNumber: number | null;
};

type TrackList = readonly { globalId: string }[];
// Native status samples look up the same song several times a second. Keep one lookup
// per immutable list so a large library needs neither a scan per sample nor a full index.
const lastPosition = new WeakMap<TrackList, { id: string; index: number }>();

export function trackPosition(
  tracks: TrackList,
  trackId: string | null,
) {
  if (trackId === null) return -1;
  const previous = lastPosition.get(tracks);
  if (previous?.id === trackId) return previous.index;
  const index = tracks.findIndex((track) => track.globalId === trackId);
  lastPosition.set(tracks, { id: trackId, index });
  return index;
}

export function moveAlbumToEndInOrder<T extends PositionedTrack>(
  currentTracks: T[],
  incomingTracks: T[],
) {
  const orderedTracks = [...incomingTracks].sort((left, right) =>
    (left.discNumber ?? 1) - (right.discNumber ?? 1) ||
    (left.trackNumber ?? Number.MAX_SAFE_INTEGER) -
      (right.trackNumber ?? Number.MAX_SAFE_INTEGER),
  );
  const incomingIds = new Set(orderedTracks.map((track) => track.globalId));
  return [
    ...currentTracks.filter((track) => !incomingIds.has(track.globalId)),
    ...orderedTracks,
  ];
}
