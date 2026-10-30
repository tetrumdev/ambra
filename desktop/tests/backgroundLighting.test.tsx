import { afterAll, beforeAll, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { FluidGradientBackground } from "../src/components/FluidGradientBackground";
import { COLOR_TRANSITION_MS } from "../src/utils/swirlShader";

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
    if (property === "uniform3fv" || property === "uniform4fv") return (name: string, value: number[]) => uniforms.set(name, [...value]);
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

test("a new palette eases in, and a settled, still swirl stops drawing", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const first = ["#000000", "#000000", "#000000", "#000000"];
  const second = ["#ff0000", "#ff0000", "#ff0000", "#ff0000"];
  const red = () => uniforms.get("u_colors[0]")![0];
  const props = { weights: [1, 0, 0, 0], active: true, animate: false, playing: false };
  try {
    await act(async () => root.render(<FluidGradientBackground colors={first} {...props} />));
    const start = performance.now() + 10_000;
    await paint(start);
    expect(red()).toBe(0);
    expect(uniforms.get("u_bias")).toHaveLength(4);
    expect(frames.size).toBe(0);

    await act(async () => root.render(<FluidGradientBackground colors={second} {...props} />));
    expect(frames.size).toBe(1);
    const changed = performance.now();
    await paint(changed + COLOR_TRANSITION_MS / 2);
    expect(red()).toBeGreaterThan(0.2);
    expect(red()).toBeLessThan(0.8);
    await paint(changed + COLOR_TRANSITION_MS + 50);
    expect(red()).toBe(1);
    expect(frames.size).toBe(0);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
