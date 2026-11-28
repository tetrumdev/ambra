/**
 * Ambra search benchmark.
 *
 *   bun run search:bench                       replay every query, print the metrics, write bench/results/latest.json
 *   bun run search:bench --compare             ...and compare with bench/baseline.json
 *   bun run search:bench --baseline            run three times, check they agree, write bench/baseline.json
 *   bun run search:bench record                record fixtures from the Ambra server at AMBRA_BENCH_SERVER
 *   bun run search:bench --fill                replay, sending requests no fixture holds to that server once
 *   bun run search:bench live                  20 queries against the live server, cold then warm, 3 runs
 *
 * Options: --only=id,id  --split=dev  --profiles=typical,fast  --platforms=desktop,mobile  --out=path
 */
import fs from "node:fs";
import path from "node:path";
import { VirtualClock, wallClock } from "./clock";
import { FixtureStore, installNetwork, profiles as allProfiles, requestKey, type Profile, type RequestLog } from "./network";
import { loadApps, measurePublishes, runDesktop, runMobile, type Run, type Section, type View } from "./pipelines";
import { score, type Label, type Score } from "./judge";
import type { CatalogAlbum, CatalogArtist, RemoteTrack } from "../desktop/src/api/server";
import type { Track } from "../desktop/src/types/music";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const option = (name: string) => args.find(arg => arg.startsWith(`--${name}=`))?.split("=")[1];
const mode = args.find(arg => !arg.startsWith("--")) ?? "bench";
const server = process.env.AMBRA_BENCH_SERVER ?? "http://127.0.0.1:38147";

const labels = (JSON.parse(fs.readFileSync(path.join(import.meta.dir, "queries.json"), "utf8")) as Label[])
  .filter(label => !option("only") || option("only")!.split(",").includes(label.id))
  // Tuning looks at the dev split only; held-out queries are scored once a change is settled.
  .filter(label => !option("split") || label.split === option("split"));


/** Each query's own first pages from every service, cold, then a filling replay for whatever else the apps ask. */
async function record() {
  const store = new FixtureStore();
  const { providers } = await (await fetch(`${server}/api/search/providers`)).json() as { providers: string[] };
  for (const [index, label] of labels.entries()) {
    const key = (route: string, params: Record<string, string>) => requestKey(`${route}?${new URLSearchParams(params)}`);
    const wanted = [key("/api/search/providers", {}), ...providers.flatMap(provider => [
      key("/api/search/catalog", { query: label.q, provider, limit: "20" }),
      key("/api/search/tracks", { query: label.q, provider, offset: "0", limit: "20" }),
    ])];
    await Promise.all(wanted.map(async request => {
      if (store.get(label.id, request) && store.bodies(label.id).length) return;
      const started = wallClock.now();
      const response = await fetch(`${server}${request}`);
      const text = await response.text();
      let body: unknown = text;
      try { body = JSON.parse(text); } catch { /* kept as text */ }
      store.set(label.id, request, { status: response.status, body, ms: Math.round(wallClock.now() - started) });
    }));
    store.save();
    console.log(`recorded ${index + 1}/${labels.length} ${label.id}`);
    // Gentle on the services: one query's six requests at a time.
    await Bun.sleep(300);
  }
  process.argv.push("--fill");
  args.push("--fill");
  await bench();
}

function percentile(values: number[], p: number) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}
const mean = (values: number[]) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
const rate = (values: (boolean | null)[]) => mean(values.filter((value): value is boolean => value !== null).map(Number));

type Timing = { first: number | null; settled: number | null; done: number | null; reshuffles: number; bySection: Record<string, number>; copySwaps: number; leadChanges: number; requests: number; upstream: number; byKind: Record<string, number>; cpu: number[] };

const visible = (view: View) => view.tracks.length > 0 || view.albums.length > 0 || view.artists.length > 0;
const signature = (view: View) => JSON.stringify([view.order[0], view.tracks.slice(0, 5).map(t => t.globalId), view.albums.slice(0, 5).map(a => a.id), view.artists.slice(0, 5).map(a => a.id)]);

