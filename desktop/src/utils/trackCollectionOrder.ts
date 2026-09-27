import type { GlobalTrackId, Track } from "../types/music";

export type TrackSortKey = "track" | "artist" | "album" | "duration";
export type TrackSortDirection = "descending" | "ascending";
export type TrackSort = {
  key: TrackSortKey;
  direction: TrackSortDirection;
} | null;

export type DropPosition = "before" | "after";

const textCollator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});

export function nextTrackSort(
  current: TrackSort,
  key: TrackSortKey,
): TrackSort {
  if (current?.key !== key) return { key, direction: "descending" };
  if (current.direction === "descending") {
    return { key, direction: "ascending" };
  }
  return null;
}

export function sortCollectionTracks<T extends Track>(
  tracks: T[],
  sort: TrackSort,
): T[] {
  if (!sort) return tracks;

  const value = (track: Track): string | number => {
    switch (sort.key) {
      case "track":
        return track.name;
      case "artist":
        return track.artist;
      case "album":
        return track.album;
      case "duration":
        return track.durationSeconds;
    }
  };
  // Down means reading A–Z / low–high from the top of the list.
  const direction = sort.direction === "descending" ? 1 : -1;

  return tracks
    .map((track, index) => ({ track, index }))
    .sort((left, right) => {
      const leftValue = value(left.track);
      const rightValue = value(right.track);
      const comparison =
        typeof leftValue === "number" && typeof rightValue === "number"
          ? leftValue - rightValue
          : textCollator.compare(String(leftValue), String(rightValue));
      return comparison * direction || left.index - right.index;
    })
    .map(({ track }) => track);
}

export function moveTrackId(
  trackIds: GlobalTrackId[],
  draggedId: GlobalTrackId,
  targetId: GlobalTrackId,
  position: DropPosition,
): GlobalTrackId[] {
  if (draggedId === targetId) return trackIds;
  const withoutDragged = trackIds.filter((id) => id !== draggedId);
  const targetIndex = withoutDragged.indexOf(targetId);
  if (targetIndex < 0 || withoutDragged.length === trackIds.length) {
    return trackIds;
  }
  const insertionIndex = targetIndex + (position === "after" ? 1 : 0);
  return [
    ...withoutDragged.slice(0, insertionIndex),
    draggedId,
    ...withoutDragged.slice(insertionIndex),
  ];
}

export function mergeVisibleTrackOrder(
  storedIds: GlobalTrackId[],
  orderedVisibleIds: GlobalTrackId[],
): GlobalTrackId[] {
  const visibleIds = [...new Set(orderedVisibleIds)];
  const visibleSet = new Set(visibleIds);
  let visibleIndex = 0;
  const merged = storedIds.map((id) =>
    visibleSet.has(id) ? visibleIds[visibleIndex++] : id,
  );
  return [...merged, ...visibleIds.slice(visibleIndex)];
}
