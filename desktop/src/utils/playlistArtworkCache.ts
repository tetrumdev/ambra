import { thumbnailArtwork } from "../api/server";
import type { Track } from "../types/music";
import { whiteArtwork } from "./artworkPlaceholder";

const DATABASE_NAME = "ambra-artwork-cache";
const DATABASE_VERSION = 1;
const STORE_NAME = "playlist-artwork";

type CachedArtwork = {
  url: string;
  blob: Blob;
  savedAt: number;
};

let databasePromise: Promise<IDBDatabase | null> | undefined;
const objectUrls = new Map<string, string>();
const cacheRequests = new Map<string, Promise<string | null>>();

function openDatabase(): Promise<IDBDatabase | null> {
  if (databasePromise) return databasePromise;
  if (typeof indexedDB === "undefined") return Promise.resolve(null);

  databasePromise = new Promise((resolve) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME, { keyPath: "url" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
  return databasePromise;
}

async function storedArtwork(url: string): Promise<CachedArtwork | null> {
  const database = await openDatabase();
  if (!database) return null;

  return new Promise((resolve) => {
    const request = database
      .transaction(STORE_NAME, "readonly")
      .objectStore(STORE_NAME)
      .get(url);
    request.onsuccess = () => resolve((request.result as CachedArtwork | undefined) ?? null);
    request.onerror = () => resolve(null);
  });
}

async function storeArtwork(entry: CachedArtwork): Promise<boolean> {
  const database = await openDatabase();
  if (!database) return false;

  return new Promise((resolve) => {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).put(entry);
    transaction.oncomplete = () => resolve(true);
    transaction.onerror = () => resolve(false);
    transaction.onabort = () => resolve(false);
  });
}

function displayUrl(url: string, blob: Blob): string | null {
  const existing = objectUrls.get(url);
  if (existing) return existing;
  if (typeof URL.createObjectURL !== "function") return null;

  const objectUrl = URL.createObjectURL(blob);
  objectUrls.set(url, objectUrl);
  return objectUrl;
}

export async function cachedPlaylistArtwork(url: string): Promise<string | null> {
  const existing = objectUrls.get(url);
  if (existing) return existing;

  const pending = cacheRequests.get(url);
  if (pending) return pending;

  const entry = await storedArtwork(url);
  return entry ? displayUrl(url, entry.blob) : null;
}

async function cacheArtwork(url: string): Promise<string | null> {
  if (!url || url === whiteArtwork || url.startsWith("data:") || url.startsWith("blob:")) {
    return url || null;
  }

  const existing = await cachedPlaylistArtwork(url);
  if (existing) return existing;

  const pending = cacheRequests.get(url);
  if (pending) return pending;

  const request = fetch(url, { cache: "force-cache" })
    .then(async (response) => {
      if (!response.ok) throw new Error(`Artwork returned HTTP ${response.status}`);
      const blob = await response.blob();
      if (!blob.type.startsWith("image/")) throw new Error("Artwork response was not an image");
      return (await storeArtwork({ url, blob, savedAt: Date.now() }))
        ? displayUrl(url, blob)
        : null;
    })
    .catch(() => null)
    .finally(() => {
      if (cacheRequests.get(url) === request) cacheRequests.delete(url);
    });
  cacheRequests.set(url, request);
  return request;
}

export async function cachePlaylistArtwork(tracks: Track[]): Promise<void> {
  const urls = [...new Set(tracks.map(thumbnailArtwork))];
  let next = 0;
  const workers = Array.from({ length: Math.min(4, urls.length) }, async () => {
    while (next < urls.length) {
      const url = urls[next++];
      await cacheArtwork(url);
    }
  });
  await Promise.all(workers);
}
