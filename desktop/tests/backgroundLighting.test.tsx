import { afterAll, beforeAll, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { FluidGradientBackground } from "../src/components/FluidGradientBackground";
import { COVER_EDGE_ZONES } from "../src/utils/backgroundPalette";

const dom = new Window({ url: "http://localhost/" });
const frames = new Map<number, FrameRequestCallback>();
const uniforms = new Map<string, number[]>();
let frameId = 0;
const gl = new Proxy({}, {
  get: (_, property) => {
    if (property === "getUniformLocation") return (_: unknown, name: string) => name;
    if (property === "getAttribLocation") return () => 0;
    if (property === "getShaderParameter" || property === "getProgramParameter") return () => true;
    if (property === "isContextLost") return () => false;
    if (property === "uniform4fv") return (name: string, value: number[]) => uniforms.set(name, [...value]);
    if (String(property).startsWith("create")) return () => ({});
    if (/^[A-Z_0-9]+$/.test(String(property))) return 1;
    return () => {};
  },
});
beforeAll(() => {
  Object.assign(globalThis, {
    window: dom, document: dom.document, navigator: dom.navigator,
    HTMLElement: dom.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; },
    cancelAnimationFrame: (id: number) => frames.delete(id),
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  });
  Object.defineProperty(dom.document, "hidden", { value: false });
  Object.defineProperty(dom.HTMLCanvasElement.prototype, "getContext", { value: () => gl });
});
afterAll(() => { dom.happyDOM.abort(); });

async function paint(now: number) {
  await act(async () => {
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback(now);
  });
}

test("cover transitions suppress all edge corrections, resume smoothly, and stop drawing once settled", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const cover = document.createElement("div");
  cover.id = "lighting-test-cover";
  const image = document.createElement("img");
  cover.append(image);
  container.append(cover);
  let animationState: AnimationPlayState | null = null;
  cover.getAnimations = options => options?.subtree && animationState
    ? [{ playState: animationState, pending: false } as Animation] : [];
  const host = document.createElement("div");
  container.append(host);
  const root = createRoot(host);
  const directions = Array.from({ length: COVER_EDGE_ZONES * 4 }, (_, index) => index % 2 ? -1 : 1);
  const lighting = () => uniforms.get("u_edgeDirection[0]")!;
  const props = {
    colors: ["#101010", "#101010", "#101010", "#101010"], weights: [1, 0, 0, 0],
    separation: { edges: directions.map(() => 0.05), directions },
    coverId: cover.id, active: true, animate: false, playing: false,
  };
  try {
    await act(async () => root.render(<FluidGradientBackground {...props} />));
    const start = performance.now() + 10_000;
    await paint(start);
    expect(lighting()[0]).toBe(0);
    expect(lighting()[1]).toBe(-0);
    await paint(start + 150);
    expect(lighting()[0]).toBeCloseTo(0.5);
    expect(lighting()[1]).toBeCloseTo(-0.5);
    await paint(start + 300);
    expect(lighting()).toEqual(directions);
    expect(frames.size).toBe(0);

    // A sharper copy of the same cover may animate without a new palette or active swirl.
    animationState = "running";
    image.dispatchEvent(new dom.Event("animationstart", { bubbles: true }));
    expect(frames.size).toBe(1);
    await paint(start + 400);
    expect(lighting()[0]).toBe(0);
    expect(lighting()[1]).toBe(-0);
    await paint(start + 800);
    expect(lighting()[0]).toBe(0);

    // CSS fill-mode keeps finished animations attached; those must not keep the renderer running.
    animationState = "finished";
    image.dispatchEvent(new dom.Event("animationend", { bubbles: true }));
    await paint(start + 900);
    expect(lighting()[0]).toBe(0);
    await paint(start + 1050);
    expect(lighting()[0]).toBeCloseTo(0.5);
    await paint(start + 1200);
    expect(lighting()).toEqual(directions);
    expect(frames.size).toBe(0);

    await act(async () => root.unmount());
    image.dispatchEvent(new dom.Event("animationstart", { bubbles: true }));
    expect(frames.size).toBe(0);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
