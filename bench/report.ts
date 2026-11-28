/**
 * Markdown tables for docs/development/search-pass.md from two benchmark results.
 *
 *   bun bench/report.ts [before.json] [after.json]
 *
 * Defaults: bench/baseline.json and bench/results/latest.json.
 */
import fs from "node:fs";
import path from "node:path";

type Summary = Record<string, any>;
type Result = { meta: Record<string, unknown>; result: Record<string, Record<string, Summary>> };
const read = (file: string): Result => JSON.parse(fs.readFileSync(file, "utf8"));
const [beforeFile = path.join(import.meta.dir, "baseline.json"), afterFile = path.join(import.meta.dir, "results", "latest.json")] = process.argv.slice(2);
const before = read(beforeFile), after = read(afterFile);
const labels = JSON.parse(fs.readFileSync(path.join(import.meta.dir, "queries.json"), "utf8")) as { id: string; q: string; split: string; cat: string[] }[];

const metrics: [string, string, "up" | "down"][] = [
  ["Lead section accuracy", "hierarchy.leadAccuracy", "up"],
  ["Song's album in albums", "hierarchy.trackAlbumInSection", "up"],
  ["Song's artist in artists", "hierarchy.trackArtistInSection", "up"],
  ["Artist query shows their songs", "hierarchy.artistTracksShown", "up"],
  ["Artist query shows their albums", "hierarchy.artistAlbumsShown", "up"],
  ["Top-1 (leading section)", "accuracy.top1", "up"],
  ["Tracks top-1", "accuracy.tracksTop1", "up"], ["Albums top-1", "accuracy.albumsTop1", "up"], ["Artists top-1", "accuracy.artistsTop1", "up"],
  ["Tracks MRR", "accuracy.tracksMRR", "up"], ["Albums MRR", "accuracy.albumsMRR", "up"], ["Artists MRR", "accuracy.artistsMRR", "up"],
  ["Tracks nDCG@5", "accuracy.tracksNDCG5", "up"], ["Albums nDCG@5", "accuracy.albumsNDCG5", "up"], ["Artists nDCG@5", "accuracy.artistsNDCG5", "up"],
  ["Forbidden in top 5", "accuracy.forbiddenTop5", "down"], ["Duplicates in top 10 (per query)", "accuracy.duplicatesTop10", "down"],
  ["Correct copy", "accuracy.correctCopy", "up"], ["Correct album edition", "accuracy.correctEdition", "up"],
  ["Artist disambiguation", "accuracy.artistDisambiguation", "up"],
];
const speed: [string, string, "up" | "down"][] = [
  ["First results p50 (ms)", "speed.firstP50", "down"], ["First results p95 (ms)", "speed.firstP95", "down"],
  ["Settled p50 (ms)", "speed.settledP50", "down"], ["Settled p95 (ms)", "speed.settledP95", "down"],
  ["Top-5 reshuffles after first paint", "speed.reshufflesMean", "down"], ["Lead-section changes", "speed.leadChangesMean", "down"],
  ["Requests to the server", "speed.requestsMean", "down"], ["Upstream searches/lookups", "speed.upstreamMean", "down"],
  ["Ranking CPU per publish p50 (ms)", "speed.cpuPerPublishP50", "down"], ["Ranking CPU per publish p95 (ms)", "speed.cpuPerPublishP95", "down"],
];

const get = (object: unknown, key: string) => key.split(".").reduce<any>((value, part) => value?.[part], object);
const fmt = (value: unknown, digits = 3) => typeof value !== "number" ? "—" : Math.abs(value) >= 100 ? value.toFixed(0) : value.toFixed(digits);
function delta(a: unknown, b: unknown) {
  if (typeof a !== "number" || typeof b !== "number") return ["—", "—"];
  const d = b - a;
  return [`${d >= 0 ? "+" : ""}${fmt(d)}`, a === 0 ? (d === 0 ? "0%" : "—") : `${d >= 0 ? "+" : ""}${(100 * d / Math.abs(a)).toFixed(1)}%`];
}

