import { describe, expect, test } from "bun:test";
import { MINI_HEIGHT, NAVIGATION_HEIGHT, playerFrame, playerLayout } from "../../mobile/src/playerGeometry";

const phones = [
  { width: 320, height: 568, top: 20, bottom: 0 },
  { width: 375, height: 667, top: 20, bottom: 0 },
  { width: 390, height: 844, top: 59, bottom: 34 },
  { width: 430, height: 932, top: 59, bottom: 34 },
  { width: 768, height: 1024, top: 24, bottom: 20 },
];

describe("continuous player geometry", () => {
  test("lyrics mode uses the same artwork in a compact header and keeps transport below the lyric viewport", () => {
    for (const phone of phones) {
      const layout = playerLayout(phone.width, phone.height, phone.top, phone.bottom);
      for (const scale of [1, 0.9]) {
        const compact = playerFrame(layout, 0, scale, 1);
        const header = playerFrame(layout, 1, scale, 1);
        expect(compact.artSize).toBe(44);
        expect(compact.textLeft).toBe(66);
        expect(compact.textOpacity).toBe(1);
        expect(header.artSize).toBeCloseTo(56);
        expect(header.artLeft).toBeCloseTo(30);
        expect(header.textLeft).toBe(100);
        expect(header.textTop + 41).toBeLessThan(layout.lyricsTop);
        expect(layout.lyricsTop + layout.lyricsHeight).toBeLessThan(layout.lyricsProgressTop);
        expect(layout.lyricsProgressTop + 36).toBeLessThan(layout.lyricsControlsTop);
        expect(layout.lyricsControlsTop + 50).toBeLessThan(phone.height - phone.bottom - 52);
      }
    }
  });
  test("collapsed artwork stays 44 points and aligns with the mini-player, including when paused", () => {
    for (const phone of phones) {
      const layout = playerLayout(phone.width, phone.height, phone.top, phone.bottom);
      for (const scale of [1, 0.9]) {
        const f = playerFrame(layout, 0, scale);
        expect(f.height).toBe(MINI_HEIGHT);
        expect(f.left + f.artLeft).toBe(18);
        expect(f.artSize).toBe(44);
        expect(f.artTop).toBe((MINI_HEIGHT - f.artSize) / 2);
        expect(phone.height - f.top - f.height).toBe(phone.bottom + NAVIGATION_HEIGHT + 8);
        expect(f.textLeft).toBe(f.artLeft + f.artSize + 12);
        expect(f.textWidth).toBeGreaterThan(0);
      }
    }
  });

  test("expanded artwork centers while paused without shifting metadata, progress or controls", () => {
    for (const phone of phones) {
      const layout = playerLayout(phone.width, phone.height, phone.top, phone.bottom);
      const playing = playerFrame(layout, 1);
      const paused = playerFrame(layout, 1, 0.9);
      expect(playing.left).toBe(0);
      expect(playing.top).toBe(0);
      expect(playing.width).toBe(phone.width);
      expect(playing.height).toBe(phone.height);
      expect(playing.artLeft + playing.artSize / 2).toBeCloseTo(phone.width / 2);
      expect(paused.artLeft + paused.artSize / 2).toBeCloseTo(phone.width / 2);
      expect(paused.artTop + paused.artSize / 2).toBeCloseTo(playing.artTop + playing.artSize / 2);
      expect(paused.textTop).toBeCloseTo(playing.textTop);
      expect(playing.textTop).toBeCloseTo(playing.artTop + playing.artSize + 40);
      expect(playing.textLeft).toBeCloseTo(30);
      expect(playing.textWidth).toBeCloseTo(phone.width - 60);
      expect(layout.controlsTop).toBeGreaterThan(layout.progressTop + 36);
      expect(layout.controlsTop + 50).toBeLessThan(phone.height - phone.bottom - 52);
    }
  });

  test("artwork stays inside its surface and text changes placement only while faded out", () => {
    for (const phone of phones) {
      const layout = playerLayout(phone.width, phone.height, phone.top, phone.bottom);
      for (const scale of [1, 0.9]) {
        for (let step = 0; step <= 100; step++) {
          const f = playerFrame(layout, step / 100, scale);
          expect(f.left).toBeGreaterThanOrEqual(0);
          expect(f.left + f.width).toBeLessThanOrEqual(phone.width + 0.001);
          expect(f.top + f.height).toBeLessThanOrEqual(phone.height + 0.001);
          expect(f.artLeft).toBeGreaterThanOrEqual(0);
          expect(f.artTop).toBeGreaterThanOrEqual(0);
          expect(f.artLeft + f.artSize).toBeLessThanOrEqual(f.width + 0.001);
          expect(f.artTop + f.artSize).toBeLessThanOrEqual(f.height + 0.001);
          expect(f.textTop + 50).toBeLessThanOrEqual(f.height + 0.001);
          expect(f.textWidth).toBeGreaterThan(0);
          expect(f.textOpacity).toBeGreaterThanOrEqual(0);
          expect(f.textOpacity).toBeLessThanOrEqual(1);
          if (f.expansion >= 0.22 && f.expansion <= 0.45) expect(f.textOpacity).toBe(0);
          if (f.textExpanded && f.textOpacity > 0) expect(f.textTop).toBeGreaterThanOrEqual(f.artTop + f.artSize);
          if (!f.textExpanded) expect(f.textLeft).toBe(66);
        }
      }
    }
  });
});
