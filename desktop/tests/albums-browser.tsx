import { createRoot } from "react-dom/client";
import { EntityView, type EntityPage } from "../src/components/EntityView";
import type { CatalogAlbum } from "../src/api/server";
import type { Track } from "../src/types/music";
import { entityKey, type BrowseEntity } from "../src/utils/browse";
import "../src/App.css";
import "../src/components/Sidebar.css";

const artist = { providerId: "queen", name: "Queen", imageUrl: null };
const album: CatalogAlbum = { id: "qobuz:opera", provider: "qobuz", title: "A Night at the Opera", artist: "Queen", artists: [artist], imageUrl: null, releaseDate: "1975-11-21" };
const alternate: CatalogAlbum = { ...album, id: "tidal:opera", provider: "tidal", title: "A Night at the Opera (Deluxe Edition)", artists: undefined };
album.versions = [{ ...album }, alternate];
const track = (source: CatalogAlbum): Track => ({
  globalId: `${source.provider}:bohemian`, provider: source.provider, providerTrackId: "bohemian", name: "Bohemian Rhapsody", artist: "Queen",
  artists: [artist], albumArtists: [artist], album: source.title, albumId: "opera", durationSeconds: 354,
  trackNumber: 1, discNumber: 1, quality: null, maximumBitDepth: 24, maximumSamplingRateKHz: 96, explicit: false,
  cover: "", audio: "", nativeCover: null, version: null, albumVersion: null, isrc: null, upc: null, genres: [],
} as Track);
const cache = new Map<string, EntityPage>([album, alternate].map(source => [
  entityKey({ kind: "album", album: source }), { entire: false, tracks: [track(source)] },
]));
const requests: string[] = [];
const originalFetch = window.fetch;
window.fetch = async (input, init) => {
  const path = new URL(String(input), location.href).pathname;
  if (!path.startsWith("/api/")) return originalFetch(input, init);
  requests.push(path);
  if (path === "/api/search/providers") return Response.json({ providers: ["qobuz", "tidal"] });
  if (path === "/api/search/catalog") return Response.json({ tracks: [], albums: [], artists: [] });
  if (path === "/api/credits/album") return Response.json({ source: "qobuz", description: "The album description.", descriptionSource: null, label: "EMI", copyright: null,
    credits: [{ role: "Producer", contributors: [{ name: "Roy Thomas Baker", tracks: [1] }] }] });
  if (path.endsWith("/biography")) return Response.json({ biography: "Queen are a rock band.", biographySource: "Fixture" });
  if (path.endsWith("/albums")) return Response.json({ albums: [], nextOffset: null });
  if (path.endsWith("/artists/queen")) return Response.json({ artist: { id: "tidal:queen", provider: "tidal", name: "Queen", imageUrl: null }, biography: null, biographySource: null, popularTracks: [], popularTracksError: null });
  throw new Error(`Unexpected album fixture request: ${path}`);
};
const root = createRoot(document.getElementById("root")!);
let entity: BrowseEntity = { kind: "album", album };
const opened: BrowseEntity[] = [];
const render = () => root.render(<EntityView key={entityKey(entity)} entity={entity} cache={cache}
  libraryTracks={[]} onBack={() => { entity = { kind: "album", album }; render(); }}
  onOpenEntity={next => { opened.push(next); entity = next; render(); }} onAction={() => {}}
  onAddTrack={() => {}} rememberTracks={() => {}} registerScrollElement={() => {}}
  playlistOptions={{ playlists: [], onAdd: () => true, onCreate: () => true }} />);
Object.assign(window, { albumHarness: { opened, requests } });
render();
