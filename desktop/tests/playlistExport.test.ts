import { describe, expect, test } from "bun:test";
import type { Track } from "../src/types/music";
import { playlistCsv } from "../src/utils/playlistExport";

const track = (changes: Partial<Track>): Track => ({
  globalId: "qobuz:1", provider: "qobuz", providerTrackId: "1", playbackKind: "direct", audio: "", cover: "", nativeCover: null,
  name: "Killer Queen", version: null, album: "Sheer Heart Attack", albumVersion: null, albumId: "a1",
  albumArtists: [{ providerId: "q", name: "Queen", imageUrl: null }], artist: "Queen",
  artists: [{ providerId: "q", name: "Queen", imageUrl: null }], trackNumber: 2, discNumber: 1, durationSeconds: 180.4,
  releaseDate: "1974-11-08", explicit: false, isrc: "GBUM71029606", copyright: null, label: "EMI", genres: ["Rock", "Glam"],
  upc: null, quality: "FLAC 24-bit/96 kHz", maximumBitDepth: 24, maximumSamplingRateKHz: 96, ...changes,
});

describe("playlist export", () => {
  const rows = (csv: string) => csv.replace(/^\uFEFF/, "").split("\r\n").filter(Boolean);

  test("one row per song in order, under a header, as UTF-8 Excel reads", () => {
    const csv = playlistCsv([track({}), track({ name: "Brighton Rock", trackNumber: 1, durationSeconds: 3725 })]);
    expect(csv.startsWith("\uFEFF#,Title,")).toBe(true);
    const [, first, second] = rows(csv);
    expect(first).toBe("1,Killer Queen,,Queen,Queen,Queen,Sheer Heart Attack,,1,2,3:00,1974-11-08,Rock; Glam,EMI,,No,GBUM71029606,,Qobuz,FLAC 24-bit/96 kHz,24,96,1,a1");
    expect(second.split(",").slice(0, 11)).toEqual(["2", "Brighton Rock", "", "Queen", "Queen", "Queen", "Sheer Heart Attack", "", "1", "1", "1:02:05"]);
  });

  test("commas, quotes and line breaks stay inside their cell", () => {
    const [, row] = rows(playlistCsv([track({ name: 'Say "Hi", then\nbye' })]));
    expect(row.startsWith('1,"Say ""Hi"", then\nbye",')).toBe(true);
  });

  test("a title that looks like a formula opens as text", () => {
    const [, row] = rows(playlistCsv([track({ name: "=HYPERLINK(1)" })]));
    expect(row.split(",")[1]).toBe("'=HYPERLINK(1)");
  });

  test("local files have no service IDs", () => {
    const [, row] = rows(playlistCsv([track({ provider: "local", providerTrackId: "C:\Music\a.flac", albumId: "x" })]));
    expect(row.endsWith(",Local,FLAC 24-bit/96 kHz,24,96,,")).toBe(true);
  });
});
