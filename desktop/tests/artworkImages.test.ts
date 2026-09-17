import { expect, test } from "bun:test";
import { cachedBigscreenArtwork, preloadArtwork, preloadBigscreenArtwork } from "../src/utils/artworkImages";
import { track } from "./searchFixture";

test("decoded artwork shares work, retries failures, and bounds thumbnail retention", async () => {
  const original = globalThis.Image;
  let decodes = 0;
  let fail = false;
  globalThis.Image = class {
    src = "";
    decoding = "";
    async decode() {
      decodes++;
      if (fail) throw new Error("decode failed");
    }
  } as unknown as typeof Image;
  try {
    const first = preloadArtwork("cover:1");
    expect(preloadArtwork("cover:1")).toBe(first);
    await first;
    expect(decodes).toBe(1);
    fail = true;
    await expect(preloadArtwork("broken")).rejects.toThrow("decode failed");
    fail = false;
    await preloadArtwork("broken");
    for (let index = 0; index < 192; index++) await preloadArtwork(`next:${index}`);
    const before = decodes;
    await preloadArtwork("cover:1");
    expect(decodes).toBe(before + 1);
    const current = preloadArtwork("current");
    await current;
    for (let index = 0; index < 5; index++) await preloadArtwork(`large:${index}`, true);
    expect(preloadArtwork("current")).toBe(current);
  } finally {
    globalThis.Image = original;
  }
});

test("known bigscreen URLs are decoded again after image eviction", async () => {
  const original = globalThis.Image;
  let decodes = 0;
  globalThis.Image = class {
    src = "";
    decoding = "";
    async decode() { decodes++; }
  } as unknown as typeof Image;
  try {
    const first = track("local:bigscreen-first", "local", { cover: "full:first" });
    await preloadBigscreenArtwork(first);
    expect(cachedBigscreenArtwork(first)).toBe(first.cover);
    for (let index = 0; index < 3; index++) {
      await preloadArtwork(`full:other-${index}`, true);
    }
    expect(cachedBigscreenArtwork(first)).toBeNull();
    const before = decodes;
    await preloadBigscreenArtwork(first);
    expect(decodes).toBe(before + 1);
    expect(cachedBigscreenArtwork(first)).toBe(first.cover);
  } finally {
    globalThis.Image = original;
  }
});
