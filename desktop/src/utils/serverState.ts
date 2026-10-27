import { flushPersistentState } from "./persistentStorage";
import { serverBaseUrl } from "../api/server";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";


/**
 * State the server keeps for every device that uses it. Writes are per key: another
 * device's change to a different key never blocks this one, and this client follows
 * other devices' changes as they happen (`followServerState`).
 */
export const serverStateKeys = new Set([
  "ambra.playlists.v1",
  "ambra.queue.v1",
  "ambra.playback.v1",
  "ambra.listening-history.v1",
  "ambra.library-order.v1",
  "ambra.removed-library-tracks.v1",
  "ambra.ui-preferences.v1",
  "ambra.album-versions.v1",
  "ambra.lyrics-sync.v1",
  "ambra.lyrics-autosync.v2",
  "ambra.lyrics-autosync-samples.v1",
  "ambra.lyrics-autosync-noticed.v1",
  "ambra.dsp-presets.v1",
]);
// Settings and the playing position follow whoever changed them last. For a library or
// playlist, a change made elsewhere meanwhile is kept, and this device's is set aside.
const latestWins = new Set([
  "ambra.queue.v1",
  "ambra.playback.v1",
  "ambra.dsp-presets.v1",

]);
// Seen on the other screens as they're made: lyric timing, so every device's lyrics move
// together, and settings, which other devices apply as they arrive.
const promptKeys = new Set(["ambra.lyrics-sync.v1", "ambra.ui-preferences.v1"]);
const PROMPT_SAVE_MS = 100;
const keyNames: Record<string, string> = {
  "ambra.playlists.v1": "Playlists",
  "ambra.listening-history.v1": "Listening history",
  "ambra.library-order.v1": "Library order",
  "ambra.removed-library-tracks.v1": "The library",
};

type Snapshot = { revision: number; values: Record<string, string> };
type Changes = Record<string, string | null>;
type Patch = { revision: number; writeId: string; changes: Changes; bases: Record<string, number> };
type Status = { ready: boolean; pending: boolean; error: string | null; conflict: boolean };
const values = new Map<string, string>();
const pending = new Map<string, string | null>();
// The revision each pending key's edit started from. Other devices' changes heard meanwhile
// advance `revision`, but not what this device had seen of that key.
const pendingBase = new Map<string, number>();
const listeners = new Set<() => void>();
let revision = 0;
let status: Status = { ready: false, pending: false, error: null, conflict: false };
let timer: ReturnType<typeof setTimeout> | undefined;
let timerDue = 0;
let saving: Promise<void> | null = null;
let hydration: Promise<void> | null = null;
let attempt: Patch | null = null;
let discarding = false;
// Says which of this device's changes gave way to another device's; shown for a while.
let setAsideNotice: string | null = null;
let noticeTimer: ReturnType<typeof setTimeout> | undefined;

function publish(change: Partial<Status>) {
  status = { ...status, ...change, pending: pending.size > 0 };
  for (const listener of listeners) listener();
}

export const serverStateStatus = () => status;

