import { countGridColumns, type WindowMetrics } from "./virtualWindow";

// Everything that reads layout lives here, behind a small interface, so the
// windowing logic can be tested without a layout engine and so that layout reads
// stay in one auditable place (they force layout, so they are never done per
// scroll event).
export type Measurer = {
  /** The nearest ancestor that scrolls. */
  findScroller: (container: HTMLElement) => HTMLElement | Window | null;
  scrollTop: (scroller: HTMLElement | Window) => number;
  viewportHeight: (scroller: HTMLElement | Window) => number;
  setScrollTop: (scroller: HTMLElement | Window, value: number) => void;
  /** Null when nothing is rendered yet, so nothing can be measured. */
  measure: (container: HTMLElement, scroller: HTMLElement | Window) => WindowMetrics | null;
};

const ITEM = ":scope > [data-virtual-item]";
const LIST_START = ':scope > [data-virtual-spacer="top"], :scope > [data-virtual-item]';

function pixels(value: string) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export const domMeasurer: Measurer = {
  findScroller(container) {
    for (let element: HTMLElement | null = container; element; element = element.parentElement) {
      const overflow = getComputedStyle(element).overflowY;
      if (overflow === "auto" || overflow === "scroll" || overflow === "overlay") return element;
    }
    return window;
  },
  scrollTop: (scroller) =>
    scroller instanceof Window ? scroller.scrollY : scroller.scrollTop,
  viewportHeight: (scroller) =>
    scroller instanceof Window ? scroller.innerHeight : scroller.clientHeight,
  setScrollTop(scroller, value) {
    if (scroller instanceof Window) scroller.scrollTo({ top: value });
    else scroller.scrollTop = value;
  },
  measure(container, scroller) {
    const items = container.querySelectorAll<HTMLElement>(ITEM);
    const listStart = container.querySelector<HTMLElement>(LIST_START);
    const first = items[0];
    if (!first || !listStart) return null;

    const style = getComputedStyle(container);
    const columns = style.display === "grid" ? countGridColumns(style.gridTemplateColumns) : 1;
    // `row-gap` is "normal" (NaN) for block and flex-column lists.
    const rowGap = pixels(style.rowGap);
    const firstRect = first.getBoundingClientRect();
    // Prefer the real distance between two rows: it includes margins and borders
    // that a bare height would miss.
    const next = items[columns];
    const rowHeight = next
      ? next.getBoundingClientRect().top - firstRect.top - rowGap
      : firstRect.height;

    const scrollerTop = scroller instanceof Window ? 0 : scroller.getBoundingClientRect().top;
    const scrolled = scroller instanceof Window ? scroller.scrollY : scroller.scrollTop;
    return {
      rowHeight,
      rowGap,
      columns,
      offset: listStart.getBoundingClientRect().top - scrollerTop + scrolled,
    };
  },
};

let measurer: Measurer = domMeasurer;

export function activeMeasurer() {
  return measurer;
}

/** Test seam: substitute geometry. Pass nothing to restore real layout reads. */
export function setMeasurerForTests(replacement: Measurer = domMeasurer) {
  measurer = replacement;
}
