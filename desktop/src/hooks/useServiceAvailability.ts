import { useSyncExternalStore } from "react";
import { serviceAuthStatus, type ServiceAuthStatus, type StreamingProvider } from "../api/server";
import { isDeviceTrack } from "../utils/nativeAudioSource";
import { isDownloadedOnServer, offlineSource, useDownloads } from "../utils/offlineDownloads";
import { serverConnection, serverOnline, subscribeServerConnection } from "../api/serverConnection";
import type { Track } from "../types/music";

let status: ServiceAuthStatus | null = null;
let request = 0;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;

export function updateServiceAvailability(value: ServiceAuthStatus) {
  request++;
  if (status && (Object.keys(value) as StreamingProvider[]).every(provider => status![provider] === value[provider])) return;
  status = value;
  for (const listener of listeners) listener();
}

export async function refreshServiceAvailability() {
  if (serverConnection && !serverConnection.server) return;
  const current = ++request;
  try {
    const value = await serviceAuthStatus();
    if (current === request) updateServiceAvailability(value);
  } catch { /* A network outage is not an account sign-out. Keep the last known state. */ }
}

subscribeServerConnection(() => {
  request++;
  status = null;
  for (const listener of listeners) listener();
  if (serverConnection?.server && listeners.size) refresh();
});
const refresh = () => { void refreshServiceAvailability(); };
function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) {
    refresh();
    timer = setInterval(refresh, 15_000);
    window.addEventListener("focus", refresh);
    window.addEventListener("online", refresh);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size) return;
    clearInterval(timer);
    window.removeEventListener("focus", refresh);
    window.removeEventListener("online", refresh);
  };
}

export function useServiceAvailability() {
  // What's downloaded also decides availability, so its changes re-render too.
  useDownloads();
  return useSyncExternalStore(subscribe, () => status);
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
