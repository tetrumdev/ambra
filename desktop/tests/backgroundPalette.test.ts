import { describe, expect, test } from "bun:test";
import { separateCollapsedPalette } from "../src/utils/backgroundPalette";

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
