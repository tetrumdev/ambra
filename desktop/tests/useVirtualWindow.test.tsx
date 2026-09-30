import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window as HappyWindow } from "happy-dom";
import { useVirtualWindow } from "../src/hooks/useVirtualWindow";
import { setMeasurerForTests, type Measurer } from "../src/utils/virtualMeasure";

let root: Root | null = null;
let mount: HTMLDivElement;

beforeAll(() => {
  const browser = new HappyWindow({ url: "http://localhost" });
  Object.assign(globalThis, {
    window: browser,
    document: browser.document,
    HTMLElement: browser.HTMLElement,
    Event: browser.Event,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  mount?.remove();
  setMeasurerForTests();
});

function Harness({ count }: { count: number }) {
  const probeRef = useRef<HTMLDivElement>(null);
  const range = useVirtualWindow({
    count,
    enabled: true,
    probeRef,
    probeIsContainer: false,
    fallback: { rowHeight: 76 },
    cacheKey: "hook-test",
    overscanRows: 10,
  });
  return (
    <div data-list="">
      <div ref={probeRef} />
      {range.topSpace > 0 && <div data-virtual-spacer="top" style={{ height: range.topSpace }} />}
      {Array.from({ length: range.end - range.start }, (_, offset) => (
        <div data-virtual-item="" data-index={range.start + offset} key={range.start + offset} />
      ))}
      {range.bottomSpace > 0 && <div data-virtual-spacer="bottom" style={{ height: range.bottomSpace }} />}
    </div>
  );
}

describe("useVirtualWindow", () => {
  test("keeps a huge DOM bounded and updates its absolute range on scroll", async () => {
    let scrollTop = 0;
    let scrollListenerRemoved = false;
    const scroller = document.createElement("div");
    const removeEventListener = scroller.removeEventListener.bind(scroller);
    scroller.removeEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions) => {
      if (type === "scroll") scrollListenerRemoved = true;
      removeEventListener(type, listener, options);
    }) as typeof scroller.removeEventListener;
    const measurer: Measurer = {
      findScroller: () => scroller,
      scrollTop: () => scrollTop,
      viewportHeight: () => 800,
      setScrollTop: (_target, value) => { scrollTop = value; },
      measure: () => ({ rowHeight: 76, rowGap: 0, columns: 1, offset: 0 }),
    };
    setMeasurerForTests(measurer);

    mount = document.createElement("div");
    scroller.append(mount);
    document.body.append(scroller);
    root = createRoot(mount);
    await act(async () => root?.render(<Harness count={100_000} />));

    const renderedAtTop = mount.querySelectorAll("[data-virtual-item]");
    expect(renderedAtTop.length).toBeLessThan(40);
    expect(renderedAtTop[0]?.getAttribute("data-index")).toBe("0");

    scrollTop = 380_000;
    await act(async () => scroller.dispatchEvent(new Event("scroll")));

    const renderedAfterScroll = mount.querySelectorAll("[data-virtual-item]");
    expect(renderedAfterScroll.length).toBeLessThan(50);
    expect(Number(renderedAfterScroll[0]?.getAttribute("data-index"))).toBeGreaterThan(4_900);
    expect(mount.querySelector('[data-virtual-spacer="top"]')).not.toBeNull();
    expect(mount.querySelector('[data-virtual-spacer="bottom"]')).not.toBeNull();

    await act(async () => root?.unmount());
    root = null;
    expect(scrollListenerRemoved).toBe(true);
  });
});
