import { useRef } from "react";
import type { QueueItem } from "../types/music";

type QueueView = {
  historyEntries: QueueItem[];
  currentEntry: QueueItem | undefined;
  upcomingEntries: QueueItem[];
};

/** How the queue reached `songKey`: 1 moving ahead through it, -1 going back, 0 any other way. */
export type QueueStep = { songKey: string; step: -1 | 0 | 1 };

const key = (item: QueueItem) =>
  `${item.source.kind}:${item.source.id}:${item.source.entryId}:${item.track.globalId}`;

/**
 * Tells moving through the queue (skipping, going back, a song ending, picking one from the
 * queue) from replacing it (playing something else, shuffling), by what stays queued around it.
 */
export function useQueueStep({ historyEntries, currentEntry, upcomingEntries }: QueueView) {
  const last = useRef({ historyEntries, currentEntry, upcomingEntries });
  const step = useRef<QueueStep | null>(null);
  const before = last.current;
  last.current = { historyEntries, currentEntry, upcomingEntries };
  if (currentEntry && (!before.currentEntry || key(currentEntry) !== key(before.currentEntry))) {
    const current = key(currentEntry);
    const was = before.upcomingEntries.map(key);
    const now = upcomingEntries.map(key);
    const ahead = was.indexOf(current);
    // Ahead: what was queued after it is still next, though more may have been added after.
    const forward = ahead >= 0 && was.slice(ahead + 1).every((item, index) => now[index] === item);
    // Back: it was played before, and what was queued still comes last.
    const back = before.historyEntries.some((item) => key(item) === current)
      && was.every((item, index) => now[now.length - was.length + index] === item);
    step.current = { songKey: currentEntry.track.globalId, step: forward ? 1 : back ? -1 : 0 };
  }
  return step.current;
}
