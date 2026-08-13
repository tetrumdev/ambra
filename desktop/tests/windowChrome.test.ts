import { describe, expect, test } from "bun:test";
import { canUseWindowDragRegion } from "../src/utils/windowChrome";

describe("window drag regions", () => {
  test("are available on macOS-style windowed layouts", () => {
    expect(canUseWindowDragRegion("other", false)).toBe(true);
  });

  test("are absent on Windows", () => {
    expect(canUseWindowDragRegion("windows", false)).toBe(false);
  });

  test("are absent in fullscreen and before fullscreen state is known", () => {
    expect(canUseWindowDragRegion("other", true)).toBe(false);
    expect(canUseWindowDragRegion("other", null)).toBe(false);
  });
});
