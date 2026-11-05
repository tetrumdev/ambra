import { forSharing, rebased, request } from "./client";

/**
 * The state the server keeps for every device (`server/src/user_state.rs`): playlists, the
 * library's order and removals, listening history. Desktop writes the same keys
 * (`desktop/src/utils/serverState.ts`); this phone reads a snapshot and edits one key at a time.
 */

type Snapshot = { revision: number; values: Record<string, string> };

let cached: Snapshot | null = null;
let loading: Promise<Snapshot> | null = null;

/** The latest state; `fresh` asks the server again instead of reusing the last answer. */
export async function readState(signal?: AbortSignal, fresh = false): Promise<Snapshot> {
  if (cached && !fresh) return cached;
  loading ??= request<Snapshot>("/api/state", { signal, timeoutMs: 60_000 })
    .then(snapshot => {
      cached = snapshot;
      return snapshot;
    })
    .finally(() => { loading = null; });
  return loading;
}

/** A key's value with server URLs moved onto this phone's bridge, or null. */
export function stateValue(snapshot: Snapshot, key: string): string | null {
  const value = snapshot.values[key];
  return value === undefined ? null : rebased(value);
}

export function forgetState() {
  cached = null;
}

function writeId() {
  return Array.from({ length: 4 }, () => Math.floor(Math.random() * 2 ** 32).toString(16).padStart(8, "0")).join("");
}

/**
 * Changes one key from its latest value. When another device changed it meanwhile, the
 * change is made again on top of theirs, so neither device's edit is lost.
 */
export async function editState(key: string, change: (current: string | null) => string | null): Promise<void> {
  let snapshot = await readState(undefined, true);
  for (let attempt = 0; attempt < 4; attempt++) {
    const next = change(stateValue(snapshot, key));
    const value = next === null ? null : forSharing(next);
    if ((snapshot.values[key] ?? null) === value) return;
    try {
      const result = await request<{ revision: number; changes?: Record<string, string | null> }>("/api/state", {
        method: "POST",
        body: JSON.stringify({ revision: snapshot.revision, writeId: writeId(), changes: { [key]: value } }),
        timeoutMs: 30_000,
      });
      const values = { ...snapshot.values, ...Object.fromEntries(Object.entries(result.changes ?? {}).filter(([, item]) => item !== null)) as Record<string, string> };
      for (const [changed, item] of Object.entries(result.changes ?? {})) if (item === null) delete values[changed];
      if (value === null) delete values[key]; else values[key] = value;
      cached = { revision: result.revision, values };
      return;
    } catch (error) {
      if ((error as { status?: number }).status !== 409) throw error;
      snapshot = await readState(undefined, true);
    }
  }
  throw new Error("This changed on another device at the same time. Please try again.");
}
