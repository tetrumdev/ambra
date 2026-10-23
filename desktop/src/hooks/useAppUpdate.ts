import { useEffect, useSyncExternalStore } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getPersistentItem, setPersistentItem } from "../utils/persistentStorage";

export type AppUpdateState =
  | { status: "idle" | "checking" | "current" }
  | { status: "available"; version: string; notes: string | null; dismissed: boolean }
  | { status: "installing"; version: string; progress: number | null }
  | { status: "error"; message: string };

type AvailableUpdate = { version: string; currentVersion: string; notes: string | null };

const settingsKey = "ambra.updates.v1";
const FIRST_CHECK_DELAY_MS = 20_000;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

// One state for the whole app, shared by the update notice and Settings.
let state: AppUpdateState = { status: "idle" };
const listeners = new Set<() => void>();
function publish(next: AppUpdateState) {
  state = next;
  for (const listener of listeners) listener();
}

export const updatesSupported = isTauri() && import.meta.env.PROD;

export function automaticUpdateChecks() {
  try {
    return JSON.parse(getPersistentItem(settingsKey) ?? "{}").automatic !== false;
  } catch {
    return true;
  }
}

export function setAutomaticUpdateChecks(automatic: boolean) {
  setPersistentItem(settingsKey, JSON.stringify({ automatic }));
}

/** Looks for a newer release. A quiet check leaves an earlier error or a dismissed notice alone. */
export async function checkForUpdate(quiet = false) {
  if (!updatesSupported || state.status === "checking" || state.status === "installing") return;
  const previous = state;
  if (!quiet) publish({ status: "checking" });
  try {
    const update = await invoke<AvailableUpdate | null>("check_for_update");
    if (!update) publish(quiet && previous.status === "error" ? previous : { status: "current" });
    else publish({
      status: "available", version: update.version, notes: update.notes,
      dismissed: quiet && previous.status === "available" && previous.version === update.version && previous.dismissed,
    });
  } catch (error) {
    publish(quiet ? previous : { status: "error", message: String(error) });
  }
}

export async function installUpdate() {
  if (state.status !== "available") return;
  const { version } = state;
  publish({ status: "installing", version, progress: null });
  const unlisten = await listen<{ downloaded: number; total: number | null }>("app-update-progress", ({ payload }) => {
    if (state.status === "installing" && payload.total) {
      publish({ ...state, progress: Math.min(1, payload.downloaded / payload.total) });
    }
  });
  try {
    // Restarts into the new version; on Windows its installer takes over.
    await invoke("install_update");
  } catch (error) {
    publish({ status: "error", message: String(error) });
  } finally {
    unlisten();
  }
}

export function dismissUpdate() {
  if (state.status === "available") publish({ ...state, dismissed: true });
}

export function useAppUpdate() {
  return useSyncExternalStore(listener => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }, () => state);
}

/** Checks a little after launch, so startup stays quick, and every few hours after that. */
export function useAutomaticUpdateChecks() {
  useEffect(() => {
    if (!updatesSupported) return;
    const check = () => { if (automaticUpdateChecks()) void checkForUpdate(true); };
    const first = setTimeout(check, FIRST_CHECK_DELAY_MS);
    const interval = setInterval(check, CHECK_INTERVAL_MS);
    return () => {
      clearTimeout(first);
      clearInterval(interval);
    };
  }, []);
}