const remoteListeners = new Set<(keys: Set<string>) => void>();
/** Hears which keys another device changed; this device's own writes aren't reported. */
export function subscribeRemoteChanges(listener: (keys: Set<string>) => void) {
  remoteListeners.add(listener);
  return () => { remoteListeners.delete(listener); };
}
export function subscribeServerState(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

class StateRequestError extends Error {
  constructor(message: string, readonly conflict = false, readonly body: Record<string, unknown> | null = null) { super(message); }
}

async function request(init?: RequestInit & { query?: string; timeoutMs?: number }) {
  const { query, timeoutMs, ...rest } = init ?? {};
  const response = await fetch(`${serverBaseUrl}/api/state${query ?? ""}`, {
    ...rest,
    cache: "no-store",
    signal: AbortSignal.timeout(timeoutMs ?? 10_000),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string } | null;
    throw new StateRequestError(body?.error ?? `Could not access server state (HTTP ${response.status}).`, response.status === 409, body);
  }
  return response;
}

function validRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

async function load(): Promise<Snapshot> {
  const saved = await (await request()).json() as Snapshot;
  if (!validRevision(saved.revision) || !saved.values || typeof saved.values !== "object" || Array.isArray(saved.values)
    || Object.values(saved.values).some(value => typeof value !== "string")) {
    throw new Error("Server returned invalid listening state.");
  }
  // A newer server may keep keys this version doesn't know; leave them to it.
  return { revision: saved.revision, values: Object.fromEntries(Object.entries(saved.values).filter(([key]) => serverStateKeys.has(key))) };
}

/** Takes other devices' changes, except to keys this device is about to overwrite anyway. */
function applyChanges(changes: unknown, atRevision: unknown) {
  if (!changes || typeof changes !== "object" || !validRevision(atRevision)) return;
  const changed = new Set<string>();
  for (const [key, value] of Object.entries(changes as Changes)) {
    if (!serverStateKeys.has(key) || pending.has(key) || (attempt && key in attempt.changes)) continue;
    if (value !== null && typeof value !== "string") continue;
    if ((values.get(key) ?? null) === value) continue;
    if (value === null) values.delete(key);
    else values.set(key, value);
    changed.add(key);
  }
  revision = Math.max(revision, atRevision);
  if (changed.size) {
    publish({});
    for (const listener of remoteListeners) listener(changed);
  }
}

// Shared state is loaded only after optional connection succeeds. Never upload device state.
export function hydrateServerState(): Promise<void> {
  hydration ??= (async () => {
    const saved = await load();
    values.clear();
    for (const [key, value] of Object.entries(saved.values)) values.set(key, value);
    revision = saved.revision;
    publish({ ready: true, error: null, conflict: false });
    if (pending.size > 0) scheduleSave(0);
    followServerState();
  })().catch(error => {
    hydration = null;
    publish({ error: `Could not load listening state. ${String(error)}` });
    throw error;
  });
  return hydration;
}

let following = false;
/** Hears other devices' changes as they're saved, for as long as the app is open. */
function followServerState() {
  if (following) return;
  following = true;
  void (async () => {
    while (!discarding && !status.conflict) {
      try {
        const response = await request({ query: `?since=${revision}&wait=25`, timeoutMs: 35_000 });
        const news = await response.json() as { revision?: unknown; changes?: unknown };
        // An older server answers with the whole state at once and can't be followed.
        if (news.changes === undefined) break;
        applyChanges(news.changes, news.revision);
      } catch (error) {
        if (error instanceof StateRequestError && error.conflict) {
          publish({ error: "The server's listening state was replaced. Reload to continue.", conflict: true });
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 3000));
      }
    }
    following = false;
  })();
}

export function getServerItem(key: string) {
  return status.ready ? values.get(key) ?? null : null;
}

export function reloadServerState() {
  discarding = true;
  window.location.reload();
}

function scheduleSave(delay = 750) {
  if (status.conflict) return;
  // A sooner save replaces a later one; the later one would only send the same keys.
  if (timer !== undefined) {
    if (performance.now() + delay >= timerDue) return;
    clearTimeout(timer);
  }
  timerDue = performance.now() + delay;
  timer = setTimeout(() => {
    timer = undefined;
    void flushServerState().catch(() => { /* Status exposes failures to the UI. */ });
  }, delay);
}

export function setServerItem(key: string, value: string | null) {
  if (!status.ready) throw new Error("Connect to the server before editing shared data.");
  if (!serverStateKeys.has(key)) throw new Error("Unsupported server state key.");
  if (status.conflict) throw new Error(status.error ?? "Reload server state before editing.");
  if ((values.get(key) ?? null) === value) return;
  if (value === null) values.delete(key);
  else values.set(key, value);
  if (!pendingBase.has(key)) pendingBase.set(key, revision);
  pending.set(key, value);
  publish({});
  scheduleSave(promptKeys.has(key) ? PROMPT_SAVE_MS : undefined);
}

/**
 * Another device changed some of the keys this one was saving. The latest change wins for
 * settings and playback; for a library or playlist, the other device's version is kept.
 */
function resolveConflict(patch: Patch, body: Record<string, unknown> | null) {
  const keys = Array.isArray(body?.keys) ? body.keys.filter((key): key is string => typeof key === "string") : [];
  if (!keys.length || !validRevision(body?.revision)) return false;
  attempt = null;
  const setAside: string[] = [];
  for (const key of keys) {
    // This device has now seen the other change and overwrites it on purpose.
    if (latestWins.has(key)) { pendingBase.set(key, body!.revision as number); continue; }
    if (pending.get(key) === patch.changes[key]) { pending.delete(key); pendingBase.delete(key); }
    setAside.push(keyNames[key] ?? key);
  }
  applyChanges(body.changes, body.revision);
  if (setAside.length) {
    setAsideNotice = `${setAside.join(" and ")} changed on another device at the same time, so your latest change there wasn't saved.`;
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => {
      if (status.error === setAsideNotice) publish({ error: null });
      setAsideNotice = null;
    }, 10_000);
  }
  publish({ error: setAsideNotice });
  return true;
}

