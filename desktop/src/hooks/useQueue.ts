import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  GlobalTrackId,
  QueueContext,
  QueueEntry,
  QueueHistoryEntry,
  QueueItem,
  QueueId,
  Track,
} from "../types/music";
import { contextEntriesFrom, contextEntry, shuffledContextEntries } from "../utils/queueModel";
import {
  loadQueueSnapshot,
  queueSnapshot,
  resolveQueueSnapshot,
  saveQueueSnapshot,
} from "../utils/queueStorage";
import {
  advanceQueue,
  completeQueueTrack,
  jumpQueue,
  refreshQueueTracks,
  replayQueueHistory,
  reorderQueue,
  removeQueueEntries,
  removeQueueHistory,
  rewindQueue,
  type QueueEntryRef,
  type QueueState,
} from "../utils/queueNavigation";

export type QueueController = {
  historyEntries: QueueHistoryEntry[];
  entries: QueueEntry[];
  currentEntry: QueueEntry | undefined;
  upcomingEntries: QueueEntry[];
  isRestored: boolean;
  playFromContext: (
    context: QueueContext,
    startTrackId: GlobalTrackId,
  ) => QueueItem | undefined;
  playStandalone: (entry: QueueItem) => void;
  addToQueue: (entry: QueueItem) => void;
  playNext: (entry: QueueItem) => void;
  shuffleContext: (context: QueueContext) => QueueItem | undefined;
  addShuffledToQueue: (context: QueueContext) => void;
  next: () => QueueItem | undefined;
  completeCurrent: () => QueueItem | undefined;
  previous: () => QueueItem | undefined;
  jumpTo: (queueId: number) => QueueItem | undefined;
  replayHistory: (historyId: string) => QueueItem | undefined;
  reorderEntries: (history: QueueEntryRef[], upcoming: QueueEntryRef[]) => void;
  removeHistoryEntries: (historyIds: string[]) => void;
  removeEntries: (queueIds: QueueId[]) => {
    currentRemoved: boolean;
    item: QueueItem | undefined;
  };
  peekNext: () => QueueItem | undefined;
};

const emptyQueue: QueueState = {
  history: [],
  current: null,
  upcoming: [],
};

/** The queue keeps only recent plays to step back through; every play stays in the listening history on Home. */
const MAX_HISTORY = 100;

function keepRecentHistory(state: QueueState): QueueState {
  return state.history.length > MAX_HISTORY ? { ...state, history: state.history.slice(-MAX_HISTORY) } : state;
}

let historySequence = 0;

function historyEntry(item: QueueItem): QueueHistoryEntry {
  historySequence += 1;
  return {
    ...item,
    historyId: `${Date.now()}-${historySequence}`,
    playedAt: new Date().toISOString(),
  };
}

function replaceActiveQueue(state: QueueState, entries: QueueItem[]): QueueState {
  const history = state.current
    ? [...state.history, historyEntry(state.current)]
    : state.history;

  return {
    history,
    current: entries[0] ?? null,
    upcoming: entries.slice(1),
  };
}

