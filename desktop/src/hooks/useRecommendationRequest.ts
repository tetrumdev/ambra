import { useEffect, useState } from "react";

export function useRecommendationRequest<T>(load: ((signal: AbortSignal) => Promise<T>) | null) {
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ load: typeof load; attempt: number; value?: T; error?: boolean }>();
  useEffect(() => {
    if (!load) return;
    const controller = new AbortController();
    void load(controller.signal).then(value => {
      if (!controller.signal.aborted) setResult({ load, attempt, value });
    }).catch(() => {
      if (!controller.signal.aborted) setResult({ load, attempt, error: true });
    });
    return () => controller.abort();
  }, [load, attempt]);
  const current = result && result.load === load && result.attempt === attempt ? result : undefined;
  return { value: current?.value, error: current?.error, retry: () => setAttempt(attempt => attempt + 1) };
}
