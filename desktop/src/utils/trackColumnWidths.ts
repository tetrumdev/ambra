/** Columns a list can show beside the standard ones, chosen from the column header. */
export const optionalTrackColumns = [
  { key: "quality", label: "Quality", className: "qualityColumn", min: 96, fr: 0.8 },
  { key: "year", label: "Year", className: "yearColumn", min: 56, fr: 0.3 },
  { key: "genre", label: "Genre", className: "genreColumn", min: 80, fr: 0.7 },
  { key: "plays", label: "Plays", className: "playsColumn", min: 64, fr: 0.3 },
  { key: "lastPlayed", label: "Last played", className: "lastPlayedColumn", min: 96, fr: 0.6 },
] as const;

// Optional columns sit between the album and the duration, in this order.
export const trackColumns = [
  { key: "track", label: "Track", className: "trackColumn", min: 140 },
  { key: "artist", label: "Artist", className: "artistColumn", min: 100 },
  { key: "album", label: "Album", className: "albumColumn", min: 120 },
  ...optionalTrackColumns,
  { key: "duration", label: "Duration", className: "durationColumn", min: 64 },
] as const;

export type ColumnKey = typeof trackColumns[number]["key"];

/** Standard columns a list can do without; the song's name is all that's needed to know it. */
export const hideableTrackColumns = ["artist", "album", "duration"] as const;
export type HideableColumnKey = typeof hideableTrackColumns[number];
export function isHideableColumn(key: string): key is HideableColumnKey {
  return (hideableTrackColumns as readonly string[]).includes(key);
}
export type OptionalColumnKey = typeof optionalTrackColumns[number]["key"];
export type ColumnWidths = Partial<Record<ColumnKey, number>>;

const optionalKeys = new Set<string>(optionalTrackColumns.map(column => column.key));
export function isOptionalColumn(key: string): key is OptionalColumnKey {
  return optionalKeys.has(key);
}

/** The chosen optional columns, in display order and without repeats or unknown keys. */
export function orderedOptionalColumns(keys: readonly string[]) {
  const chosen = new Set(keys);
  return optionalTrackColumns.filter(column => chosen.has(column.key));
}

/** Grid tracks for the chosen optional columns, spliced into every list's column template. */
export function optionalColumnsTemplate(keys: readonly OptionalColumnKey[]) {
  return orderedOptionalColumns(keys).map(column => `minmax(${column.min}px, ${column.fr}fr)`).join(" ");
}

export function resizeColumnPair(widths: ColumnWidths, left: ColumnKey, right: ColumnKey, delta: number): ColumnWidths {
  const leftWidth = widths[left];
  const rightWidth = widths[right];
  if (leftWidth === undefined || rightWidth === undefined || !Number.isFinite(delta)) return widths;
  const minimum = (key: ColumnKey) => trackColumns.find(column => column.key === key)!.min;
  const maximum = (key: ColumnKey) => key === "duration" ? 180 : Infinity;
  const low = Math.max(minimum(left) - leftWidth, rightWidth - maximum(right));
  const high = Math.min(maximum(left) - leftWidth, rightWidth - minimum(right));
  if (low > high) return widths;
  const change = Math.max(low, Math.min(high, delta));
  return { ...widths, [left]: leftWidth + change, [right]: rightWidth - change };
}
