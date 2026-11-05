import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { DownloadDialog } from "../src/components/DownloadDialog";
import { DownloadActivity } from "../src/components/DownloadActivity";
import { closeDownloadDialog, openDownloadDialog, refreshServerDownloads, type DownloadJob } from "../src/utils/offlineDownloads";
import { setReducedMotion } from "../src/utils/reducedMotion";

const dom = new Window({ url: "http://localhost/" });
const originalFetch = globalThis.fetch;
const requests: Record<string, unknown>[] = [];
let root: Root | undefined;
let host: HTMLDivElement;
let jobs: DownloadJob[] = [];
let rejectDownload = false;
const job = (overrides: Partial<DownloadJob> = {}): DownloadJob => ({
  id: 1, target: "server", clientId: null, targetName: "Server", quality: "max",
  total: 2, done: 0, failed: 0, current: null, error: null, finished: false, createdAt: 1,
  ...overrides,
});

beforeAll(() => {
  Object.assign(globalThis, {
    window: dom, document: dom.document, navigator: dom.navigator,
    HTMLElement: dom.HTMLElement, Node: dom.Node, IS_REACT_ACT_ENVIRONMENT: true,
  });
  setReducedMotion(true);
  // Happy DOM does not implement the popover API. Supply its visibility/toggle
  // events so these tests exercise the component's focus and selection behavior.
  const toggle = (element: HTMLElement, open: boolean) => {
    if (element.hasAttribute("data-test-open") === open) return;
    element.toggleAttribute("data-test-open", open);
    const event = new dom.Event("toggle");
    Object.assign(event, { newState: open ? "open" : "closed" });
    element.dispatchEvent(event);
  };
  Object.assign(dom.HTMLElement.prototype, {
    showPopover(this: HTMLElement) { toggle(this, true); },
    hidePopover(this: HTMLElement) { toggle(this, false); },
    togglePopover(this: HTMLElement) { toggle(this, !this.hasAttribute("data-test-open")); },
  });
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url.endsWith("/api/downloads/clients")) return Response.json([{ id: "laptop", name: "Laptop" }]);
    if (init?.method === "POST") {
      requests.push(JSON.parse(String(init.body)));
      if (rejectDownload) return Response.json({ error: "Server unavailable" }, { status: 503 });
      jobs = [job({ quality: requests.at(-1)!.quality as DownloadJob["quality"] })];
      return Response.json({ jobs });
    }
    if (url.endsWith("/api/downloads")) return Response.json({ entries: [], jobs });
    throw new Error(`Unexpected request: ${url}`);
  }) as typeof fetch;
});

afterEach(async () => {
  await act(async () => { closeDownloadDialog(); root?.unmount(); });
  root = undefined;
  host?.remove();
  requests.length = 0;
  jobs = [];
  rejectDownload = false;
});
afterAll(() => { globalThis.fetch = originalFetch; dom.happyDOM.abort(); });

async function mount() {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await refreshServerDownloads();
  await act(async () => {
    root!.render(<><DownloadDialog /><DownloadActivity tracks={[{ globalId: "qobuz:1", name: "Song", artist: "Artist" }]} /></>);
    openDownloadDialog(["qobuz:1", "tidal:2"], "MEGA");
  });
}
const trigger = () => host.querySelector<HTMLButtonElement>(".downloadQualityTrigger")!;
const picker = () => host.querySelector<HTMLDivElement>(".downloadQualityMenu")!;
const option = (index: number) => picker().querySelectorAll<HTMLButtonElement>('[role="radio"]')[index];
const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>("button")]
  .find(element => element.textContent?.trim() === label)!;
async function key(value: string) {
  await act(async () => {
    document.activeElement!.dispatchEvent(new dom.KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true }));
  });
}

test("quality popup supports keyboard selection and sends chosen quality to the server", async () => {
  await mount();
  expect(host.querySelector("select")).toBeNull();
  trigger().focus();
  await key("ArrowDown");
  expect(trigger().getAttribute("aria-expanded")).toBe("true");
  expect(document.activeElement).toBe(option(0));
  await key("End");
  expect(document.activeElement).toBe(option(3));
  await key("Home");
  await key("ArrowUp");
  expect(document.activeElement).toBe(option(3));
  await act(async () => option(3).click());
  expect(trigger().textContent).toContain("Lossy (up to 320 kbps)");
  expect(trigger().getAttribute("aria-expanded")).toBe("false");
  expect(document.activeElement).toBe(trigger());
  await act(async () => button("Download to Server").click());
  expect(requests).toEqual([{
    tracks: [{ provider: "qobuz", providerTrackId: "1" }, { provider: "tidal", providerTrackId: "2" }],
    quality: "lossy", target: "server", clientIds: [],
  }]);
});

test("Escape dismisses only the quality popup and restores trigger focus", async () => {
  await mount();
  await act(async () => trigger().click());
  await key("ArrowDown");
  await key("Escape");
  expect(trigger().getAttribute("aria-expanded")).toBe("false");
  expect(document.activeElement).toBe(trigger());
  expect(host.querySelector("dialog")!.open).toBe(true);
  expect(option(0).getAttribute("aria-checked")).toBe("true");
  expect(requests).toEqual([]);
});

