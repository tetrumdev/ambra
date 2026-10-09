export const trackColumns = [
  { key: "track", label: "Track", className: "trackColumn", min: 140 },
  { key: "artist", label: "Artist", className: "artistColumn", min: 100 },
  { key: "album", label: "Album", className: "albumColumn", min: 120 },
  { key: "duration", label: "Duration", className: "durationColumn", min: 64 },
] as const;

export type ColumnKey = typeof trackColumns[number]["key"];
export type ColumnWidths = Partial<Record<ColumnKey, number>>;

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
