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
  removeQueueEntries,
  rewindQueue,
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
): QueueController {
  const [state, setState] = useState<QueueState>(emptyQueue);
  const [isRestored, setIsRestored] = useState(false);
  const stateRef = useRef<QueueState>(emptyQueue);
  const restoreAttemptedRef = useRef(false);
  const restoredTrackIdRef = useRef(restoredTrackId);

  const commitState = useCallback((nextState: QueueState) => {
    stateRef.current = nextState;
    setState(nextState);
  }, []);

  useEffect(() => {
    if (restoreAttemptedRef.current || availableTracks.length === 0) return;
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

    commitState(restored);
    setIsRestored(true);
  }, [availableTracks, commitState]);

  useEffect(() => {
    if (!isRestored) return;
    saveQueueSnapshot(
      queueSnapshot(state.history, state.current, state.upcoming),
    );
  }, [isRestored, state]);

  useEffect(() => {
    if (!isRestored) return;
    const refreshed = refreshQueueTracks(stateRef.current, availableTracks);
    if (refreshed !== stateRef.current) commitState(refreshed);
  }, [availableTracks, commitState, isRestored]);

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

  return {
    historyEntries: state.history,
    entries,
    currentEntry: entries[0],
    upcomingEntries: entries.slice(1),
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
