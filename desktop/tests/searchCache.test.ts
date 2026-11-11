import { afterAll, beforeAll, expect, test } from "bun:test";
import { SearchCache } from "../src/utils/searchCache";

const builtIn = globalThis.structuredClone;
beforeAll(() => {
  // As in WebKit, where structuredClone throws unless it is called as a plain function or on the window.
  globalThis.structuredClone = function <T>(this: unknown, value: T) {
    if (this !== undefined && this !== globalThis) throw new TypeError("Can only call Window.structuredClone on instances of Window");
    return builtIn(value);
  } as typeof structuredClone;
});
afterAll(() => { globalThis.structuredClone = builtIn; });

test("cached pages are stored and read as copies", () => {
  const cache = new SearchCache<{ artists: string[] }>();
  const page = { artists: ["One"] };
  cache.set("query", page);
  page.artists.push("changed after caching");

  const read = cache.get("query")!;
  expect(read).toEqual({ artists: ["One"] });
  read.artists.push("changed by a reader");
  expect(cache.get("query")).toEqual({ artists: ["One"] });
});

test("values nothing changes can be shared instead of copied", () => {
  const cache = new SearchCache<{ lines: string[] }>(60_000, 4, (value) => value);
  const lyrics = { lines: ["a"] };
  cache.set("song", lyrics);
  expect(cache.get("song")).toBe(lyrics);
});
