import { useEffect, useState } from "react";
import { serverBaseUrl, serverConnection } from "../api/serverConnection";
import type { NativeAudioDevice } from "./audioSettings";

/**
 * The computers using this server and their outputs. The server's core decides which output
 * plays (api/core.ts); these are for choosing one and setting it up, on any computer.
 */
export type RemoteEndpoint = { id: string; name: string; devices: NativeAudioDevice[]; selectedDeviceId: string | null };
export type EndpointRef = { endpointId: string; endpointName: string };

/** Runs one of the setup commands another computer takes (`COMMANDS` in the server's endpoints.rs). */
export async function invokeOn<T>(on: EndpointRef, command: string, args?: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${serverBaseUrl}/api/endpoints/${encodeURIComponent(on.endpointId)}/command`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ command, args: args ?? {} }),
    signal: AbortSignal.timeout(20_000),
  });
  const body = await response.json().catch(() => null) as (T & { error?: string }) | null;
  if (!response.ok) throw new Error(body?.error ?? `${on.endpointName} answered ${response.status}`);
  return body as T;
}

/** The computers using this server with their outputs, while `active`; this one too unless `othersOnly`. */
export function useEndpoints(active: boolean, othersOnly = false) {
  const [endpoints, setEndpoints] = useState<RemoteEndpoint[]>([]);
  useEffect(() => {
    if (!active || !serverConnection) return;
    let disposed = false;
    const refresh = async () => {
      try {
        const response = await fetch(`${serverBaseUrl}/api/endpoints`, { signal: AbortSignal.timeout(5000) });
        if (!response.ok) return;
        const list = await response.json() as RemoteEndpoint[];
        if (!disposed) setEndpoints(list.filter(endpoint => endpoint.devices.length > 0 && !(othersOnly && endpoint.id === serverConnection?.clientId)));
      } catch { /* Offline: keep the last list until the server answers. */ }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 3000);
    return () => { disposed = true; clearInterval(timer); };
  }, [active, othersOnly]);
  return endpoints;
}
