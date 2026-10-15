/** Provider-independent wire model. Mirrors server/src/lyrics/model.rs. */
export type LyricSegment = {
  text: string;
  startMs: number | null;
  endMs: number | null;
  granularity: "none" | "line" | "word" | "syllable" | "segment";
  singer: string | null;
};

export type LyricAnnotation = {
  language: string | null;
  segments: LyricSegment[];
};

export type LyricLine = {
  text: string;
  startMs: number | null;
  endMs: number | null;
  segments: LyricSegment[];
  /** Legacy response alias. Renderers use segments. */
  words: LyricSegment[];
  singer: string | null;
  translations: LyricAnnotation[];
  romanization: LyricAnnotation[];
  backgroundVocals: LyricLine[];
  key: string | null;
};

export type TrackLyrics = {
  status: "lyrics" | "instrumental" | "unavailable";
  instrumental: boolean | null;
  sync: LyricSegment["granularity"];
  hasWordSync: boolean;
  plainLyrics: string | null;
  lines: LyricLine[];
  source: "amll" | "lrc.red" | "lrclib" | null;
  originalFormat: "ttml" | "lyricsfile" | "lrc" | "plain" | null;
  offsetMs: number;
  language: string | null;
  singers: { id: string; name: string | null }[];
  failedProviders: string[];
};

const timing = (value: unknown): value is number | null => value === null
  || (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 86_400_000);
const optionalText = (value: unknown) => value === null || typeof value === "string";
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

/** Validate the local server boundary before building animation state. */
export function parseTrackLyrics(value: unknown): TrackLyrics {
  let segmentCount = 0;
  let lineCount = 0;
  const segment = (value: unknown): boolean => {
    if (++segmentCount > 60_000 || !object(value)) return false;
    return typeof value.text === "string" && timing(value.startMs) && timing(value.endMs)
      && (value.startMs === null || value.endMs === null || value.endMs >= value.startMs)
      && ["none", "line", "word", "syllable", "segment"].includes(String(value.granularity))
      && optionalText(value.singer);
  };
  const annotation = (value: unknown): boolean => object(value) && optionalText(value.language)
    && Array.isArray(value.segments) && value.segments.every(segment);
  const line = (value: unknown, depth = 0): boolean => {
    if (++lineCount > 10_000 || depth > 1 || !object(value)) return false;
    return typeof value.text === "string" && timing(value.startMs) && timing(value.endMs)
      && (value.startMs === null || value.endMs === null || value.endMs >= value.startMs)
      && Array.isArray(value.segments) && value.segments.every(segment)
      && value.segments.map(item => (item as LyricSegment).text).join("") === value.text
      && Array.isArray(value.words) && optionalText(value.singer) && optionalText(value.key)
      && Array.isArray(value.translations) && value.translations.every(annotation)
      && Array.isArray(value.romanization) && value.romanization.every(annotation)
      && Array.isArray(value.backgroundVocals) && value.backgroundVocals.every(item => line(item, depth + 1));
  };
  if (!object(value) || !["lyrics", "instrumental", "unavailable"].includes(String(value.status))
    || ![true, false, null].includes(value.instrumental as boolean | null)
    || !["none", "line", "word", "syllable", "segment"].includes(String(value.sync))
    || typeof value.hasWordSync !== "boolean" || !optionalText(value.plainLyrics)
    || !Array.isArray(value.lines) || !value.lines.every(item => line(item))
    || ![null, "amll", "lrc.red", "lrclib"].includes(value.source as string | null)
    || ![null, "ttml", "lyricsfile", "lrc", "plain"].includes(value.originalFormat as string | null)
    || typeof value.offsetMs !== "number" || !Number.isFinite(value.offsetMs) || Math.abs(value.offsetMs) > 86_400_000
    || !optionalText(value.language) || !Array.isArray(value.singers)
    || !value.singers.every(item => object(item) && typeof item.id === "string" && optionalText(item.name))
    || !Array.isArray(value.failedProviders) || !value.failedProviders.every(item => typeof item === "string")
  ) throw new Error("Invalid lyrics response");
  return value as TrackLyrics;
}