function timing(run: Run): Timing {
  const shown = run.views.filter(visible);
  const bySection: Record<string, number> = { tracks: 0, albums: 0, artists: 0 };
  let reshuffles = 0, leadChanges = 0, copySwaps = 0, settled: number | null = shown[0]?.at ?? null;
  for (let i = 1; i < shown.length; i++) {
    const before = shown[i - 1], after = shown[i];
    if (signature(before) !== signature(after)) settled = after.at;
    if (before.order[0] !== after.order[0]) leadChanges++;
    // A card that was on screen moved or went away; new cards filling empty places don't count.
    for (const [section, a, b] of [["tracks", before.tracks.map(t => t.globalId), after.tracks.map(t => t.globalId)], ["albums", before.albums.map(x => x.id), after.albums.map(x => x.id)], ["artists", before.artists.map(x => x.id), after.artists.map(x => x.id)]] as const) {
      if (a.slice(0, 5).some((id, index) => b[index] !== id)) { reshuffles++; bySection[section]++; }
    }
    // The same song in the same place, shown from another copy (service or edition).
    const song = (t: Track) => `${t.name.toLowerCase()}|${t.artist.toLowerCase()}`;
    if (before.tracks.slice(0, 5).some((t, i) => after.tracks[i] && after.tracks[i].globalId !== t.globalId && song(after.tracks[i]) === song(t))) copySwaps++;
  }
  const requests = run.requests.filter(entry => entry.kind !== "other");
  const byKind: Record<string, number> = {};
  for (const entry of requests) byKind[entry.kind] = (byKind[entry.kind] ?? 0) + 1;
  // The server answers a repeated search from its 5-minute cache; only the first goes upstream.
  const upstream = new Set(requests.filter(entry => entry.kind !== "providers").map(entry => entry.key)).size;
  const done = run.views.filter(view => !view.searching).at(-1)?.at ?? null;
  return { first: shown[0]?.at ?? null, settled, done, reshuffles, bySection, copySwaps, leadChanges, requests: requests.length, upstream, byKind, cpu: run.cpu };
}

/** Everything recorded for the query, plus what the run found: where the ideal ranking is looked for. */
function poolFor(store: FixtureStore, id: string, run: Run, toTrack: (remote: RemoteTrack) => Track) {
  const tracks: Track[] = [], albums: CatalogAlbum[] = [], artists: CatalogArtist[] = [];
  for (const body of store.bodies(id)) {
    if (!body || typeof body !== "object") continue;
    const page = body as { tracks?: RemoteTrack[]; albums?: CatalogAlbum[]; artists?: CatalogArtist[] };
    if (Array.isArray(page.tracks)) for (const remote of page.tracks) { try { tracks.push(toTrack(remote)); } catch { /* not a track */ } }
    if (Array.isArray(page.albums)) albums.push(...page.albums);
    if (Array.isArray(page.artists)) artists.push(...page.artists);
  }
  for (const view of run.views) { tracks.push(...view.candidates); albums.push(...view.albums.flatMap(album => [album, ...album.versions ?? []])); artists.push(...view.artists); }
  return { tracks, albums, artists };
}

type QueryResult = { id: string; split: string; cat: string[]; score: Score; timing: Timing; top: Record<Section, string[]>; order: Section[] };

const describeTrack = (track: Track) => `${track.name} — ${track.artist} [${track.album}; ${track.provider}${track.quality ? ` ${track.quality}` : ""}]`;
const describeAlbum = (album: CatalogAlbum) => `${album.title}${album.version ? ` (${album.version})` : ""} — ${album.artist} [${album.provider}]`;

