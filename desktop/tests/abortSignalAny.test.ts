import { describe, expect, test } from "bun:test";
import { installStrongAbortSignalAny, strongAbortSignalAny } from "../src/utils/abortSignalAny";

describe("strongAbortSignalAny", () => {
  test("aborts with the first source's reason", () => {
    const first = new AbortController();
    const second = new AbortController();
    const combined = strongAbortSignalAny([first.signal, second.signal]);
    expect(combined.aborted).toBe(false);
    second.abort("second");
    expect(combined.aborted).toBe(true);
    expect(combined.reason).toBe("second");
    first.abort("first");
    expect(combined.reason).toBe("second");
  });

  test("starts aborted when a source already is", () => {
    const done = new AbortController();
    done.abort("early");
    const combined = strongAbortSignalAny([new AbortController().signal, done.signal]);
    expect(combined.aborted).toBe(true);
    expect(combined.reason).toBe("early");
  });

  test("passes an abort through nested combinations", () => {
    const root = new AbortController();
    const inner = strongAbortSignalAny([root.signal, new AbortController().signal]);
    const outer = strongAbortSignalAny([strongAbortSignalAny([inner]), new AbortController().signal]);
    root.abort();
    expect(outer.aborted).toBe(true);
    expect((outer.reason as DOMException).name).toBe("AbortError");
  });

  test("replaces the built-in only for WebKit", () => {
    const builtIn = AbortSignal.any;
    try {
      installStrongAbortSignalAny("Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 Edg/130.0");
      expect(AbortSignal.any).toBe(builtIn);
      installStrongAbortSignalAny("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko)");
      expect(AbortSignal.any).toBe(strongAbortSignalAny);
    } finally {
      AbortSignal.any = builtIn;
    }
  });
});
