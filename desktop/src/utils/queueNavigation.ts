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
