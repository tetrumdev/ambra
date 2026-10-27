import { notifyLocalStorage } from "./storageEvents";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { forDeviceStorage, fromDeviceStorage } from "../api/serverConnection";

export const persistentKeys = new Set([
  "ambra.shared-playback.v1",
  "ambra.audio-settings.v1", "ambra.local-ownership.v1", "ambra.preferences", "ambra.ui-preferences.v1", "ambra.device-view.v1", "ambra.current-screen",
  "ambra.playlists.v1", "ambra.queue.v1", "ambra.playback.v1", "ambra.listening-history.v1",
  "ambra.library-order.v1", "ambra.removed-library-tracks.v1", "ambra.album-versions.v1",
  "ambra.lyrics-sync.v1", "ambra.lyrics-autosync.v2", "ambra.lyrics-autosync-samples.v1",
  "ambra.lyrics-autosync-noticed.v1", "ambra.dsp-presets.v1", "ambra.streaming-library.v1",
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
    return isTauri()
      ? invoke<LoadedState | null>("load_persistent_state", {
          knownUpdatedAtMs: knownUpdatedAtMs || null,
        })
      : null;
  },
  save: async (patch) => {
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
    if (document.visibilityState === "hidden") void flushPersistentState().catch(() => {});
  };
  document.addEventListener("visibilitychange", flushWhenHidden);
  window.addEventListener("pagehide", () => { void flushPersistentState().catch(() => {}); });
}

function scheduleFlush() {
  if (!hydrated || flushTimer !== undefined) return;
  flushTimer = setTimeout(() => { void flushPersistentState().catch(() => {}); }, writeDelayMs);
}

/** Send every pending change to the backend now. Safe to call at any time. */
export function flushPersistentState(): Promise<void> {
  if (flushTimer !== undefined) {
    clearTimeout(flushTimer);
    flushTimer = undefined;
  }
  if (!hydrated || !storageAvailable() || dirtyKeys.size === 0) return writeChain;

  const changes: Record<string, string | null> = {};
  for (const key of dirtyKeys) changes[key] = localStorage.getItem(key);
  dirtyKeys.clear();
  const patch: StatePatch = {
    updatedAtMs: localRevision() || Date.now(),
    changes,
  };
  writeChain = writeChain
    .catch(() => {}).then(() => backend.save(patch))
    .catch((error) => {
      for (const key of Object.keys(changes)) dirtyKeys.add(key);
      console.warn("Could not save Ambra state:", error);
      throw error;
    });
  return writeChain;
}

/**
 * Reconcile WebView storage with the durable copy without blocking rendering.
 * Resolves `true` only when the durable copy was newer and replaced local
 * values; the caller should then re-read state (e.g. remount the app).
 */
export function hydratePersistentStorage(): Promise<boolean> {
  hydration ??= (async () => {
    let restored = false;
    if (!storageAvailable()) {
      hydrated = true;
      return false;
    }
    installHideFlush();
    try {
      const localUpdatedAt = localRevision();
      const saved = await backend.load(localUpdatedAt);
      restored = true;

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
      for (const key of persistentKeys) {
        const value = saved.values[key];
        if (typeof value === "string") localStorage.setItem(key, value);
        // Old mirrors do not know newly local keys. New mirrors also describe deletions.
        else if (saved.values["ambra.local-ownership.v1"] === "1") localStorage.removeItem(key);
      }
      localStorage.setItem(revisionKey, String(saved.updatedAtMs));
      return true;
    } catch (error) {
      console.warn("Could not restore local state; using this device’s stored copy:", error);
      return false;
    } finally {
      hydrated = true;
      if (restored && localStorage.getItem("ambra.local-ownership.v1") !== "1") {
        localStorage.setItem("ambra.local-ownership.v1", "1");
        for (const key of persistentKeys) if (localStorage.getItem(key) !== null) dirtyKeys.add(key);
        localStorage.setItem(revisionKey, String(Date.now()));
      }
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

// Device state keeps its original URLs. Only explicitly server-owned snapshots are rebased.
export function getPersistentItem(key: string) {
  return fromDeviceStorage(localStorage.getItem(key));
}

export function setPersistentItem(key: string, savedValue: string) {
  const value = forDeviceStorage(savedValue);
  const canTrack = persistentKeys.has(key) && storageAvailable();
  // Rewriting an identical value would bump the revision and trigger a backend
  // write for no reason; providers and effects do this routinely on startup.
  if (canTrack && localStorage.getItem(key) === value) return;
  localStorage.setItem(key, value);
  if (canTrack) markChanged(key);
  notifyLocalStorage(key);
}

export function removePersistentItem(key: string) {
  const canTrack = persistentKeys.has(key) && storageAvailable();
  if (canTrack && localStorage.getItem(key) === null) return;
  localStorage.removeItem(key);
  if (canTrack) markChanged(key);
  notifyLocalStorage(key);
}
