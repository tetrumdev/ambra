// Pure windowing maths for long lists and grids. Items are laid out in rows of
// `columns` items; every row has the same height and rows are separated by
// `rowGap`. Only the rows that intersect the viewport (plus a margin) are
// rendered; two spacer elements stand in for the rest so that the scrollable
// height, and therefore every scroll position, is unchanged.

export type WindowMetrics = {
  /** Height of one row in px. */
  rowHeight: number;
  /** Vertical gap between rows in px (grid/flex `row-gap`). */
  rowGap: number;
  /** Items per row. */
  columns: number;
  /** Distance from the top of the scroll content to the first row, in px. */
  offset: number;
};

export type WindowInput = WindowMetrics & {
  count: number;
  scrollTop: number;
  viewportHeight: number;
  overscanRows: number;
  /** Rows are quantized to this many so scrolling commits only every few rows. */
  step?: number;
  /** An item that must stay mounted (e.g. the row being dragged). */
  pinnedIndex?: number | null;
};

export type WindowRange = {
  rows: number;
  startRow: number;
  endRow: number;
  /** First rendered item (inclusive). */
  start: number;
  /** Last rendered item (exclusive). */
  end: number;
  /** Height of the spacer before the first rendered row; 0 means render none. */
  topSpace: number;
  /** Height of the spacer after the last rendered row; 0 means render none. */
  bottomSpace: number;
};

const DEFAULT_STEP = 4;

function clamp(value: number, low: number, high: number) {
  return Math.min(high, Math.max(low, value));
}

export function computeWindow(input: WindowInput): WindowRange {
  const { count, columns, rowHeight, rowGap, offset, scrollTop, viewportHeight } = input;
  const step = Math.max(1, input.step ?? DEFAULT_STEP);
  const safeColumns = Math.max(1, Math.floor(columns));
  const rows = Math.ceil(count / safeColumns);
  if (count <= 0 || rows === 0) {
    return { rows: 0, startRow: 0, endRow: 0, start: 0, end: 0, topSpace: 0, bottomSpace: 0 };
  }

  const pitch = Math.max(1, rowHeight + rowGap);
  const visibleTop = scrollTop - offset;
  const visibleBottom = visibleTop + Math.max(0, viewportHeight);
  let startRow = Math.floor(visibleTop / pitch) - input.overscanRows;
  let endRow = Math.ceil(visibleBottom / pitch) + input.overscanRows;

  startRow = clamp(Math.floor(startRow / step) * step, 0, rows - 1);
  endRow = clamp(Math.ceil(endRow / step) * step, startRow + 1, rows);

  if (input.pinnedIndex !== undefined && input.pinnedIndex !== null && input.pinnedIndex >= 0) {
    const pinnedRow = clamp(Math.floor(input.pinnedIndex / safeColumns), 0, rows - 1);
    startRow = Math.min(startRow, pinnedRow);
    endRow = Math.max(endRow, pinnedRow + 1);
  }

  // A spacer is its own row in a grid/flex layout, so the gap that follows (or
  // precedes) it is already accounted for and must be subtracted once.
  const rowsAbove = startRow;
  const rowsBelow = rows - endRow;
  return {
    rows,
    startRow,
    endRow,
    start: startRow * safeColumns,
    end: Math.min(count, endRow * safeColumns),
    topSpace: rowsAbove > 0 ? Math.max(0, rowsAbove * pitch - rowGap) : 0,
    bottomSpace: rowsBelow > 0 ? Math.max(0, rowsBelow * pitch - rowGap) : 0,
  };
}

export function sameRange(a: WindowRange, b: WindowRange) {
  return (
    a.rows === b.rows &&
    a.startRow === b.startRow &&
    a.endRow === b.endRow &&
    a.start === b.start &&
    a.end === b.end &&
    a.topSpace === b.topSpace &&
    a.bottomSpace === b.bottomSpace
  );
}

export function sameMetrics(a: WindowMetrics, b: WindowMetrics) {
  return (
    Math.abs(a.rowHeight - b.rowHeight) < 0.5 &&
    Math.abs(a.rowGap - b.rowGap) < 0.5 &&
    a.columns === b.columns &&
    Math.abs(a.offset - b.offset) < 1
  );
}

/** Number of tracks in a computed `grid-template-columns` value. */
export function countGridColumns(computedTemplate: string | undefined | null) {
  if (!computedTemplate || computedTemplate === "none") return 1;
  // Resolved values list one length per track, e.g. "150px 150px 150px".
  // Strip any function arguments defensively before counting tokens.
  const flattened = computedTemplate.replace(/\([^)]*\)/g, "x").trim();
  const tracks = flattened.split(/\s+/).filter(Boolean).length;
  return Math.max(1, tracks);
}

/**
 * The scroll offset that keeps the same item at the top of the viewport after
 * the layout metrics change (window resize, first real measurement).
 */
export function anchoredScrollTop(
  scrollTop: number,
  before: WindowMetrics,
  after: WindowMetrics,
) {
  const beforePitch = Math.max(1, before.rowHeight + before.rowGap);
  const afterPitch = Math.max(1, after.rowHeight + after.rowGap);
  const anchorItem = Math.max(0, ((scrollTop - before.offset) / beforePitch) * before.columns);
  return Math.max(0, after.offset + (anchorItem / after.columns) * afterPitch);
}
