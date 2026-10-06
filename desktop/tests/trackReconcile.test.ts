import { describe, expect, test } from "bun:test";
import { reconcileServerLibrary, reconcileTracks } from "../src/utils/trackReconcile";

type T = { globalId: string; name: string; artists: { name: string }[] };
const track = (id: string, name = id): T => ({ globalId: id, name, artists: [{ name: "a" }] });
const clone = (tracks: T[]) => JSON.parse(JSON.stringify(tracks)) as T[];

describe("reconcileTracks", () => {
  test("returns the previous array when a response is identical", () => {
    const previous = [track("a"), track("b")];
    expect(reconcileTracks(previous, clone(previous))).toBe(previous);
  });

  test("ignores key order differences between cached and fresh objects", () => {
    const previous = [track("a")];
    const reordered = [{ artists: [{ name: "a" }], name: "a", globalId: "a" }];
    expect(reconcileTracks(previous, reordered)).toBe(previous);
  });

  test("keeps identity of unchanged tracks and adopts changed and new ones", () => {
    const previous = [track("a"), track("b")];
    const next = [...clone(previous), track("c")];
    next[1] = track("b", "renamed");
    const result = reconcileTracks(previous, next);
    expect(result).not.toBe(previous);
    expect(result[0]).toBe(previous[0]);
    expect(result[1]).toBe(next[1]);
    expect(result.map((item) => item.globalId)).toEqual(["a", "b", "c"]);
  });

  test("a reorder is a change, but tracks keep their identity", () => {
    const previous = [track("a"), track("b")];
    const result = reconcileTracks(previous, clone(previous).reverse());
    expect(result).not.toBe(previous);
    expect(result[0]).toBe(previous[1]);
    expect(result[1]).toBe(previous[0]);
  });

  test("removals shrink the list", () => {
    const previous = [track("a"), track("b")];
    const result = reconcileTracks(previous, clone(previous).slice(0, 1));
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(previous[0]);
  });

  test("empty stays empty without a state change", () => {
    const previous: T[] = [];
    expect(reconcileTracks(previous, [])).toBe(previous);
    const incoming = [track("a")];
    expect(reconcileTracks(previous, incoming)).toBe(incoming);
  });

  test("a 100,000-track identical response reconciles quickly", () => {
    const previous = Array.from({ length: 100_000 }, (_, index) => track(`t${index}`));
    const next = clone(previous);
    const started = performance.now();
    const result = reconcileTracks(previous, next);
    const elapsed = performance.now() - started;
    console.log(`reconcile 100k identical tracks: ${elapsed.toFixed(0)} ms`);
    expect(result).toBe(previous);
    expect(elapsed).toBeLessThan(2000);
  });
});

describe("reconcileServerLibrary", () => {
  test("keeps cached copies of saved tracks the server could not load", () => {
    const previous = [track("a"), track("b"), track("c")];
    const result = reconcileServerLibrary(previous, clone([previous[0]]), new Set(["b"]));
    expect(result.map((item) => item.globalId)).toEqual(["a", "b"]);
    expect(result[1]).toBe(previous[1]);
  });

  test("is a plain reconcile when everything loaded", () => {
    const previous = [track("a"), track("b")];
    expect(reconcileServerLibrary(previous, clone(previous), new Set())).toBe(previous);
  });
});
