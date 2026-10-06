import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window as HappyWindow } from "happy-dom";
import { Queue, type QueueProps } from "../src/components/Queue";
import { TrackList } from "../src/components/TrackList";
import type { QueueEntry, QueueHistoryEntry } from "../src/types/music";
import { track } from "./searchFixture";

let root: Root | null = null;
let mount: HTMLDivElement;
const globals = ["window", "document", "Window", "HTMLElement", "Event", "MouseEvent", "PointerEvent", "KeyboardEvent", "Image", "getComputedStyle", "matchMedia", "requestAnimationFrame", "cancelAnimationFrame", "ResizeObserver", "IS_REACT_ACT_ENVIRONMENT"] as const;
const savedGlobals = new Map<string, PropertyDescriptor | undefined>();

beforeAll(() => {
  for (const key of globals) savedGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  const browser = new HappyWindow({ url: "http://localhost" });
  Object.assign(globalThis, {
    window: browser, document: browser.document, Window: browser.Window, HTMLElement: browser.HTMLElement,
    Event: browser.Event, MouseEvent: browser.MouseEvent, PointerEvent: browser.PointerEvent, KeyboardEvent: browser.KeyboardEvent,
    Image: class { src = ""; decoding = ""; async decode() {} },
    getComputedStyle: browser.getComputedStyle.bind(browser), matchMedia: browser.matchMedia.bind(browser),
    requestAnimationFrame: browser.requestAnimationFrame.bind(browser), cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
    ResizeObserver: browser.ResizeObserver, IS_REACT_ACT_ENVIRONMENT: true,
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

function entry(queueId: number, name = `Song ${queueId}`): QueueEntry {
  return { queueId, track: track(`local:${queueId}`, "local", { name }), source: { kind: "playlist", id: "test", entryId: queueId }, shufflePackageId: null };
}

const past: QueueHistoryEntry = { ...entry(8, "Past song"), historyId: "past", playedAt: "2026-10-05T00:00:00Z" };

async function renderQueue(overrides: Partial<QueueProps> = {}) {
  const props: QueueProps = {
    currentEntry: entry(1), upcomingEntries: [entry(2), entry(3), entry(4)], historyEntries: [past],
    jumpTo: mock((_id: number) => {}), replayHistory: mock((_id: string) => {}),
    reorderEntries: mock((_ids: number[]) => {}), deleteEntries: mock((_ids: number[]) => {}),
    deleteHistoryEntries: mock((_ids: string[]) => {}), registerScrollElement: () => {}, ...overrides,
  };
  mount = document.createElement("div");
  document.body.append(mount);
  root = createRoot(mount);
  await act(async () => root?.render(<Queue {...props} />));
  return props;
}

async function click(element: HTMLElement, shiftKey = false) {
  await act(async () => { element.dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey })); });
}

test("plain row and artwork clicks never skip; play button and menu actions are explicit", async () => {
  const props = await renderQueue();
  const row = mount.querySelector<HTMLElement>("#upcomingQueueTracks .queueItem")!;
  await click(row);
  await click(row.querySelector<HTMLElement>(".trackName")!);
  await click(row.querySelector<HTMLElement>(".coverImg")!);
  expect(props.jumpTo).not.toHaveBeenCalled();
  await click(row.querySelector<HTMLElement>(".trackPlayButton")!);
  expect(props.jumpTo).toHaveBeenCalledWith(2);
  await click(row.querySelector<HTMLElement>(".trackCollectionMenuTrigger")!);
  expect(mount.querySelector("#trackCollectionMenu")?.textContent).toContain("Play from here");
  const action = Array.from(mount.querySelectorAll<HTMLButtonElement>("#trackCollectionMenu button")).find(button => button.textContent === "Play from here")!;
  await click(action);
  expect(props.jumpTo).toHaveBeenCalledTimes(2);
});

test("right-click selection and Shift ranges remove queue occurrences without playing them", async () => {
  const props = await renderQueue({ upcomingEntries: [entry(2, "Duplicate"), { ...entry(3, "Duplicate"), track: entry(2).track }, entry(4)] });
  const rows = mount.querySelectorAll<HTMLElement>("#upcomingQueueTracks .queueItem");
  await act(async () => { rows[0].dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })); });
  await click(rows[1], true);
  expect(mount.querySelectorAll('[data-selected="true"]').length).toBe(2);
  expect(mount.querySelectorAll(".selectionIndicator").length).toBe(5);
  expect(props.jumpTo).not.toHaveBeenCalled();
  await click(mount.querySelector<HTMLElement>(".selectionRemoveAction")!);
  expect(props.deleteEntries).toHaveBeenCalledWith([2, 3]);
  expect(mount.querySelector(".selectionActionMenu")).toBeNull();
});

