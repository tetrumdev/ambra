/**
 * TEMPORARY playback diagnostics (remove once the phone desync is found). Events wait here
 * and are sent to the server's `/api/diagnostics` log every second, together with what the
 * native bridge recorded; they're kept through a disconnect and sent once it's back.
 */
const queue: Record<string, unknown>[] = [];
const LIMIT = 5000;

export function diag(event: string, fields: Record<string, unknown> = {}) {
  if (queue.length >= LIMIT) queue.splice(0, queue.length - LIMIT + 1);
  queue.push({ event, phoneMs: Math.round(performance.now() * 10) / 10, phoneWallMs: Date.now(), ...fields });
}

/** Logs at most once per `ms` under `key`, for events that come several times a second. */
const last = new Map<string, number>();
export function diagEvery(key: string, ms: number, event: string, fields: Record<string, unknown> = {}) {
  const now = Date.now();
  if (now - (last.get(key) ?? 0) < ms) return;
  last.set(key, now);
  diag(event, fields);
}

/** Sends what's waiting every second until the returned function is called. */
export function startDiagnostics(
  send: (events: Record<string, unknown>[]) => Promise<unknown>,
  drainBridge: () => Promise<Record<string, unknown>[]>,
) {
  let stopped = false;
  let sending = false;
  const flush = async () => {
    if (sending || stopped) return;
    sending = true;
    try {
      const bridge = await drainBridge().catch(() => []);
      for (const event of bridge) queue.push({ ...event, event: `bridge.${String(event.event)}`, phoneMs: Math.round(performance.now() * 10) / 10 });
      if (!queue.length) return;
      const batch = queue.splice(0, 500);
      try { await send(batch); } catch { queue.unshift(...batch); if (queue.length > LIMIT) queue.splice(0, queue.length - LIMIT); }
    } finally { sending = false; }
  };
  const timer = setInterval(() => { void flush(); }, 1000);
  return () => { stopped = true; clearInterval(timer); };
}
