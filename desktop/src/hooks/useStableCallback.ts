import { useCallback, useLayoutEffect, useRef } from "react";

// Keeps one function identity for the component's lifetime while always
// calling the latest closure, so memoized children skip unrelated renders.
export function useStableCallback<Args extends unknown[], Result>(
  callback: (...args: Args) => Result,
): (...args: Args) => Result {
  const latest = useRef(callback);
  useLayoutEffect(() => {
    latest.current = callback;
  });
  return useCallback((...args: Args) => latest.current(...args), []);
}
