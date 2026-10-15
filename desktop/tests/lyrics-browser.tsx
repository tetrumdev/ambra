import { createRoot } from "react-dom/client";
import { LyricsView } from "../src/components/LyricsView";
import { createPlaybackClock } from "../src/utils/playbackClock";
import type { Track } from "../src/types/music";
import type { TrackLyrics } from "../src/types/lyrics";
import { lyricsFixture } from "./lyricsFixtures";

const root = createRoot(document.getElementById("root")!);
const clock = createPlaybackClock();
const requests: { title: string; aborted: boolean }[] = [];
let fixture = lyricsFixture();
let nextDelay = 0;
let identity = 0;
let playing = false;
let track = { globalId: "test-0", name: "Song", artist: "Singer", album: "Album", durationSeconds: 30, provider: "local", providerTrackId: "0", isrc: null, version: null } as Track;
const fetchOriginal = window.fetch;
window.fetch = (input, init) => {
  const url = new URL(String(input));
  if (url.pathname !== "/api/lyrics") return fetchOriginal(input, init);
  const record = { title: url.searchParams.get("trackName")!, aborted: false };
  requests.push(record);
  const snapshot = structuredClone(fixture);
  const delay = nextDelay; nextDelay = 0;
  return new Promise((resolve, reject) => {
    let pending = true;
    const timer = setTimeout(() => {
      pending = false;
      resolve(new Response(JSON.stringify(snapshot), { headers: { "content-type": "application/json" } }));
    }, delay);
    init?.signal?.addEventListener("abort", () => {
      if (!pending) return;
      pending = false;
      record.aborted = true;
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    }, { once: true });
  });
};
const render = () => root.render(<LyricsView key={track.globalId} track={track} clock={clock} playing={playing} />);
const harness = {
  clock, requests,
  time(value: number) { clock.set(value); },
  playing(value: boolean) { playing = value; clock.setRunning(value); render(); },
  load(sync: TrackLyrics["sync"], delay = 0) { fixture = lyricsFixture(sync); nextDelay = delay; track = { ...track, globalId: `test-${++identity}`, name: `Song ${identity}` }; clock.setRunning(false); clock.set(0); render(); return track.name; },
  setFixture(value: TrackLyrics) { fixture = value; track = { ...track, globalId: `test-${++identity}`, name: `Song ${identity}` }; render(); },
};
Object.assign(window, { lyricsHarness: harness });
render();
