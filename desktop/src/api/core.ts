import { forStorage, fromStorage, serverBaseUrl } from "./serverConnection";
import type { QueueState } from "../utils/queueNavigation";
import { parseQueueSnapshot, queueSnapshot, resolveQueueSnapshot, type PersistedQueue } from "../utils/queueStorage";
import { localMusicTrack } from "./localMusic";
import { getServerItem } from "../utils/serverState";
import type { AudioQuality, Track } from "../types/music";
import { resetServerClock, serverNow, syncServerClock } from "./serverClock";
import { invokeOn } from "../utils/playbackTarget";
import { nativeAudioSource, isDeviceTrack } from "../utils/nativeAudioSource";

/**
 * The server's core decides what plays for every device (server/src/session.rs). This is
 * how an app follows it and asks it for things: it never plays anything itself.
 *
 * Requests go out strictly in order, so "queue these songs" always lands before "play the
 * first one". A queue change says which queue revision it was made on; if another device
 * changed the queue meanwhile, the change is made again on the newer queue.
 */
export type CoreOutput = { endpointId: string; deviceId: string; endpointName: string; deviceName: string };
export type CoreView = {
  instanceId: string;
  revision: number;
  playing: boolean;
  positionSeconds: number;
  /** When `positionSeconds` was true, on the server's clock. Missing from older servers. */
  serverTimeMs?: number;
  duration: number;
  buffering: boolean;
  error: string | null;
  audioQuality: AudioQuality | null;
  output: CoreOutput | null;
  outputOnline: boolean;
  queueRevision: number;
  queue: PersistedQueue & { revision?: number };
};
/** A view as it arrives: the queue is left out when this app already has that revision. */
type ArrivingView = Omit<CoreView, "queue"> & { queue?: CoreView["queue"] };

const QUEUE_KEY = "ambra.queue.v1";
let view: CoreView | null = null;
/** When `view` arrived, so its position can be carried forward while playing. */
let viewAt = performance.now();
const listeners = new Set<() => void>();
let chain: Promise<unknown> = Promise.resolve();
let following = false;

export const coreView = () => view;

/** Prepare where the song will play, including when this app is only a remote. */
export async function warmCoreTrack(track: Track) {
  const output = view?.output;
  if (output) await invokeOn(output, "warm_native_audio", { source: nativeAudioSource(track) });
}

/**
 * Seconds since `view`'s position was true: from when the server took it, where this app
 * knows the server's clock, so the trip here doesn't leave it behind; else from its arrival.
 */
export function coreViewAge() {
  const now = serverNow();
  const age = now !== null && view?.serverTimeMs !== undefined ? (now - view.serverTimeMs) / 1000 : null;
  // A clock estimate from before a sleep or a server restart can be far off; arrival is safe.
  const arrived = (performance.now() - viewAt) / 1000;
  return age !== null && age >= 0 && age <= arrived + 1 ? age : arrived;
}
export function subscribeCore(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function accept(next: ArrivingView) {
  if (view && next.instanceId === view.instanceId && next.revision < view.revision) return;
  if (view && next.instanceId !== view.instanceId) resetServerClock();
  const { queue: arrived, ...rest } = next;
  let queue: CoreView["queue"];
  if (arrived === undefined) {
    // Left out as already known; a restarted or different server's queue can't be assumed to match.
    if (!view || view.instanceId !== next.instanceId || view.queueRevision !== next.queueRevision) {
      void request<ArrivingView>("/api/session").then(accept).catch(() => {});
      return;
    }
    queue = view.queue;
  } else {
    queue = JSON.parse(fromStorage(JSON.stringify(arrived))) as CoreView["queue"];
    if (queue.tracks) queue.tracks = queue.tracks.map(track => track.provider === "local" ? localMusicTrack(track) : track);
  }
  view = { ...JSON.parse(fromStorage(JSON.stringify(rest))) as Omit<CoreView, "queue">, queue };
  viewAt = performance.now();
  for (const listener of listeners) listener();
}

/** Tells the server which queue this app has, so an unchanged one isn't sent again. */
const knownQueue = () => view ? `queue=${view.queueRevision}` : "";

async function request<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${serverBaseUrl}${path}`, body === undefined ? { signal: AbortSignal.timeout(35_000) } : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000),
  });
  const value = await response.json().catch(() => null) as (T & { error?: string }) | null;
  if (!response.ok) throw Object.assign(new Error(value?.error ?? `The server answered ${response.status}`), { status: response.status, body: value });
  return value as T;
}

/** Keeps `view` current for as long as the app runs; a few seconds' wait also corrects the position. */
export function followCore() {
  if (following) return;
  following = true;
  syncServerClock();
  void (async () => {
    for (;;) {
      try {
        const since = view ? `?since=${view.revision}&wait=5&${knownQueue()}` : "";
        accept(await request<ArrivingView>(`/api/session${since}`));
      } catch {
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
  })();
}

function inOrder<T>(work: () => Promise<T>): Promise<T> {
  const result = chain.then(work, work);
  chain = result.catch(() => {});
  return result;
}

// A queue change that hasn't gone out yet. "Play this song" right after it travels with it,
// so the server loads the song once, already playing.
let unsentQueueChange: { playTrackId?: string; done: Promise<void> } | null = null;

/** Plays, pauses, seeks, skips or picks the output, on the server. */
export function coreCommand(action: string, details: Record<string, unknown> = {}) {
  if (action === "playTrack" && unsentQueueChange && typeof details.trackId === "string") {
    unsentQueueChange.playTrackId = details.trackId;
    return unsentQueueChange.done;
  }
  return inOrder(async () => accept(await request<ArrivingView>(`/api/session/command?${knownQueue()}`, { action, ...details })));
}

/** The queue as the server has it, with this app's copies of its songs where it knows them. */
export function coreQueue(tracks: Track[]): QueueState & { revision: number } {
  const snapshot = view?.queue ?? parseQueueSnapshot(getServerItem(QUEUE_KEY));
  const revision = (snapshot as { revision?: number } | null)?.revision ?? 0;
  return { ...(snapshot ? resolveQueueSnapshot(snapshot, tracks) : { history: [], current: null, upcoming: [] }), revision };
}

/**
 * Asks the server for the queue `change` makes of the current one, then optionally plays
 * `playTrackId`. Made again on the newer queue if another device got there first.
 */
export function coreChangeQueue(tracks: () => Track[], change: (state: QueueState) => QueueState, playTrackId?: string) {
  const job: { playTrackId?: string; done: Promise<void> } = { playTrackId, done: Promise.resolve() };
  unsentQueueChange = job;
  job.done = inOrder(async () => {
    if (unsentQueueChange === job) unsentQueueChange = null;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const current = coreQueue(tracks());
      const next = change(current);
      if ([...next.history, ...(next.current ? [next.current] : []), ...next.upcoming].some(item => isDeviceTrack(item.track))) {
        throw new Error("Private device files cannot enter the shared queue. Use local playback or explicitly import them into the server library.");
      }
      const queue = JSON.parse(forStorage(JSON.stringify(queueSnapshot(next.history, next.current, next.upcoming))));
      try {
        accept(await request<CoreView>("/api/session/queue", { base: current.revision, queue, playTrackId: job.playTrackId }));
        return;
      } catch (error) {
        if ((error as { status?: number }).status !== 409) throw error;
        // Retry on the actual queue in the refusal, rather than waiting for a separate poll.
        const session = (error as { body?: { session?: CoreView } }).body?.session;
        if (session) accept(session);
        else accept(await request<CoreView>("/api/session"));
      }
    }
    throw new Error("The queue kept changing on another device; try again.");
  });
  return job.done;
}
