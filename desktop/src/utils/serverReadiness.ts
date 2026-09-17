function waitForRetry(milliseconds: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}

// The packaged server restores provider sessions before accepting connections.
// Retry connection failures only; real HTTP/provider errors remain authoritative.
export async function fetchWhenServerReady(url: string, signal?: AbortSignal): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    try {
      return await fetch(url, { signal });
    } catch (error) {
      if (!(error instanceof TypeError) || signal?.aborted || attempt >= 7) throw error;
      await waitForRetry(Math.min(200 * 2 ** attempt, 2000), signal);
    }
  }
}
