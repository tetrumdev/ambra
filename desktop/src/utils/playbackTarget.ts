import { useEffect, useState, useSyncExternalStore } from "react";
import { serverBaseUrl, serverConnectionSignal, subscribeServerConnection, getServerConnection } from "../api/serverConnection";
import type { NativeAudioDevice } from "./audioSettings";

/**
 * The computers using this server and their outputs. The server's core decides which output
 * plays (api/core.ts); these are for choosing one and setting it up, on any computer.
 */
export type RemoteEndpoint = { id: string; name: string; devices: NativeAudioDevice[]; availableDevices?: NativeAudioDevice[]; selectedDeviceId: string | null };
export type EndpointRef = { endpointId: string; endpointName: string };

/** Runs one of the setup commands another computer takes (`COMMANDS` in the server's endpoints.rs). */
export async function invokeOn<T>(on: EndpointRef, command: string, args?: Record<string, unknown>): Promise<T> {
  const signal = serverConnectionSignal();
  const response = await fetch(`${serverBaseUrl}/api/endpoints/${encodeURIComponent(on.endpointId)}/command`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ command, args: args ?? {} }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
  });
  const body = await response.json().catch(() => null) as (T & { error?: string }) | null;
  signal.throwIfAborted();
  if (!response.ok) throw new Error(body?.error ?? `${on.endpointName} answered ${response.status}`);
  return body as T;
}

/** The computers using this server with their outputs, while `active`; this one too unless `othersOnly`. */
export function useEndpoints(active: boolean, othersOnly = false) {
  const [endpoints, setEndpoints] = useState<RemoteEndpoint[]>([]);
  const connection = useSyncExternalStore(subscribeServerConnection, getServerConnection);
  useEffect(() => {
    setEndpoints([]);
    if (!active || !connection?.server) return;
    let disposed = false;
    let running = false;
    const abort = new AbortController();
    const refresh = async () => {
      if (running) return;
      running = true;
      try {
        const response = await fetch(`${serverBaseUrl}/api/endpoints`, { cache: "no-store", signal: AbortSignal.any([abort.signal, serverConnectionSignal(), AbortSignal.timeout(5000)]) });
        if (!response.ok) return;
        const list = await response.json() as RemoteEndpoint[];
        const next = list.filter(endpoint => (endpoint.availableDevices ?? endpoint.devices).length > 0 && !(othersOnly && endpoint.id === connection.clientId))
          .map(({ id, name, devices, availableDevices, selectedDeviceId }) => ({ id, name, devices, availableDevices, selectedDeviceId }));
        if (!disposed) setEndpoints(current => JSON.stringify(current) === JSON.stringify(next) ? current : next);
      } catch { /* Offline: keep the last list until the server answers. */ }
      finally { running = false; }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 1000);
    return () => { disposed = true; abort.abort(); clearInterval(timer); };
  }, [active, othersOnly, connection]);
  return endpoints;
}
