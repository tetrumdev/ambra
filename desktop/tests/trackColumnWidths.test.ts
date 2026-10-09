import { describe, expect, test } from "bun:test";
import { resizeColumnPair } from "../src/utils/trackColumnWidths";

describe("track column resizing", () => {
  const widths = { track: 300, artist: 200, album: 240, duration: 90 };

  test("moves only the neighboring columns and preserves their total width", () => {
    expect(resizeColumnPair(widths, "track", "artist", 60))
      .toEqual({ track: 360, artist: 140, album: 240, duration: 90 });
    expect(widths.track).toBe(300);
  });

  test("keeps text columns readable at either drag limit", () => {
    expect(resizeColumnPair(widths, "track", "artist", 5000).artist).toBe(100);
    expect(resizeColumnPair(widths, "track", "artist", -5000).track).toBe(140);
    expect(resizeColumnPair(widths, "artist", "album", 5000).album).toBe(120);
  });

  test("bounds duration and supports the compact queue's visible neighbors", () => {
    expect(resizeColumnPair(widths, "album", "duration", 5000).duration).toBe(64);
    expect(resizeColumnPair(widths, "album", "duration", -5000).duration).toBe(180);
    expect(resizeColumnPair({ track: 300, duration: 90 }, "track", "duration", -5000))
      .toEqual({ track: 210, duration: 180 });
  });

  test("does not force overflowing minima when the viewport cannot fit them", () => {
    const small = { track: 80, duration: 64 };
    expect(resizeColumnPair(small, "track", "duration", 100)).toBe(small);
    expect(resizeColumnPair(widths, "track", "artist", NaN)).toBe(widths);
  });
});
