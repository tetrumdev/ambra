/**
 * WebKit links an `AbortSignal.any()` result to its sources only weakly. Once a
 * garbage collection drops an intermediate signal, aborting a source no longer
 * reaches the fetch beneath it: a stalled stream read then waits forever, and
 * neither its silence timeout nor a manual refresh can end it. Seen on Linux
 * after a game ran in the foreground for a while, which left the player showing
 * a song from twenty minutes earlier.
 *
 * Here each source holds its combined signal strongly through its abort
 * listener, and the combined signal holds its sources, so the chain lives as
 * long as anything still uses it.
 */
export function strongAbortSignalAny(signals: Iterable<AbortSignal>): AbortSignal {
  const sources = [...signals];
  const controller = new AbortController();
  const alreadyAborted = sources.find((signal) => signal.aborted);
  if (alreadyAborted) {
    controller.abort(alreadyAborted.reason);
    return controller.signal;
  }
  const onAbort = (event: Event) => {
    for (const signal of sources) signal.removeEventListener("abort", onAbort);
    controller.abort((event.target as AbortSignal).reason);
  };
  for (const signal of sources) signal.addEventListener("abort", onAbort);
  return controller.signal;
}

/** Chromium (WebView2) keeps these chains alive; WebKit (Linux, macOS) does not. */
export function installStrongAbortSignalAny(userAgent = navigator.userAgent) {
  if (!userAgent.includes("AppleWebKit") || userAgent.includes("Chrome/")) return;
  AbortSignal.any = strongAbortSignalAny;
}
