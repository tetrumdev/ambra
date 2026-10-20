import type {
  QueueHistoryEntry,
  QueueId,
  QueueItem,
  Track,
} from "../types/music";

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

export function refreshQueueTracks(
  state: QueueState,
  availableTracks: Track[],
): QueueState {
  const tracksById = new Map(
    availableTracks.map((track) => [track.globalId, track]),
  );
  const refresh = <Entry extends QueueItem>(entry: Entry): Entry => {
    const track = tracksById.get(entry.track.globalId);
    return track && track !== entry.track ? { ...entry, track } : entry;
  };
  const history = state.history.map(refresh);
  const current = state.current ? refresh(state.current) : null;
  const upcoming = state.upcoming.map(refresh);
  const changed =
    current !== state.current ||
    history.some((entry, index) => entry !== state.history[index]) ||
    upcoming.some((entry, index) => entry !== state.upcoming[index]);

  return changed ? { history, current, upcoming } : state;
}

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

export function replayQueueHistory(state: QueueState, historyId: string): QueueTransition {
  const index = state.history.findIndex(entry => entry.historyId === historyId);
  const entry = state.history[index];
  if (!entry) return { state, item: undefined };
  const item = asItem(entry);
  return {
    state: {
      history: state.history.slice(0, index),
      current: item,
      upcoming: [
        ...state.history.slice(index + 1).map(asItem),
        ...(state.current ? [state.current] : []),
        ...state.upcoming,
      ],
    },
    item,
  };
}

const asItem = ({ track, source, shufflePackageId }: QueueItem): QueueItem => ({ track, source, shufflePackageId });

/** A played entry by its history ID, or an upcoming one by its queue position. */
export type QueueEntryRef = { historyId: string } | { queueId: QueueId };

/**
 * Lays out history and upcoming anew around the current track. Entries may cross over:
 * an upcoming one moved behind the current track joins the history, and a played one
 * moved ahead of it is queued again.
 */
export function reorderQueue(
  state: QueueState,
  historyRefs: readonly QueueEntryRef[],
  upcomingRefs: readonly QueueEntryRef[],
  archive: (item: QueueItem) => QueueHistoryEntry,
): QueueState {
  const refs = [...historyRefs, ...upcomingRefs];
  const keys = refs.map(ref => "historyId" in ref ? `h:${ref.historyId}` : `q:${ref.queueId}`);
  if (refs.length !== state.history.length + state.upcoming.length || new Set(keys).size !== keys.length) return state;
  const played = new Map(state.history.map(entry => [entry.historyId, entry]));
  const resolve = (ref: QueueEntryRef) => "historyId" in ref ? played.get(ref.historyId) : state.upcoming[ref.queueId - 2];
  if (refs.some(ref => !resolve(ref))) return state;
  const history = historyRefs.map(ref => "historyId" in ref ? played.get(ref.historyId)! : archive(resolve(ref)!));
  const upcoming = upcomingRefs.map(ref => "queueId" in ref ? resolve(ref)! : asItem(resolve(ref)!));
  if (
    history.length === state.history.length
    && history.every((entry, index) => entry === state.history[index])
    && upcoming.every((entry, index) => entry === state.upcoming[index])
  ) return state;
  return { ...state, history, upcoming };
}

export function removeQueueHistory(state: QueueState, historyIds: ReadonlySet<string>): QueueState {
  const history = state.history.filter(entry => !historyIds.has(entry.historyId));
  return history.length === state.history.length ? state : { ...state, history };
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
