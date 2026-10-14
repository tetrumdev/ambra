import { describe, expect, test } from "bun:test";
import {
  COVER_EDGE_ZONES,
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
    const edges = coverEdgeLuminances(sample(16, (_, y) => y < 8 ? 255 : 0), 16);
    expect(edges).toHaveLength(COVER_EDGE_ZONES * 4);
    const side = (index: number) => edges.filter((_, entry) => entry % 4 === index);
    const [top, right, bottom, left] = [0, 1, 2, 3].map(side);
    top.forEach(zone => expect(zone).toBeCloseTo(1));
    bottom.forEach(zone => expect(zone).toBeCloseTo(0));
    // The sides run top to bottom, so they cross from white to black.
    for (const edge of [right, left]) {
      expect(edge.slice(0, COVER_EDGE_ZONES / 2).every(zone => zone > 0.99)).toBe(true);
      expect(edge.slice(COVER_EDGE_ZONES / 2).every(zone => zone < 0.01)).toBe(true);
    }
  });

  test("measures zones along a side separately", () => {
    // White left half, black right half: the top edge changes partway along.
    const edges = coverEdgeLuminances(sample(16, x => x < 8 ? 255 : 0), 16);
    const top = edges.filter((_, entry) => entry % 4 === 0);
    expect(top[0]).toBeCloseTo(1);
    expect(top[COVER_EDGE_ZONES - 1]).toBeCloseTo(0);
  });

  const zones = (value: number) => Array(COVER_EDGE_ZONES * 4).fill(value);

  test("deepens a dark field beside a light edge and lifts a light one beside a dark edge", () => {
    expect(coverSeparation(zones(0.9), ["#202020", "#202020", "#202020", "#202020"], [1, 1, 1, 1]).directions)
      .toEqual(zones(-1));
    expect(coverSeparation(zones(0.05), ["#d0d0d0", "#d0d0d0", "#d0d0d0", "#d0d0d0"], [1, 1, 1, 1]).directions)
      .toEqual(zones(1));
  });

  test("uses headroom when the field matches the edge", () => {
    const dark = ["#151515", "#151515", "#151515", "#151515"];
    const light = ["#eeeeee", "#eeeeee", "#eeeeee", "#eeeeee"];
    expect(coverSeparation(null, dark, [1, 0, 0, 0]).directions).toEqual(zones(1));
    expect(coverSeparation(null, light, [1, 0, 0, 0]).directions).toEqual(zones(-1));
  });

  test("never pushes past black or white beside an extreme edge", () => {
    const white = ["#ffffff", "#ffffff", "#ffffff", "#ffffff"];
    const black = ["#000000", "#000000", "#000000", "#000000"];
    expect(coverSeparation(zones(0.95), white, [1, 1, 1, 1]).directions).toEqual(zones(-1));
    expect(coverSeparation(zones(0.05), black, [1, 1, 1, 1]).directions).toEqual(zones(1));
  });

  test("shadows a mid-tone cover that matches its field", () => {
    const red = ["#9a4639", "#9a4639", "#9a4639", "#9a4639"];
    expect(coverSeparation(null, red, [1, 0, 0, 0]).directions).toEqual(zones(-1));
  });

  test("stays neutral without a palette", () => {
    expect(coverSeparation(zones(1), [], [])).toBe(neutralCoverSeparation);
  });
});
