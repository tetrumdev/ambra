import { expect, test } from "bun:test";
import {
  cachedBigscreenArtwork,
  cachedArtwork,
  preloadArtwork,
  preloadBigscreenArtwork,
  preloadUpcomingBigscreenArtwork,
} from "../src/utils/artworkImages";
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
    expect(cachedArtwork("cover:1")).toBe(false);
    expect(preloadArtwork("cover:1")).toBe(first);
    await first;
    expect(cachedArtwork("cover:1")).toBe(true);
    expect(decodes).toBe(1);
    fail = true;
    await expect(preloadArtwork("broken")).rejects.toThrow("decode failed");
    expect(cachedArtwork("broken")).toBe(false);
    fail = false;
    await preloadArtwork("broken");
    for (let index = 0; index < 192; index++) await preloadArtwork(`next:${index}`);
    expect(cachedArtwork("cover:1")).toBe(false);
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

test("upcoming bigscreen artwork uses only resolved full-size covers", async () => {
  const originalImage = globalThis.Image;
  const originalFetch = globalThis.fetch;
  const decoded: string[] = [];
  const requests: string[] = [];
  globalThis.Image = class {
    src = "";
    decoding = "";
    async decode() { decoded.push(this.src); }
  } as unknown as typeof Image;
  globalThis.fetch = (async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as { albumId: string };
    requests.push(request.albumId);
    return Response.json({
      provider: "qobuz",
      url: `resolved:${request.albumId}`,
      width: 3000,
      height: 3000,
      colors: [],
    });
  }) as typeof fetch;

  const remoteTrack = (id: string) => track(`tidal:${id}`, "tidal", {
    albumId: id,
    cover: `thumbnail:${id}`,
    nativeCover: `https://resources.tidal.com/images/${id}/1280x1280.jpg`,
  });

  try {
    const first = remoteTrack("first");
    const second = remoteTrack("second");
    const third = remoteTrack("third");
    await preloadUpcomingBigscreenArtwork([first, second, third]);

    expect(new Set(requests)).toEqual(new Set(["first", "second"]));
    expect(new Set(decoded)).toEqual(new Set(["resolved:first", "resolved:second"]));
    expect(cachedBigscreenArtwork(first)).toBe("resolved:first");
    expect(cachedBigscreenArtwork(second)).toBe("resolved:second");
    expect(cachedBigscreenArtwork(third)).toBeNull();

    const unavailable = { ...remoteTrack("unavailable"), albumId: null };
    expect(await preloadBigscreenArtwork(unavailable)).toBeNull();
    expect(decoded).not.toContain(unavailable.cover);
    expect(cachedBigscreenArtwork(unavailable)).toBeNull();
  } finally {
    globalThis.Image = originalImage;
    globalThis.fetch = originalFetch;
  }
});
