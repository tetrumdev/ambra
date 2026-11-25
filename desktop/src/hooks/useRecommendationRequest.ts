import { useEffect, useState } from "react";

export function useRecommendationRequest<T>(load: ((signal: AbortSignal) => Promise<T>) | null, refreshMs?: number) {
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ load: typeof load; attempt: number; value?: T; error?: boolean }>();
  useEffect(() => {
    if (!load) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function request(fetchValue: NonNullable<typeof load>) {
      let delay = refreshMs;
      try {
        const value = await fetchValue(controller.signal);
        if (!controller.signal.aborted) setResult({ load, attempt, value });
      } catch {
        if (!controller.signal.aborted) {
          setResult(previous => ({
            load, attempt, error: true,
            value: previous?.load === load && previous.attempt === attempt ? previous.value : undefined,
          }));
        }
        if (delay) delay = Math.min(delay, 60_000);
      } finally {
        if (delay && !controller.signal.aborted) timer = setTimeout(() => {
          void request(fetchValue);
        }, delay);
      }
    }
    void request(load);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [load, attempt, refreshMs]);
  const current = result && result.load === load && result.attempt === attempt ? result : undefined;
  return { value: current?.value, error: current?.error, retry: () => setAttempt(attempt => attempt + 1) };
}
