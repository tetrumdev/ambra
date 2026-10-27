import * as FileSystem from "expo-file-system/legacy";
import * as DocumentPicker from "expo-document-picker";
import { emptyLocalLibrary, parseLocalLibrary, type LocalLibrary, type LocalTrack } from "./localLibrary";

const directory = () => {
  if (!FileSystem.documentDirectory) throw new Error("Local music needs a native iOS or Android build.");
  return `${FileSystem.documentDirectory}local-music/`;
};
const slot = (index: number) => `${directory()}library-${index}.json`;
let revision = 0;

/** Alternating slots retain the last good snapshot even if a write is interrupted. */
export async function loadLocalLibrary(): Promise<LocalLibrary> {
  await FileSystem.makeDirectoryAsync(directory(), { intermediates: true });
  const states = await Promise.all([0, 1].map(async index => {
    if (!(await FileSystem.getInfoAsync(slot(index))).exists) return null;
    try {
      const saved = JSON.parse(await FileSystem.readAsStringAsync(slot(index))) as { revision: number; state: LocalLibrary };
      if (!Number.isSafeInteger(saved.revision) || saved.revision < 1) throw new Error("Invalid local revision.");
      return { revision: saved.revision, state: parseLocalLibrary(JSON.stringify(saved.state)) };
    } catch { return { revision: -1, state: null }; }
  }));
  const latest = states.filter(state => state?.state).sort((left, right) => right!.revision - left!.revision)[0];
  if (!latest && states.some(Boolean)) throw new Error("Local music state could not be read. Files and recovery snapshots are preserved.");
  revision = latest?.revision ?? 0;
  const state = latest?.state ?? emptyLocalLibrary();
  // iOS may move the application container during an update. Owned filenames stay stable.
  return { ...state, tracks: state.tracks.map(track => {
    const filename = track.uri.slice(track.uri.lastIndexOf("/") + 1);
    return track.uri.includes("/local-music/") && filename.startsWith(`${track.id}.`)
      ? { ...track, uri: `${directory()}${filename}` } : track;
  }) };
}
export async function saveLocalLibrary(state: LocalLibrary) {
  const next = revision + 1;
  await FileSystem.writeAsStringAsync(slot(next % 2), JSON.stringify({ revision: next, state }));
  revision = next;
}

/** Copy into application documents so temporary picker permissions cannot break offline playback. */
export async function importLocalFiles(): Promise<LocalTrack[]> {
  const result = await DocumentPicker.getDocumentAsync({ type: ["audio/*", "application/ogg"], multiple: true, copyToCacheDirectory: true });
  if (result.canceled) return [];
  await FileSystem.makeDirectoryAsync(directory(), { intermediates: true });
  const tracks: LocalTrack[] = [];
  try {
    for (const asset of result.assets) {
      const extension = asset.name.split(".").pop()?.toLowerCase();
      if (!extension || !["mp3", "m4a", "aac", "wav", "flac", "ogg", "opus", "aif", "aiff", "alac", "mp4"].includes(extension)) throw new Error(`Unsupported audio file: ${asset.name}`);
      const id = `local-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const uri = `${directory()}${id}.${extension}`;
      await FileSystem.copyAsync({ from: asset.uri, to: uri });
      tracks.push({ id, uri, name: asset.name.replace(/\.[^.]+$/, ""), artist: "Unknown artist", album: "Local music", durationSeconds: 0 });
    }
    return tracks;
  } catch (error) {
    await Promise.all(tracks.map(track => FileSystem.deleteAsync(track.uri, { idempotent: true })));
    throw error;
  }
}

export async function removeLocalFile(track: LocalTrack) {
  if (!track.uri.startsWith(directory()) || track.uri.slice(directory().length).includes("/")) throw new Error("Only imported Ambra copies can be removed.");
  await FileSystem.deleteAsync(track.uri, { idempotent: true });
}
