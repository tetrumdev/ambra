import { readJsonLines } from "../utils/jsonLines";
import type { ServiceAuthStatus } from "./server";
import { serverBaseUrl } from "./serverConnection";

export type LibraryVersions = { streaming: string; local: string; services: ServiceAuthStatus | null };

const STREAM_SILENCE_MS = 25_000;
const RETRY_MS = 3000;

/** Follow the selected server until stopped. Older servers use the legacy refresh paths. */
export function followLibraryEvents(
  signal: AbortSignal,
  changed: (versions: LibraryVersions) => void,
  disconnected: () => void,
  legacy: () => void,
) {
  let resume: (() => void) | undefined;
  let stream: AbortController | undefined;
  let reopen = false;
  const wake = () => {
    if (stream) { reopen = true; stream.abort(); }
    resume?.();
  };
  const online = () => { wake(); };
  window.addEventListener("online", online);
  signal.addEventListener("abort", wake, { once: true });
  void (async () => {
    try {
      while (!signal.aborted) {
        const active = stream = new AbortController();
        const request = AbortSignal.any([signal, active.signal]);
        let timer: ReturnType<typeof setTimeout>;
        const heard = () => {
          clearTimeout(timer);
          timer = setTimeout(() => active.abort(), STREAM_SILENCE_MS);
        };
        heard();
        try {
          const response = await fetch(`${serverBaseUrl}/api/library/events`, { signal: request, cache: "no-store" });
          if (request.aborted) continue;
          if (response.status === 404 || response.status === 405) { legacy(); return; }
          if (!response.ok || !response.body) throw new Error(`Library events HTTP ${response.status}`);
          await readJsonLines<LibraryVersions>(response.body, versions => {
            if (!request.aborted) changed(versions);
          }, heard);
        } catch {
          // Reopen after a stalled stream or a transport outage.
        } finally {
          clearTimeout(timer!);
          stream = undefined;
        }
        if (signal.aborted) return;
        disconnected();
        if (reopen) { reopen = false; continue; }
        await new Promise<void>(resolve => {
          const timer = setTimeout(done, RETRY_MS);
          function done() { clearTimeout(timer); resume = undefined; resolve(); }
          resume = done;
        });
      }
    } finally {
      window.removeEventListener("online", online);
      signal.removeEventListener("abort", wake);
    }
  })();
}