function aggregate(results: QueryResult[]) {
  const scores = results.map(result => result.score);
  const timings = results.map(result => result.timing);
  const sectionMetric = (section: Section, metric: "mrr" | "ndcg" | "top1") => {
    const values = scores.map(s => s.section[section]?.[metric]).filter((v): v is number | boolean => v !== null && v !== undefined).map(Number);
    return mean(values);
  };
  const confusion: Record<string, Record<string, number>> = {};
  for (const [index, result] of results.entries()) {
    const label = labels.find(candidate => candidate.id === result.id)!;
    confusion[label.lead] ??= { tracks: 0, albums: 0, artists: 0 };
    confusion[label.lead][scores[index].leadPredicted]++;
  }
  const cpu = timings.flatMap(t => t.cpu);
  const firsts = timings.map(t => t.first).filter((v): v is number => v !== null);
  const settles = timings.map(t => t.settled).filter((v): v is number => v !== null);
  const kinds: Record<string, number> = {};
  for (const t of timings) for (const [kind, count] of Object.entries(t.byKind)) kinds[kind] = (kinds[kind] ?? 0) + count / timings.length;
  return {
    queries: results.length,
    hierarchy: {
      leadAccuracy: rate(scores.map(s => s.leadHit)),
      confusion,
      trackAlbumInSection: rate(scores.map(s => s.consistency.album)),
      trackArtistInSection: rate(scores.map(s => s.consistency.artist)),
      artistTracksShown: rate(scores.map(s => s.consistency.artistTracks)),
      artistAlbumsShown: rate(scores.map(s => s.consistency.artistAlbums)),
    },
    accuracy: {
      top1: rate(scores.map(s => s.top1)),
      tracksTop1: sectionMetric("tracks", "top1"), albumsTop1: sectionMetric("albums", "top1"), artistsTop1: sectionMetric("artists", "top1"),
      tracksMRR: sectionMetric("tracks", "mrr"), albumsMRR: sectionMetric("albums", "mrr"), artistsMRR: sectionMetric("artists", "mrr"),
      tracksNDCG5: sectionMetric("tracks", "ndcg"), albumsNDCG5: sectionMetric("albums", "ndcg"), artistsNDCG5: sectionMetric("artists", "ndcg"),
      forbiddenTop5: rate(scores.map(s => s.forbidden)),
      duplicatesTop10: mean(scores.map(s => s.duplicates)),
      correctCopy: rate(scores.map(s => s.copyOk)),
      correctEdition: rate(scores.map(s => s.editionOk)),
      artistDisambiguation: rate(scores.map(s => s.disambiguation)),
      empty: rate(scores.map(s => s.empty)),
    },
    speed: {
      firstP50: percentile(firsts, 0.5), firstP95: percentile(firsts, 0.95),
      settledP50: percentile(settles, 0.5), settledP95: percentile(settles, 0.95),
      neverShown: timings.filter(t => t.first === null).length,
      reshufflesMean: mean(timings.map(t => t.reshuffles)),
      reshufflesBySection: Object.fromEntries(["tracks", "albums", "artists"].map(section => [section, mean(timings.map(t => t.bySection?.[section] ?? 0))])),
      copySwapsMean: mean(timings.map(t => t.copySwaps ?? 0)), reshufflesP95: percentile(timings.map(t => t.reshuffles), 0.95),
      leadChangesMean: mean(timings.map(t => t.leadChanges)),
      requestsMean: mean(timings.map(t => t.requests)), requestsP95: percentile(timings.map(t => t.requests), 0.95),
      upstreamMean: mean(timings.map(t => t.upstream)), upstreamP95: percentile(timings.map(t => t.upstream), 0.95),
      requestsByKind: kinds,
      cpuPerPublishP50: percentile(cpu, 0.5), cpuPerPublishP95: percentile(cpu, 0.95), publishesMean: mean(timings.map(t => t.cpu.length)),
    },
  };
}

function summarize(results: QueryResult[]) {
  const categories = [...new Set(labels.flatMap(label => label.cat))].sort();
  return {
    all: aggregate(results),
    dev: aggregate(results.filter(r => r.split === "dev")),
    holdout: aggregate(results.filter(r => r.split === "holdout")),
    byCategory: Object.fromEntries(categories.map(category => [category, (() => {
      const subset = results.filter(r => r.cat.includes(category));
      const a = aggregate(subset);
      return { queries: a.queries, leadAccuracy: a.hierarchy.leadAccuracy, top1: a.accuracy.top1, tracksMRR: a.accuracy.tracksMRR, albumsMRR: a.accuracy.albumsMRR, artistsMRR: a.accuracy.artistsMRR, forbiddenTop5: a.accuracy.forbiddenTop5, correctCopy: a.accuracy.correctCopy, firstP50: a.speed.firstP50, reshufflesMean: a.speed.reshufflesMean };
    })()])),
  };
}

