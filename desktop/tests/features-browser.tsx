import { createRoot } from "react-dom/client";
import App from "../src/App";
import { AudioSettingsProvider } from "../src/hooks/AudioSettingsContext";
import type { Track } from "../src/types/music";
import { setPersistentItem } from "../src/utils/persistentStorage";
import { defaultPreferences } from "../src/utils/preferences";
import { whiteArtwork } from "../src/utils/artworkPlaceholder";

const song = (id: string, name: string, artist: string, album: string, releaseDate: string, quality: string): Track => ({
  globalId: `local:${id}`, provider: "local", providerTrackId: id, playbackKind: "direct", audio: "", cover: whiteArtwork, nativeCover: null,
  name, version: null, album, albumVersion: null, albumId: null,
  albumArtists: [{ name: artist, providerId: artist, imageUrl: null }], artist, artists: [{ name: artist, providerId: artist, imageUrl: null }],
  trackNumber: 1, discNumber: 1, durationSeconds: 200, releaseDate, explicit: false, isrc: null, copyright: null, label: null, genres: ["Rock"], upc: null,
  quality, maximumBitDepth: null, maximumSamplingRateKHz: null,
});
const tracks = [
  song("rhapsody", "Bohemian Rhapsody", "Queen", "A Night at the Opera", "1975-10-31", "FLAC 24-bit 96 kHz"),
  song("halo", "Halo", "Beyoncé", "I Am... Sasha Fierce", "2008-11-14", "FLAC 16-bit 44.1 kHz"),
  song("paranoid", "Paranoid", "Black Sabbath", "Paranoid", "1970-09-18", "Ogg Vorbis 320 kbps"),
];
setPersistentItem("ambra.ui-preferences.v1", JSON.stringify(defaultPreferences));
setPersistentItem("ambra.playback.v1", JSON.stringify({ trackId: tracks[0].globalId, positionSeconds: 0 }));
setPersistentItem("ambra.playlists.v1", JSON.stringify({ version: 1, playlists: [{ id: "mix", name: "Feature Mix", trackIds: tracks.map(track => track.globalId) }], tracks }));
setPersistentItem("ambra.listening-history.v1", JSON.stringify({ version: 1, entries: [{ track: tracks[1], lastPlayedAt: Date.now(), playCount: 7 }] }));
const originalFetch = window.fetch;
window.fetch = async (input, init) => {
  const path = new URL(String(input), location.href).pathname;
  if (!path.startsWith("/api/")) return originalFetch(input, init);
  if (path === "/api/search/providers") return Response.json({ providers: [] });
  if (path === "/api/auth/status") return Response.json({ qobuz: false, tidal: false, spotify: false });
  if (path === "/api/library") return Response.json({ tracks: [], unavailableTrackIds: [] });
  if (path === "/api/lyrics") return Response.json({ lines: [] });
  throw new Error(`Unexpected feature fixture request: ${path}`);
};
createRoot(document.getElementById("root")!).render(<AudioSettingsProvider><App localOnly={false} /></AudioSettingsProvider>);
