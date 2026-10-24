import { serverBaseUrl } from "./serverConnection";

/**
 * This app's estimate of the server's clock (server/src/session.rs `server_time_ms`), so a
 * playback position can be carried forward from when the server took it, not from when it
 * arrived here. Like NTP: a quick round trip bounds the reading, and the quickest recent
 * one is trusted, since anything slower was held up by something besides the network.
 */
type Sample = { offset: number; roundTrip: number; at: number };

const SAMPLE_EVERY_MS = 15_000;
/** Older samples are dropped; the two clocks drift, and a sleep can upset this one. */
const SAMPLES_LAST_MS = 120_000;
const FIRST_SAMPLES = 5;

let samples: Sample[] = [];
let syncing = false;

async function sample() {
  const sent = performance.now();
  const response = await fetch(`${serverBaseUrl}/api/session/clock`, { cache: "no-store", signal: AbortSignal.timeout(5_000) });
  const { serverTimeMs } = await response.json() as { serverTimeMs: number };
  const received = performance.now();
  if (!response.ok || !Number.isFinite(serverTimeMs)) return;
  samples = [...samples.filter(sample => received - sample.at < SAMPLES_LAST_MS),
    { offset: serverTimeMs - (sent + received) / 2, roundTrip: received - sent, at: received }];
}

/** Keeps the estimate current for as long as the app runs. */
export function syncServerClock() {
  if (syncing) return;
  syncing = true;
  void (async () => {
    // A few at once, so the first estimate doesn't rest on one connection's setup.
    for (let index = 0; index < FIRST_SAMPLES; index += 1) await sample().catch(() => {});
    for (;;) {
      await new Promise(resolve => setTimeout(resolve, SAMPLE_EVERY_MS));
      await sample().catch(() => {});
    }
  })();
}

/** The server restarted: its clock began again. */
export function resetServerClock() {
  samples = [];
  void sample().catch(() => {});
}

/** Now, on the server's clock, or null before any round trip has come back. */
export function serverNow(): number | null {
  const quickest = samples.reduce<Sample | null>((best, sample) => !best || sample.roundTrip < best.roundTrip ? sample : best, null);
  return quickest ? performance.now() + quickest.offset : null;
}
