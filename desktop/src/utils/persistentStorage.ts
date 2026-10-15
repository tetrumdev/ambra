import { getServerItem, serverStateKeys, setServerItem } from "./serverState";

const restoreKeys = new Set([
  "ambra.preferences",
  "ambra.ui-preferences.v1",
  "ambra.current-screen",
  "ambra.playlists.v1",
  "ambra.streaming-library.v1",
  "ambra.removed-library-tracks.v1",
  "ambra.library-order.v1",
  "ambra.queue.v1",
]);
// Old server-owned keys are read only for migration and retained for rollback.
const persistentKeys = new Set([
  "ambra.ui-preferences.v1",
  "ambra.current-screen",
  "ambra.streaming-library.v1",
]);
const revisionKey = "ambra.persistence.updated-at-ms";

// localStorage is the synchronous working copy; the desktop backend keeps a
// durable mirror. Writes to the mirror are coalesced so a burst of changes (or a
// playback position that updates every few seconds) costs one small IPC call
// carrying only the keys that actually changed.
const writeDelayMs = 750;

type LoadedState = {
  updatedAtMs: number;
  // Present only when the stored state is newer than what the caller has.
  values: Record<string, string> | null;
};

type StatePatch = {
  updatedAtMs: number;
  changes: Record<string, string | null>;
};

export type PersistenceBackend = {
  load: (knownUpdatedAtMs: number) => Promise<LoadedState | null>;
  save: (patch: StatePatch) => Promise<void>;
};

const desktopBackend: PersistenceBackend = {
  load: async (knownUpdatedAtMs) => {
    const { invoke, isTauri } = await import("@tauri-apps/api/core");
    return isTauri()
      ? invoke<LoadedState | null>("load_persistent_state", {
          knownUpdatedAtMs: knownUpdatedAtMs || null,
        })
      : null;
  },
  save: async (patch) => {
    const { invoke, isTauri } = await import("@tauri-apps/api/core");
    if (isTauri()) await invoke("save_persistent_state", { patch });
  },
};

const backend = desktopBackend;
const dirtyKeys = new Set<string>();
let hydrated = false;
let hydration: Promise<boolean> | null = null;
let flushTimer: ReturnType<typeof setTimeout> | undefined;
let writeChain: Promise<void> = Promise.resolve();
let hideFlushInstalled = false;

function storageAvailable() {
  return (
    typeof localStorage !== "undefined" &&
    typeof localStorage.getItem === "function"
  );
}

function localRevision() {
  return Number(localStorage.getItem(revisionKey)) || 0;
}

function installHideFlush() {
  if (hideFlushInstalled || typeof document === "undefined") return;
  hideFlushInstalled = true;
  const flushWhenHidden = () => {
    if (document.visibilityState === "hidden") flushPersistentState();
  };
  document.addEventListener("visibilitychange", flushWhenHidden);
  window.addEventListener("pagehide", () => flushPersistentState());
}

function scheduleFlush() {
  if (!hydrated || flushTimer !== undefined) return;
  flushTimer = setTimeout(flushPersistentState, writeDelayMs);
}

/** Send every pending change to the backend now. Safe to call at any time. */
export function flushPersistentState() {
  if (flushTimer !== undefined) {
    clearTimeout(flushTimer);
    flushTimer = undefined;
  }
  if (!hydrated || !storageAvailable() || dirtyKeys.size === 0) return;

  const changes: Record<string, string | null> = {};
  for (const key of dirtyKeys) changes[key] = localStorage.getItem(key);
  dirtyKeys.clear();
  const patch: StatePatch = {
    updatedAtMs: localRevision() || Date.now(),
    changes,
  };
  writeChain = writeChain
    .then(() => backend.save(patch))
    .catch((error) => console.warn("Could not save Ambra state:", error));
}

/**
 * Reconcile WebView storage with the durable copy without blocking rendering.
 * Resolves `true` only when the durable copy was newer and replaced local
 * values; the caller should then re-read state (e.g. remount the app).
 */
export function hydratePersistentStorage(): Promise<boolean> {
  hydration ??= (async () => {
    if (!storageAvailable()) {
      hydrated = true;
      return false;
    }
    installHideFlush();
    try {
      const localUpdatedAt = localRevision();
      const saved = await backend.load(localUpdatedAt);

      if (saved === null) {
        // Nothing durable yet: seed it from whatever this WebView has.
        for (const key of persistentKeys) {
          if (localStorage.getItem(key) !== null) dirtyKeys.add(key);
        }
        if (dirtyKeys.size > 0 && localUpdatedAt === 0) {
          localStorage.setItem(revisionKey, String(Date.now()));
        }
        return false;
      }

      if (saved.values === null || saved.updatedAtMs <= localUpdatedAt) {
        // Writes made while hydrating are real user changes on top of current state.
        if (dirtyKeys.size > 0)
          localStorage.setItem(revisionKey, String(Date.now()));
        if (localRevision() > saved.updatedAtMs) {
          // The durable copy is behind (e.g. a write was lost at exit).
          for (const key of persistentKeys) dirtyKeys.add(key);
        }
        return false;
      }

      // The durable copy wins. Discard pre-hydration writes, which were derived
      // from the older state that was just replaced.
      dirtyKeys.clear();
      for (const key of restoreKeys) {
        const value = saved.values[key];
        if (typeof value === "string") localStorage.setItem(key, value);
        else localStorage.removeItem(key);
      }
      localStorage.setItem(revisionKey, String(saved.updatedAtMs));
      return true;
    } catch (error) {
      throw new Error(`Could not restore local state for migration: ${String(error)}`);
    } finally {
      hydrated = true;
      if (dirtyKeys.size > 0) scheduleFlush();
    }
  })().catch(error => {
    hydration = null;
    throw error;
  });
  return hydration;
}

function markChanged(key: string) {
  dirtyKeys.add(key);
  // Until hydration finishes the revision must stay untouched, otherwise a
  // stale WebView could appear newer than the durable copy and overwrite it.
  if (!hydrated) return;
  localStorage.setItem(revisionKey, String(Date.now()));
  scheduleFlush();
}

export function getPersistentItem(key: string) {
  if (serverStateKeys.has(key)) return getServerItem(key);
  return localStorage.getItem(key);
}

export function setPersistentItem(key: string, value: string) {
  if (serverStateKeys.has(key)) return setServerItem(key, value);
  const canTrack = persistentKeys.has(key) && storageAvailable();
  // Rewriting an identical value would bump the revision and trigger a backend
  // write for no reason; providers and effects do this routinely on startup.
  if (canTrack && localStorage.getItem(key) === value) return;
  localStorage.setItem(key, value);
  if (canTrack) markChanged(key);
}

export function removePersistentItem(key: string) {
  if (serverStateKeys.has(key)) return setServerItem(key, null);
  const canTrack = persistentKeys.has(key) && storageAvailable();
  if (canTrack && localStorage.getItem(key) === null) return;
  localStorage.removeItem(key);
  if (canTrack) markChanged(key);
}
