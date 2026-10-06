import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window as HappyWindow } from "happy-dom";
import { AlbumArtwork } from "../src/components/AlbumArtwork";

let root: Root | null = null;
let mount: HTMLDivElement;
const globals = ["window", "document", "HTMLElement", "Event", "Image", "matchMedia", "IS_REACT_ACT_ENVIRONMENT"] as const;
const savedGlobals = new Map<string, PropertyDescriptor | undefined>();

beforeAll(() => {
  for (const key of globals) savedGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  const browser = new HappyWindow({ url: "http://localhost" });
  Object.assign(globalThis, {
    window: browser,
    document: browser.document,
    HTMLElement: browser.HTMLElement,
    Event: browser.Event,
    Image: class { src = ""; decoding = ""; async decode() {} },
    matchMedia: browser.matchMedia.bind(browser),
    IS_REACT_ACT_ENVIRONMENT: true,
  });
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  mount?.remove();
});

afterAll(() => {
  for (const key of globals) {
    const descriptor = savedGlobals.get(key);
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

async function renderArtwork() {
  mount = document.createElement("div");
  document.body.append(mount);
  root = createRoot(mount);
  await act(async () => root?.render(
    <AlbumArtwork src="https://static.qobuz.com/images/cover_600.jpg" title="Album" />,
  ));
  return {
    trigger: mount.querySelector<HTMLButtonElement>(".albumArtworkTrigger")!,
    dialog: mount.querySelector<HTMLDialogElement>("dialog")!,
    zoom: mount.querySelector<HTMLButtonElement>(".albumArtworkZoom")!,
  };
}

async function click(element: HTMLElement) {
  await act(async () => element.click());
}

async function finishClose() {
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 170)); });
}

test("cover opens large, expands, returns on any click, and closes on dimmed background", async () => {
  const { trigger, dialog, zoom } = await renderArtwork();
  expect(dialog.open).toBe(false);
  await click(trigger);
  expect(dialog.open).toBe(true);
  expect(zoom.getAttribute("aria-label")).toBe("Expand cover to window");
  expect(zoom.querySelector("img")?.getAttribute("src")).toBe("https://static.qobuz.com/images/cover_600.jpg");

  await click(zoom);
  expect(dialog.dataset.expanded).toBe("true");
  await click(zoom.querySelector("img")!);
  expect(dialog.open).toBe(true);
  expect(dialog.dataset.expanded).toBeUndefined();

  await click(zoom);
  await click(dialog);
  expect(dialog.open).toBe(true);
  expect(dialog.dataset.expanded).toBeUndefined();

  await click(dialog);
  await finishClose();
  expect(dialog.open).toBe(false);
  await click(trigger);
  expect(dialog.open).toBe(true);
  expect(dialog.dataset.expanded).toBeUndefined();
});

test("Escape returns from expanded view, then closes large view", async () => {
  const { trigger, dialog, zoom } = await renderArtwork();
  await click(trigger);
  await click(zoom);
  await act(async () => { dialog.dispatchEvent(new Event("cancel", { cancelable: true })); });
  expect(dialog.open).toBe(true);
  expect(dialog.dataset.expanded).toBeUndefined();
  await act(async () => { dialog.dispatchEvent(new Event("cancel", { cancelable: true })); });
  await finishClose();
  expect(dialog.open).toBe(false);
});

test("both artwork sizes keep the existing titlebar's drag region available in the modal", async () => {
  const { trigger, dialog, zoom } = await renderArtwork();
  const titlebar = document.createElement("div");
  titlebar.className = "libraryTitlebar";
  titlebar.setAttribute("data-tauri-drag-region", "");
  document.body.append(titlebar);
  try {
    await click(trigger);
    expect(dialog.querySelector("[data-tauri-drag-region]")).not.toBeNull();
    expect(dialog.querySelector("[data-tauri-drag-region]")?.classList.contains("libraryTitlebar")).toBe(true);
    await click(zoom);
    expect(dialog.dataset.expanded).toBe("true");
    expect(dialog.querySelector("[data-tauri-drag-region]")).not.toBeNull();
    expect(titlebar.isConnected).toBe(true);
  } finally {
    titlebar.remove();
  }
});

test("artwork does not create a drag region when the window has no custom titlebar", async () => {
  const { trigger, dialog, zoom } = await renderArtwork();
  await click(trigger);
  expect(dialog.querySelector("[data-tauri-drag-region]")).toBeNull();
  await click(zoom);
  expect(dialog.querySelector("[data-tauri-drag-region]")).toBeNull();
});
