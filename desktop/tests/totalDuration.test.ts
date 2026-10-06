import { expect, test } from "bun:test";
import { formatTotalDuration } from "../src/utils/totalDuration";

test("collection lengths read like the library overview", () => {
  expect(formatTotalDuration(21_063)).toBe("5 hr 51 min");
  expect(formatTotalDuration(7_200)).toBe("2 hr");
  expect(formatTotalDuration(2_530)).toBe("42 min");
  expect(formatTotalDuration(38)).toBe("38 sec");
});