test("quality stays selected through client navigation and client downloads", async () => {
  await mount();
  await act(async () => trigger().click());
  await act(async () => option(2).click());
  await act(async () => button("Download to Client").click());
  expect(host.textContent).toContain("Laptop");
  await act(async () => button("Back").click());
  expect(trigger().textContent).toContain("CD (16-bit / 44.1 kHz)");
  await act(async () => button("Download to Client").click());
  await act(async () => host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  await act(async () => button("Download").click());
  expect(requests[0]).toMatchObject({ quality: "cd", target: "clients", clientIds: ["laptop"] });
});

test("accepted downloads close the picker and keep progressing in a nonmodal panel", async () => {
  await mount();
  await act(async () => button("Download to Server").click());
  expect(host.querySelector("dialog")!.open).toBe(false);
  const summary = host.querySelector<HTMLButtonElement>(".downloadActivitySummary")!;
  expect(summary.textContent).toContain("Downloading");
  expect(summary.getAttribute("aria-expanded")).toBe("false");
  expect(host.querySelector<HTMLElement>(".downloadActivityPanel")!.hidden).toBe(true);
  jobs = [job({ done: 1, current: "qobuz:1" })];
  await act(async () => { await refreshServerDownloads(); });
  expect(summary.textContent).toContain("1 / 2");
  await act(async () => summary.click());
  expect(host.textContent).toContain("1 of 2 saved");
  expect(host.textContent).toContain("Song · Artist");
  summary.focus();
  await key("Escape");
  expect(summary.getAttribute("aria-expanded")).toBe("false");
  expect(document.activeElement).toBe(summary);
  expect(jobs[0].finished).toBe(false);
});

test("finished jobs show failures and can be cleared without hiding active downloads", async () => {
  await mount();
  jobs = [job(), job({ id: 2 })];
  await act(async () => { await refreshServerDownloads(); });
  jobs = [job({ done: 1, failed: 1, error: "Download timed out", finished: true }), job({ id: 2 })];
  await act(async () => { await refreshServerDownloads(); });
  await act(async () => host.querySelector<HTMLButtonElement>(".downloadActivitySummary")!.click());
  expect(host.textContent).toContain("1 song failed");
  expect(host.textContent).toContain("Download timed out");
  expect(host.textContent).toContain("Queued");
  await act(async () => button("Clear completed").click());
  expect(host.querySelectorAll(".downloadActivityPanel li").length).toBe(1);
  expect(host.textContent).not.toContain("Download timed out");
  jobs = [job({ id: 2, done: 2, finished: true })];
  await act(async () => { await refreshServerDownloads(); });
  expect(host.textContent).toContain("Downloads complete");
  await act(async () => button("Clear completed").click());
  expect(host.querySelector(".downloadActivity")).toBeNull();
});

test("completed download history stays hidden on startup and after the first background refresh", async () => {
  jobs = [job({ done: 2, finished: true })];
  await mount();
  expect(host.querySelector(".downloadActivity")).toBeNull();
  jobs = [job({ id: 2, done: 2, finished: true })];
  await act(async () => { await refreshServerDownloads(); });
  expect(host.querySelector(".downloadActivity")).toBeNull();
  jobs.push(job({ id: 3 }));
  await act(async () => { await refreshServerDownloads(); });
  expect(host.querySelectorAll(".downloadActivityPanel li").length).toBe(1);
  jobs = [job({ id: 3, done: 2, finished: true })];
  await act(async () => { await refreshServerDownloads(); });
  expect(host.querySelector(".downloadActivitySummary")!.textContent).toContain("Downloads complete");
});

test("a rejected download leaves the picker open and shows the error", async () => {
  await mount();
  rejectDownload = true;
  await act(async () => button("Download to Server").click());
  expect(host.querySelector("dialog")!.open).toBe(true);
  expect(host.textContent).toContain("Server unavailable");
  expect(host.querySelector(".downloadActivity")).toBeNull();
});

test("queue icon keeps its size regardless of player stylesheet load order", () => {
  const controls = readFileSync(new URL("../src/components/ExtraCtrls.css", import.meta.url), "utf8");
  const player = readFileSync(new URL("../src/components/NowPlayingBar.css", import.meta.url), "utf8");
  const container = document.createElement("div");
  container.innerHTML = '<div id="extraCtrls"><button id="queueBtn"><img id="queueImg" src="/queue.svg"></button></div>';
  document.body.append(container);
  const style = document.createElement("style");
  document.head.append(style);
  try {
    for (const css of [controls + player, player + controls]) {
      style.textContent = css;
      expect(dom.getComputedStyle(container.querySelector("img")!).width).toBe("20px");
      expect(dom.getComputedStyle(container.querySelector("img")!).height).toBe("auto");
      expect(dom.getComputedStyle(container.querySelector("button")!).width).toBe("35px");
    }
  } finally { container.remove(); style.remove(); }
});
