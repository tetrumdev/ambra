import { createRoot } from "react-dom/client";
import App from "../src/App";
import { AudioSettingsProvider } from "../src/hooks/AudioSettingsContext";
import type { Track } from "../src/types/music";
import { setPersistentItem } from "../src/utils/persistentStorage";
import { defaultPreferences } from "../src/utils/preferences";
import { whiteArtwork } from "../src/utils/artworkPlaceholder";
import { lyricsFixture } from "./lyricsFixtures";

const track: Track = {
  globalId: "local:fixture", provider: "local", providerTrackId: "fixture", playbackKind: "direct", audio: "", cover: whiteArtwork, nativeCover: null,
  name: "Bohemian Rhapsody", version: null, album: "A Night at the Opera", albumVersion: null, albumId: null,
  albumArtists: [{ name: "Queen", providerId: "Queen", imageUrl: null }], artist: "Queen", artists: [{ name: "Queen", providerId: "Queen", imageUrl: null }],
  trackNumber: 1, discNumber: 1, durationSeconds: 354, releaseDate: null, explicit: false, isrc: null, copyright: null, label: null, genres: [], upc: null,
  quality: null, maximumBitDepth: null, maximumSamplingRateKHz: null,
};
setPersistentItem("ambra.ui-preferences.v1", JSON.stringify(defaultPreferences));
setPersistentItem("ambra.playback.v1", JSON.stringify({ trackId: track.globalId, positionSeconds: 0 }));
setPersistentItem("ambra.playlists.v1", JSON.stringify({ version: 1, playlists: [{ id: "navigation", name: "Navigation Mix", trackIds: [track.globalId] }], tracks: [track] }));
const originalFetch = window.fetch;
window.fetch = async (input, init) => {
  const path = new URL(String(input), location.href).pathname;
  if (!path.startsWith("/api/")) return originalFetch(input, init);
  if (path === "/api/search/providers") return Response.json({ providers: [] });
  if (path === "/api/auth/status") return Response.json({ qobuz: false, tidal: false, spotify: false });
  if (path === "/api/library") return Response.json({ tracks: [], unavailableTrackIds: [] });
  if (path === "/api/lyrics") return Response.json(lyricsFixture());
  throw new Error(`Unexpected navigation fixture request: ${path}`);
};
createRoot(document.getElementById("root")!).render(<AudioSettingsProvider><App localOnly={false} /></AudioSettingsProvider>);
