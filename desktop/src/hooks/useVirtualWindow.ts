import { useCallback, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { flushSync } from "react-dom";
import { timed } from "../utils/perf";
import { activeMeasurer } from "../utils/virtualMeasure";
import {
  anchoredScrollTop,
  computeWindow,
  sameMetrics,
  sameRange,
  type WindowMetrics,
  type WindowRange,
} from "../utils/virtualWindow";

type Options = {
  count: number;
  /** When false the full list is rendered and nothing is measured or observed. */
  enabled: boolean;
  /**
   * An element that is always rendered. The list container is the anchor itself
   * (`probeIsContainer`) or the anchor's parent.
   */
  probeRef: RefObject<HTMLElement | null>;
  probeIsContainer: boolean;
  /** Used for the first render, before anything can be measured. */
  fallback: { rowHeight: number; columns?: number; rowGap?: number };
  /** Remembers real measurements so revisiting a view starts with exact geometry. */
  cacheKey: string;
  overscanRows?: number;
  /** Keep this item mounted (e.g. the row being dragged). */
  pinnedIndex?: number | null;
};

// Geometry is stable between visits, and scroll restoration depends on the first
// render having the right total height, so remember the last measurement.
const measuredMetrics = new Map<string, WindowMetrics>();

function everything(count: number): WindowRange {
  return { rows: count, startRow: 0, endRow: count, start: 0, end: count, topSpace: 0, bottomSpace: 0 };
}

/**
 * Windowed rendering for long lists and grids. Returns which items to render and
 * the heights of the two spacers that stand in for the rest. Scrolling commits
 * synchronously so new rows exist before the frame is painted.
 */
export function useVirtualWindow(options: Options): WindowRange {
  const { count, enabled, probeRef, probeIsContainer, cacheKey } = options;
  const overscanRows = options.overscanRows ?? 8;
  const pinnedIndex = options.pinnedIndex ?? null;

  const metricsRef = useRef<WindowMetrics>({
    rowHeight: options.fallback.rowHeight,
    rowGap: options.fallback.rowGap ?? 0,
    columns: options.fallback.columns ?? 1,
    offset: 0,
    ...measuredMetrics.get(cacheKey),
  });
  const countRef = useRef(count);
  const pinnedRef = useRef(pinnedIndex);
  const scrollerRef = useRef<HTMLElement | Window | null>(null);
  const hasMeasuredRef = useRef(false);
  countRef.current = count;
  pinnedRef.current = pinnedIndex;

  const initial = useMemo(
    () =>
      enabled
        ? computeWindow({
            count,
            ...metricsRef.current,
            scrollTop: 0,
            viewportHeight: typeof window === "undefined" ? 800 : window.innerHeight,
            overscanRows,
            pinnedIndex,
          })
        : everything(count),
    // Only the first render; later ranges come from scrolling and measurement.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const [range, setRange] = useState<WindowRange>(initial);
  const rangeRef = useRef(range);

  const recompute = useCallback(
    (synchronous: boolean) => {
      const scroller = scrollerRef.current;
      if (!scroller) return;
      const measurer = activeMeasurer();
      const next = computeWindow({
        count: countRef.current,
        ...metricsRef.current,
        scrollTop: measurer.scrollTop(scroller),
        viewportHeight: measurer.viewportHeight(scroller),
        overscanRows,
        pinnedIndex: pinnedRef.current,
      });
      if (sameRange(next, rangeRef.current)) return;
      rangeRef.current = next;
      if (synchronous) flushSync(() => setRange(next));
      else setRange(next);
    },
    [overscanRows],
  );

  const measure = useCallback(() => {
    const anchor = probeRef.current;
    const scroller = scrollerRef.current;
    if (!anchor || !scroller) return;
    const container = probeIsContainer ? anchor : anchor.parentElement;
    if (!container) return;
    const measurer = activeMeasurer();
    const measured = measurer.measure(container, scroller);
    if (!measured || !(measured.rowHeight > 0)) return;

    const previous = metricsRef.current;
    if (sameMetrics(previous, measured)) {
      hasMeasuredRef.current = true;
      return;
    }
    metricsRef.current = measured;
    measuredMetrics.set(cacheKey, measured);
    const geometryChanged =
      previous.columns !== measured.columns ||
      Math.abs(previous.rowHeight + previous.rowGap - (measured.rowHeight + measured.rowGap)) > 0.5;
    // After a resize keep the same item in view. The very first measurement of a
    // mount is not anchored: the saved scroll position was recorded against the
    // real geometry, not against the fallback used until now.
    if (hasMeasuredRef.current && geometryChanged && measurer.scrollTop(scroller) > previous.offset) {
      measurer.setScrollTop(scroller, anchoredScrollTop(measurer.scrollTop(scroller), previous, measured));
    }
    hasMeasuredRef.current = true;
  }, [cacheKey, probeIsContainer, probeRef]);

  // Attach: find the scroller, then listen for scrolling and size changes.
  useLayoutEffect(() => {
    if (!enabled) return;
    const anchor = probeRef.current;
    const container = anchor && (probeIsContainer ? anchor : anchor.parentElement);
    if (!container) return;
    const measurer = activeMeasurer();
    const scroller = measurer.findScroller(container);
    if (!scroller) return;
    scrollerRef.current = scroller;
    hasMeasuredRef.current = false;

    const onScroll = () => timed("virtual.scrollCommit", () => recompute(true));
    const target: EventTarget = scroller;
    target.addEventListener("scroll", onScroll, { passive: true });

    let observer: ResizeObserver | undefined;
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(() => {
        measure();
        recompute(true);
      });
      observer.observe(container);
      if (scroller instanceof HTMLElement) observer.observe(scroller);
    }

    measure();
    recompute(false);
    return () => {
      target.removeEventListener("scroll", onScroll);
      observer?.disconnect();
      scrollerRef.current = null;
    };
  }, [enabled, measure, probeIsContainer, probeRef, recompute]);

  // Re-measure once real rows exist and whenever the rendered window or the data
  // changes; then settle the range against the measured geometry before paint.
  useLayoutEffect(() => {
    if (!enabled) return;
    measure();
    recompute(false);
  }, [enabled, count, pinnedIndex, range.startRow, range.endRow, measure, recompute]);

  return useMemo(() => (enabled ? range : everything(count)), [enabled, range, count]);
}
