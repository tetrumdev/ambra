import { expect, test } from "bun:test";
import { SearchCache } from "../src/utils/searchCache";

test("enrichment and callers cannot mutate a cached response", () => {
  const cache = new SearchCache<{ artists: string[] }>();
  const page = { artists: ["original"] };
  cache.set("tidal:query", page);
  page.artists.push("added by enrichment");
  cache.get("tidal:query")!.artists.push("added by caller");
  expect(cache.get("tidal:query")).toEqual({ artists: ["original"] });
  expect(cache.get("qobuz:query")).toBeUndefined();
});

test("expired entries are fetched again", async () => {
  const cache = new SearchCache<string>(5);
  cache.set("query", "result");
  await new Promise(resolve => setTimeout(resolve, 15));
  expect(cache.get("query")).toBeUndefined();
});

test("evicts the least recently used query and replaces existing entries", () => {
  const cache = new SearchCache<string>(300_000, 2);
  cache.set("a", "first");
  cache.set("b", "second");
  cache.get("a");
  cache.set("c", "third");
  expect(cache.get("b")).toBeUndefined();
  cache.set("a", "updated");
  expect(cache.get("a")).toBe("updated");
  expect(cache.get("c")).toBe("third");
});