export function useQueue(
  availableTracks: Track[],
  restoredTrackId: GlobalTrackId | null,
  ready: boolean,
): QueueController {
  const [state, setState] = useState<QueueState>(emptyQueue);
  const [isRestored, setIsRestored] = useState(false);
  const stateRef = useRef<QueueState>(emptyQueue);
  const restoreAttemptedRef = useRef(false);
  const restoredTrackIdRef = useRef(restoredTrackId);

  const commitState = useCallback((committed: QueueState) => {
    const nextState = keepRecentHistory(committed);
    saveQueueSnapshot(queueSnapshot(nextState.history, nextState.current, nextState.upcoming));
    stateRef.current = nextState;
    setState(nextState);
  }, []);

  useEffect(() => {
    if (restoreAttemptedRef.current || !ready) return;
    restoreAttemptedRef.current = true;

    const savedQueue = loadQueueSnapshot();
    const restored = savedQueue
      ? resolveQueueSnapshot(savedQueue, availableTracks)
      : emptyQueue;

    if (restored.current === null && restoredTrackIdRef.current !== null) {
      const restoredTrackIndex = availableTracks.findIndex(
        (track) => track.globalId === restoredTrackIdRef.current,
      );
      const restoredTrack = availableTracks[restoredTrackIndex];
      if (restoredTrack) {
        restored.current = {
          track: restoredTrack,
          source: {
            kind: "library",
            id: "library",
            entryId: restoredTrackIndex + 1,
          },
          shufflePackageId: null,
        };
      }
    }

    // Restoring on a machine without some local files must not erase their IDs
    // from the server. Persist only subsequent queue actions.
    const trimmed = keepRecentHistory(restored);
    stateRef.current = trimmed;
    setState(trimmed);
    setIsRestored(true);
  }, [availableTracks, ready]);

  useEffect(() => {
    if (!isRestored) return;
    const refreshed = refreshQueueTracks(stateRef.current, availableTracks);
    if (refreshed !== stateRef.current) {
      stateRef.current = refreshed;
      setState(refreshed);
    }
  }, [availableTracks, isRestored]);

  const playFromContext = useCallback(
    (context: QueueContext, startTrackId: GlobalTrackId) => {
      const entries = contextEntriesFrom(context, startTrackId);
      if (entries.length === 0) return undefined;
      commitState(replaceActiveQueue(stateRef.current, entries));
      return entries[0];
    },
    [commitState],
  );

  const playStandalone = useCallback((entry: QueueItem) => {
    commitState(replaceActiveQueue(stateRef.current, [entry]));
  }, [commitState]);

  const addToQueue = useCallback((entry: QueueItem) => {
    const current = stateRef.current;
    commitState(
      current.current
        ? { ...current, upcoming: [...current.upcoming, entry] }
        : { ...current, current: entry },
    );
  }, [commitState]);

  const playNext = useCallback((entry: QueueItem) => {
    const current = stateRef.current;
    commitState(
      current.current
        ? { ...current, upcoming: [entry, ...current.upcoming] }
        : { ...current, current: entry },
    );
  }, [commitState]);

  const shuffleContext = useCallback((context: QueueContext) => {
    const shuffled = shuffledContextEntries(context.entries);
    if (shuffled.length === 0) return undefined;
    commitState(replaceActiveQueue(stateRef.current, shuffled));
    return shuffled[0];
  }, [commitState]);

  const addShuffledToQueue = useCallback((context: QueueContext) => {
    const shuffled = shuffledContextEntries(context.entries);
    if (shuffled.length === 0) return;

    const current = stateRef.current;
    commitState(
      current.current === null
        ? {
          ...current,
          current: shuffled[0],
          upcoming: shuffled.slice(1),
        }
        : {
          ...current,
          upcoming: [...current.upcoming, ...shuffled],
        },
    );
  }, [commitState]);

  const next = useCallback(() => {
    const transition = advanceQueue(stateRef.current, historyEntry);
    if (transition.item) commitState(transition.state);
    return transition.item;
  }, [commitState]);

  const completeCurrent = useCallback(() => {
    const transition = completeQueueTrack(stateRef.current, historyEntry);
    if (transition.state !== stateRef.current) commitState(transition.state);
    return transition.item;
  }, [commitState]);

  const previous = useCallback(() => {
    const transition = rewindQueue(stateRef.current);
    if (transition.item) commitState(transition.state);
    return transition.item;
  }, [commitState]);

  const jumpTo = useCallback((queueId: number) => {
    const upcomingIndex = queueId - 2;
    const transition = jumpQueue(stateRef.current, upcomingIndex, historyEntry);
    if (transition.item) commitState(transition.state);
    return transition.item;
  }, [commitState]);

  const removeEntries = useCallback((queueIds: QueueId[]) => {
    const transition = removeQueueEntries(stateRef.current, new Set(queueIds));
    if (transition.state !== stateRef.current) commitState(transition.state);
    return {
      currentRemoved: transition.currentRemoved,
      item: transition.item,
    };
  }, [commitState]);

  const replayHistory = useCallback((historyId: string) => {
    const transition = replayQueueHistory(stateRef.current, historyId);
    if (transition.item) commitState(transition.state);
    return transition.item;
  }, [commitState]);

  const reorderEntries = useCallback((history: QueueEntryRef[], upcoming: QueueEntryRef[]) => {
    const nextState = reorderQueue(stateRef.current, history, upcoming, historyEntry);
    if (nextState !== stateRef.current) commitState(nextState);
  }, [commitState]);

  const removeHistoryEntries = useCallback((historyIds: string[]) => {
    const nextState = removeQueueHistory(stateRef.current, new Set(historyIds));
    if (nextState !== stateRef.current) commitState(nextState);
  }, [commitState]);

  const peekNext = useCallback(
    () => stateRef.current.upcoming[0],
    [],
  );

  const entries = useMemo(
    () =>
      state.current === null
        ? []
        : [state.current, ...state.upcoming].map((entry, index) => ({
            ...entry,
            queueId: index + 1,
          })),
    [state.current, state.upcoming],
  );
  const upcomingEntries = useMemo(() => entries.slice(1), [entries]);

  return {
    historyEntries: state.history,
    entries,
    currentEntry: entries[0],
    upcomingEntries,
    isRestored,
    playFromContext,
    playStandalone,
    addToQueue,
    playNext,
    shuffleContext,
    addShuffledToQueue,
    next,
    completeCurrent,
    previous,
    jumpTo,
    replayHistory,
    reorderEntries,
    removeHistoryEntries,
    removeEntries,
    peekNext,
  };
}

export function queueEntryForTrack(
  context: QueueContext,
  trackId: GlobalTrackId,
) {
  return contextEntry(context, trackId);
}
