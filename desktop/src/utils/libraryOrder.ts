export function orderLibraryTracks<T extends { globalId: string }>(tracks: T[], order: string[]): T[] {
  const positions = new Map(order.map((id, index) => [id, index]));
  return [...tracks].sort((a, b) => (positions.get(a.globalId) ?? Infinity) - (positions.get(b.globalId) ?? Infinity));
}

export function appendLibraryOrder(tracks: { globalId: string }[], order: string[], added: string[]) {
  const ids = new Set(added);
  return [...orderLibraryTracks(tracks, order).map(track => track.globalId).filter(id => !ids.has(id)), ...added];
}

export function loadLibraryOrder(): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem("ambra.library-order.v1") ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch { return []; }
}