test("history is visible after queue exhaustion and replays through its play button", async () => {
  const props = await renderQueue({ currentEntry: undefined, upcomingEntries: [] });
  const row = mount.querySelector<HTMLElement>("#queueHistory .queueItem")!;
  expect(row.textContent).toContain("Past song");
  await click(row);
  expect(props.replayHistory).not.toHaveBeenCalled();
  await click(row.querySelector<HTMLElement>(".trackPlayButton")!);
  expect(props.replayHistory).toHaveBeenCalledWith("past");
  await act(async () => { row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })); });
  await click(mount.querySelector<HTMLElement>(".selectionRemoveAction")!);
  expect(props.deleteHistoryEntries).toHaveBeenCalledWith(["past"]);
  expect(props.deleteEntries).not.toHaveBeenCalled();
});

test("played tracks precede now playing and History returns to them without changing playback", async () => {
  const older = { ...past, historyId: "older", track: entry(9, "Older song").track };
  const props = await renderQueue({ historyEntries: [older, past] });
  const names = Array.from(mount.querySelectorAll(".queueTrackName > span"), element => element.textContent);
  expect(names).toEqual(["Older song", "Past song", "Song 1", "Song 2", "Song 3", "Song 4"]);
  expect(mount.querySelectorAll('[data-played="true"]').length).toBe(2);
  const scroller = mount.querySelector<HTMLElement>("#queueList")!;
  const anchor = mount.querySelector<HTMLElement>("#currentQueueTrack")!;
  const columns = mount.querySelector<HTMLElement>(".columnInfo")!;
  const rect = (top: number, height: number) => ({ top, height } as DOMRect);
  scroller.getBoundingClientRect = () => rect(0, 500);
  anchor.getBoundingClientRect = () => rect(400 - scroller.scrollTop, 76);
  columns.getBoundingClientRect = () => rect(0, 100);
  await click(Array.from(mount.querySelectorAll<HTMLButtonElement>(".librarySectionButton")).find(button => button.textContent?.startsWith("History"))!);
  expect(scroller.scrollTop).toBe(0);
  const jump = Array.from(mount.querySelectorAll<HTMLButtonElement>(".librarySectionButton")).find(button => button.textContent === "Jump to now playing")!;
  expect(jump).toBeTruthy();
  await click(jump);
  expect(scroller.scrollTop).toBe(300);
  expect(mount.textContent).not.toContain("Jump to now playing");
  expect(props.jumpTo).not.toHaveBeenCalled();
  expect(props.replayHistory).not.toHaveBeenCalled();
});

test("Clear upcoming preserves played tracks and now playing; Clear all clears the remaining timeline", async () => {
  const props = await renderQueue();
  await click(Array.from(mount.querySelectorAll<HTMLButtonElement>(".librarySectionButton")).find(button => button.textContent === "Clear upcoming")!);
  expect(props.deleteEntries).toHaveBeenCalledWith([2, 3, 4]);
  expect(props.deleteHistoryEntries).not.toHaveBeenCalled();
  await act(async () => root?.render(<Queue {...props} upcomingEntries={[]} />));
  await click(Array.from(mount.querySelectorAll<HTMLButtonElement>(".librarySectionButton")).find(button => button.textContent === "Clear all")!);
  expect(props.deleteEntries).toHaveBeenLastCalledWith([1]);
  expect(props.deleteHistoryEntries).toHaveBeenCalledWith(["past"]);
});

