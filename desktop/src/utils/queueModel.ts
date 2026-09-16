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

export function searchQueueContext(tracks: Track[], id: string, selectedTrack?: Track): QueueContext {
  // An open result menu can outlive a provider merge. Keep its exact selection
  // actionable even if another edition now represents the recording on screen.
  const selectedTracks = selectedTrack
    ? tracks.some(track => track.globalId === selectedTrack.globalId)
      ? tracks.map(track => track.globalId === selectedTrack.globalId ? selectedTrack : track)
      : [...tracks, selectedTrack]
    : tracks;
  return collectionQueueContext(selectedTracks, { kind: "search", id });
}

export function collectionQueueContext(tracks: Track[], source: QueueContext["source"]): QueueContext {
  return {
    source,
    entries: tracks.map((track, index) => ({
      track,
      source: {
        ...source,
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

export function secureRandom(): number {
  const cryptoObj =
    typeof globalThis !== "undefined" ? globalThis.crypto : undefined;
  if (!cryptoObj?.getRandomValues) return Math.random();
  const buffer = new Uint32Array(2);
  cryptoObj.getRandomValues(buffer);
  const hi = buffer[0] >>> 11;
  const lo = buffer[1];
  return (hi * 0x100000000 + lo) / 0x20000000000000;
}

export function secureRandomInt(bound: number): number {
  if (!Number.isInteger(bound) || bound <= 0) {
    throw new RangeError("bound must be a positive integer");
  }
  if (bound === 1) return 0;
  const cryptoObj =
    typeof globalThis !== "undefined" ? globalThis.crypto : undefined;
  if (!cryptoObj?.getRandomValues) {
    return Math.floor(Math.random() * bound);
  }
  const range = 0x100000000;
  const limit = Math.floor(range / bound) * bound;
  const buffer = new Uint32Array(1);
  let value: number;
  do {
    cryptoObj.getRandomValues(buffer);
    value = buffer[0];
  } while (value >= limit);
  return value % bound;
}

export function shuffledContextEntries(
  entries: QueueItem[],
  random: () => number = secureRandom,
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
    const swapIndex =
      random === secureRandom
        ? secureRandomInt(index + 1)
        : Math.floor(random() * (index + 1));
    [units[index], units[swapIndex]] = [units[swapIndex], units[index]];
  }

  return units.flat();
}
