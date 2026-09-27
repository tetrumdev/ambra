const persistentKeys = new Set([
  "ambra.preferences",
  "ambra.current-screen",
  "ambra.playlists.v1",
  "ambra.streaming-library.v1",
  "ambra.removed-library-tracks.v1",
  "ambra.library-order.v1",
  "ambra.queue.v1",
]);
const revisionKey = "ambra.persistence.updated-at-ms";

type PersistentState = {
  version: 1;
  updatedAtMs: number;
  values: Record<string, string>;
};

let writeChain = Promise.resolve();

function snapshot() {
  const values: Record<string, string> = {};
  for (const key of persistentKeys) {
    const value = localStorage.getItem(key);
    if (value !== null) values[key] = value;
  }
  return values;
}

async function invokeIfDesktop<T>(command: string, args?: Record<string, unknown>) {
  const { invoke, isTauri } = await import("@tauri-apps/api/core");
  return isTauri() ? invoke<T>(command, args) : null;
}

function persistSnapshot() {
  if (
    typeof localStorage === "undefined" ||
    typeof localStorage.getItem !== "function"
  ) return;
  const state: PersistentState = {
    version: 1,
    updatedAtMs: Number(localStorage.getItem(revisionKey)) || Date.now(),
    values: snapshot(),
  };
  writeChain = writeChain
    .then(() => invokeIfDesktop("save_persistent_state", { state }))
    .then(() => undefined)
    .catch((error) => console.warn("Could not save Ambra state:", error));
}

export async function hydratePersistentStorage() {
  if (typeof localStorage === "undefined") return;
  try {
    const saved = await invokeIfDesktop<PersistentState | null>(
      "load_persistent_state",
    );
    const localUpdatedAt = Number(localStorage.getItem(revisionKey)) || 0;
    if (saved === null || saved.updatedAtMs <= localUpdatedAt) {
      if (localUpdatedAt === 0) {
        localStorage.setItem(revisionKey, String(Date.now()));
      }
      persistSnapshot();
      return;
    }
    for (const key of persistentKeys) {
      const value = saved.values[key];
      if (typeof value === "string") localStorage.setItem(key, value);
      else localStorage.removeItem(key);
    }
    localStorage.setItem(revisionKey, String(saved.updatedAtMs));
  } catch (error) {
    console.warn("Could not restore Ambra state:", error);
  }
}

export function getPersistentItem(key: string) {
  return localStorage.getItem(key);
}

export function setPersistentItem(key: string, value: string) {
  localStorage.setItem(key, value);
  if (
    persistentKeys.has(key) &&
    typeof localStorage.getItem === "function"
  ) {
    localStorage.setItem(revisionKey, String(Date.now()));
    persistSnapshot();
  }
}

export function removePersistentItem(key: string) {
  localStorage.removeItem(key);
  if (
    persistentKeys.has(key) &&
    typeof localStorage.getItem === "function"
  ) {
    localStorage.setItem(revisionKey, String(Date.now()));
    persistSnapshot();
  }
}
