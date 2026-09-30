// Responses from the backend are authoritative but almost always identical to
// what is already on screen. Replacing the array with fresh objects would
// invalidate every memo, re-stringify and re-persist the whole library, and
// re-render every row. Reconciling keeps existing object identities for
// unchanged tracks, and keeps the *array* identity when nothing changed at all.

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) {
    return false;
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => deepEqual(item, b[index]));
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every((key) => key in right && deepEqual(left[key], right[key]));
}

export function reconcileTracks<T extends { globalId: string }>(
  previous: T[],
  next: T[],
): T[] {
  if (previous.length === 0) return next.length === 0 ? previous : next;

  const existing = new Map(previous.map((track) => [track.globalId, track]));
  let unchanged = previous.length === next.length;
  const merged = next.map((track, index) => {
    const old = existing.get(track.globalId);
    const same = old !== undefined && deepEqual(old, track);
    if (!same || previous[index] !== old) unchanged = false;
    return same ? old : track;
  });
  return unchanged ? previous : merged;
}
