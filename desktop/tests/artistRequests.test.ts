import { expect, test } from "bun:test";
import { cachedArtistAlbums, cachedArtistProfile, loadArtistAlbums, loadArtistProfile, thumbnailArtwork, thumbnailSource, type CatalogArtist } from "../src/api/server";
import { cachedArtistImage, rememberArtistImage, resolveArtistImage, subscribeArtistImages } from "../src/utils/artistImages";
import { libraryAlbums } from "../src/utils/librarySections";
import { track } from "./searchFixture";

const artist = (id: string, provider: CatalogArtist["provider"] = "qobuz"): CatalogArtist => ({ id: `${provider}:${id}`, provider, name: "Same name", imageUrl: null });
const profile = (artist: CatalogArtist) => ({ artist, biography: null, biographySource: null, popularTracks: [], popularTracksError: null });

test("cards and track rows share persistent thumbnails; local covers stay local", () => {
  for (const [provider, source] of [
    ["qobuz", "https://static.qobuz.com/images/cover_600.jpg"],
    ["tidal", "https://resources.tidal.com/images/id/750x750.jpg"],
    ["spotify", "https://i.scdn.co/image/id"],
  ] as const) {
    const song = track(`${provider}:thumb`, provider, { albumId: "thumb", cover: source, nativeCover: source });
    expect(thumbnailSource(source)).toBe(thumbnailArtwork(song));
    expect(libraryAlbums([song])[0].cover).toBe(thumbnailArtwork(song));
    expect(thumbnailSource(thumbnailSource(source))).toBe(thumbnailSource(source));
  }
  expect(thumbnailSource("asset:///cover.jpg")).toBe("asset:///cover.jpg");
  expect(thumbnailSource("https://other.example/cover.jpg")).toBe("https://other.example/cover.jpg");
});

test("portrait cache restores URLs and uses provider identities without catalog searches", async () => {
  const originalFetch = globalThis.fetch;
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const stored = new Map<string, string>();
  const restored = artist("portrait-restored");
  stored.set("ambra.artist-portraits.v1", JSON.stringify([[restored.id, { image: "restored.jpg", until: Date.now() + 60_000 }]]));
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => { stored.set(key, value); },
  } });
  const requests: string[] = [];
  globalThis.fetch = (async input => {
    requests.push(String(input));
    const provider = String(input).includes("/tidal/") ? "tidal" : "qobuz";
    const id = String(input).split("/artists/")[1].split("/")[0];
    return Response.json({ ...artist(id, provider), imageUrl: `${provider}-${id}.jpg` });
  }) as typeof fetch;
  let notifications = 0;
  const unsubscribe = subscribeArtistImages(() => notifications++);
  try {
    expect(cachedArtistImage(restored)).toBe("restored.jpg");
    expect(await resolveArtistImage(restored)).toBe("restored.jpg");
    expect(requests).toHaveLength(0);
    const one = artist("portrait-one");
    const first = resolveArtistImage(one);
    expect(resolveArtistImage(one)).toBe(first);
    expect(await first).toBe("qobuz-portrait-one.jpg");
    await resolveArtistImage(one);
    await resolveArtistImage(artist("portrait-two"));
    await resolveArtistImage(artist("portrait-one", "tidal"));
    expect(requests).toHaveLength(3);
    expect(requests.every(url => url.endsWith("/metadata"))).toBe(true);
    expect(notifications).toBe(3);
    rememberArtistImage({ ...one, imageUrl: "page-portrait.jpg" });
    expect(await resolveArtistImage(one)).toBe("page-portrait.jpg");
    expect(cachedArtistImage(artist("portrait-one", "tidal"))).toBe("tidal-portrait-one.jpg");
    expect(stored.get("ambra.artist-portraits.v1")).toContain("page-portrait.jpg");
  } finally {
    unsubscribe();
    globalThis.fetch = originalFetch;
    if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});

test("navigation reuses prefetch work even when its first consumer unmounts", async () => {
  const originalFetch = globalThis.fetch;
  const target = artist("shared-prefetch");
  let finish!: (response: Response) => void;
  let calls = 0;
  globalThis.fetch = (() => {
    calls++;
    return new Promise<Response>(resolve => { finish = resolve; });
  }) as unknown as typeof fetch;
  try {
    const controller = new AbortController();
    const prefetch = loadArtistProfile(target, controller.signal);
    controller.abort();
    const page = loadArtistProfile(target);
    finish(Response.json(profile(target)));
    await expect(prefetch).rejects.toThrow();
    expect((await page).artist.id).toBe(target.id);
    await loadArtistProfile(target);
    expect(calls).toBe(1);
    expect(cachedArtistProfile(target)?.artist.id).toBe(target.id);
    const refreshed = loadArtistProfile(target, undefined, true);
    finish(Response.json(profile(target)));
    await refreshed;
    expect(calls).toBe(2);
    const albums = loadArtistAlbums(target);
    const concurrent = loadArtistAlbums(target);
    finish(Response.json({ albums: [], nextOffset: null }));
    await Promise.all([albums, concurrent]);
    await loadArtistAlbums(target);
    expect(cachedArtistAlbums(target)?.albums).toEqual([]);
    expect(calls).toBe(3);
  } finally { globalThis.fetch = originalFetch; }
});

test("failed profile requests remain retryable", async () => {
  const originalFetch = globalThis.fetch;
  const target = artist("retry-profile");
  let fail = true;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return fail ? new Response("Unavailable", { status: 503 }) : Response.json(profile(target));
  }) as unknown as typeof fetch;
  try {
    await expect(loadArtistProfile(target)).rejects.toThrow("Unavailable");
    expect(cachedArtistProfile(target)).toBeUndefined();
    fail = false;
    await loadArtistProfile(target);
    expect(calls).toBe(2);
  } finally { globalThis.fetch = originalFetch; }
});

test("artist header bypasses queued card searches and avoids a second metadata fetch", async () => {
  const originalFetch = globalThis.fetch;
  const releases: Array<() => void> = [];
  const requested: string[] = [];
  globalThis.fetch = (async input => {
    const id = String(input).split("/artists/")[1].split("/")[0];
    requested.push(id);
    if (id.startsWith("busy-")) await new Promise<void>(resolve => releases.push(resolve));
    return Response.json({ ...artist(id), imageUrl: `${id}.jpg` });
  }) as typeof fetch;
  const background = Array.from({ length: 4 }, (_, index) => resolveArtistImage(artist(`busy-${index}`)));
  const target = artist("priority-header");
  const queued = resolveArtistImage(target);
  try {
    expect(requested).toHaveLength(4);
    expect(await resolveArtistImage(target, true)).toBe("priority-header.jpg");
    releases.forEach(release => release());
    await Promise.all([...background, queued]);
    expect(requested.filter(id => id === "priority-header")).toHaveLength(1);
  } finally {
    releases.forEach(release => release());
    await Promise.all([...background, queued]);
    globalThis.fetch = originalFetch;
  }
});
