import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ExtraCtrls } from "../src/components/ExtraCtrls";
import { AudioSettingsProvider, type AudioSettingsApi } from "../src/hooks/AudioSettingsContext";
import { defaultAudioSettings } from "../src/utils/audioSettings";

const dom = new Window({ url: "http://localhost/" });
let root: Root | undefined;
let host: HTMLDivElement;
let saved: number[] = [];

beforeAll(() => {
  Object.assign(globalThis, {
    window: dom, document: dom.document, navigator: dom.navigator,
    HTMLElement: dom.HTMLElement, Element: dom.Element, WheelEvent: dom.WheelEvent, IS_REACT_ACT_ENVIRONMENT: true,
  });
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  host?.remove();
  saved = [];
});
afterAll(() => { dom.happyDOM.abort(); });

async function mount(volume = 50) {
  let settings = defaultAudioSettings();
  settings.outputs[0].volume = volume;
  const api: AudioSettingsApi = {
    native: false,
    load: async () => settings,
    devices: async () => [],
    save: async next => { settings = next; saved.push(next.outputs[0].volume); },
  };
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(<AudioSettingsProvider api={api}><ExtraCtrls /></AudioSettingsProvider>));
}

function dispatchWheel(deltaY: number, deltaMode = 0, target: Element = host.querySelector("#volumeBtn")!) {
  const event = new dom.WheelEvent("wheel", { deltaY, deltaMode, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

test.each([100, 120, 144, 150, 160])("a %s-pixel mouse-wheel event changes volume by exactly five points", async delta => {
  await mount();
  await act(async () => { expect(dispatchWheel(delta).defaultPrevented).toBe(true); });
  expect(saved).toEqual([45]);
  await act(async () => { dispatchWheel(-delta); });
  expect(saved).toEqual([45, 50]);
});

test("line and page wheel events use the same five-point step", async () => {
  await mount();
  await act(async () => { dispatchWheel(3, 1); });
  expect(saved.at(-1)).toBe(45);
  await act(async () => { dispatchWheel(-1, 2); });
  expect(saved.at(-1)).toBe(50);
});

test("rapid wheel events accumulate before React renders", async () => {
  await mount();
  await act(async () => {
    dispatchWheel(144);
    dispatchWheel(150);
    dispatchWheel(160);
  });
  expect(saved.at(-1)).toBe(35);
  expect(host.querySelector(".volumePercentage")!.textContent).toBe("35%");
});

test("volume clamps at its limits and ignores zero vertical scroll", async () => {
  await mount(98);
  await act(async () => { dispatchWheel(-144); });
  expect(saved).toEqual([100]);
  await act(async () => {
    dispatchWheel(-150);
    expect(dispatchWheel(0).defaultPrevented).toBe(false);
  });
  expect(saved).toEqual([100]);
  await act(async () => { for (let index = 0; index < 25; index++) dispatchWheel(144); });
  expect(saved.at(-1)).toBe(0);
});

test("scrolling the output-device list does not change volume or block scrolling", async () => {
  await mount();
  const list = document.createElement("div");
  list.className = "audioDeviceList";
  host.querySelector(".volumeControlContainer")!.append(list);
  await act(async () => { expect(dispatchWheel(144, 0, list).defaultPrevented).toBe(false); });
  expect(saved).toEqual([]);
});
