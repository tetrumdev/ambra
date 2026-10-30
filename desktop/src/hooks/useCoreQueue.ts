import { useCallback, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { GlobalTrackId, QueueContext, QueueItem, QueueId, Track } from "../types/music";
import { coreChangeQueue, coreCommand, coreQueue, coreView, subscribeCore } from "../api/core";
import { contextEntriesFrom, shuffledContextEntries } from "../utils/queueModel";
import {
  advanceQueue,
  jumpQueue,
  removeQueueEntries,
  removeQueueHistory,
  reorderQueue,
  replayQueueHistory,
  rewindQueue,
  type QueueEntryRef,
  type QueueState,
  type QueueTransition,
} from "../utils/queueNavigation";
import type { QueueController } from "./useQueue";

let historySequence = 0;
function historyEntry(item: QueueItem) {
  historySequence += 1;
  return { ...item, historyId: `${Date.now()}-${historySequence}`, playedAt: new Date().toISOString() };
}

function replaceActiveQueue(state: QueueState, entries: QueueItem[]): QueueState {
  return {
    history: state.current ? [...state.history, historyEntry(state.current)] : state.history,
    current: entries[0] ?? null,
    upcoming: entries.slice(1),
  };
}


/**
 * The server's queue, which every device shares. Changes are shown at once and confirmed by
 * the server; moving through it (next, previous, a song ending) is the server's to do.
 */
export function useCoreQueue(availableTracks: Track[]): QueueController {
  const raw = useSyncExternalStore(subscribeCore, coreView);
  const tracksRef = useRef(availableTracks);
  tracksRef.current = availableTracks;
  const confirmed = useMemo(() => coreQueue(availableTracks), [raw?.queue, availableTracks]);
  // A change shown before the server confirms it; dropped once the server's queue moves past it.
  const [optimistic, setOptimistic] = useState<{ state: QueueState; after: number } | null>(null);
  const state = optimistic && confirmed.revision <= optimistic.after ? optimistic.state : confirmed;
  const stateRef = useRef(state);
  stateRef.current = state;

  const change = useCallback((transform: (state: QueueState) => QueueState, playTrackId?: string) => {
    const next = transform(stateRef.current);
    if (next === stateRef.current) return next;
    stateRef.current = next;
    setOptimistic({ state: next, after: coreQueue(tracksRef.current).revision });
    void coreChangeQueue(() => tracksRef.current, transform, playTrackId)
      .catch(error => console.warn("Could not change the queue:", error))
      .finally(() => setOptimistic(current => current?.state === next ? null : current));
    return next;
  }, []);

  const playFromContext = useCallback((context: QueueContext, startTrackId: GlobalTrackId) => {
    const entries = contextEntriesFrom(context, startTrackId);
    if (!entries.length) return undefined;
    change(state => replaceActiveQueue(state, entries));
    return entries[0];
  }, [change]);
  const playStandalone = useCallback((entry: QueueItem) => { change(state => replaceActiveQueue(state, [entry])); }, [change]);
  const addToQueue = useCallback((entry: QueueItem) => {
    change(state => state.current ? { ...state, upcoming: [...state.upcoming, entry] } : { ...state, current: entry });
  }, [change]);
  const playNext = useCallback((entry: QueueItem) => {
    change(state => state.current ? { ...state, upcoming: [entry, ...state.upcoming] } : { ...state, current: entry });
  }, [change]);
  // Shuffled once here, so every retry and every device gets the same order.
  const shuffleContext = useCallback((context: QueueContext) => {
    const shuffled = shuffledContextEntries(context.entries);
    if (!shuffled.length) return undefined;
    change(state => replaceActiveQueue(state, shuffled));
    return shuffled[0];
  }, [change]);
  const addShuffledToQueue = useCallback((context: QueueContext) => {
    const shuffled = shuffledContextEntries(context.entries);
    if (!shuffled.length) return;
    change(state => state.current === null
      ? { ...state, current: shuffled[0], upcoming: shuffled.slice(1) }
      : { ...state, upcoming: [...state.upcoming, ...shuffled] });
  }, [change]);

  // Moving through the queue happens on the server, which knows where playback is; the song it
  // moves to is shown at once, until the server's queue confirms it.
  const move = useCallback((transition: QueueTransition, command: "next" | "previous" | null) => {
    const moved = transition.item ? transition.state : null;
    if (moved) {
      stateRef.current = moved;
      setOptimistic({ state: moved, after: coreQueue(tracksRef.current).revision });
    }
    const settle = () => { if (moved) setOptimistic(current => current?.state === moved ? null : current); };
    // With nothing to ask, the server's own move replaces this one once it hears of it.
    if (command === null) setTimeout(settle, 5000);
    else void coreCommand(command).catch(() => {}).finally(settle);
    return transition.item;
  }, []);
  const next = useCallback((tellServer = true) => move(advanceQueue(stateRef.current, historyEntry), tellServer ? "next" : null), [move]);
  const previous = useCallback(() => move(rewindQueue(stateRef.current), "previous"), [move]);
  const completeCurrent = useCallback(() => next(), [next]);

  const jumpTo = useCallback((queueId: number) => {
    const item = stateRef.current.upcoming[queueId - 2];
    if (item) change(state => jumpQueue(state, queueId - 2, historyEntry).state);
    return item;
  }, [change]);
  const replayHistory = useCallback((historyId: string) => {
    const item = stateRef.current.history.find(entry => entry.historyId === historyId);
    if (item) change(state => replayQueueHistory(state, historyId).state);
    return item;
  }, [change]);
  const reorderEntries = useCallback((history: QueueEntryRef[], upcoming: QueueEntryRef[]) => {
    change(state => reorderQueue(state, history, upcoming, historyEntry));
  }, [change]);
  const removeHistoryEntries = useCallback((historyIds: string[]) => {
    change(state => removeQueueHistory(state, new Set(historyIds)));
  }, [change]);
  const removeEntries = useCallback((queueIds: QueueId[]) => {
    const transition = removeQueueEntries(stateRef.current, new Set(queueIds));
    change(state => removeQueueEntries(state, new Set(queueIds)).state);
    return { currentRemoved: transition.currentRemoved, item: transition.item };
  }, [change]);
  const peekNext = useCallback(() => stateRef.current.upcoming[0], []);

  const entries = useMemo(
    () => state.current === null ? [] : [state.current, ...state.upcoming].map((entry, index) => ({ ...entry, queueId: index + 1 })),
    [state.current, state.upcoming],
  );
  const upcomingEntries = useMemo(() => entries.slice(1), [entries]);
  return {
    historyEntries: state.history,
    entries,
    currentEntry: entries[0],
    upcomingEntries,
    isRestored: true,
    playFromContext, playStandalone, addToQueue, playNext, shuffleContext, addShuffledToQueue,
    next, completeCurrent, previous, jumpTo, replayHistory, reorderEntries, removeHistoryEntries, removeEntries, peekNext,
  };
}
