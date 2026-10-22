import type { CatalogArtist } from "../api/server";
import "./Credits.css";

export type CreditRow = { role: string; entries: { name: string; detail?: string }[] };

/** Liner notes: each role, then everyone credited with it; names with an artist page link to it. */
export function CreditList({ rows, artistFor, onOpenArtist }: {
  rows: CreditRow[];
  artistFor?: (name: string) => CatalogArtist | null;
  onOpenArtist?: (artist: CatalogArtist) => void;
}) {
  return (
    <dl className="creditList">
      {rows.map(row => (
        <div key={row.role} className="creditRow">
          <dt>{row.role}</dt>
          {row.entries.map(entry => {
            const artist = onOpenArtist ? artistFor?.(entry.name) : null;
            return (
              <dd key={entry.name}>
                {artist ? (
                  <button type="button" className="entityLink" onClick={() => onOpenArtist!(artist)}>{entry.name}</button>
                ) : entry.name}
                {entry.detail && <span className="creditDetail">{entry.detail}</span>}
              </dd>
            );
          })}
        </div>
      ))}
    </dl>
  );
}
