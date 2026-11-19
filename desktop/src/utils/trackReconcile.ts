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
  if (previous === next) return previous;
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

/** Applies a server library sync, keeping the cached copy of any saved track
 * the server could not load this time (a provider hiccup must not drop it). */
export function reconcileServerLibrary<T extends { globalId: string }>(
  previous: T[],
  loaded: T[],
  unavailableIds: ReadonlySet<string>,
): T[] {
  if (unavailableIds.size === 0) return reconcileTracks(previous, loaded);
  const loadedIds = new Set(loaded.map((track) => track.globalId));
  const kept = previous.filter(
    (track) => unavailableIds.has(track.globalId) && !loadedIds.has(track.globalId),
  );
  return reconcileTracks(previous, [...loaded, ...kept]);
}

/** Applies a streaming delta. Added or reimported tracks go to the end in server order. */
export function applyServerLibraryDelta<T extends { globalId: string }>(
  previous: T[],
  loaded: T[],
  removedIds: readonly string[],
  updatedIds: readonly string[] = [],
): T[] {
  if (!loaded.length && !removedIds.length) return previous;
  const updated = new Set(updatedIds);
  const replacements = new Map(loaded.filter(track => updated.has(track.globalId)).map(track => [track.globalId, track]));
  const moved = loaded.filter(track => !updated.has(track.globalId));
  const removed = new Set([...removedIds, ...moved.map(track => track.globalId)]);
  return reconcileTracks(previous, [
    ...previous.filter(track => !removed.has(track.globalId)).map(track => {
      const replacement = replacements.get(track.globalId);
      replacements.delete(track.globalId);
      return replacement ?? track;
    }),
    ...moved,
    // A track that was previously unavailable can enter the library on a metadata update.
    ...replacements.values(),
  ]);
}
