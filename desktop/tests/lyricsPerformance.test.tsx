import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { TrackLyrics, LyricLine } from "../src/types/lyrics";
import type { Track } from "../src/types/music";
import type { PlaybackClock } from "../src/utils/playbackClock";

const motion = { ...await import("../src/utils/lyricsMotion") };
const animatedRows: string[] = [];
mock.module("../src/utils/lyricsMotion", () => ({
  ...motion,
  animateLetter: (...args: Parameters<typeof motion.animateLetter>) => {
    animatedRows.push(args[1].closest<HTMLElement>("[data-row]")!.dataset.row!);
    return motion.animateLetter(...args);
  },
}));

const data: TrackLyrics = {
  status: "lyrics", instrumental: false, sync: "word", hasWordSync: true,
  plainLyrics: null, source: "amll", originalFormat: "ttml", offsetMs: 0,
  language: "en", singers: [], failedProviders: [],
  lines: Array.from({ length: 100 }, (_, index): LyricLine => ({
    text: "Hold this note", startMs: index * 4000, endMs: index * 4000 + 3000,
    segments: [
      { text: "Hold ", startMs: index * 4000, endMs: index * 4000 + 1500, granularity: "word", singer: null },
      { text: "this note", startMs: index * 4000 + 1500, endMs: index * 4000 + 3000, granularity: "word", singer: null },
    ],
    words: [], singer: null, translations: [], romanization: [], backgroundVocals: [], key: null,
  })),
};
mock.module("../src/utils/lyricsCache", () => ({
  cachedLyrics: () => data, loadLyrics: async () => data,
}));
const dom = new Window({ url: "http://localhost/" });
const frames = new Map<number, FrameRequestCallback>();
let frameId = 0;
let now = 0;
let wordSplits = 0;
const Segmenter = Intl.Segmenter;
const observers: ResizeObserverCallback[] = [];
Object.defineProperty(Intl, "Segmenter", { configurable: true, value: class extends Segmenter {
  segment(text: string) { wordSplits++; return super.segment(text); }
} });
const { LyricsView } = await import("../src/components/LyricsView");

beforeAll(() => {
  Object.assign(globalThis, {
    window: dom, document: dom.document, navigator: dom.navigator, localStorage: dom.localStorage,
    HTMLElement: dom.HTMLElement, HTMLButtonElement: dom.HTMLButtonElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    getComputedStyle: () => ({ lineHeight: "64px", display: "block" }),
    requestAnimationFrame: (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; },
    cancelAnimationFrame: (id: number) => frames.delete(id),
    ResizeObserver: class {
      constructor(callback: ResizeObserverCallback) { observers.push(callback); }
      observe() {} unobserve() {} disconnect() {}
    },
  });
  Object.defineProperty(dom.document, "hidden", { value: false });
});
afterAll(() => {
  Object.defineProperty(Intl, "Segmenter", { configurable: true, value: Segmenter });
  dom.happyDOM.abort();
});

const track = {
  globalId: "qobuz:lyrics-performance", provider: "qobuz", providerTrackId: "lyrics-performance",
  playbackKind: "direct", audio: "", cover: "", nativeCover: null, name: "Test",
  album: "Test", artist: "Test", artists: [], albumArtists: [], durationSeconds: 400,
} satisfies Track;

function clockAt(seconds: number) {
  let time = seconds;
  const listeners = new Set<() => void>();
  const clock: PlaybackClock = {
    get: () => time, getSmooth: () => time, setRunning: () => {},
    set: next => { time = next; for (const listener of listeners) listener(); },
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  return clock;
}

async function paint(clock: PlaybackClock, seconds: number) {
  animatedRows.length = 0;
  await act(async () => {
    clock.set(seconds);
    now += 1000 / 60;
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback(now);
  });
}

test("only singing and settling rows animate, including after seeking backward", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const clock = clockAt(0.5);
  try {
    await act(async () => root.render(<LyricsView track={track} clock={clock} playing autoSync={false} />));
    await paint(clock, 0.5); // First paint initializes every letter, including offscreen lines.
    await paint(clock, 0.516);
    expect(new Set(animatedRows)).toEqual(new Set(["0"]));
    await paint(clock, 200.5);
    await paint(clock, 200.516);
    expect(new Set(animatedRows)).toEqual(new Set(["50"]));
    await paint(clock, 0.5);
    await paint(clock, 0.516);
    expect(new Set(animatedRows)).toEqual(new Set(["0"]));
    expect(container.querySelector('[data-row="0"]')?.getAttribute("aria-current")).toBe("true");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("unrelated player updates do not split every lyric into letters again", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const clock = clockAt(0.5);
  const seek = mock();
  try {
    await act(async () => root.render(<LyricsView track={track} clock={clock} playing onSeek={seek} autoSync={false} />));
    const splits = wordSplits;
    expect(splits).toBeGreaterThan(0);
    const observerCount = observers.length;
    await act(async () => root.render(<LyricsView track={track} clock={clock} playing onSeek={seek} autoSync={false} arriving />));
    expect(wordSplits).toBe(splits);
    expect(observers.length).toBe(observerCount);
    const line = container.querySelector<HTMLButtonElement>('[data-row="1"]')!;
    await act(async () => line.click());
    expect(seek).toHaveBeenCalledWith(4);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("held-note release excludes future notes and keeps the sung note's trailing animation", () => {
  const letter = motion.letterMotion(data.lines[1].segments[0], 0, 4);
  expect(motion.releasing(letter, 0)).toBe(false);
  expect(motion.releasing(letter, 4000)).toBe(true);
  expect(motion.releasing(letter, 5500)).toBe(true);
  expect(motion.releasing(letter, 5949)).toBe(true);
  expect(motion.releasing(letter, 5950)).toBe(false);
});
