import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { moveTrackId, type DropPosition } from "../utils/trackCollectionOrder";

type DropTarget = { trackId: string; position: DropPosition };

// Pointer gestures bypass the native file-drop handler in desktop webviews.
export function useTrackReorder(
  trackIds: string[],
  reorderTracks: ((ids: string[]) => void) | undefined,
  onStart: () => void,
  scrollRef?: RefObject<HTMLElement | null>,
) {
  const latest = useRef({ trackIds, reorderTracks, onStart, scrollRef });
  latest.current = { trackIds, reorderTracks, onStart, scrollRef };
  const cleanup = useRef<(() => void) | null>(null);
  const suppressClick = useRef(false);
  const [draggedTrackId, setDraggedTrackId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  useEffect(() => () => cleanup.current?.(), []);

  const onPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>, index: number) => {
    suppressClick.current = false;
    if (!latest.current.reorderTracks || event.button !== 0 || !event.isPrimary || event.pointerType === "touch") return;
    const target = event.target as HTMLElement;
    if (target.closest("[data-collection-menu-trigger], button, input, select")) return;
    const row = event.currentTarget;
    if (row.dataset.selecting) return;
    const container = row.parentElement;
    const sourceId = latest.current.trackIds[index];
    if (!container || !sourceId) return;
    cleanup.current?.();
    const scroller = latest.current.scrollRef?.current ?? container;

    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startY = event.clientY;
    let x = startX;
    let y = startY;
    let dragging = false;
    let destination: DropTarget | null = null;
    let frame = 0;
    const previousScrollBehavior = scroller.style.scrollBehavior;

    function viewport() {
      const bounds = container!.getBoundingClientRect();
      const scrollBounds = scroller.getBoundingClientRect();
      const columns = container!.querySelector(".columnInfo")?.getBoundingClientRect();
      const playerHeight = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--player-height")) || 0;
      return {
        left: Math.max(bounds.left, scrollBounds.left),
        right: Math.min(bounds.right, scrollBounds.right),
        top: Math.max(bounds.top, scrollBounds.top, columns?.bottom ?? bounds.top),
        bottom: Math.min(bounds.bottom, scrollBounds.bottom, window.innerHeight - playerHeight),
      };
    }

    function updateDestination() {
      const bounds = viewport();
      const over = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-track-id]");
      destination = null;
      if (x >= bounds.left && x <= bounds.right && y >= bounds.top && y <= bounds.bottom && over?.parentElement === container && over.dataset.trackId !== sourceId) {
        const rect = over.getBoundingClientRect();
        destination = {
          trackId: over.dataset.trackId!,
          position: y < rect.top + rect.height / 2 ? "before" : "after",
        };
      }
      const next = destination;
      setDropTarget(current => current?.trackId === next?.trackId && current?.position === next?.position ? current : next);
    }

    function scrollAtEdge() {
      const bounds = viewport();
      if (x >= bounds.left && x <= bounds.right && y >= bounds.top && y <= bounds.bottom) {
        const edge = Math.min(48, (bounds.bottom - bounds.top) / 3);
        const speed = y < bounds.top + edge
          ? -12 * (1 - (y - bounds.top) / edge)
          : y > bounds.bottom - edge
            ? 12 * (1 - (bounds.bottom - y) / edge)
            : 0;
        if (speed) scroller.scrollTop += speed;
      }
      updateDestination();
      frame = requestAnimationFrame(scrollAtEdge);
    }

    function move(moveEvent: PointerEvent) {
      if (moveEvent.pointerId !== pointerId) return;
      x = moveEvent.clientX;
      y = moveEvent.clientY;
      if (!dragging && Math.hypot(x - startX, y - startY) < 6) return;
      moveEvent.preventDefault();
      if (!dragging) {
        dragging = true;
        suppressClick.current = true;
        row.setPointerCapture(pointerId);
        scroller.style.scrollBehavior = "auto";
        document.documentElement.dataset.trackReordering = "true";
        setDraggedTrackId(sourceId);
        latest.current.onStart();
        frame = requestAnimationFrame(scrollAtEdge);
      }
      updateDestination();
    }

    function dispose() {
      cancelAnimationFrame(frame);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", keyDown, true);
      window.removeEventListener("blur", cancel);
      row.removeEventListener("lostpointercapture", cancel);
      if (row.hasPointerCapture(pointerId)) row.releasePointerCapture(pointerId);
      scroller.style.scrollBehavior = previousScrollBehavior;
      delete document.documentElement.dataset.trackReordering;
      cleanup.current = null;
    }

    function stop() {
      dispose();
      setDraggedTrackId(null);
      setDropTarget(null);
      // Keep the synthetic click suppressed until the next pointer press.
    }

    function finish(upEvent: PointerEvent) {
      if (upEvent.pointerId !== pointerId) return;
      x = upEvent.clientX;
      y = upEvent.clientY;
      if (dragging) updateDestination();
      const dropped = destination;
      stop();
      if (dragging && dropped) {
        latest.current.reorderTracks?.(moveTrackId(latest.current.trackIds, sourceId, dropped.trackId, dropped.position));
      }
    }

    function cancel() { stop(); }
    function keyDown(keyEvent: KeyboardEvent) {
      if (keyEvent.key === "Escape") {
        keyEvent.preventDefault();
        stop();
      }
    }

    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", keyDown, true);
    window.addEventListener("blur", cancel);
    row.addEventListener("lostpointercapture", cancel);
    cleanup.current = dispose;
  }, []);

  return { draggedTrackId, dropTarget, suppressClick, onPointerDown };
}
