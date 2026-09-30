import { describe, expect, test } from "bun:test";
import {
  anchoredScrollTop,
  computeWindow,
  countGridColumns,
  sameMetrics,
  type WindowInput,
} from "../src/utils/virtualWindow";

const list = (overrides: Partial<WindowInput> = {}): WindowInput => ({
  count: 10_000,
  rowHeight: 76,
  rowGap: 0,
  columns: 1,
  offset: 300,
  scrollTop: 0,
  viewportHeight: 800,
  overscanRows: 10,
  step: 4,
  ...overrides,
});

describe("computeWindow", () => {
  test("a huge list at the top renders only a screenful plus overscan", () => {
    const range = computeWindow(list());
    expect(range.start).toBe(0);
    expect(range.end).toBeLessThan(40);
    expect(range.topSpace).toBe(0);
    expect(range.bottomSpace).toBe((10_000 - range.end) * 76);
  });

  test("spacers always preserve the total scrollable height", () => {
    for (const scrollTop of [0, 1, 999, 12_345, 400_000, 759_000]) {
      const range = computeWindow(list({ scrollTop }));
      const rendered = (range.end - range.start) * 76;
      expect(range.topSpace + rendered + range.bottomSpace).toBe(10_000 * 76);
    }
  });

  test("the visible rows are always inside the rendered range", () => {
    for (const scrollTop of [0, 5_000, 123_456, 700_000]) {
      const range = computeWindow(list({ scrollTop }));
      const firstVisible = Math.floor((scrollTop - 300) / 76);
      const lastVisible = Math.ceil((scrollTop - 300 + 800) / 76);
      expect(range.start).toBeLessThanOrEqual(Math.max(0, firstVisible));
      expect(range.end).toBeGreaterThanOrEqual(Math.min(10_000, lastVisible));
    }
  });

  test("the rendered count stays bounded regardless of list size", () => {
    const counts = [1_000, 10_000, 100_000, 500_000].map((count) => {
      const range = computeWindow(list({ count, scrollTop: Math.floor(count * 38) }));
      return range.end - range.start;
    });
    expect(Math.max(...counts)).toBeLessThan(45);
    expect(new Set(counts).size).toBeLessThanOrEqual(2);
  });

  test("quantization means small scrolls do not change the range", () => {
    const base = computeWindow(list({ scrollTop: 50_000 }));
    let changes = 0;
    let previous = base;
    for (let scrollTop = 50_000; scrollTop < 50_000 + 76 * 40; scrollTop += 8) {
      const next = computeWindow(list({ scrollTop }));
      if (next.startRow !== previous.startRow || next.endRow !== previous.endRow) changes++;
      previous = next;
    }
    // 40 rows scrolled, committing once per 4-row step, for each edge.
    expect(changes).toBeLessThanOrEqual(22);
  });

  test("the end of the list clamps", () => {
    const range = computeWindow(list({ count: 500, scrollTop: 500 * 76 + 300 + 99 }));
    expect(range.end).toBe(500);
    expect(range.bottomSpace).toBe(0);
    expect(range.endRow).toBeGreaterThan(range.startRow);
  });

  test("empty and tiny lists", () => {
    expect(computeWindow(list({ count: 0 })).end).toBe(0);
    const one = computeWindow(list({ count: 1 }));
    expect([one.start, one.end, one.topSpace, one.bottomSpace]).toEqual([0, 1, 0, 0]);
  });

  test("a pinned row stays mounted while the viewport is far away", () => {
    const range = computeWindow(list({ scrollTop: 300_000, pinnedIndex: 12 }));
    expect(range.start).toBeLessThanOrEqual(12);
    expect(range.end).toBeGreaterThan(12);
    const rendered = (range.end - range.start) * 76;
    expect(range.topSpace + rendered + range.bottomSpace).toBe(10_000 * 76);
  });
});

describe("grid windows", () => {
  const grid = (overrides: Partial<WindowInput> = {}): WindowInput =>
    list({ count: 5_003, columns: 6, rowHeight: 204, rowGap: 28, offset: 400, overscanRows: 3, ...overrides });

  test("items map to whole rows and spacers account for row gaps", () => {
    const range = computeWindow(grid({ scrollTop: 60_000 }));
    expect(range.start % 6).toBe(0);
    const renderedRows = range.endRow - range.startRow;
    // spacer rows add one gap each when present.
    const spacers = (range.topSpace > 0 ? 1 : 0) + (range.bottomSpace > 0 ? 1 : 0);
    const gaps = renderedRows - 1 + spacers;
    const total = range.topSpace + range.bottomSpace + renderedRows * 204 + gaps * 28;
    const rows = Math.ceil(5_003 / 6);
    expect(total).toBe(rows * 204 + (rows - 1) * 28);
  });

  test("the last partial row is included at the end", () => {
    const range = computeWindow(grid({ scrollTop: 10_000_000 }));
    expect(range.end).toBe(5_003);
  });

  test("a pinned grid item pulls in its whole row", () => {
    const range = computeWindow(grid({ scrollTop: 100_000, pinnedIndex: 7 }));
    expect(range.start).toBeLessThanOrEqual(6);
    expect(range.end).toBeGreaterThan(7);
  });
});

describe("helpers", () => {
  test("counts resolved grid tracks", () => {
    expect(countGridColumns("150px 150px 150px 150px")).toBe(4);
    expect(countGridColumns("none")).toBe(1);
    expect(countGridColumns("")).toBe(1);
    expect(countGridColumns(undefined)).toBe(1);
    expect(countGridColumns("repeat(3, 100px)")).toBe(1);
    expect(countGridColumns("60px 312.5px 160px 200px 88px 40px")).toBe(6);
  });

  test("metric comparison tolerates sub-pixel noise only", () => {
    const base = { rowHeight: 76, rowGap: 0, columns: 1, offset: 300 };
    expect(sameMetrics(base, { ...base, rowHeight: 76.2, offset: 300.4 })).toBe(true);
    expect(sameMetrics(base, { ...base, rowHeight: 77 })).toBe(false);
    expect(sameMetrics(base, { ...base, columns: 2 })).toBe(false);
  });

  test("scroll anchoring keeps the same item at the top when metrics change", () => {
    const before = { rowHeight: 200, rowGap: 28, columns: 6, offset: 400 };
    const after = { rowHeight: 230, rowGap: 28, columns: 5, offset: 400 };
    const scrollTop = 400 + 100 * 228; // top of row 100 => item 600
    const adjusted = anchoredScrollTop(scrollTop, before, after);
    expect(adjusted).toBe(400 + (600 / 5) * 258);
    // Unchanged metrics are a no-op.
    expect(anchoredScrollTop(scrollTop, before, before)).toBe(scrollTop);
    // Above the list clamps at the first row instead of going negative.
    expect(anchoredScrollTop(10, before, after)).toBeGreaterThanOrEqual(0);
  });
});
