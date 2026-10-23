import type { Track } from "../types/music";
import { useTrackColumns } from "../hooks/useTrackColumns";
import { compactAudioQuality } from "../utils/audioQuality";
import { orderedOptionalColumns, type OptionalColumnKey } from "../utils/trackColumnWidths";

const dateFormat = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" });
const DAY_MS = 86_400_000;

function formatLastPlayed(time: number) {
  const startOfToday = new Date().setHours(0, 0, 0, 0);
  if (time >= startOfToday) return "Today";
  const days = Math.ceil((startOfToday - time) / DAY_MS);
  if (days <= 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;
  return dateFormat.format(time);
}

/** The text a song shows in an optional column, or null when it has nothing to show. */
function cellText(key: OptionalColumnKey, track: Track, stats: ReturnType<typeof useTrackColumns>["stats"]) {
  switch (key) {
    case "quality": return compactAudioQuality(track);
    case "year": return track.releaseDate?.slice(0, 4) || null;
    case "genre": return track.genres[0] ?? null;
    case "plays": return String(stats.get(track.globalId)?.plays ?? 0);
    case "lastPlayed": {
      const played = stats.get(track.globalId)?.lastPlayedAt;
      return played ? formatLastPlayed(played) : null;
    }
  }
}

/** A song's cells for the optional columns, between its album and its duration. */
export function TrackExtraCells({ track }: { track: Track }) {
  const { extra, stats } = useTrackColumns();
  return orderedOptionalColumns(extra).map(column => {
    const text = cellText(column.key, track, stats);
    return <span key={column.key} className={`extraCell ${column.className}Cell trackDescriptor`} title={text ?? undefined}>
      {text ?? <span className="extraCellEmpty" aria-label="None">–</span>}
    </span>;
  });
}
