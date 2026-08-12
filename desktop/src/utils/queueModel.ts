import type {
  GlobalTrackId,
  LibraryTrack,
  QueueContext,
  QueueItem,
  Track,
} from "../types/music";

export function libraryQueueContext(tracks: LibraryTrack[]): QueueContext {
  return {
    source: { kind: "library", id: "library" },
    entries: tracks.map((track) => ({
      track,
      source: {
        kind: "library",
        id: "library",
        entryId: track.libraryId,
      },
      shufflePackageId: null,
    })),
  };
}

export function searchQueueContext(tracks: Track[], id: string): QueueContext {
  return {
    source: { kind: "search", id },
    entries: tracks.map((track, index) => ({
      track,
      source: {
        kind: "search",
        id,
        entryId: index + 1,
      },
      shufflePackageId: null,
    })),
  };
}

export function contextEntry(
  context: QueueContext,
  trackId: GlobalTrackId,
) {
  return context.entries.find((entry) => entry.track.globalId === trackId);
}

export function contextEntriesFrom(
  context: QueueContext,
  trackId: GlobalTrackId,
) {
  const startIndex = context.entries.findIndex(
    (entry) => entry.track.globalId === trackId,
  );
  return startIndex < 0 ? [] : context.entries.slice(startIndex);
}

export function shuffledContextEntries(
  entries: QueueItem[],
  random: () => number = Math.random,
) {
  const units: QueueItem[][] = [];
  const packages = new Map<string, QueueItem[]>();

  for (const entry of entries) {
    const packageId = entry.shufflePackageId;
    if (packageId === null) {
      units.push([entry]);
      continue;
    }

    const existingPackage = packages.get(packageId);
    if (existingPackage) {
      existingPackage.push(entry);
      continue;
    }

    const newPackage = [entry];
    packages.set(packageId, newPackage);
    units.push(newPackage);
  }

  for (let index = units.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [units[index], units[swapIndex]] = [units[swapIndex], units[index]];
  }

  return units.flat();
}