function table(title: string, rows: [string, string, "up" | "down"][], platform: string, profile: string, splits = ["dev", "holdout"]) {
  const lines = [`#### ${title}`, "", `| Metric | ${splits.map(s => `${s} before | ${s} after | Δ | Δ%`).join(" | ")} |`, `|---|${splits.map(() => "---:|---:|---:|---:").join("|")}|`];
  for (const [name, key] of rows) {
    const cells = splits.flatMap(split => {
      const a = get(before.result[platform]?.[profile]?.[split], key), b = get(after.result[platform]?.[profile]?.[split], key);
      return [fmt(a), fmt(b), ...delta(a, b)];
    });
    lines.push(`| ${name} | ${cells.join(" | ")} |`);
  }
  return lines.join("\n");
}

function categories(platform: string, profile: string) {
  const b = before.result[platform][profile].perQuery, a = after.result[platform][profile].perQuery;
  const names = [...new Set(labels.flatMap(label => label.cat))].sort();
  const rate = (values: number[]) => values.length ? (values.reduce((x, y) => x + y, 0) / values.length).toFixed(2) : "—";
  const pair = (subset: typeof labels, read: (entry: any) => number | null) => {
    const x = subset.map(label => read(b[label.id])).filter((v): v is number => v !== null);
    const y = subset.map(label => read(a[label.id])).filter((v): v is number => v !== null);
    return `${rate(x)} → ${rate(y)}`;
  };
  const lead = (entry: any) => Number(entry.score.leadHit), top1 = (entry: any) => Number(entry.score.top1);
  const mrr = (section: string) => (entry: any) => entry.score.section[section]?.mrr ?? null;
  const forbidden = (entry: any) => Number(entry.score.forbidden);
  const lines = [`#### ${platform}, ${profile}: by category`, "", "| Category | n dev / held out | Lead dev | Lead held out | Top-1 dev | Top-1 held out | Tracks MRR | Albums MRR | Artists MRR | Forbidden |", "|---|---|---|---|---|---|---|---|---|---|"];
  for (const name of names) {
    const all = labels.filter(label => label.cat.includes(name));
    const dev = all.filter(label => label.split === "dev"), held = all.filter(label => label.split === "holdout");
    lines.push(`| ${name} | ${dev.length} / ${held.length} | ${pair(dev, lead)} | ${pair(held, lead)} | ${pair(dev, top1)} | ${pair(held, top1)} | ${pair(all, mrr("tracks"))} | ${pair(all, mrr("albums"))} | ${pair(all, mrr("artists"))} | ${pair(all, forbidden)} |`);
  }
  return lines.join("\n");
}

function confusion(platform: string, profile: string) {
  const lines = [`#### ${platform}, ${profile}: leading section, expected (rows) × shown (columns), all queries, before → after`, "", "| Expected | tracks | albums | artists |", "|---|---|---|---|"];
  for (const expected of ["tracks", "albums", "artists"]) {
    const cell = (shown: string) => ["dev", "holdout"].map(split => [before, after].map(r => r.result[platform][profile][split].hierarchy.confusion[expected]?.[shown] ?? 0))
      .reduce(([x0, y0], [x1, y1]) => [x0 + x1, y0 + y1], [0, 0]).join(" → ");
    lines.push(`| ${expected} | ${cell("tracks")} | ${cell("albums")} | ${cell("artists")} |`);
  }
  return lines.join("\n");
}

/** One number per query to rank wins and losses by. */
function utility(entry: any) {
  if (!entry) return 0;
  const s = entry.score;
  const mrr = ["tracks", "albums", "artists"].map(name => s.section[name]?.mrr).filter((v: unknown) => typeof v === "number");
  return 2 * Number(s.leadHit) + 2 * Number(s.top1) + mrr.reduce((x: number, y: number) => x + y, 0) / Math.max(1, mrr.length)
    + (s.copyOk === null ? 0 : 0.5 * Number(s.copyOk)) - Number(s.forbidden) - 0.1 * s.duplicates;
}

