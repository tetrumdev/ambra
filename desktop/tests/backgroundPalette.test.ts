import { describe, expect, test } from "bun:test";
import {
  coverEdgeLuminances,
  coverSeparation,
  neutralCoverSeparation,
  separateCollapsedPalette,
  softenedPaletteWeights,
} from "../src/utils/backgroundPalette";

describe("gentle background color weighting", () => {
  test("favors dark and blue while retaining a small yellow accent", () => {
    const weights = softenedPaletteWeights([0.625, 0.328125, 0.046875, 0], 4);
    expect(weights[0]).toBeGreaterThan(weights[1]);
    expect(weights[1]).toBeGreaterThan(weights[2]);
    expect(weights[2]).toBeGreaterThan(0.046875);
    expect(weights[2]).toBeLessThan(0.2);
    expect(weights[3]).toBe(0);
    expect(weights.reduce((sum, weight) => sum + weight, 0)).toBeCloseTo(1);
  });

  test("equal coverage preserves the original blend", () => {
    expect(softenedPaletteWeights([0.25, 0.25, 0.25, 0.25], 4))
      .toEqual([0.25, 0.25, 0.25, 0.25]);
  });

  test("padding gets no influence and missing coverage falls back safely", () => {
    expect(softenedPaletteWeights([1], 1)).toEqual([1, 0, 0, 0]);
    expect(softenedPaletteWeights([], 2)).toEqual([0.5, 0.5, 0, 0]);
    expect(softenedPaletteWeights([NaN, -1, Infinity, 1], 4)).toEqual([0, 0, 0, 1]);
  });
});

describe("bigscreen background palette separation", () => {
  test("moves an almost-white palette away from a white cover", () => {
    const separated = separateCollapsedPalette([
      "#ffffff",
      "#fcfcfc",
      "#efefef",
      "#f8f8f8",
    ]);
    expect(separated.every((color) => color < "#e0e0e0")).toBe(true);
    expect(new Set(separated).size).toBeGreaterThan(1);
  });

  test("moves a collapsed dark palette lighter", () => {
    const separated = separateCollapsedPalette([
      "#080808",
      "#101010",
      "#151515",
      "#0c0c0c",
    ]);
    expect(separated.every((color) => color > "#202020")).toBe(true);
  });

  test("moves a pure-black palette away from a black cover", () => {
    expect(
      separateCollapsedPalette(["#000000", "#000000", "#000000", "#000000"]),
    ).toEqual(["#1f1f1f", "#1f1f1f", "#1f1f1f", "#1f1f1f"]);
  });

  test("does not alter a varied album palette", () => {
    const colors = ["#8db8bd", "#7c888a", "#e8d624", "#e98aad"];
    expect(separateCollapsedPalette(colors)).toEqual(colors);
  });
});

describe("bigscreen cover separation", () => {
  function sample(size: number, shade: (x: number, y: number) => number) {
    const pixels = new Uint8ClampedArray(size * size * 4);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const value = shade(x, y);
        pixels.set([value, value, value, 255], (y * size + x) * 4);
      }
    }
    return pixels;
  }

  test("measures each side of the cover separately", () => {
    // White top half, black bottom half.
    const [top, right, bottom, left] = coverEdgeLuminances(
      sample(16, (_, y) => y < 8 ? 255 : 0),
      16,
    );
    expect(top).toBeCloseTo(1);
    expect(bottom).toBeCloseTo(0);
    expect(right).toBeCloseTo(0.5);
    expect(left).toBeCloseTo(0.5);
  });

  test("deepens a dark field beside a light edge and lifts a light one beside a dark edge", () => {
    expect(coverSeparation([0.9, 0.9, 0.9, 0.9], ["#202020", "#202020", "#202020", "#202020"], [1, 1, 1, 1]).directions)
      .toEqual([-1, -1, -1, -1]);
    expect(coverSeparation([0.05, 0.05, 0.05, 0.05], ["#d0d0d0", "#d0d0d0", "#d0d0d0", "#d0d0d0"], [1, 1, 1, 1]).directions)
      .toEqual([1, 1, 1, 1]);
  });

  test("uses headroom when the field matches the edge", () => {
    const dark = ["#151515", "#151515", "#151515", "#151515"];
    const light = ["#eeeeee", "#eeeeee", "#eeeeee", "#eeeeee"];
    expect(coverSeparation(null, dark, [1, 0, 0, 0]).directions).toEqual([1, 1, 1, 1]);
    expect(coverSeparation(null, light, [1, 0, 0, 0]).directions).toEqual([-1, -1, -1, -1]);
  });

  test("stays neutral without a palette", () => {
    expect(coverSeparation([1, 1, 1, 1], [], [])).toBe(neutralCoverSeparation);
  });
});