/** Serialize writes; keep changed keys pending until the server acknowledges them. */
export function flushServerState(keepalive = false): Promise<void> {
  clearTimeout(timer);
  timer = undefined;
  if (saving) return saving.then(() => flushServerState(keepalive));
  if (status.conflict) return Promise.reject(new Error(status.error ?? "Server state conflict."));
  if (!status.ready || pending.size === 0) return Promise.resolve();
  attempt ??= {
    revision, writeId: crypto.randomUUID(), changes: Object.fromEntries(pending),
    bases: Object.fromEntries([...pending.keys()].map(key => [key, pendingBase.get(key) ?? revision])),
  };
  const patch = attempt;
  saving = (async () => {
    const response = await request({
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch), keepalive,
    });
    const result = await response.json() as { revision: number; changes?: unknown };
    if (!validRevision(result.revision) || result.revision < patch.revision) throw new Error("Server returned an invalid revision.");
    attempt = null;
    for (const [key, value] of Object.entries(patch.changes)) {
      if (pending.get(key) === value) { pending.delete(key); pendingBase.delete(key); }
      // Edited again while saving: what's left builds on this write.
      else if (pending.has(key)) pendingBase.set(key, result.revision);
    }
    applyChanges(result.changes ?? {}, result.revision);
    publish({ error: setAsideNotice });
  })().catch(error => {
    if (error instanceof StateRequestError && error.conflict && resolveConflict(patch, error.body)) {
      // Retry at once with what's left, now on top of the other device's changes.
      return;
    }
    const replaced = error instanceof StateRequestError && error.conflict;
    const disconnected = error instanceof TypeError
      || (error instanceof DOMException && error.name === "TimeoutError");
    publish({
      error: disconnected ? null : replaced ? error.message
        : "Listening state has not saved. Keep Ambra open; reconnect to the server to retry.",
      conflict: replaced,
    });
    if (!replaced) scheduleSave(5000);
    throw error;
  }).finally(() => {
    saving = null;
    if (pending.size > 0 && !status.conflict) scheduleSave();
  });
  return saving.then(() => {
    if (pending.size > 0) return flushServerState(keepalive);
  });
}

export function installServerStateLifecycle() {
  const saveLatest = () => window.dispatchEvent(new Event("ambra:save-session"));
  const flush = () => {
    if (discarding) return;
    saveLatest();
    void flushServerState(true).catch(() => {});
  };
  const beforeUnload = (event: BeforeUnloadEvent) => {
    flush();
    if (!isTauri() && !discarding && pending.size > 0) {
      event.preventDefault();
      event.returnValue = "";
    }
  };
  window.addEventListener("pagehide", flush);
  window.addEventListener("beforeunload", beforeUnload);
  const visibility = () => {
    if (document.visibilityState !== "hidden") return;
    saveLatest();
    void flushServerState().catch(() => {});
  };
  document.addEventListener("visibilitychange", visibility);
  const online = () => { void flushServerState().catch(() => {}); };
  window.addEventListener("online", online);

  let disposed = false;
  let closing = false;
  let unlisten: (() => void) | undefined;
  void (async () => {
    if (!isTauri() || disposed) return;
    const appWindow = getCurrentWindow();
    const stop = await appWindow.onCloseRequested(async event => {
      event.preventDefault();
      if (closing) return;
      closing = true;
      saveLatest();
      try {
        await flushPersistentState();
        await flushServerState();
        await appWindow.destroy();
      } catch { /* Leave the window open with the save error visible. */ }
      finally { closing = false; }
    });
    if (disposed) stop();
    else unlisten = stop;
  })().catch(error => publish({ error: `Could not protect unsaved state on close. ${String(error)}` }));

  return () => {
    disposed = true;
    unlisten?.();
    window.removeEventListener("pagehide", flush);
    window.removeEventListener("beforeunload", beforeUnload);
    document.removeEventListener("visibilitychange", visibility);
    window.removeEventListener("online", online);
  };
}
