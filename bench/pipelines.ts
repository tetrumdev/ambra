/**
 * Drives the apps' own search code: desktop's `startTrackSearch` (the hook's whole effect) and the
 * phone's `startSearch`, then reads what each screen would show the way its component does.
 */
import { mock } from "bun:test";
import { realNow, VirtualClock } from "./clock";
import type { Network } from "./network";
import type { CatalogAlbum, CatalogArtist } from "../desktop/src/api/server";
import type { Track } from "../desktop/src/types/music";
import type { SearchSnapshot } from "../desktop/src/utils/searchSession";

export type Section = "tracks" | "albums" | "artists";
/** What a screen shows at one moment. */
export type View = { at: number; tracks: Track[]; artists: CatalogArtist[]; albums: CatalogAlbum[]; order: Section[]; searching: boolean; error: string | null; candidates: Track[]; allTracks: Track[] };
export type Run = { views: View[]; cpu: number[]; requests: Network["log"]; final: View };

const store = new Map<string, string>([["ambra.token", "bench-token"], ["ambra.pairingPayload.v1", "bench-pairing"]]);

/** Browser and phone globals the search modules touch, before any of them is imported. */
export async function loadApps() {
  const global = globalThis as Record<string, unknown>;
  global.window = globalThis;
  const memory = new Map<string, string>();
  global.localStorage = {
    getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => { memory.set(key, String(value)); },
    removeItem: (key: string) => { memory.delete(key); }, clear: () => memory.clear(), key: () => null, get length() { return memory.size; },
  };
  global.Image = class { decoding = ""; fetchPriority = ""; src = ""; decode() { return Promise.resolve(); } };
  global.document = { visibilityState: "visible", addEventListener() {}, removeEventListener() {} };
  mock.module("expo-secure-store", () => ({
    getItemAsync: async (key: string) => store.get(key) ?? null,
    setItemAsync: async (key: string, value: string) => { store.set(key, value); },
    deleteItemAsync: async (key: string) => { store.delete(key); },
  }));
  mock.module("react-native", () => ({ AppState: { addEventListener: () => ({ remove() {} }) }, Platform: { OS: "ios" } }));
  mock.module("../mobile/modules/ambra-network/src", () => ({ nativeNetworkAvailable: true, networkCall: async () => ({ baseUrl: "http://phone.test/capability" }) }));
  const connection = await import("../desktop/src/api/serverConnection");
  connection.setServerForTesting("http://bench.test", null);
  const desktop = await import("../desktop/src/hooks/useTrackSearch");
  const ranking = await import("../desktop/src/utils/catalogRanking");
  const session = await import("../desktop/src/utils/searchSession");
  const client = await import("../mobile/src/client");
  const mobile = await import("../mobile/src/catalog");
  return { desktop, ranking, session, client, mobile };
}

export type Apps = Awaited<ReturnType<typeof loadApps>>;

/** Times every publish (ranking, completion planning and the snapshot) in real CPU milliseconds. */
export function measurePublishes(apps: Apps, cpu: { samples: number[] }) {
  const proto = apps.session.SearchSession.prototype as unknown as { publish: () => void };
  const publish = proto.publish;
  proto.publish = function (this: unknown) {
    const started = realNow();
    try { return publish.call(this); } finally { cpu.samples.push(realNow() - started); }
  };
}

const LIMIT_MS = 30_000;

export async function runDesktop(apps: Apps, clock: VirtualClock, network: Network, query: string, cpu: { samples: number[] }): Promise<Run> {
  const start = clock.now;
  const views: View[] = [];
  cpu.samples = [];
  const viewCpu: number[] = [];
  const ref = { current: null };
  const stop = apps.desktop.startTrackSearch(query, "all", ref, (snapshot: SearchSnapshot) => {
    // As SearchView reads it: the snapshot's own section order, or (before snapshots carried one,
    // as at the baseline) `categoryOrder` over every result, computed on each render.
    const started = realNow();
    const ordered = (snapshot as SearchSnapshot & { order?: Section[] }).order;
    const order = ordered ?? (apps.ranking.categoryOrder as unknown as (...args: unknown[]) => Section[])(query, snapshot.results, snapshot.artists, snapshot.albums, snapshot.candidates);
    viewCpu.push(realNow() - started);
    views.push({ at: clock.now - start, tracks: snapshot.results, artists: snapshot.artists, albums: snapshot.albums, order, searching: snapshot.isSearching,
      error: snapshot.error, candidates: snapshot.candidates, allTracks: snapshot.allResults });
  }, () => {});
  await clock.run(LIMIT_MS);
  stop();
  await clock.flush();
  const samples = cpu.samples.map((value, index) => value + (viewCpu[index] ?? 0));
  return { views, cpu: samples, requests: network.log, final: views.at(-1) ?? emptyView() };
}

export async function runMobile(apps: Apps, clock: VirtualClock, network: Network, query: string, cpu: { samples: number[] }): Promise<Run> {
  const start = clock.now;
  const views: View[] = [];
  cpu.samples = [];
  const abort = new AbortController();
  let tracks: SearchSnapshot | null = null;
  let catalog: { artists: CatalogArtist[]; albums: CatalogAlbum[] } | null = null;
  let error: string | null = null;
  // As SearchScreen draws it: the artists row, the albums row, then the songs.
  const push = () => {
    const artists = catalog?.artists ?? [], albums = catalog?.albums ?? [];
    const order: Section[] = [...artists.length ? ["artists" as const] : [], ...albums.length ? ["albums" as const] : [], "tracks", ...!artists.length ? ["artists" as const] : [], ...!albums.length ? ["albums" as const] : []];
    views.push({ at: clock.now - start, tracks: tracks?.results ?? [], artists, albums, order, searching: tracks ? tracks.isSearching : true,
      error: tracks?.error ?? error, candidates: tracks?.candidates ?? [], allTracks: tracks?.allResults ?? [] });
  };
  const stop = apps.mobile.startSearch(query.trim(), { tidal: true, qobuz: true, spotify: true }, "all", abort.signal, {
    tracks: next => { tracks = next; push(); },
    session: () => {},
    error: reason => { error = String(reason); push(); },
    catalog: value => { catalog = value; push(); },
  });
  await clock.run(LIMIT_MS);
  stop();
  abort.abort();
  await clock.flush();
  return { views, cpu: [...cpu.samples], requests: network.log, final: views.at(-1) ?? emptyView() };
}

function emptyView(): View {
  return { at: 0, tracks: [], artists: [], albums: [], order: ["tracks", "artists", "albums"], searching: false, error: null, candidates: [], allTracks: [] };
}
