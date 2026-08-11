import type { QueueHistoryEntry, QueueItem } from "../types/music";

export type QueueState = {
  history: QueueHistoryEntry[];
  current: QueueItem | null;
  upcoming: QueueItem[];
};

export type QueueTransition = {
  state: QueueState;
  item: QueueItem | undefined;
};

export function advanceQueue(
  state: QueueState,
  archive: (item: QueueItem) => QueueHistoryEntry,
): QueueTransition {
  const nextItem = state.upcoming[0];
  if (!state.current || !nextItem) return { state, item: undefined };

  return {
    state: {
      history: [...state.history, archive(state.current)],
      current: nextItem,
      upcoming: state.upcoming.slice(1),
    },
    item: nextItem,
  };
}

export function completeQueueTrack(
  state: QueueState,
  archive: (item: QueueItem) => QueueHistoryEntry,
): QueueTransition {
  const advanced = advanceQueue(state, archive);
  if (advanced.item || !state.current) return advanced;

  return {
    state: {
      history: [...state.history, archive(state.current)],
      current: null,
      upcoming: [],
    },
    item: undefined,
  };
}

export function rewindQueue(state: QueueState): QueueTransition {
  const previousEntry = state.history[state.history.length - 1];
  if (!previousEntry) return { state, item: undefined };

  const previousItem: QueueItem = {
    track: previousEntry.track,
    source: previousEntry.source,
    shufflePackageId: previousEntry.shufflePackageId,
  };

  return {
    state: {
      history: state.history.slice(0, -1),
      current: previousItem,
      upcoming: state.current
        ? [state.current, ...state.upcoming]
        : state.upcoming,
    },
    item: previousItem,
  };
}

export function jumpQueue(
  state: QueueState,
  upcomingIndex: number,
  archive: (item: QueueItem) => QueueHistoryEntry,
): QueueTransition {
  const item = state.upcoming[upcomingIndex];
  if (!state.current || !item || upcomingIndex < 0) {
    return { state, item: undefined };
  }

  const skipped = [state.current, ...state.upcoming.slice(0, upcomingIndex)];
  return {
    state: {
      history: [...state.history, ...skipped.map(archive)],
      current: item,
      upcoming: state.upcoming.slice(upcomingIndex + 1),
    },
    item,
  };
}
