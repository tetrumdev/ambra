import { useSyncExternalStore } from "react";
import { serviceAuthStatus, type ServiceAuthStatus, type StreamingProvider } from "../api/server";
import { isDeviceTrack } from "../utils/nativeAudioSource";
import { isDownloadedOnServer, offlineSource, useLocalDownloads, useServerDownloads } from "../utils/offlineDownloads";
import { hasServerConnection, serverConnection, serverOnline, subscribeServerConnection } from "../api/serverConnection";
import type { Track } from "../types/music";

let status: ServiceAuthStatus | null = null;
let revision = 0;
let pending: Promise<void> | undefined;
let eventsAvailable = false;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;

export function updateServiceAvailability(value: ServiceAuthStatus) {
  revision++;
  if (status && (Object.keys(value) as StreamingProvider[]).every(provider => status![provider] === value[provider])) return;
  status = value;
  for (const listener of listeners) listener();
}

export function markServiceConnected(provider: StreamingProvider) {
  updateServiceAvailability({ tidal: false, qobuz: false, spotify: false, ...status, [provider]: true });
}

export function refreshServiceAvailability(): Promise<void> {
  if (eventsAvailable || !hasServerConnection()) return Promise.resolve();
  if (pending) return pending;
  const current = revision;
  const request = serviceAuthStatus().then(value => {
    if (!eventsAvailable && current === revision) updateServiceAvailability(value);
  }).catch(() => {
    // A network outage does not change the last known account state.
  }).finally(() => { if (pending === request) pending = undefined; });
  return pending = request;
}

function refresh() { void refreshServiceAvailability(); }

function updateFallbackTimer() {
  clearInterval(timer);
  if (listeners.size && !eventsAvailable && hasServerConnection()) {
    timer = setInterval(refresh, 15_000);
  }
}

export function setServiceEventsAvailable(available: boolean) {
  if (eventsAvailable === available) return;
  eventsAvailable = available;
  updateFallbackTimer();
}

subscribeServerConnection(() => {
  revision++;
  pending = undefined;
  status = null;
  eventsAvailable = false;
  for (const listener of listeners) listener();
  updateFallbackTimer();
  if (listeners.size) refresh();
});
const skipSubscription = () => () => {};
function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) {
    refresh();
    updateFallbackTimer();
    window.addEventListener("online", refresh);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size) return;
    clearInterval(timer);
    window.removeEventListener("online", refresh);
  };
}

export function useServiceStatus(enabled = true) {
  return useSyncExternalStore(enabled ? subscribe : skipSubscription, () => enabled ? status : null);
}

export function useServiceAvailability() {
  // What's downloaded also decides availability, so its changes re-render too.
  useLocalDownloads();
  useServerDownloads();
  return useServiceStatus();
}

export function isTrackAvailable(track: Track | string, connected = status) {
  const id = typeof track === "string" ? track : track.globalId;
  // A song downloaded to this device plays without any server or service.
  if (offlineSource(id)) return true;
  const device = typeof track !== "string" ? isDeviceTrack(track) : track.startsWith("local:") && !track.startsWith("local:server:");
  if (serverConnection && !device && (!serverOnline || !serverConnection.server)) return false;
  if (typeof track !== "string" && track.serverIdentity && track.serverIdentity !== serverConnection?.server?.publicKey) return false;
  // The server's own copy plays while the song's service is signed out.
  if (isDownloadedOnServer(id)) return true;
  const provider = typeof track === "string" ? track.split(":", 1)[0] : track.provider;
  return !connected || !["tidal", "qobuz", "spotify"].includes(provider) || connected[provider as StreamingProvider];
}
