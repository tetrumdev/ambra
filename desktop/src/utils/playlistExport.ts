import { invoke, isTauri } from "@tauri-apps/api/core";
import type { Track } from "../types/music";
import { playlistCsv } from "./playlistCsv";

export { playlistCsv };

/** Saves the playlist to Downloads and shows it selected in Finder or Explorer; the browser downloads it instead. */
export async function exportPlaylist(name: string, tracks: Track[]) {
  const csv = playlistCsv(tracks);
  if (isTauri()) {
    await invoke<string>("export_playlist_csv", { name, csv });
    return;
  }
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = Object.assign(document.createElement("a"), { href: url, download: `${name.trim() || "Playlist"}.csv` });
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
