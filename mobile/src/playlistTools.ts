import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";
import * as WebBrowser from "expo-web-browser";
import type { Playlist, Track } from "../../desktop/src/types/music";
import { playlistCsv } from "../../desktop/src/utils/playlistCsv";
import { findUpgrades, type UpgradeServices } from "../../desktop/src/utils/playlistUpgrades";
import { networkCall } from "../modules/ambra-network/src";
import { request } from "./client";
import { catalogSearch, playlistSongs, refreshLibrary, replacePlaylistTracks, withPlayback } from "./library";
import { services as allServices, type Service } from "./servicePreferences";

/**
 * Desktop's playlist and service tools on the phone: Improve Playlist and Export Playlist
 * (sharing the desktop code), music import, and service sign-in.
 */

const phoneServices: UpgradeServices = {
  providers: signal => request<{ providers: Service[] }>("/api/search/providers", { signal, timeoutMs: 10_000 }).then(value => value.providers.filter(provider => allServices.includes(provider))),
  catalog: (query, provider, signal) => catalogSearch(query, provider as Service, signal).then(page => page.tracks),
  playback: (track, signal) => withPlayback(track, signal),
};

export type Improvement = { upgraded: number; done: number; total: number };

/** Moves an AMBRA playlist's songs onto their best-sounding copies, as desktop's Improve Playlist. */
export async function improvePlaylist(playlist: Playlist, onProgress: (done: number, total: number) => void, signal: AbortSignal): Promise<number> {
  const tracks = playlistSongs(playlist);
  onProgress(0, tracks.length);
  const upgrades = await findUpgrades(phoneServices, tracks, done => onProgress(done, tracks.length), signal, playlist.packages ?? []);
  signal.throwIfAborted();
  if (upgrades.size) await replacePlaylistTracks(playlist.id, upgrades);
  return upgrades.size;
}

/** Desktop's CSV, handed to the share sheet (Files, Mail, Numbers…). */
export async function exportPlaylist(name: string, tracks: Track[]) {
  if (!FileSystem.cacheDirectory) throw new Error("Exporting needs a native iOS or Android build.");
  const safe = (name.trim() || "Playlist").replace(/[\\/:*?"<>|]/g, "-").slice(0, 80);
  const uri = `${FileSystem.cacheDirectory}${safe}.csv`;
  await FileSystem.writeAsStringAsync(uri, playlistCsv(tracks));
  if (!(await Sharing.isAvailableAsync())) throw new Error("Sharing isn't available on this phone.");
  await Sharing.shareAsync(uri, { mimeType: "text/csv", UTI: "public.comma-separated-values-text", dialogTitle: `Export ${name}` });
}

/** Picks music files on this phone and adds them to the server's library, as desktop's import does. */
export async function importMusic(onProgress: (done: number, total: number) => void): Promise<{ imported: number; failed: string[] }> {
  const picked = await DocumentPicker.getDocumentAsync({ type: "audio/*", multiple: true, copyToCacheDirectory: true });
  if (picked.canceled) return { imported: 0, failed: [] };
  let imported = 0;
  const failed: string[] = [];
  onProgress(0, picked.assets.length);
  for (const [index, asset] of picked.assets.entries()) {
    try {
      await networkCall("import_file", { uri: asset.uri, name: asset.name });
      imported++;
    } catch (error) {
      failed.push(`${asset.name}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      // The picker's copy is only needed for the upload.
      void FileSystem.deleteAsync(asset.uri, { idempotent: true }).catch(() => {});
      onProgress(index + 1, picked.assets.length);
    }
  }
  if (imported) await refreshLibrary();
  return { imported, failed };
}

type AuthStart = { status: "connected" | "callbackRequired"; loginUrl: string | null; attemptId?: string };

/**
 * Signs a service in on the server through an in-app browser on this phone. Qobuz and
 * Spotify redirect to a loopback address this phone listens on; Tidal's final address is
 * pasted, as on desktop. `onPaste` gets a submit function while that paste is wanted.
 */
export async function signIn(provider: Service, signal: AbortSignal, onPaste: (submit: ((url: string) => Promise<void>) | null) => void): Promise<void> {
  const start = await request<AuthStart>(`/api/auth/${provider}/start?browser=true`, { method: "POST", signal, timeoutMs: 30_000 });
  if (start.status === "connected") return;
  if (!start.loginUrl || !start.attemptId) throw new Error("Update the Ambra server to sign in from your phone.");
  const attemptId = start.attemptId;
  const complete = (callbackUrl: string) => {
    if (new URL(callbackUrl).searchParams.has("error")) throw new Error("Service sign-in was declined.");
    return request(`/api/auth/${provider}/complete`, { method: "POST", body: JSON.stringify({ callbackUrl, attemptId }), timeoutMs: 60_000 });
  };
  const redirect = new URL(start.loginUrl).searchParams.get("redirect_uri") ?? new URL(start.loginUrl).searchParams.get("redirect_url") ?? "";
  try {
    if (redirect.startsWith("http://127.0.0.1:")) {
      await networkCall("login_listen", { redirect });
      void WebBrowser.openBrowserAsync(start.loginUrl, { presentationStyle: WebBrowser.WebBrowserPresentationStyle.PAGE_SHEET });
      // The browser stays in the app, so this phone's listener answers the service's redirect.
      for (;;) {
        await new Promise(resolve => setTimeout(resolve, 500));
        signal.throwIfAborted();
        const { url } = await networkCall<{ url: string | null }>("login_result");
        if (url) { WebBrowser.dismissBrowser(); await complete(url); return; }
      }
    }
    // Tidal ends on its own site: the listener pastes the final address, as on desktop.
    let finish: (() => void) | undefined;
    let fail: ((error: unknown) => void) | undefined;
    const pasted = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; });
    onPaste(async url => { await complete(url.trim()); WebBrowser.dismissBrowser(); finish!(); });
    signal.addEventListener("abort", () => fail!(signal.reason), { once: true });
    void WebBrowser.openBrowserAsync(start.loginUrl, { presentationStyle: WebBrowser.WebBrowserPresentationStyle.PAGE_SHEET });
    await pasted;
  } catch (error) {
    WebBrowser.dismissBrowser();
    await request(`/api/auth/${provider}/cancel`, { method: "POST", body: JSON.stringify({ attemptId }), timeoutMs: 10_000 }).catch(() => {});
    throw error;
  } finally {
    onPaste(null);
    void networkCall("login_stop").catch(() => {});
  }
}

export async function signOut(provider: Service) {
  await request(`/api/auth/${provider}/disconnect`, { method: "POST", timeoutMs: 30_000 });
  await refreshLibrary();
}
