import { serverBaseUrl } from "../api/server";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

export const serverStateKeys = new Set([
  "ambra.playlists.v1",
  "ambra.queue.v1",
  "ambra.playback.v1",
  "ambra.listening-history.v1",
  "ambra.library-order.v1",
  "ambra.removed-library-tracks.v1",
]);

type Snapshot = { revision: number; values: Record<string, string> };
type Patch = { revision: number; writeId: string; changes: Record<string, string | null> };
type Status = { ready: boolean; pending: boolean; error: string | null; conflict: boolean };
const endpoint = `${serverBaseUrl}/api/state`;
const values = new Map<string, string>();
const pending = new Map<string, string | null>();
const listeners = new Set<() => void>();
let revision = 0;
let status: Status = { ready: false, pending: false, error: null, conflict: false };
let timer: ReturnType<typeof setTimeout> | undefined;
let saving: Promise<void> | null = null;
let hydration: Promise<void> | null = null;
let attempt: Patch | null = null;
let discarding = false;

function publish(change: Partial<Status>) {
  status = { ...status, ...change, pending: pending.size > 0 };
  for (const listener of listeners) listener();
}

export const serverStateStatus = () => status;
export function subscribeServerState(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

class StateRequestError extends Error {
  constructor(message: string, readonly conflict = false) { super(message); }
}

async function request(init?: RequestInit) {
  const response = await fetch(endpoint, {
    ...init,
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string } | null;
    throw new StateRequestError(body?.error ?? `Could not access server state (HTTP ${response.status}).`, response.status === 409);
  }
  return response;
}

async function load(): Promise<Snapshot> {
  const saved = await (await request()).json() as Snapshot;
  if (!Number.isSafeInteger(saved.revision) || saved.revision < 0
    || !saved.values || typeof saved.values !== "object" || Array.isArray(saved.values)
    || Object.entries(saved.values).some(([key, value]) => !serverStateKeys.has(key) || typeof value !== "string")) {
    throw new Error("Server returned invalid listening state.");
  }
  return saved;
}

// Local keys remain untouched as frozen rollback copies. Only an uninitialized
// server accepts an import; opening another client never merges its old state.
export function hydrateServerState(): Promise<void> {
  hydration ??= (async () => {
    let saved = await load();
    if (saved.revision === 0) {
      const changes: Record<string, string> = {};
      for (const key of serverStateKeys) {
        const legacy = localStorage.getItem(key);
        if (legacy !== null) changes[key] = legacy;
      }
      const preferences = JSON.parse(localStorage.getItem("ambra.preferences") ?? "null") as { playback?: unknown } | null;
      if (preferences?.playback !== undefined) {
        changes["ambra.playback.v1"] = JSON.stringify(preferences.playback);
      }
      try {
        await request({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ revision: 0, writeId: crypto.randomUUID(), changes }) });
      } catch (error) {
        // A concurrent import already established the server's authoritative copy.
        if (!(error instanceof StateRequestError && error.conflict)) throw error;
      }
      saved = await load();
    }
    values.clear();
    for (const [key, value] of Object.entries(saved.values)) values.set(key, value);
    revision = saved.revision;
    publish({ ready: true, error: null, conflict: false });
  })().catch(error => {
    hydration = null;
    publish({ error: `Could not load listening state. ${String(error)}` });
    throw error;
  });
  return hydration;
}

export function getServerItem(key: string) {
  return values.get(key) ?? null;
}

export function reloadServerState() {
  discarding = true;
  window.location.reload();
}

function scheduleSave(delay = 750) {
  if (timer !== undefined || status.conflict) return;
  timer = setTimeout(() => {
    timer = undefined;
    void flushServerState().catch(() => { /* Status exposes failures to the UI. */ });
  }, delay);
}

export function setServerItem(key: string, value: string | null) {
  if (!status.ready) throw new Error("Listening state has not loaded from the server.");
  if (status.conflict) throw new Error(status.error ?? "Reload server state before editing.");
  if ((values.get(key) ?? null) === value) return;
  if (value === null) values.delete(key);
  else values.set(key, value);
  pending.set(key, value);
  publish({});
  scheduleSave();
}

/** Serialize writes; keep changed keys pending until the server acknowledges them. */
export function flushServerState(keepalive = false): Promise<void> {
  clearTimeout(timer);
  timer = undefined;
  if (saving) return saving.then(() => flushServerState(keepalive));
  if (status.conflict) return Promise.reject(new Error(status.error ?? "Server state conflict."));
  if (!status.ready || pending.size === 0) return Promise.resolve();
  attempt ??= { revision, writeId: crypto.randomUUID(), changes: Object.fromEntries(pending) };
  const patch = attempt;
  saving = (async () => {
    const response = await request({
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch), keepalive,
    });
    const result = await response.json() as { revision: number };
    if (!Number.isSafeInteger(result.revision) || result.revision < revision) throw new Error("Server returned an invalid revision.");
    revision = result.revision;
    attempt = null;
    for (const [key, value] of Object.entries(patch.changes)) {
      if (pending.get(key) === value) pending.delete(key);
    }
    publish({ error: null });
  })().catch(error => {
    const conflict = error instanceof StateRequestError && error.conflict;
    publish({ error: conflict ? error.message : "Listening state has not saved. Keep Ambra open; reconnect to the server to retry.", conflict });
    if (!conflict) scheduleSave(5000);
    throw error;
  }).finally(() => {
    saving = null;
    if (pending.size > 0 && !status.error) scheduleSave();
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