test("playlist pointer gestures reorder only upcoming entries and suppress the drop click", async () => {
  const props = await renderQueue();
  const rows = mount.querySelectorAll<HTMLElement>("#upcomingQueueTracks .queueItem");
  const container = rows[0].parentElement!;
  const scroller = mount.querySelector<HTMLElement>("#queueList")!;
  const rectangle = (top: number, height: number): DOMRect => ({ x: 0, y: top, top, bottom: top + height, left: 0, right: 900, width: 900, height, toJSON: () => ({}) });
  container.getBoundingClientRect = () => rectangle(100, 228);
  scroller.getBoundingClientRect = () => rectangle(0, 600);
  rows.forEach((row, index) => { row.getBoundingClientRect = () => rectangle(100 + index * 76, 76); });
  let captured = false;
  rows[0].setPointerCapture = () => { captured = true; };
  rows[0].hasPointerCapture = () => captured;
  rows[0].releasePointerCapture = () => { captured = false; };
  const originalElementFromPoint = document.elementFromPoint;
  document.elementFromPoint = () => rows[1];
  try {
    const pointer = { bubbles: true, pointerId: 1, pointerType: "mouse", isPrimary: true, button: 0, clientX: 100 };
    await act(async () => { rows[0].dispatchEvent(new PointerEvent("pointerdown", { ...pointer, clientY: 130 })); });
    await act(async () => { window.dispatchEvent(new PointerEvent("pointermove", { ...pointer, clientY: 240 })); });
    expect(document.documentElement.dataset.trackReordering).toBe("true");
    await act(async () => { window.dispatchEvent(new PointerEvent("pointerup", { ...pointer, clientY: 240 })); });
    expect(props.reorderEntries).toHaveBeenCalledWith([3, 2, 4]);
    await click(rows[0]);
    expect(props.jumpTo).not.toHaveBeenCalled();
    expect(document.documentElement.dataset.trackReordering).toBeUndefined();
  } finally { document.elementFromPoint = originalElementFromPoint; }
});

test("long queue and history sections keep their rendered rows bounded", async () => {
  const upcomingEntries = Array.from({ length: 1000 }, (_, index) => entry(index + 2));
  const historyEntries = Array.from({ length: 1000 }, (_, index) => ({ ...past, historyId: `history-${index}` }));
  await renderQueue({ upcomingEntries, historyEntries });
  expect(mount.querySelectorAll("#upcomingQueueTracks .queueItem").length).toBeLessThan(40);
  expect(mount.querySelectorAll("#queueHistory .queueItem").length).toBeLessThan(40);
});

test("shared playlist play buttons play once and select instead of playing during selection", async () => {
  const playTrack = mock((_id: string) => {});
  const removeTracks = mock((_ids: string[]) => {});
  mount = document.createElement("div");
  document.body.append(mount);
  root = createRoot(mount);
  await act(async () => root?.render(<TrackList tracks={[entry(1).track, entry(2).track]}
    playTrack={playTrack} playStandalone={() => {}} addToQueue={() => {}} playNext={() => {}} removeTracks={removeTracks} />));
  const rows = mount.querySelectorAll<HTMLElement>(".libraryItem");
  await click(rows[0].querySelector<HTMLElement>(".coverImg")!);
  expect(playTrack).not.toHaveBeenCalled();
  await click(rows[0].querySelector<HTMLElement>(".trackPlayButton")!);
  expect(playTrack).toHaveBeenCalledWith("local:1");
  expect(playTrack).toHaveBeenCalledTimes(1);
  await act(async () => { rows[0].dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })); });
  await click(rows[1].querySelector<HTMLElement>(".trackPlayButton")!);
  expect(playTrack).toHaveBeenCalledTimes(1);
  expect(mount.querySelectorAll('[data-selected="true"]').length).toBe(2);
  await click(mount.querySelector<HTMLElement>(".selectionRemoveAction")!);
  expect(removeTracks).toHaveBeenCalledWith(["local:1", "local:2"]);
});
