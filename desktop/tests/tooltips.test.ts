import { expect, test } from "bun:test";
import { placeTooltip } from "../src/utils/tooltips";

const viewport = { width: 1440, height: 900 };
const size = { width: 60, height: 22 };

test("hover tooltips sit just below the cursor", () => {
  expect(placeTooltip({ x: 600, top: 400, bottom: 400, align: "cursor" }, size, viewport)).toEqual({
    left: 600, top: 420,
  });
});

test("hover tooltips flip above the cursor at the bottom of the window", () => {
  expect(placeTooltip({ x: 600, top: 880, bottom: 880, align: "cursor" }, size, viewport).top).toBe(852);
});

test("focus tooltips sit centered under the focused control", () => {
  expect(placeTooltip({ x: 622, top: 20, bottom: 60, align: "center" }, size, viewport)).toEqual({
    left: 592, top: 66,
  });
});

test("tooltips stay inside the window edges", () => {
  expect(placeTooltip({ x: 1430, top: 400, bottom: 400, align: "cursor" }, size, viewport).left).toBe(1372);
  expect(placeTooltip({ x: 2, top: 400, bottom: 400, align: "center" }, size, viewport).left).toBe(8);
});
