import { useCallback, useEffect, useMemo, useState } from "react";
import { isUnmodifiedKey } from "../utils/keyboard";

type SelectionState<Id> = {
  selectedIds: Set<Id>;
  anchorIndex: number;
};

export function useRangeSelection<Id>(ids: readonly Id[]) {
  const [state, setState] = useState<SelectionState<Id> | null>(null);

  const toggle = useCallback(
    (index: number, extendRange: boolean) => {
      const id = ids[index];
      if (id === undefined) return;

      setState((current) => {
        if (current === null) {
          return { selectedIds: new Set([id]), anchorIndex: index };
        }

        const selectedIds = new Set(current.selectedIds);
        if (extendRange) {
          const start = Math.min(current.anchorIndex, index);
          const end = Math.max(current.anchorIndex, index);
          for (let rangeIndex = start; rangeIndex <= end; rangeIndex += 1) {
            const rangeId = ids[rangeIndex];
            if (rangeId !== undefined) selectedIds.add(rangeId);
          }
        } else if (selectedIds.has(id)) {
          selectedIds.delete(id);
        } else {
          selectedIds.add(id);
        }

        return { selectedIds, anchorIndex: index };
      });
    },
    [ids],
  );

  const clear = useCallback(() => setState(null), []);
  const selectedIds = useMemo(() => state?.selectedIds ?? new Set<Id>(), [state]);
  const selecting = state !== null;

  useEffect(() => {
    if (!selecting) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!isUnmodifiedKey(event, "Escape")) return;
      // Escape ends selecting and nothing else, so it doesn't also close the screen (such as the queue).
      event.preventDefault();
      clear();
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [selecting, clear]);

  return {
    isSelecting: state !== null,
    selectedIds,
    toggle,
    clear,
  };
}
