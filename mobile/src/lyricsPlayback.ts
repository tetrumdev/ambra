/** Resolve the current client when requested; Fast Refresh can replace its exports after lyrics mount. */
export async function refreshLyricPlayback(signal: AbortSignal, force = false) {
  const client = await import("./client");
  if (signal.aborted) return null;
  await client.refreshSession(signal, { clock: force ? "force" : "recent" });
  if (signal.aborted) return null;
  return { view: client.sessionView(), ageSeconds: client.sessionViewAge() };
}
