/**
 * What the server's own step through the queue (next, previous, a song ending) did to queue
 * revision `base` (server/src/session.rs `QueuePatch`). Sent in place of the whole queue,
 * which can hold thousands of songs, to apps that ask with `patches=1`.
 */
export type QueuePatch = {
  base: number;
  revision: number;
  historyDropFront: number;
  historyDropBack: number;
  historyPush: unknown[];
  current: unknown;
  upcomingDropFront: number;
  upcomingUnshift: unknown[];
};

type PatchableQueue = { history?: unknown[]; current: unknown; upcoming: unknown[] };

/** Whether `patch` turns the queue an app has (at `knownRevision`) into the one a view describes. */
export function queuePatchApplies(patch: QueuePatch | undefined, knownRevision: number, viewRevision: number): patch is QueuePatch {
  return !!patch && patch.base === knownRevision && patch.revision === viewRevision;
}

/** The queue `patch` makes of `queue`. Its songs are the same, so their list is shared. */
export function applyQueuePatch<Queue extends PatchableQueue>(queue: Queue, patch: QueuePatch): Queue {
  const history = queue.history ?? [];
  return {
    ...queue,
    history: [...history.slice(patch.historyDropFront, history.length - patch.historyDropBack), ...patch.historyPush],
    current: patch.current,
    upcoming: [...patch.upcomingUnshift, ...queue.upcoming.slice(patch.upcomingDropFront)],
    revision: patch.revision,
  };
}
