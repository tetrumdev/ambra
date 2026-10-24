import { invoke, isTauri } from "@tauri-apps/api/core";
import type { Track } from "../types/music";
import { musicProviderName } from "./musicProviderName";

/** One row per song, in playlist order, with every detail AMBRA knows about it. */
const COLUMNS: [string, (track: Track, index: number) => string | number | null | undefined][] = [
  ["#", (_, index) => index + 1],
  ["Title", track => track.name],
  ["Version", track => track.version],
  ["Artist", track => track.artist],
  ["Artists", track => track.artists.map(artist => artist.name).join("; ")],
  ["Album Artist", track => track.albumArtists.map(artist => artist.name).join("; ")],
  ["Album", track => track.album],
  ["Album Version", track => track.albumVersion],
  ["Disc Number", track => track.discNumber],
  ["Track Number", track => track.trackNumber],
  ["Duration", track => formatDuration(track.durationSeconds)],
  ["Release Date", track => track.releaseDate],
  ["Genre", track => track.genres.join("; ")],
  ["Label", track => track.label],
  ["Copyright", track => track.copyright],
  ["Explicit", track => track.explicit ? "Yes" : "No"],
  ["ISRC", track => track.isrc],
  ["UPC", track => track.upc],
  ["Source", track => musicProviderName(track.provider)],
  ["Quality", track => track.quality],
  ["Bit Depth", track => track.maximumBitDepth],
  ["Sample Rate (kHz)", track => track.maximumSamplingRateKHz],
  ["Source Track ID", track => track.provider === "local" ? null : track.providerTrackId],
  ["Source Album ID", track => track.provider === "local" ? null : track.albumId],
];

function formatDuration(seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "";
  const total = Math.round(seconds);
  const [h, m, s] = [Math.floor(total / 3600), Math.floor(total / 60) % 60, total % 60];
  const pad = (value: number) => String(value).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function cell(value: string | number | null | undefined) {
  if (value === null || value === undefined) return "";
  let text = String(value);
  // A title like "=1" or "+44" would run as a formula in Excel or Numbers; a leading quote keeps it text.
  if (typeof value === "string" && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) || text !== text.trim() ? `"${text.replace(/"/g, '""')}"` : text;
}

export function playlistCsv(tracks: Track[]) {
  const rows = [COLUMNS.map(([name]) => cell(name)), ...tracks.map((track, index) => COLUMNS.map(([, read]) => cell(read(track, index))))];
  // A byte-order mark tells Excel the file is UTF-8, so accented and non-Latin names survive.
  return `﻿${rows.map(row => row.join(",")).join("\r\n")}\r\n`;
}

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
