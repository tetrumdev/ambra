import type {
  QueueHistoryEntry,
  QueueItem,
  QueueSource,
  Track,
} from "../types/music";

const QUEUE_STORAGE_KEY = "ambra.queue.v1";

type PersistedQueueItem = {
  globalTrackId: string;
  source: QueueSource;
  shufflePackageId: string | null;
};

type PersistedHistoryEntry = PersistedQueueItem & {
  historyId: string;
  playedAt: string;
};

export type PersistedQueue = {
  version: 1;
  history: PersistedHistoryEntry[];
  current: PersistedQueueItem | null;
  upcoming: PersistedQueueItem[];
};

export type RestoredQueue = {
  history: QueueHistoryEntry[];
  current: QueueItem | null;
  upcoming: QueueItem[];
};

function persistedItem(item: QueueItem): PersistedQueueItem {
  return {
    globalTrackId: item.track.globalId,
    source: item.source,
    shufflePackageId: item.shufflePackageId,
  };
}

export function queueSnapshot(
  history: QueueHistoryEntry[],
  current: QueueItem | null,
  upcoming: QueueItem[],
): PersistedQueue {
  return {
    version: 1,
    history: history.map((entry) => ({
      ...persistedItem(entry),
      historyId: entry.historyId,
      playedAt: entry.playedAt,
    })),
    current: current ? persistedItem(current) : null,
    upcoming: upcoming.map(persistedItem),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isQueueSource(value: unknown): value is QueueSource {
  if (!isRecord(value)) return false;
  return (
    (value.kind === "library" || value.kind === "playlist") &&
    typeof value.id === "string" &&
    typeof value.entryId === "number" &&
    Number.isFinite(value.entryId)
  );
}

function isPersistedItem(value: unknown): value is PersistedQueueItem {
  if (!isRecord(value)) return false;
  return (
    typeof value.globalTrackId === "string" &&
    isQueueSource(value.source) &&
    (value.shufflePackageId === null ||
      typeof value.shufflePackageId === "string")
  );
}

function isPersistedHistory(value: unknown): value is PersistedHistoryEntry {
  if (!isPersistedItem(value)) return false;
  const history = value as PersistedQueueItem & Record<string, unknown>;
  return (
    typeof history.historyId === "string" &&
    typeof history.playedAt === "string"
  );
}

export function parseQueueSnapshot(value: string | null): PersistedQueue | null {
  if (value === null) return null;

  try {
    const parsed = JSON.parse(value) as unknown;
    if (!isRecord(parsed) || parsed.version !== 1) return null;
    if (!Array.isArray(parsed.history) || !parsed.history.every(isPersistedHistory)) {
      return null;
    }
    if (
      parsed.current !== null &&
      !isPersistedItem(parsed.current)
    ) {
      return null;
    }
    if (!Array.isArray(parsed.upcoming) || !parsed.upcoming.every(isPersistedItem)) {
      return null;
    }

    return parsed as PersistedQueue;
  } catch {
    return null;
  }
}

export function resolveQueueSnapshot(
  snapshot: PersistedQueue,
  tracks: Track[],
): RestoredQueue {
  const tracksById = new Map(tracks.map((track) => [track.globalId, track]));
  const resolveItem = (item: PersistedQueueItem): QueueItem | null => {
    const track = tracksById.get(item.globalTrackId);
    return track
      ? {
          track,
          source: item.source,
          shufflePackageId: item.shufflePackageId,
        }
      : null;
  };

  const history = snapshot.history.flatMap((entry) => {
    const item = resolveItem(entry);
    return item
      ? [{ ...item, historyId: entry.historyId, playedAt: entry.playedAt }]
      : [];
  });
  const current = snapshot.current ? resolveItem(snapshot.current) : null;
  const upcoming = snapshot.upcoming.flatMap((entry) => {
    const item = resolveItem(entry);
    return item ? [item] : [];
  });

  return { history, current, upcoming };
}

export function loadQueueSnapshot() {
  try {
    return parseQueueSnapshot(localStorage.getItem(QUEUE_STORAGE_KEY));
  } catch (error) {
    console.warn("Could not load saved queue:", error);
    return null;
  }
}

export function saveQueueSnapshot(snapshot: PersistedQueue) {
  try {
    localStorage.setItem(QUEUE_STORAGE_KEY, JSON.stringify(snapshot));
  } catch (error) {
    console.warn("Could not save queue:", error);
  }
}
