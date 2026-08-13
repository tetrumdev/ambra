import type { QueueHistoryEntry, QueueId, QueueItem } from "../types/music";

export type QueueState = {
  history: QueueHistoryEntry[];
  current: QueueItem | null;
  upcoming: QueueItem[];
};

export type QueueTransition = {
  state: QueueState;
  item: QueueItem | undefined;
};

export type QueueRemovalTransition = QueueTransition & {
  currentRemoved: boolean;
};

export function removeQueueEntries(
  state: QueueState,
  queueIds: ReadonlySet<QueueId>,
): QueueRemovalTransition {
  if (queueIds.size === 0 || state.current === null) {
    return { state, item: state.current ?? undefined, currentRemoved: false };
  }

  const currentRemoved = queueIds.has(1);
  const upcoming = state.upcoming.filter(
    (_, index) => !queueIds.has(index + 2),
  );
  if (!currentRemoved) {
    return {
      state: { ...state, upcoming },
      item: state.current,
      currentRemoved: false,
    };
  }

  const current = upcoming[0] ?? null;
  return {
    state: {
      ...state,
      current,
      upcoming: upcoming.slice(1),
    },
    item: current ?? undefined,
    currentRemoved: true,
  };
}

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
