type PositionedTrack = {
  globalId: string;
  discNumber: number | null;
  trackNumber: number | null;
};

export function trackPosition(
  tracks: readonly { globalId: string }[],
  trackId: string | null,
) {
  return tracks.findIndex((track) => track.globalId === trackId);
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
