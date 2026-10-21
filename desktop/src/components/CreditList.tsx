import "./Credits.css";

export type CreditRow = { role: string; entries: { name: string; detail?: string }[] };

/** Liner notes: each role, then everyone credited with it. */
export function CreditList({ rows }: { rows: CreditRow[] }) {
  return (
    <dl className="creditList">
      {rows.map(row => (
        <div key={row.role} className="creditRow">
          <dt>{row.role}</dt>
          {row.entries.map(entry => (
            <dd key={entry.name}>
              {entry.name}
              {entry.detail && <span className="creditDetail">{entry.detail}</span>}
            </dd>
          ))}
        </div>
      ))}
    </dl>
  );
}