async function bench() {
  const clock = new VirtualClock();
  clock.install();
  const store = new FixtureStore();
  const network = installNetwork(clock, store, flag("fill") ? server : null);
  const apps = await loadApps();
  const { playableTrack } = await import("../desktop/src/api/server");
  const cpu = { samples: [] as number[] };
  measurePublishes(apps, cpu);
  await apps.client.restore();
  const chosenProfiles = (option("profiles")?.split(",") ?? allProfiles) as Profile[];
  const platforms = option("platforms")?.split(",") ?? ["desktop", "mobile"];
  const runs = flag("baseline") ? 3 : 1;
  const outputs: Record<string, Record<string, ReturnType<typeof summarize> & { perQuery: Record<string, unknown> }>>[] = [];
  for (let attempt = 0; attempt < runs; attempt++) {
    const output: (typeof outputs)[number] = {};
    for (const platform of platforms) {
      output[platform] = {};
      for (const profile of chosenProfiles) {
        const results: QueryResult[] = [];
        for (const label of labels) {
          clock.reset();
          network.begin(label.id, profile);
          const run = platform === "desktop" ? await runDesktop(apps, clock, network, label.q, cpu) : await runMobile(apps, clock, network, label.q, cpu);
          const pool = poolFor(store, label.id, run, playableTrack);
          const result = score(label, run.final, pool);
          results.push({ id: label.id, split: label.split, cat: label.cat, score: result, timing: timing(run), order: run.final.order,
            top: { tracks: run.final.tracks.slice(0, 5).map(describeTrack), albums: run.final.albums.slice(0, 5).map(describeAlbum), artists: run.final.artists.slice(0, 5).map(a => `${a.name} [${(a.sources ?? [a]).map(s => s.provider).join("+")}]`) } });
        }
        output[platform][profile] = { ...summarize(results), perQuery: Object.fromEntries(results.map(r => [r.id, { score: r.score, timing: { ...r.timing, cpu: undefined, cpuTotal: r.timing.cpu.reduce((a, b) => a + b, 0) }, order: r.order, top: r.top }])) };
        console.error(`${platform}/${profile}: ${results.length} queries`);
      }
    }
    outputs.push(output);
    if (flag("fill")) store.save();
  }
  if (network.misses.size) console.error(`${network.misses.size} requests had no fixture (run with --fill against a live server):\n${[...network.misses].slice(0, 20).join("\n")}`);
  const result = outputs[0];
  const meta = { date: new Date(wallClock.dateNow()).toISOString(), commit: Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"]).stdout.toString().trim(), queries: labels.length, misses: network.misses.size };
  fs.mkdirSync(path.join(import.meta.dir, "results"), { recursive: true });
  if (flag("baseline")) {
    const noise = noiseOf(outputs);
    fs.writeFileSync(path.join(import.meta.dir, "baseline.json"), `${JSON.stringify({ meta, noise, result }, null, 1)}\n`);
    console.log(`baseline written; noise: ${JSON.stringify(noise)}`);
  }
  const out = option("out") ?? path.join(import.meta.dir, "results", "latest.json");
  fs.writeFileSync(out, `${JSON.stringify({ meta, result }, null, 1)}\n`);
  print(result, flag("compare") || flag("baseline") ? JSON.parse(fs.readFileSync(path.join(import.meta.dir, "baseline.json"), "utf8")) : null);
}

/** How far repeated runs disagree, metric by metric: simulated metrics should not move at all. */
function noiseOf(outputs: Record<string, Record<string, ReturnType<typeof summarize>>>[]) {
  const spread: Record<string, number> = {};
  const walk = (values: unknown[], prefix: string) => {
    if (typeof values[0] === "number") {
      const numbers = values as number[];
      const range = Math.max(...numbers) - Math.min(...numbers);
      if (range > 0) spread[prefix] = Number((range / Math.max(1e-9, Math.abs(mean(numbers)!))).toFixed(4));
      return;
    }
    if (values[0] && typeof values[0] === "object") for (const key of Object.keys(values[0] as object)) walk(values.map(v => (v as Record<string, unknown>)?.[key]), prefix ? `${prefix}.${key}` : key);
  };
  walk(outputs.map(output => Object.fromEntries(Object.entries(output).map(([platform, byProfile]) => [platform, Object.fromEntries(Object.entries(byProfile).map(([profile, s]) => [profile, { all: s.all }]))]))), "");
  return spread;
}

function format(value: unknown) {
  if (value === null || value === undefined) return "—";
  if (typeof value === "number") return Math.abs(value) >= 10 ? value.toFixed(0) : value.toFixed(3);
  return String(value);
}

function print(result: Record<string, Record<string, ReturnType<typeof summarize>>>, baseline: { result: typeof result } | null) {
  const rows: [string, (s: ReturnType<typeof summarize>["all"]) => unknown][] = [
    ["lead section accuracy", s => s.hierarchy.leadAccuracy], ["top-1 (leading section)", s => s.accuracy.top1],
    ["tracks top-1", s => s.accuracy.tracksTop1], ["albums top-1", s => s.accuracy.albumsTop1], ["artists top-1", s => s.accuracy.artistsTop1],
    ["tracks MRR", s => s.accuracy.tracksMRR], ["albums MRR", s => s.accuracy.albumsMRR], ["artists MRR", s => s.accuracy.artistsMRR],
    ["tracks nDCG@5", s => s.accuracy.tracksNDCG5], ["albums nDCG@5", s => s.accuracy.albumsNDCG5], ["artists nDCG@5", s => s.accuracy.artistsNDCG5],
    ["forbidden in top 5", s => s.accuracy.forbiddenTop5], ["duplicates in top 10", s => s.accuracy.duplicatesTop10],
    ["correct copy", s => s.accuracy.correctCopy], ["correct edition", s => s.accuracy.correctEdition], ["artist disambiguation", s => s.accuracy.artistDisambiguation],
    ["song's album shown", s => s.hierarchy.trackAlbumInSection], ["song's artist shown", s => s.hierarchy.trackArtistInSection],
    ["artist's songs shown", s => s.hierarchy.artistTracksShown], ["artist's albums shown", s => s.hierarchy.artistAlbumsShown],
    ["first results p50 ms", s => s.speed.firstP50], ["first results p95 ms", s => s.speed.firstP95],
    ["settled p50 ms", s => s.speed.settledP50], ["settled p95 ms", s => s.speed.settledP95],
    ["reshuffles/query", s => s.speed.reshufflesMean], ["  tracks", s => s.speed.reshufflesBySection?.tracks], ["  albums", s => s.speed.reshufflesBySection?.albums], ["  artists", s => s.speed.reshufflesBySection?.artists], ["  copy swaps", s => s.speed.copySwapsMean], ["lead changes/query", s => s.speed.leadChangesMean],
    ["requests/query", s => s.speed.requestsMean], ["upstream/query", s => s.speed.upstreamMean],
    ["CPU/publish p50 ms", s => s.speed.cpuPerPublishP50], ["CPU/publish p95 ms", s => s.speed.cpuPerPublishP95],
  ];
  for (const [platform, byProfile] of Object.entries(result)) {
    for (const [profile, summary] of Object.entries(byProfile)) {
      const before = baseline?.result[platform]?.[profile];
      console.log(`\n${platform} / ${profile}${before ? " (baseline → now, dev | holdout)" : " (dev | holdout | all)"}`);
      for (const [name, read] of rows) {
        const cells = before
          ? [`${format(read(before.dev))} → ${format(read(summary.dev))}`, `${format(read(before.holdout))} → ${format(read(summary.holdout))}`]
          : [format(read(summary.dev)), format(read(summary.holdout)), format(read(summary.all))];
        console.log(`  ${name.padEnd(26)} ${cells.map(cell => cell.padEnd(18)).join(" ")}`);
      }
    }
  }
}

/** Real timings against the live server: 20 queries, three rounds of a cold then a warm pass. */
async function live() {
  const subset = labels.filter((_, index) => index % Math.ceil(labels.length / 20) === 0).slice(0, 20);
  const apps = await loadApps();
  await apps.client.restore();
  const realFetch = globalThis.fetch;
  const log: RequestLog[] = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const key = requestKey(url);
    log.push({ at: wallClock.now(), kind: "other", provider: "", key, status: 0, recorded: true });
    return realFetch(`${server}${key}`, init);
  }) as typeof fetch;
  const rounds = Number(option("rounds") ?? 3);
  const results: { round: number; pass: string; id: string; first: number | null; done: number | null; requests: number }[] = [];
  for (let round = 0; round < rounds; round++) {
    for (const pass of ["cold", "warm"]) {
      for (const label of subset) {
        log.length = 0;
        const started = wallClock.now();
        let first: number | null = null, done: number | null = null;
        const ref = { current: null };
        await new Promise<void>(resolve => {
          const stop = apps.desktop.startTrackSearch(label.q, "all", ref, snapshot => {
            const now = wallClock.now() - started;
            if (first === null && (snapshot.results.length || snapshot.albums.length || snapshot.artists.length)) first = now;
            if (!snapshot.isSearching && first !== null) done = now;
          }, () => {});
          setTimeout(() => { stop(); resolve(); }, 12_000);
        });
        results.push({ round, pass, id: label.id, first, done, requests: log.length });
      }
      console.error(`live round ${round + 1} ${pass} done`);
    }
    // The server keeps searches for 5 minutes: wait them out so the next cold pass is cold.
    if (round < rounds - 1) await Bun.sleep(5.5 * 60_000);
  }
  const by = (pass: string, field: "first" | "done") => results.filter(r => r.pass === pass).map(r => r[field]).filter((v): v is number => v !== null);
  const summary = Object.fromEntries(["cold", "warm"].map(pass => [pass, { firstP50: percentile(by(pass, "first"), 0.5), firstP95: percentile(by(pass, "first"), 0.95), doneP50: percentile(by(pass, "done"), 0.5), doneP95: percentile(by(pass, "done"), 0.95) }]));
  const out = option("out") ?? path.join(import.meta.dir, "results", "live.json");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify({ date: new Date().toISOString(), commit: Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"]).stdout.toString().trim(), queries: subset.map(l => l.id), summary, results }, null, 1)}\n`);
  console.log(JSON.stringify(summary, null, 1));
  process.exit(0);
}

if (mode === "record") await record();
else if (mode === "live") await live();
else await bench();
