import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { act, createElement, Fragment, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ArtistBiography, CatalogAlbum, CatalogArtist } from "../src/api/server";
import type { EntityViewProps } from "../src/components/EntityView";

type Albums = { albums: CatalogAlbum[]; nextOffset: number | null };
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};
let providers = Promise.resolve<CatalogArtist["provider"][]>([]);
const albums = new Map<string, Albums | Promise<Albums>>();
const biographies = new Map<string, ArtistBiography | Promise<ArtistBiography>>();
const biographyCalls: string[] = [];
const emptyBiography = { biography: null, biographySource: null };
mock.module("../src/api/server", () => ({
  thumbnailArtwork: () => "",
  cachedArtistProfile: () => undefined,
  cachedArtistAlbums: (artist: CatalogArtist) => {
    const page = albums.get(artist.id);
    return page instanceof Promise ? undefined : page;
  },
  loadArtistProfile: async (artist: CatalogArtist) => ({ artist, popularTracks: [] }),
  loadArtistAlbums: async (artist: CatalogArtist) => {
    const page = albums.get(artist.id);
    if (!page) throw new Error("Releases unavailable");
    return page;
  },
  loadArtistBiography: async (artist: CatalogArtist) => {
    biographyCalls.push(artist.id);
    return biographies.get(artist.id) ?? emptyBiography;
  },
  configuredSearchProviders: () => providers,
  searchServerCatalog: async () => ({ artists: [] }),
}));
mock.module("../src/utils/artistImages", () => ({ rememberArtistImage: () => {} }));
mock.module("../src/components/ArtistPortrait", () => ({ ArtistPortrait: () => null }));
mock.module("../src/components/LibraryView", () => ({ CatalogAlbumGrid: () => null }));
mock.module("../src/components/TrackList", () => ({ TrackList: () => null }));
mock.module("../src/components/TrackCollectionView", () => ({
  TrackCollectionView: ({ headerContent, content }: { headerContent: ReactNode; content: ReactNode }) => createElement(Fragment, null, headerContent, content),
}));
const { ArtistView } = await import("../src/components/ArtistView");
const dom = new Window({ url: "http://localhost/" });
let root: Root;
let container: HTMLDivElement;
beforeAll(() => {
  Object.assign(globalThis, {
    window: dom, document: dom.document, navigator: dom.navigator, HTMLElement: dom.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
});
afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  providers = Promise.resolve([]);
  albums.clear(); biographies.clear(); biographyCalls.length = 0;
});
afterAll(() => { dom.happyDOM.abort(); });

const artist = (provider: CatalogArtist["provider"], id: string): CatalogArtist => ({
  id: `${provider}:${id}`, provider, name: "Artist", imageUrl: null,
});
const release = (source: CatalogArtist, title = "Shared album"): Albums => ({
  albums: [{ id: `${source.id}:album`, provider: source.provider, title, artist: source.name, imageUrl: null }], nextOffset: null,
});
async function mount(source: CatalogArtist) {
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  const props: EntityViewProps = {
    entity: { kind: "artist", artist: source }, cache: new Map(), libraryTracks: [],
    onBack: () => {}, onOpenEntity: () => {}, onAction: () => {}, onAddTrack: () => {}, onAddTracks: () => {},
    rememberTracks: () => {}, registerScrollElement: () => {}, playlistOptions: {} as EntityViewProps["playlistOptions"],
  };
  await act(async () => root.render(createElement(ArtistView, { ...props, artist: source })));
  await act(async () => container.querySelector<HTMLButtonElement>(".entityBylineAction")!.click());
}
const about = () => container.querySelector(".aboutContent")!.textContent;

test("the current artist's biography loads while discovery and releases are pending", async () => {
  const source = artist("qobuz", "pending-discovery");
  const discovery = deferred<CatalogArtist["provider"][]>();
  const releases = deferred<Albums>();
  providers = discovery.promise;
  albums.set(source.id, releases.promise);
  biographies.set(source.id, { biography: "Available biography", biographySource: "Author" });
  await mount(source);
  expect(about()).toContain("Available biography");
  expect(about()).toContain("Author");
  expect(about()).not.toContain("Loading artist info");
  await act(async () => { discovery.resolve([]); releases.resolve(release(source)); });
});

test("failed releases do not prevent the current artist's biography", async () => {
  const source = artist("tidal", "failed-releases");
  biographies.set(source.id, { biography: "Biography without albums", biographySource: null });
  await mount(source);
  expect(about()).toContain("Biography without albums");
});

test("a slow preferred catalog does not hide an available biography", async () => {
  const source = artist("tidal", "fallback");
  const preferred = artist("qobuz", "preferred");
  source.sources = [source, preferred];
  albums.set(source.id, release(source)); albums.set(preferred.id, release(preferred));
  const pending = deferred<ArtistBiography>();
  biographies.set(preferred.id, pending.promise);
  biographies.set(source.id, { biography: "Tidal biography", biographySource: null });
  await mount(source);
  expect(about()).toContain("Tidal biography");
  await act(async () => pending.resolve({ biography: "Qobuz biography", biographySource: null }));
  expect(about()).toContain("Qobuz biography");
  expect(about()).not.toContain("Tidal biography");
});

test("a trusted counterpart loads without waiting for another catalog's releases", async () => {
  const source = artist("spotify", "cross-catalog");
  const trusted = artist("qobuz", "trusted");
  const slow = artist("tidal", "slow");
  source.sources = [source, trusted, slow];
  albums.set(source.id, release(source)); albums.set(trusted.id, release(trusted));
  const pending = deferred<Albums>(); albums.set(slow.id, pending.promise);
  biographies.set(trusted.id, { biography: "Trusted biography", biographySource: null });
  await mount(source);
  expect(about()).toContain("Trusted biography");
  await act(async () => pending.resolve(release(slow)));
});

test("a late lower-priority biography cannot replace the preferred catalog", async () => {
  const source = artist("qobuz", "keep-preferred");
  const fallback = artist("tidal", "late-fallback");
  source.sources = [source, fallback];
  albums.set(source.id, release(source)); albums.set(fallback.id, release(fallback));
  const pending = deferred<ArtistBiography>();
  biographies.set(source.id, { biography: "Preferred biography", biographySource: null });
  biographies.set(fallback.id, pending.promise);
  await mount(source);
  expect(about()).toContain("Preferred biography");
  await act(async () => pending.resolve({ biography: "Late fallback", biographySource: null }));
  expect(about()).toContain("Preferred biography");
  expect(about()).not.toContain("Late fallback");
});

test("a namesake with different releases cannot supply the biography", async () => {
  const source = artist("spotify", "namesake");
  const namesake = artist("qobuz", "unrelated");
  source.sources = [source, namesake];
  albums.set(source.id, release(source)); albums.set(namesake.id, release(namesake, "Unrelated album"));
  biographies.set(namesake.id, { biography: "Wrong artist", biographySource: null });
  await mount(source);
  expect(about()).toContain("No info is available for this artist.");
  expect(biographyCalls).not.toContain(namesake.id);
});

test("empty biographies settle after discovery and releases finish", async () => {
  const source = artist("qobuz", "empty");
  albums.set(source.id, release(source));
  await mount(source);
  expect(about()).toContain("No info is available for this artist.");
  expect(about()).not.toContain("Loading artist info");
});