function topList(entry: any) {
  const lead = entry.order[0];
  const sections = [lead, ...["tracks", "albums", "artists"].filter(name => name !== lead)];
  return sections.map(name => `${name}: ${(entry.top[name] ?? []).slice(0, 2).join("; ") || "—"}`).join("<br>");
}

function movers(platform: string, profile: string) {
  const b = before.result[platform][profile].perQuery, a = after.result[platform][profile].perQuery;
  const rows = labels.map(label => ({ label, gain: utility(a[label.id]) - utility(b[label.id]), now: utility(a[label.id]) }));
  const wins = [...rows].sort((x, y) => y.gain - x.gain).slice(0, 10);
  const worst = [...rows].sort((x, y) => x.now - y.now).slice(0, 10);
  const block = (title: string, list: typeof rows) => [`#### ${title}`, "", "| Query | Split | Utility before → after | Before | After |", "|---|---|---|---|---|",
    ...list.map(({ label }) => `| \`${label.q}\` | ${label.split} | ${utility(b[label.id]).toFixed(2)} → ${utility(a[label.id]).toFixed(2)} | ${topList(b[label.id])} | ${topList(a[label.id])} |`)].join("\n");
  return `${block(`${platform}: 10 biggest wins`, wins)}\n\n${block(`${platform}: 10 worst remaining`, worst)}`;
}

function parity(profile: string) {
  const d = after.result.desktop[profile], m = after.result.mobile[profile];
  const db = before.result.desktop[profile], mb = before.result.mobile[profile];
  const lines = ["#### Mobile vs desktop (all queries)", "", "| Metric | Desktop before | Mobile before | Desktop after | Mobile after |", "|---|---:|---:|---:|---:|"];
  for (const [name, key] of [...metrics, ...speed]) lines.push(`| ${name} | ${fmt(get(db.all, key))} | ${fmt(get(mb.all, key))} | ${fmt(get(d.all, key))} | ${fmt(get(m.all, key))} |`);
  const differ = labels.filter(label => {
    const x = d.perQuery[label.id], y = m.perQuery[label.id];
    return x.order[0] !== y.order[0] || x.top.tracks[0] !== y.top.tracks[0];
  });
  const differBefore = labels.filter(label => {
    const x = db.perQuery[label.id], y = mb.perQuery[label.id];
    return x.order[0] !== y.order[0] || x.top.tracks[0] !== y.top.tracks[0];
  });
  lines.push("", `Queries where mobile's leading section or top song differs from desktop: ${differBefore.length} before, ${differ.length} after.`);
  if (differ.length) lines.push("", ...differ.slice(0, 15).map(label => `- \`${label.q}\`: desktop ${d.perQuery[label.id].order[0]} / ${d.perQuery[label.id].top.tracks[0] ?? "—"}; mobile ${m.perQuery[label.id].order[0]} / ${m.perQuery[label.id].top.tracks[0] ?? "—"}`));
  return lines.join("\n");
}

const out: string[] = [`Before: \`${before.meta.commit}\`; after: \`${after.meta.commit}\`.`, ""];
for (const platform of ["desktop", "mobile"]) {
  out.push(`### ${platform[0].toUpperCase()}${platform.slice(1)}`, "", table(`${platform}: hierarchy and accuracy (typical latency)`, metrics, platform, "typical"), "");
  for (const profile of Object.keys(after.result[platform])) out.push(table(`${platform}: speed, ${profile} latency`, speed, platform, profile), "");
  out.push(confusion(platform, "typical"), "", categories(platform, "typical"), "", movers(platform, "typical"), "");
}
out.push("### Parity", "", parity("typical"));
console.log(out.join("\n"));
