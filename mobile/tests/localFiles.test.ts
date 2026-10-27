import { expect, mock, test } from "bun:test";
import { emptyLocalLibrary } from "../src/localLibrary";
const files = new Map<string, string>();
const copied: string[] = [];
mock.module("expo-file-system/legacy", () => ({
  documentDirectory: "file:///documents/", makeDirectoryAsync: async () => {},
  getInfoAsync: async (uri: string) => ({ exists: files.has(uri) }),
  readAsStringAsync: async (uri: string) => files.get(uri),
  writeAsStringAsync: async (uri: string, value: string) => { files.set(uri, value); },
  copyAsync: async ({ to }: { to: string }) => { copied.push(to); }, deleteAsync: async () => {},
}));
mock.module("expo-document-picker", () => ({ getDocumentAsync: async () => ({ canceled: false, assets: [{ uri: "content://external-song", name: "Song.mp3" }] }) }));
const { importLocalFiles, loadLocalLibrary, saveLocalLibrary } = await import("../src/localFiles");
test("imports keep durable device files; interrupted journal writes recover the last good state", async () => {
  expect((await loadLocalLibrary()).tracks).toHaveLength(0);
  const tracks = await importLocalFiles();
  expect(tracks[0].uri).toStartWith("file:///documents/local-music/");
  expect(copied).toContain(tracks[0].uri);
  const first = { ...emptyLocalLibrary(), tracks };
  await saveLocalLibrary(first);
  await saveLocalLibrary({ ...first, volume: 50 });
  expect((await loadLocalLibrary()).volume).toBe(50);
  files.set("file:///documents/local-music/library-0.json", "partial write");
  expect((await loadLocalLibrary()).tracks[0].id).toBe(tracks[0].id);
  expect((await loadLocalLibrary()).volume).toBe(100);
  files.set("file:///documents/local-music/library-1.json", "corrupt");
  await expect(loadLocalLibrary()).rejects.toThrow("recovery snapshots are preserved");
  expect(files.size).toBe(2);
});
