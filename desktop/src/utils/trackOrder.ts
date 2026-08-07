type PositionedTrack = {
  id: string;
  discNumber: number | null;
  trackNumber: number | null;
};

export function trackPosition(
  tracks: readonly { id: string }[],
  trackId: string | null,
) {
  return tracks.findIndex((track) => track.id === trackId);
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
  const incomingIds = new Set(orderedTracks.map((track) => track.id));
  return [
    ...currentTracks.filter((track) => !incomingIds.has(track.id)),
    ...orderedTracks,
  ];
}
