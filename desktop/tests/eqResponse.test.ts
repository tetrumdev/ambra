import { describe, expect, test } from "bun:test";
import { bandResponseDb, clippingRiskDb, eqResponseDb, maxBoostDb } from "../src/utils/eqResponse";
import type { EqBand } from "../src/utils/audioSettings";

const band = (fields: Partial<EqBand>): EqBand => ({ enabled: true, kind: "peak", frequency: 1000, gainDb: 6, q: 1, ...fields });

describe("EQ response", () => {
  test("a peak reaches its gain at its frequency and fades away from it", () => {
    expect(bandResponseDb(band({}), 1000)).toBeCloseTo(6, 6);
    expect(Math.abs(bandResponseDb(band({}), 20))).toBeLessThan(0.1);
    expect(Math.abs(bandResponseDb(band({}), 20_000))).toBeLessThan(0.5);
  });

  test("shelves hold their gain on their own side", () => {
    expect(bandResponseDb(band({ kind: "lowShelf", frequency: 200, gainDb: -4, q: 0.7 }), 20)).toBeCloseTo(-4, 1);
    expect(Math.abs(bandResponseDb(band({ kind: "lowShelf", frequency: 200, gainDb: -4, q: 0.7 }), 10_000))).toBeLessThan(0.05);
    expect(bandResponseDb(band({ kind: "highShelf", frequency: 4000, gainDb: 3, q: 0.7 }), 20_000)).toBeCloseTo(3, 0);
  });

  test("disabled and flat bands, like the engine, change nothing", () => {
    expect(eqResponseDb([band({ enabled: false }), band({ gainDb: 0 })], 1000)).toBe(0);
  });

  test("headroom covers the largest boost", () => {
    const bands = [band({ gainDb: 6 }), band({ frequency: 1100, gainDb: 3 })];
    const boost = maxBoostDb(bands);
    expect(boost).toBeGreaterThan(8);
    expect(clippingRiskDb({ bands, headroomDb: 0 })).toBeCloseTo(boost, 6);
    expect(clippingRiskDb({ bands, headroomDb: Math.ceil(boost) })).toBe(0);
  });
});
