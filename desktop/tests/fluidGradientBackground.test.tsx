import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window as HappyWindow } from "happy-dom";
import { FluidGradientBackground } from "../src/components/FluidGradientBackground";

const keys = ["window", "document", "HTMLElement", "Event", "ResizeObserver", "requestAnimationFrame", "cancelAnimationFrame", "IS_REACT_ACT_ENVIRONMENT"] as const;
const saved = new Map<string, PropertyDescriptor | undefined>();
const frames = new Map<number, FrameRequestCallback>();
const times: number[] = [];
let nextFrame = 0;
let root: Root | null = null;
let mount: HTMLDivElement;
let clock: number;

beforeAll(() => {
  keys.forEach(key => saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key)));
  const browser = new HappyWindow({ url: "http://localhost" });
  // Reproduce Windows with system UI animations disabled.
  browser.matchMedia = (() => ({ matches: true, addEventListener() {}, removeEventListener() {} })) as unknown as typeof browser.matchMedia;
  const noop = () => {};
  const gl = {
    VERTEX_SHADER: 1, FRAGMENT_SHADER: 2, COMPILE_STATUS: 3, LINK_STATUS: 4,
    ARRAY_BUFFER: 5, STATIC_DRAW: 6, FLOAT: 7, TRIANGLES: 8,
    createShader: () => ({}), shaderSource: noop, compileShader: noop,
    getShaderParameter: () => true, deleteShader: noop,
    createProgram: () => ({}), attachShader: noop, linkProgram: noop,
    getProgramParameter: () => true, deleteProgram: noop,
    createBuffer: () => ({}), deleteBuffer: noop, getAttribLocation: () => 0,
    getUniformLocation: (_program: unknown, name: string) => ({ name }),
    useProgram: noop, bindBuffer: noop, bufferData: noop,
    enableVertexAttribArray: noop, vertexAttribPointer: noop,
    uniform1f: (location: { name: string }, value: number) => {
      if (location.name === "u_time") times.push(value);
    },
    uniform2f: noop, uniform3fv: noop, uniform4fv: noop,
    viewport: noop, drawArrays: noop, isContextLost: () => false,
  };
  Object.defineProperty(browser.HTMLCanvasElement.prototype, "getContext", { value: () => gl });
  Object.assign(globalThis, {
    window: browser, document: browser.document, HTMLElement: browser.HTMLElement, Event: browser.Event,
    ResizeObserver: class { observe() {} disconnect() {} },
    requestAnimationFrame: (callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame; },
    cancelAnimationFrame: (id: number) => { frames.delete(id); },
    IS_REACT_ACT_ENVIRONMENT: true,
  });
});
beforeEach(() => {
  frames.clear(); times.length = 0;
  Object.defineProperty(document, "hidden", { configurable: true, value: false });
  mount = document.createElement("div"); document.body.append(mount); root = createRoot(mount);
  clock = performance.now() + 1000;
});
afterEach(async () => {
  await act(async () => root?.unmount()); root = null; mount.remove();
  expect(frames.size).toBe(0);
});
afterAll(() => keys.forEach(key => {
  const descriptor = saved.get(key);
  if (descriptor) Object.defineProperty(globalThis, key, descriptor);
  else Reflect.deleteProperty(globalThis, key);
}));

async function render(active = true, animate = true) {
  await act(async () => root!.render(<FluidGradientBackground
    colors={["#225588", "#aa3344"]} weights={[0.5, 0.5]}
    separation={{ edges: [0.2, 0.2, 0.2, 0.2], directions: [1, 1, 1, 1] }}
    coverId="test-cover" seed="test" active={active} animate={animate}
  />));
}
function tick() {
  clock += 20;
  const pending = [...frames.values()]; frames.clear();
  pending.forEach(callback => callback(clock));
}

test("swirl keeps advancing despite Windows reduced-motion preference", async () => {
  await render(); tick();
  const firstTime = times[times.length - 1];
  expect(firstTime).toBeGreaterThan(0);
  expect(frames.size).toBe(1);
  tick();
  expect(times[times.length - 1]).toBeGreaterThan(firstTime);
  expect(frames.size).toBe(1);
});

test("app motion switch stops rendering and resumes animation", async () => {
  await render(); tick();
  await render(true, false); tick();
  expect(times[times.length - 1]).toBe(0);
  expect(frames.size).toBe(0);
  const drawCount = times.length; tick();
  expect(times.length).toBe(drawCount);
  await render(true, true); tick();
  expect(times[times.length - 1]).toBeGreaterThan(0);
  expect(frames.size).toBe(1);
});

test("inactive and hidden backgrounds stop scheduling frames and resume", async () => {
  await render(); tick();
  await render(false); tick();
  expect(frames.size).toBe(0);
  await render(true); tick();
  expect(frames.size).toBe(1);
  Object.defineProperty(document, "hidden", { configurable: true, value: true });
  document.dispatchEvent(new Event("visibilitychange"));
  expect(frames.size).toBe(0);
  Object.defineProperty(document, "hidden", { configurable: true, value: false });
  document.dispatchEvent(new Event("visibilitychange")); tick();
  expect(frames.size).toBe(1);
});

test("animation recovers after WebGL context restoration", async () => {
  await render(); tick();
  const canvas = mount.querySelector("canvas")!;
  canvas.dispatchEvent(new Event("webglcontextlost", { cancelable: true }));
  expect(frames.size).toBe(0);
  await act(async () => { canvas.dispatchEvent(new Event("webglcontextrestored")); });
  tick();
  expect(frames.size).toBe(1);
  const restoredTime = times[times.length - 1]; tick();
  expect(times[times.length - 1]).toBeGreaterThan(restoredTime);
});
