// Lightweight performance tracing. Everything here is a no-op unless tracing is
// enabled (development builds, or `localStorage["ambra.perf"] = "1"`), so it can
// stay in production code paths without measurable cost.

type Counter = { count: number; totalMs: number; maxMs: number };

const marks = new Map<string, number>();
const counters = new Map<string, Counter>();
let processOffsetMs: number | null = null;
let longTaskObserverStarted = false;

export function perfEnabled() {
  try {
    return (
      import.meta.env?.DEV === true ||
      (typeof localStorage !== "undefined" &&
        typeof localStorage.getItem === "function" &&
        localStorage.getItem("ambra.perf") === "1")
    );
  } catch {
    return false;
  }
}

const enabled = perfEnabled();

/** Record the first time a named startup milestone is reached. */
export function mark(name: string) {
  if (!enabled || marks.has(name)) return;
  marks.set(name, performance.now());
  performance.mark(`ambra:${name}`);
}

/** Time a synchronous operation, accumulating per-operation statistics. */
export function timed<T>(name: string, operation: () => T): T {
  if (!enabled) return operation();
  const start = performance.now();
  try {
    return operation();
  } finally {
    record(name, performance.now() - start);
  }
}

export function record(name: string, durationMs: number) {
  if (!enabled) return;
  const counter = counters.get(name) ?? { count: 0, totalMs: 0, maxMs: 0 };
  counter.count += 1;
  counter.totalMs += durationMs;
  counter.maxMs = Math.max(counter.maxMs, durationMs);
  counters.set(name, counter);
}

export function count(name: string, amount = 1) {
  if (!enabled) return;
  const counter = counters.get(name) ?? { count: 0, totalMs: 0, maxMs: 0 };
  counter.count += amount;
  counters.set(name, counter);
}

/** Convert a page-relative timestamp into milliseconds since process start. */
export function setProcessOffset(elapsedSinceProcessStartMs: number) {
  processOffsetMs = elapsedSinceProcessStartMs - performance.now();
}

export function perfSnapshot() {
  const offset = processOffsetMs ?? 0;
  return {
    processRelative: processOffsetMs !== null,
    marks: Object.fromEntries(
      [...marks].map(([name, time]) => [name, Math.round(time + offset)]),
    ),
    counters: Object.fromEntries(
      [...counters].map(([name, counter]) => [
        name,
        {
          count: counter.count,
          totalMs: Math.round(counter.totalMs * 10) / 10,
          maxMs: Math.round(counter.maxMs * 10) / 10,
        },
      ]),
    ),
  };
}

export function startPerfTracing() {
  if (!enabled || typeof window === "undefined") return;
  (window as unknown as { __ambraPerf?: () => unknown }).__ambraPerf = perfSnapshot;
  if (longTaskObserverStarted || typeof PerformanceObserver === "undefined") return;
  longTaskObserverStarted = true;
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) record("longTask", entry.duration);
    }).observe({ entryTypes: ["longtask"] });
  } catch {
    // Long-task timing is unavailable in some WebViews.
  }
}

/** Print the startup summary once the app has settled. */
export function reportStartup() {
  if (!enabled) return;
  console.info("[ambra:perf]", JSON.stringify(perfSnapshot()));
}
