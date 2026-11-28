# Search pass — 2026-11-27: hierarchy, accuracy, speed, mobile parity

Scope: catalog search on desktop and mobile, from the keystroke to the settled result list. Every change below was measured with the same offline benchmark (`bench/`) before and after; numbers are from that benchmark unless marked live.

## 1. Pipeline map (as found at `da41f77`)

### Desktop data flow

1. `SearchBar` writes every keystroke to `preferences.search.query` (`useAppNavigation.changeSearchQuery`). There is no debounce in the bar.
2. `useTrackSearch(query, provider)` (`desktop/src/hooks/useTrackSearch.ts`) restarts on every query change. The effect body now lives in `startTrackSearch` so the benchmark can run it unchanged.
   - Publishes an empty `isSearching` snapshot at once.
   - Waits **150 ms** (debounce), then calls `GET /api/search/providers` (service discovery; aborted after **8 s**).
   - Creates a `SearchSession` with the discovered providers (`combined` when the filter is "all").
3. `SearchSession.loadMore()` (`desktop/src/utils/searchSession.ts`) asks every provider at once through `fetchPage` → `searchServerCatalog` (`desktop/src/api/server.ts`), which calls `GET /api/search/catalog?query&provider&limit=20`.
   - The catalog endpoint ignores offsets and `searchServerCatalog` always returns `nextOffset: null`, so desktop never pages: one page per provider.
   - `searchServerCatalog` adds the artists and albums credited on the page's own tracks when they match the query (or the inferred song artist), then may issue **one** extra catalog request: the missing credited artist's name, the query with `and` → `&`, the query spelled out letter by letter (4–8 letter single words with no exact artist), or the folded query when nothing came back. That retry has an **1.8 s** timeout. Responses are cached client-side in a `SearchCache` (**5 min**, 60 entries).
   - After a provider's first page, `widen()` tries up to **2** `queryVariants` (punctuation and brackets removed; title after "Artist – ") while the provider has no track scoring ≥ `STRONG_MATCH`.
4. `publish()` runs after every answer and every background lookup:
   - `completeLeaders()`: for the top **5** recording groups with relevance ≥ **0.6**, every provider that answered without that song is asked for it (at most **10** lookups per search). It first opens the provider's own release of the song (`albumTracks`, one album, three when hunting the explicit edit), then searches `"<artist> <title>"` (limit 10), and for the first **2** groups also searches the album (`"<album> <album artist>"`) and opens what it finds. Each lookup has an **8 s** timeout.
   - `snapshot()` ranks everything (below) and `settled()` decides whether the first list may be shown early.
   - Release rules for the first visible list: wait until every service answered and every completion lookup ended; or **1200 ms** after the first non-empty answer (merge window); or **1800 ms** after the search started (deadline); or early when the leader is a lossless strong match and only lossy services (Spotify) are still out. Until then `onUpdate` receives empty lists.
   - Each provider request has an **8 s** timeout; a failure marks that provider's error and offers a retry.
5. After the first settled snapshot, `startTrackSearch` warms up to **5** TIDAL copies of the leading five songs through `GET /api/providers/tidal/tracks/{id}/playback` (2 at a time, cached **5 min**, 100 entries). Each answer replaces the track (exact quality) and republishes.
6. `SearchView` renders the first **5** of each section (all copies when "Show all" is open), ordered by `categoryOrder(query, results, artists, albums, candidates)`. The first section spans the row. Cards glide when they move.

### Mobile data flow

1. `SearchScreen` (`mobile/src/SearchScreen.tsx`) restarts on every query change; the timers now live in `startSearch` (`mobile/src/catalog.ts`).
2. After **300 ms**: `openSearch` calls `/api/search/providers` and creates a `SearchSession` whose `fetchPage` is `GET /api/search/tracks?query&provider&offset&limit=20` (tracks only, paged; **25 s** client timeout). The session has no `albumTracks`, so completion lookups only use the song search.
3. After **350 ms**: `catalogSearch` calls `/api/search/catalog` for each enabled provider in parallel. `mergeCatalog` keeps the first artist per folded name and the first album per title+artist, sorts each by `textRelevance` (0–5) only, and keeps **12** artists and **16** albums.
4. The screen always draws an Artists row, then an Albums row, then Songs. There is no `categoryOrder`, no named-song artists/albums, no edition collapsing, no lossless preference among albums.

### Server

`server/src/api.rs`:

| Endpoint | Behaviour |
|---|---|
| `GET /api/search/providers` | Configured services; no upstream call. |
| `GET /api/search/catalog` | TIDAL `TRACKS,ARTISTS,ALBUMS` and Qobuz `catalog/search` in one upstream call each. Spotify: `search_track_ids` (pathfinder `findTracks`, **5** IDs per upstream page, so up to 4 sequential calls for 20) then a metadata load per track (8 at a time, **6 s** each); artists and albums are every credit and album of those tracks, unfiltered. Limit clamped to 1–20; query ≤ 200 characters; **7 s** timeout; **5 min** cache, **100** entries, keyed by provider + lowercased query. |
| `GET /api/search/tracks` | One page of tracks; default limit **10**, max **50**; same cache, timeout and key scheme. Spotify asks for `limit + 1` IDs to know whether there is a next page. |
| both | Identical concurrent requests share one fetch (`search_request_lock`, weak map). |

So the Spotify hypothesis holds: Spotify has no artist or album search here; its cards come from track hits only, and every credited guest becomes an artist candidate.

### Ranking signals

- **Folding** (`searchMatch.fold`): NFKD, marks removed, lowercase, apostrophes dropped, `$`→`s` and `!`→`i` inside words, dotted initials joined, `&`/`+` → "and", other punctuation → space.
- **Word match** (`matchWords`): exact 1; last word as a prefix 0.85 (≥ 2 letters); edit distance ≤ 1 (≤ 2 for words ≥ 8 letters) 0.9 for words of ≥ 4 letters, never for numbers; split/joined words 0.95.
- **Field weights** (`matchFields`): title words count `0.6 + 0.4 × share of the title named`, notes 0.8, album 0.4, artist `0.55 + 0.4 × share of the name named`. Minor words weigh 0.15, video-title noise 0.1. Score = explained share × coverage, × 0.93 when title words are out of order.
- **Variant factor**: remakes (karaoke, tribute, lullaby, nightcore, sped up, "in the style of"…) and covers 0.55; alternate takes (remix, live, demo, acoustic…) 0.85; edits 0.95; 1 when the query names the variant.
- **Recording groups** (`groupSearchResults`): same ISRC + one shared artist, or same folded title + shared artist + same performance words + duration within 2–8 s (15 s for remasters), with release evidence when ISRCs differ.
- **Copy choice** (`compareEdition`): album named in the query (+10) and requested edition words, then explicit (unless "clean"), then lossless/bit depth/sample rate, then non-compilation, non-remaster, plain edition, service order (local, Qobuz, TIDAL, Spotify), then deterministic tie-breaks.
- **Track order** (`rankSearchGroups`): `relevance × variant × mention + 0.2 × agreement + 0.02 × releases`, where agreement is reciprocal-rank fusion across services (k = 10) and `mention` is 0.7 for songs that only mention the asked-for artist. Groups below `max(0.3, 0.4 × best)` are dropped; below 0.3 overall the services' own order is kept.
- **Artists** (`rankArtists`): `max(named × (0.6 + 0.4 coverage), coverage × (0.5 + 0.5 named))`, raised to ≥ 0.9 (+0.15 when performing) for the artists of the named songs, +0.02 per extra service; kept ≥ 0.65; spelled-out names beat near misses; full-coverage names beat partial ones.
- **Albums** (`rankAlbums`): `matchEntry × variantFactor`, or 0.85 − 0.05 × rank for the release of a named song; editions collapse by `albumIdentity` + one shared artist; best copy by explicit, bit depth, sample rate, service; kept ≥ 0.55; ties by cross-service fusion (k = 60).
- **Section order** (`categoryOrder`): per section `10 × best text relevance (0–6) + min(20, support)`, where support adds 6/3/1 for each provider's first three distinct tracks whose title (tracks), artist (artists) or album (albums) equals the query. A leading song that names the query wins ties.

## 2. Benchmark

`bun run search:bench` (root `package.json`) replays every query through the apps' own search code and prints each metric, baseline → now, for dev and held-out queries. `bun run search:report` prints the tables below from `bench/baseline.json` and `bench/results/latest.json`.

### Fixtures

Recorded from the signed-in development server (TIDAL, Qobuz, Spotify) on 2026-11-27, not synthesized. `bun run search:bench record` stored, per query, each service's first catalog page and first track page (cold, with the measured latency), then replayed both apps under every latency profile against the live server, recording each further request (spelling retries, completion lookups, album tracks, TIDAL playback lookups) once. Later changes that asked for something new were filled the same way (`--fill`); nothing already recorded was ever re-recorded, so every run reads the same answers. 214 gzipped JSON files, 6.5 MB, in `bench/fixtures/`.

Bodies are the server's own responses minus `copyright`; any `token`, `access_token`, signature or expiry parameter would be replaced by `REDACTED` (none occurred). A scan for tokens, bearer headers, user IDs and e-mail addresses found nothing. No account identifiers are stored.

### Harness

- `bench/clock.ts`: virtual time. `setTimeout`, `Date.now`, `performance.now` and `AbortSignal.timeout` follow a simulated clock that jumps to the next timer once every promise has settled. A 1.2 s merge window costs no wall time, and the same inputs always take the same path.
- `bench/network.ts`: a stub `fetch` that serves fixtures keyed like the server's own caches (provider, lowercased query, offset, limit) after a profile's latency. Profiles: **fast** (150 ms per search), **typical** (each request's recorded live latency), **slow-spotify** (typical, Spotify +4 s), **fail-qobuz** (typical, Qobuz returns 502 after 400 ms).
- `bench/pipelines.ts`: runs desktop's `startTrackSearch` (the `useTrackSearch` effect, moved out unchanged so it can run without React) and the phone's `startSearch` (the `SearchScreen` timers, likewise), and reads each screen the way its component does. The clock jumps an hour between queries, so client caches start cold.
- `bench/judge.ts`: scores the final screen against the label with its own folding and variant rules, independent of the app's matching code.

### Queries and labels

214 queries in `bench/queries.json`, written and committed (`a454ea8`) before any output was recorded. Categories: exact titles, song + artist both orders, artists, albums, album + artist, title tracks, self-titled albums, artists named like words or songs, as-you-type prefixes, typos and transpositions, diacritics, punctuation, Japanese and Korean, "feat." credits, remaster/deluxe editions, explicit variant requests (live, remix, acoustic, clean, edit, instrumental), karaoke-prone titles, classical, long-tail. Each label gives the expected leading section (and any acceptable alternative), the expected song, album and artist by normalized title and artist, results that must not appear in the top 5, and the preferred copy (lossless, the original album, explicit unless "clean"). 67 queries (31%, every category) are held out. No label was changed.

### Metrics

- **Hierarchy**: leading-section accuracy and its confusion matrix; whether the leading song's album and artist appear in their sections; whether an artist query shows that artist's songs and albums.
- **Accuracy**: top-1 of the leading section; per section top-1, MRR (first 10) and nDCG@5 (expected item 2, same artist 1, distinct items only); junk (karaoke, tribute, "in the style of"…) or label-forbidden items in a top 5; duplicate songs, albums or names in a top 10; correct copy of the leading song; correct album edition; artist disambiguation (the top artist is the one credited on their known songs).
- **Speed (simulated)**: time to first visible result and to the last visible change, from the query changing; top-5 reshuffles after first paint (a shown card moved or disappeared, by section) and lead-section changes; requests to the server and upstream requests (distinct cache keys, as the server's 5-minute cache would see them); ranking CPU per publish (real time, the only noisy number).
- **Parity**: the same queries through the phone's path.

### Noise

Three baseline runs agreed exactly on every simulated metric. Only CPU time moved: p50 by up to 22% and p95 by up to 74% between runs (`bench/baseline.json`, `noise`). CPU changes inside those bands are reported as no change.

### Metric fix after the baseline

nDCG@5 first counted a second recording of the expected song, or a second artist card of the same name, as another relevant result, so collapsing duplicates lowered it. It now counts each distinct item once, keyed as the duplicate metric keys them (`d74f74c`). The baseline was re-run at `e6abf35` with the corrected judge; every metric except nDCG came out identical, and the tables use that re-scored baseline.

## 3. Results

Baseline `e6abf35` (the code at `da41f77`, with only the benchmark seams moved out); final `bcf7308`. Simulated with recorded fixtures. Each table shows dev and held-out queries separately; Δ% is relative to the baseline. Lower is better for forbidden, duplicates, times, reshuffles, lead changes, requests and CPU.

### Hypotheses, checked

- **Spotify has no artist or album search.** Confirmed: the server's Spotify catalog page is built from `findTracks` hits only, and every credited guest becomes an artist candidate. Not changed (see limits).
- **Mobile loses the hierarchy.** Confirmed: the phone always drew Artists, then Albums, then Songs, with artists and albums from a separate catalog request sorted by name match only. Its leading section was right for 34% of queries (desktop 79%); now both are 94%, and their leading section and top song agree on all 214 queries (165 disagreed before).
- **`categoryOrder`'s hand-tuned weights fail the ambiguous cases.** Partly confirmed. Song and album with the same title (title-track) were already fine (15/15 lead); self-titled albums led with the album instead of the artist (lead 3/9 → 9/9), artists named like words or songs (lead 8/15 → 15/15), and partial/typo artist names (typo lead 6/15 → 12/15) were the failures.
- **Debounce, discovery and the merge window.** Measured: the debounce is a fixed 150 ms (300 ms on the phone); discovery was a serial round trip (p50 7 ms, p90 27 ms against a local server; a full network round trip for a remote one); before this pass 91 of 214 desktop searches first painted only at the merge window or deadline (≥ 1.4 s), now 62. Most of the remaining wait is the merge window waiting for Spotify, whose catalog page takes 1.7 s p50 (it fetches five IDs per upstream call, then each track's metadata).

### Desktop

#### desktop: hierarchy and accuracy (typical latency)

| Metric | dev before | dev after | Δ | Δ% | holdout before | holdout after | Δ | Δ% |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Lead section accuracy | 0.782 | 0.925 | +0.143 | +18.3% | 0.821 | 0.970 | +0.149 | +18.2% |
| Song's album in albums | 0.617 | 0.952 | +0.335 | +54.3% | 0.519 | 0.889 | +0.370 | +71.4% |
| Song's artist in artists | 0.855 | 0.919 | +0.065 | +7.5% | 0.800 | 0.867 | +0.067 | +8.3% |
| Artist query shows their songs | 0.854 | 0.854 | +0.000 | +0.0% | 0.920 | 0.920 | +0.000 | +0.0% |
| Artist query shows their albums | 0.854 | 0.875 | +0.021 | +2.4% | 0.840 | 0.840 | +0.000 | +0.0% |
| Top-1 (leading section) | 0.755 | 0.816 | +0.061 | +8.1% | 0.776 | 0.866 | +0.090 | +11.5% |
| Tracks top-1 | 0.758 | 0.774 | +0.016 | +2.1% | 0.821 | 0.857 | +0.036 | +4.3% |
| Albums top-1 | 0.535 | 0.831 | +0.296 | +55.3% | 0.433 | 0.800 | +0.367 | +84.6% |
| Artists top-1 | 0.727 | 0.867 | +0.140 | +19.2% | 0.719 | 0.906 | +0.188 | +26.1% |
| Tracks MRR | 0.810 | 0.829 | +0.019 | +2.3% | 0.873 | 0.899 | +0.026 | +2.9% |
| Albums MRR | 0.606 | 0.838 | +0.232 | +38.3% | 0.511 | 0.832 | +0.321 | +62.9% |
| Artists MRR | 0.785 | 0.875 | +0.090 | +11.5% | 0.777 | 0.906 | +0.129 | +16.6% |
| Tracks nDCG@5 | 0.660 | 0.688 | +0.028 | +4.2% | 0.743 | 0.774 | +0.031 | +4.1% |
| Albums nDCG@5 | 0.477 | 0.613 | +0.136 | +28.5% | 0.429 | 0.619 | +0.191 | +44.5% |
| Artists nDCG@5 | 0.796 | 0.874 | +0.078 | +9.7% | 0.786 | 0.900 | +0.114 | +14.5% |
| Forbidden in top 5 | 0.136 | 0.116 | -0.020 | -15.0% | 0.075 | 0.045 | -0.030 | -40.0% |
| Duplicates in top 10 (per query) | 1.544 | 0.578 | -0.966 | -62.6% | 1.731 | 0.866 | -0.866 | -50.0% |
| Correct copy | 0.839 | 0.857 | +0.018 | +2.2% | 0.800 | 0.800 | +0.000 | +0.0% |
| Correct album edition | 0.842 | 0.949 | +0.107 | +12.7% | 0.923 | 1.000 | +0.077 | +8.3% |
| Artist disambiguation | 0.813 | 0.854 | +0.042 | +5.1% | 0.920 | 0.920 | +0.000 | +0.0% |

#### desktop: speed, fast latency

| Metric | dev before | dev after | Δ | Δ% | holdout before | holdout after | Δ | Δ% |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| First results p50 (ms) | 494 | 327 | -167 | -33.8% | 474 | 328 | -146 | -30.8% |
| First results p95 (ms) | 683 | 624 | -59.000 | -8.6% | 661 | 640 | -21.000 | -3.2% |
| Settled p50 (ms) | 515 | 425 | -90.000 | -17.5% | 490 | 387 | -103 | -21.0% |
| Settled p95 (ms) | 786 | 773 | -13.000 | -1.7% | 753 | 640 | -113 | -15.0% |
| Top-5 reshuffles after first paint | 0.864 | 0.558 | -0.306 | -35.4% | 0.716 | 0.403 | -0.313 | -43.7% |
| Lead-section changes | 0.007 | 0.000 | -0.007 | -100.0% | 0.015 | 0.000 | -0.015 | -100.0% |
| Requests to the server | 14.395 | 8.986 | -5.408 | -37.6% | 14.478 | 9.836 | -4.642 | -32.1% |
| Upstream searches/lookups | 13.306 | 7.898 | -5.408 | -40.6% | 13.418 | 8.746 | -4.672 | -34.8% |
| Ranking CPU per publish p50 (ms) | 11.299 | 2.240 | -9.059 | -80.2% | 11.722 | 2.379 | -9.343 | -79.7% |
| Ranking CPU per publish p95 (ms) | 30.950 | 6.392 | -24.558 | -79.3% | 32.151 | 7.013 | -25.138 | -78.2% |

#### desktop: speed, typical latency

| Metric | dev before | dev after | Δ | Δ% | holdout before | holdout after | Δ | Δ% |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| First results p50 (ms) | 1300 | 987 | -313 | -24.1% | 1220 | 995 | -225 | -18.4% |
| First results p95 (ms) | 1779 | 1654 | -125 | -7.0% | 1699 | 1693 | -6.000 | -0.4% |
| Settled p50 (ms) | 2654 | 2010 | -644 | -24.3% | 2630 | 1924 | -706 | -26.8% |
| Settled p95 (ms) | 5751 | 4107 | -1644 | -28.6% | 6178 | 5634 | -544 | -8.8% |
| Top-5 reshuffles after first paint | 2.980 | 1.959 | -1.020 | -34.2% | 2.791 | 1.940 | -0.851 | -30.5% |
| Lead-section changes | 0.075 | 0.014 | -0.061 | -81.8% | 0.060 | 0.030 | -0.030 | -50.0% |
| Requests to the server | 13.966 | 8.898 | -5.068 | -36.3% | 13.925 | 9.627 | -4.299 | -30.9% |
| Upstream searches/lookups | 12.898 | 7.837 | -5.061 | -39.2% | 12.851 | 8.537 | -4.313 | -33.6% |
| Ranking CPU per publish p50 (ms) | 11.003 | 2.671 | -8.332 | -75.7% | 11.449 | 2.877 | -8.572 | -74.9% |
| Ranking CPU per publish p95 (ms) | 25.641 | 7.464 | -18.177 | -70.9% | 27.922 | 8.868 | -19.053 | -68.2% |

#### desktop: speed, slow-spotify latency

| Metric | dev before | dev after | Δ | Δ% | holdout before | holdout after | Δ | Δ% |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| First results p50 (ms) | 1300 | 987 | -313 | -24.1% | 1220 | 995 | -225 | -18.4% |
| First results p95 (ms) | 1700 | 1626 | -74.000 | -4.4% | 1689 | 1680 | -9.000 | -0.5% |
| Settled p50 (ms) | 6277 | 5947 | -330 | -5.3% | 6444 | 5919 | -525 | -8.1% |
| Settled p95 (ms) | 13065 | 11786 | -1279 | -9.8% | 13116 | 11884 | -1232 | -9.4% |
| Top-5 reshuffles after first paint | 2.891 | 1.939 | -0.952 | -32.9% | 2.791 | 2.104 | -0.687 | -24.6% |
| Lead-section changes | 0.075 | 0.014 | -0.061 | -81.8% | 0.060 | 0.045 | -0.015 | -25.0% |
| Requests to the server | 13.789 | 8.776 | -5.014 | -36.4% | 13.567 | 9.433 | -4.134 | -30.5% |
| Upstream searches/lookups | 12.728 | 7.714 | -5.014 | -39.4% | 12.507 | 8.343 | -4.164 | -33.3% |
| Ranking CPU per publish p50 (ms) | 10.787 | 2.614 | -8.172 | -75.8% | 11.072 | 2.853 | -8.219 | -74.2% |
| Ranking CPU per publish p95 (ms) | 24.570 | 6.913 | -17.657 | -71.9% | 26.016 | 8.785 | -17.231 | -66.2% |

#### desktop: speed, fail-qobuz latency

| Metric | dev before | dev after | Δ | Δ% | holdout before | holdout after | Δ | Δ% |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| First results p50 (ms) | 557 | 550 | -7.000 | -1.3% | 557 | 550 | -7.000 | -1.3% |
| First results p95 (ms) | 1344 | 1338 | -6.000 | -0.4% | 610 | 550 | -60.000 | -9.8% |
| Settled p50 (ms) | 2319 | 2041 | -278 | -12.0% | 2940 | 1982 | -958 | -32.6% |
| Settled p95 (ms) | 5887 | 4107 | -1780 | -30.2% | 5480 | 5272 | -208 | -3.8% |
| Top-5 reshuffles after first paint | 3.218 | 2.891 | -0.327 | -10.1% | 3.343 | 3.015 | -0.328 | -9.8% |
| Lead-section changes | 0.109 | 0.102 | -0.007 | -6.2% | 0.104 | 0.075 | -0.030 | -28.6% |
| Requests to the server | 11.122 | 9.660 | -1.463 | -13.1% | 11.507 | 10.493 | -1.015 | -8.8% |
| Upstream searches/lookups | 10.088 | 8.612 | -1.476 | -14.6% | 10.493 | 9.478 | -1.015 | -9.7% |
| Ranking CPU per publish p50 (ms) | 7.012 | 1.761 | -5.251 | -74.9% | 7.484 | 1.778 | -5.706 | -76.2% |
| Ranking CPU per publish p95 (ms) | 17.846 | 5.193 | -12.652 | -70.9% | 17.504 | 5.300 | -12.204 | -69.7% |

#### desktop, typical: leading section, expected (rows) × shown (columns), all queries, before → after

| Expected | tracks | albums | artists |
|---|---|---|---|
| tracks | 81 → 86 | 20 → 12 | 1 → 4 |
| albums | 10 → 2 | 29 → 36 | 0 → 1 |
| artists | 12 → 3 | 12 → 0 | 49 → 70 |

#### desktop, typical: by category

| Category | n dev / held out | Lead dev | Lead held out | Top-1 dev | Top-1 held out | Tracks MRR | Albums MRR | Artists MRR | Forbidden |
|---|---|---|---|---|---|---|---|---|---|
| album | 10 / 5 | 0.90 → 1.00 | 1.00 → 1.00 | 0.90 → 1.00 | 0.80 → 0.80 | — → — | 0.94 → 0.94 | 0.87 → 0.93 | 0.13 → 0.13 |
| album-artist | 13 / 4 | 0.85 → 1.00 | 0.50 → 0.75 | 0.85 → 1.00 | 0.25 → 0.50 | 1.00 → 1.00 | 0.97 → 0.97 | 0.94 → 0.94 | 0.24 → 0.24 |
| artist | 12 / 5 | 0.83 → 1.00 | 1.00 → 1.00 | 0.83 → 1.00 | 1.00 → 1.00 | 0.85 → 0.87 | — → — | 0.92 → 1.00 | 0.00 → 0.00 |
| artist-like-word | 10 / 5 | 0.50 → 1.00 | 0.60 → 1.00 | 0.60 → 1.00 | 0.80 → 1.00 | 0.73 → 0.79 | 1.00 → 1.00 | 0.95 → 1.00 | 0.00 → 0.00 |
| classical | 5 / 3 | 0.80 → 0.80 | 1.00 → 1.00 | 0.40 → 0.40 | 0.33 → 0.00 | 1.00 → 1.00 | 1.00 → 1.00 | 1.00 → 1.00 | 0.13 → 0.13 |
| common-word | 4 / 4 | 0.75 → 1.00 | 1.00 → 1.00 | 0.50 → 0.75 | 1.00 → 1.00 | 0.69 → 0.75 | 0.80 → 1.00 | 0.64 → 0.88 | 0.00 → 0.00 |
| diacritics | 8 / 2 | 1.00 → 1.00 | 1.00 → 1.00 | 1.00 → 1.00 | 1.00 → 1.00 | 1.00 → 1.00 | 0.71 → 1.00 | 0.93 → 1.00 | 0.10 → 0.10 |
| disambiguation | 3 / 0 | 0.67 → 1.00 | — → — | 0.67 → 1.00 | — → — | 0.73 → 0.78 | — → — | 0.73 → 1.00 | 0.00 → 0.00 |
| edition | 10 / 7 | 0.90 → 1.00 | 1.00 → 1.00 | 0.90 → 1.00 | 0.71 → 0.71 | 1.00 → 1.00 | 0.46 → 0.85 | 0.78 → 0.88 | 0.18 → 0.12 |
| exact-title | 16 / 7 | 1.00 → 1.00 | 1.00 → 1.00 | 0.88 → 0.88 | 1.00 → 1.00 | 0.94 → 0.96 | 0.00 → 0.69 | 0.37 → 0.91 | 0.04 → 0.04 |
| feat | 12 / 4 | 0.75 → 0.92 | 0.50 → 0.75 | 0.75 → 0.83 | 0.50 → 0.75 | 0.91 → 0.97 | 0.42 → 1.00 | 0.80 → 1.00 | 0.19 → 0.19 |
| karaoke | 9 / 3 | 1.00 → 1.00 | 0.67 → 1.00 | 1.00 → 1.00 | 0.67 → 1.00 | 1.00 → 1.00 | 0.13 → 0.83 | 0.62 → 1.00 | 0.08 → 0.00 |
| long-tail | 9 / 3 | 0.89 → 0.89 | 0.67 → 0.67 | 0.89 → 0.89 | 0.67 → 0.67 | 0.69 → 0.76 | 1.00 → 1.00 | 1.00 → 1.00 | 0.00 → 0.00 |
| non-latin | 5 / 2 | 0.40 → 0.60 | 1.00 → 1.00 | 0.40 → 0.60 | 1.00 → 1.00 | 0.57 → 0.57 | — → — | 0.86 → 0.79 | 0.29 → 0.29 |
| partial | 11 / 5 | 0.64 → 0.73 | 0.60 → 1.00 | 0.55 → 0.45 | 0.60 → 1.00 | 0.78 → 0.78 | 0.50 → 0.75 | 0.47 → 0.59 | 0.00 → 0.00 |
| popular | 2 / 1 | 1.00 → 1.00 | 1.00 → 1.00 | 1.00 → 1.00 | 1.00 → 1.00 | 0.83 → 0.83 | — → — | 1.00 → 1.00 | 0.00 → 0.00 |
| punctuation | 17 / 10 | 1.00 → 0.94 | 0.90 → 0.90 | 0.82 → 0.76 | 0.90 → 0.90 | 0.78 → 0.81 | 0.38 → 0.61 | 0.89 → 0.96 | 0.19 → 0.15 |
| self-titled | 5 / 4 | 0.20 → 1.00 | 0.50 → 1.00 | 1.00 → 1.00 | 1.00 → 1.00 | 0.94 → 0.94 | 1.00 → 1.00 | 1.00 → 1.00 | 0.00 → 0.00 |
| song-artist | 28 / 11 | 0.93 → 0.96 | 0.73 → 1.00 | 0.82 → 0.82 | 0.73 → 1.00 | 0.92 → 0.92 | 0.29 → 0.73 | 0.99 → 1.00 | 0.33 → 0.21 |
| title-track | 11 / 4 | 1.00 → 1.00 | 1.00 → 1.00 | 1.00 → 0.91 | 1.00 → 1.00 | 0.87 → 0.87 | 0.93 → 0.97 | 0.91 → 0.93 | 0.13 → 0.13 |
| typo | 10 / 5 | 0.30 → 0.70 | 0.60 → 1.00 | 0.40 → 0.40 | 0.60 → 0.80 | 0.54 → 0.54 | — → — | 0.40 → 0.41 | 0.07 → 0.07 |
| variant | 7 / 3 | 0.57 → 1.00 | 1.00 → 1.00 | 0.29 → 0.71 | 0.67 → 0.67 | 0.65 → 0.77 | — → — | 0.80 → 0.80 | 0.10 → 0.10 |

#### desktop: 10 biggest wins

| Query | Split | Utility before → after | Before | After |
|---|---|---|---|---|
| `come together beatles` | dev | -0.03 → 5.50 | albums: Come Together - Tulio Mourão Plays Beatles — Túlio Mourão [qobuz]; Come Together (The Beatles) — Catupecu Machu [qobuz]<br>tracks: Come Together — The Beatles [Abbey Road; tidal FLAC 24-bit/96 kHz]; Come Together (2019 Mix) — The Beatles [Abbey Road (Super Deluxe Edition); qobuz FLAC 24-bit/96 kHz]<br>artists: The Beatles [qobuz+spotify+tidal]; The Beloved [spotify] | tracks: Come Together — The Beatles [Abbey Road; tidal FLAC 24-bit/96 kHz]; Come Together (2019 Mix) — The Beatles [Abbey Road (Super Deluxe Edition); qobuz FLAC 24-bit/96 kHz]<br>albums: Abbey Road (Remastered 2009) (Remastered 2009) — The Beatles [qobuz]; Come Together - Tulio Mourão Plays Beatles — Túlio Mourão [qobuz]<br>artists: The Beatles [qobuz+spotify+tidal] |
| `lemonade` | dev | -0.20 → 5.00 | tracks: Lemonade — Gucci Mane [The State vs. Radric Davis  (Deluxe); qobuz FLAC 16-bit/44.1 kHz]; LEMONADE — aespa [LEMONADE - The 2nd Album; qobuz FLAC 24-bit/96 kHz]<br>albums: Lemonade (Explicit) — Beyoncé [qobuz]; LEMONADE — Forrest Frank [qobuz]<br>artists: Lemonade [qobuz+tidal]; lemónade [tidal] | albums: Lemonade (Explicit) — Beyoncé [qobuz]; LEMONADE — Forrest Frank [qobuz]<br>tracks: Lemonade — Gucci Mane [The State vs. Radric Davis  (Deluxe); qobuz FLAC 16-bit/44.1 kHz]; Lemonade (feat. NAV) — Internet Money [B4 The Storm; qobuz FLAC 16-bit/44.1 kHz]<br>artists: Beyoncé [spotify] |
| `bad guy justin bieber` | dev | 0.50 → 5.50 | albums: bad guy (with Justin Bieber) — Billie Eilish [qobuz]<br>tracks: bad guy — Billie Eilish [WHEN WE ALL FALL ASLEEP, WHERE DO WE GO?; tidal FLAC 24-bit/44.1 kHz]; BadGuy - Billie Eilish - Justin Bieber - Remake — Swattrex [What Do You Mean; qobuz FLAC 16-bit/44.1 kHz]<br>artists: Billie Eilish [qobuz+spotify+tidal] | tracks: bad guy (with Justin Bieber) — Billie Eilish [bad guy (with Justin Bieber); qobuz FLAC 16-bit/44.1 kHz]; BadGuy - Billie Eilish - Justin Bieber - Remake — Swattrex [What Do You Mean; qobuz FLAC 16-bit/44.1 kHz]<br>albums: bad guy (with Justin Bieber) — Billie Eilish [qobuz]<br>artists: Billie Eilish [qobuz+spotify+tidal] |
| `ok comp` | holdout | 0.15 → 5.00 | tracks: Ok Computer — Lemaitre [Ok Computer; qobuz FLAC 16-bit/44.1 kHz]; ok computer — Sef [lieve monsters; qobuz FLAC 24-bit/96 kHz]<br>albums: Ok Computer — Lemaitre [qobuz]; OK Computer — Radiohead [qobuz]<br>artists: OK COOP [qobuz+tidal]; Ok computer [qobuz] | albums: OK Computer — Radiohead [qobuz]; Ok Computer — Lemaitre [qobuz]<br>tracks: Ok Computer — Lemaitre [Ok Computer; qobuz FLAC 16-bit/44.1 kHz]; ok computer — huxeti [huxeti and the internet!; tidal FLAC]<br>artists: Radiohead [spotify] |
| `levitating remix` | dev | 0.90 → 5.50 | albums: Levitating remix — Eye'z [qobuz]; Levitating (feat. Madonna and Missy Elliott) [The Blessed Madonna Remix] — Madonna [qobuz]<br>tracks: Levitating (feat. Madonna and Missy Elliott) [The Blessed Madonna Remix] — Dua Lipa [Levitating (feat. Madonna and Missy Elliott) [The Blessed Madonna Remix]; qobuz FLAC 24-bit/44.1 kHz]; Levitating (feat. DaBaby)  (Don Diablo Remix) — Dua Lipa [Levitating (feat. DaBaby)  (Don Diablo Remix); qobuz FLAC 24-bit/44.1 kHz]<br>artists: Dua Lipa [qobuz+spotify]; DaBaby [spotify] | tracks: Levitating (feat. Madonna and Missy Elliott) [The Blessed Madonna Remix] — Dua Lipa [Levitating (feat. Madonna and Missy Elliott) [The Blessed Madonna Remix]; qobuz FLAC 24-bit/44.1 kHz]; Levitating (Chambord Remix) — RUFUS DU SOL [Inhale / Exhale Remixed, Vol. 2; qobuz FLAC 24-bit/44.1 kHz]<br>albums: Levitating (feat. Madonna and Missy Elliott) [The Blessed Madonna Remix] — Madonna [qobuz]; Levitating (feat. Prakriti Kakar & Sukriti Kakar) [Amaal Mallik Remix] — Amaal Mallik [qobuz]<br>artists: Dua Lipa [qobuz+spotify] |
| `yes` | holdout | 0.40 → 4.90 | albums: YES — Internet Girl [tidal]; Yes (Deluxe Edition) — Yes [tidal]<br>tracks: Yes (Album Version) — Shekinah Glory Ministry [Live; qobuz FLAC 16-bit/44.1 kHz]; Yes (Album Version) — Beyoncé [Dangerously In Love; qobuz FLAC 16-bit/44.1 kHz]<br>artists: Yes [qobuz+spotify+tidal]; Yes* [qobuz+tidal] | artists: Yes [qobuz+spotify+tidal]; Yes Yes [qobuz]<br>tracks: Owner Of A Lonely Heart — Yes [90125; qobuz FLAC 24-bit/192 kHz]; Yes (Album Version) — Beyoncé [Dangerously In Love; qobuz FLAC 16-bit/44.1 kHz]<br>albums: YES — Internet Girl [tidal]; Yes (Deluxe Edition) — Yes [tidal] |
| `random access mem` | holdout | 0.40 → 4.90 | tracks: Random Access Memory [RAM] — Bryson Tiller [Bryson Tiller; qobuz FLAC 24-bit/44.1 kHz]; Random Access Memory — System Reset [Connection Lost; qobuz FLAC 24-bit/44.1 kHz]<br>albums: Random Access Memories — Daft Punk [qobuz]; Random Access Memories - 50 Electronic Chillout Lounge Tracks, Vol. 1 — Various Artists [qobuz]<br>artists: Random Access Memory [tidal] | albums: Random Access Memories — Daft Punk [qobuz]; Random Access Memories - 50 Electronic Chillout Lounge Tracks, Vol. 1 — Various Artists [qobuz]<br>tracks: Random Access Memory [RAM] — Bryson Tiller [Bryson Tiller; qobuz FLAC 24-bit/44.1 kHz]; Random Access Memory — System Reset [Connection Lost; tidal FLAC 24-bit/44.1 kHz]<br>artists: Daft Punk [spotify] |
| `daft punk get lucky` | holdout | 1.00 → 5.40 | albums: Get Lucky (feat. Pharrell Williams & Nile Rodgers) — Daft Punk, Pharrell Williams, Nile Rodgers [tidal]; Get Lucky (Radio Edit - feat. Pharrell Williams and Nile Rodgers) — Daft Punk [qobuz]<br>tracks: Get Lucky (feat. Pharrell Williams and Nile Rodgers) — Daft Punk feat. Pharrell Williams [Random Access Memories; qobuz FLAC 24-bit/88.2 kHz]; Get Lucky (Radio Edit - feat. Pharrell Williams and Nile Rodgers) — Daft Punk [Get Lucky (Radio Edit - feat. Pharrell Williams and Nile Rodgers); tidal FLAC 24-bit/44.1 kHz]<br>artists: Daft Punk feat. Pharrell Williams [qobuz]; Daft Punk [spotify+tidal] | tracks: Get Lucky (feat. Pharrell Williams and Nile Rodgers) — Daft Punk feat. Pharrell Williams [Random Access Memories; qobuz FLAC 24-bit/88.2 kHz]; Get Lucky (Radio Edit - feat. Pharrell Williams and Nile Rodgers) — Daft Punk ft. Pharrell Williams [Get Lucky (Radio Edit - feat. Pharrell Williams and Nile Rodgers); qobuz FLAC 24-bit/44.1 kHz]<br>albums: Random Access Memories — Daft Punk [tidal]; Get Lucky (feat. Pharrell Williams & Nile Rodgers) — Daft Punk, Pharrell Williams, Nile Rodgers [tidal]<br>artists: Daft Punk [spotify+tidal]; Daft Punk feat. Pharrell Williams [qobuz] |
| `james` | dev | 0.60 → 5.00 | albums: James — Chris Stockwell [tidal]; Laid — James [qobuz]<br>tracks: Laid (Album Version) — James [Laid; qobuz FLAC 16-bit/44.1 kHz]; You’re Beautiful — James Blunt [The Stars Beneath My Feet (2004 - 2021); qobuz FLAC 24-bit/96 kHz]<br>artists: James Taylor [qobuz+spotify+tidal]; James Brown [qobuz+spotify+tidal] | artists: James [qobuz+tidal]; James Taylor [qobuz+spotify+tidal]<br>tracks: Laid (Album Version) — James [Laid; qobuz FLAC 16-bit/44.1 kHz]; Fire and Rain (2019 Remaster) — James Taylor [Sweet Baby James (2019 Remaster); qobuz FLAC 24-bit/192 kHz]<br>albums: James — Chris Stockwell [tidal]; Laid — James [qobuz] |
| `rumours fleetwood mac` | dev | 0.60 → 5.00 | tracks: Dreams (2001 Remaster) — Fleetwood Mac [Rumours (2001 Remaster); qobuz FLAC 24-bit/96 kHz]; The Chain (2001 Remaster) — Fleetwood Mac [Rumours (2001 Remaster); qobuz FLAC 24-bit/96 kHz]<br>albums: Rumours (2001 Remaster) — Fleetwood Mac [qobuz]; Rumours Live — Fleetwood Mac [tidal]<br>artists: Fleetwood Mac [spotify+tidal] | albums: Rumours (2001 Remaster) — Fleetwood Mac [qobuz]; Rumours Live — Fleetwood Mac [tidal]<br>tracks: Dreams (2001 Remaster) — Fleetwood Mac [Rumours (2001 Remaster); qobuz FLAC 24-bit/96 kHz]; The Chain (2001 Remaster) — Fleetwood Mac [Rumours (2001 Remaster); qobuz FLAC 24-bit/96 kHz]<br>artists: Fleetwood Mac [spotify+tidal] |

#### desktop: 10 worst remaining

| Query | Split | Utility before → after | Before | After |
|---|---|---|---|---|
| `blinding ligths` | dev | -1.00 → -1.00 | albums: Blinding Ligths — Mr Jham [qobuz]; Baby Can I Hold You / Nikita / Blinding Ligths (Ao Vivo) — Grupo Rapadura [qobuz]<br>tracks: Blinding Ligths — Mr Jham [Blinding Ligths; qobuz FLAC 16-bit/44.1 kHz]; Blinding City Ligths — DJ Gold Fox [DJ Gold Fox the Great Hits, Vol. 1; tidal FLAC 24-bit/48 kHz]<br>artists: Mr Jham [spotify] | albums: Blinding Ligths — Mr Jham [qobuz]; Baby Can I Hold You / Nikita / Blinding Ligths (Ao Vivo) — Grupo Rapadura [qobuz]<br>tracks: Blinding Ligths — Mr Jham [Blinding Ligths; qobuz FLAC 16-bit/44.1 kHz]; Blinding City Ligths — DJ Gold Fox [DJ Gold Fox the Great Hits, Vol. 1; spotify Ogg Vorbis 160 kbps]<br>artists: Mr Jham [spotify] |
| `宇多田ヒカル` | dev | -1.00 → -1.00 | tracks: 宇多田ヒカル — 恋と嘘 [夜に聴きたいエモい曲; tidal FLAC 24-bit/48 kHz]; 宇多田 ヒカル — The Boy Who Drink Stars [杉並区; qobuz FLAC 16-bit/44.1 kHz]<br>albums: 夜に聴きたいエモい曲 — 恋と嘘 [tidal]; 杉並区 — The Boy Who Drink Stars [spotify]<br>artists: 宇多田ヒカル／宇多田ヒカル [qobuz]; 恋と嘘 [tidal] | tracks: 宇多田ヒカル — 恋と嘘 [夜に聴きたいエモい曲; tidal FLAC 24-bit/48 kHz]; 宇多田 ヒカル — The Boy Who Drink Stars [杉並区; qobuz FLAC 16-bit/44.1 kHz]<br>albums: 夜に聴きたいエモい曲 — 恋と嘘 [tidal]<br>artists: 恋と嘘 [tidal]; 宇多田ヒカル／宇多田ヒカル [qobuz] |
| `방탄소년단` | dev | -0.60 → -0.85 | tracks: 방탄소년단 — K9theGr8 [방탄소년단; tidal FLAC 16-bit/44.1 kHz]; DNA (From "BTS 방탄소년단") — Nicolás Iaciancio [DNA (From "BTS 방탄소년단"); qobuz FLAC 16-bit/44.1 kHz]<br>albums: 방탄소년단 — K9theGr8 [tidal]; DNA (From "BTS 방탄소년단") — Nicolás Iaciancio [qobuz]<br>artists: 방탄소년단 [qobuz+tidal]; 방탄소년단 . [qobuz] | tracks: 방탄소년단 — K9theGr8 [방탄소년단; tidal FLAC 16-bit/44.1 kHz]; Butter (방탄소년단) — FUKUSHU BAND [Butter (방탄소년단); tidal FLAC 16-bit/44.1 kHz]<br>albums: 방탄소년단 — K9theGr8 [tidal]; DNA (From "BTS 방탄소년단") — Nicolás Iaciancio [qobuz]<br>artists: K9theGr8 [tidal]; 방탄소년단 [qobuz+tidal] |
| `mr bright` | dev | -0.20 → -0.20 | artists: Mr Bright [qobuz+tidal]; Mr Bright [tidal]<br>tracks: Na-meya — Mr Bright [Na meya; qobuz FLAC 16-bit/44.1 kHz]; with you — Mr Bright [Na meya; qobuz FLAC 16-bit/44.1 kHz]<br>albums: OLUWA TOO GOOD — Mr Bright [qobuz]; PAS PAREIL — Mr Bright [qobuz] | artists: Mr Bright [qobuz+tidal]; Mr Bright Starz [qobuz]<br>tracks: with you — Mr Bright [Na meya; qobuz FLAC 16-bit/44.1 kHz]; Na-meya — Mr Bright [Na meya; qobuz FLAC 16-bit/44.1 kHz]<br>albums: OLUWA TOO GOOD — Mr Bright [qobuz]; PAS PAREIL — Mr Bright [qobuz] |
| `dark side of the m` | dev | 0.00 → 0.00 | tracks: The Dark Side Of The Moon — M Official [The Dark Side Of The Moon; tidal FLAC 16-bit/44.1 kHz]; Cruise Control (FYH346) [Dark Side Track Of The Week] (AndyG & Alex M Remix) — Jordan Suckley [FYH346 - Find Your Harmony Radio Episode #346; qobuz FLAC 24-bit/44.1 kHz]<br>albums: The Dark Side Of The Moon — M Official [tidal]; Dark Side Of The Power — Goncalo M [qobuz]<br>artists: — | artists: —<br>tracks: The Dark Side Of The Moon — M Official [The Dark Side Of The Moon; tidal FLAC 16-bit/44.1 kHz]; Cruise Control (FYH346) [Dark Side Track Of The Week] (AndyG & Alex M Remix) — Jordan Suckley [FYH346 - Find Your Harmony Radio Episode #346; qobuz FLAC 24-bit/44.1 kHz]<br>albums: The Dark Side Of The Moon — M Official [tidal]; Dark Side Of The Power — Goncalo M [qobuz] |
| `the beatels` | dev | 0.00 → 0.00 | tracks: Krabbelaar — BeatELS [Koelbloedig; qobuz FLAC 24-bit/48 kHz]; Hertentrein — BeatELS [Koelbloedig; qobuz FLAC 24-bit/48 kHz]<br>albums: Koelbloedig — BeatELS [qobuz]<br>artists: — | tracks: Krabbelaar — BeatELS [Koelbloedig; qobuz FLAC 24-bit/48 kHz]; Bakfiets — BeatELS [Koelbloedig; qobuz FLAC 24-bit/48 kHz]<br>albums: Koelbloedig — BeatELS [qobuz]<br>artists: — |
| `blinding li` | dev | 5.00 → 1.00 | tracks: Blinding Lights — The Weeknd [After Hours (Explicit); qobuz FLAC 24-bit/44.1 kHz]; Blinding Lights — Teddy Swims [Blinding Lights; qobuz FLAC 24-bit/44.1 kHz]<br>albums: After Hours — The Weeknd [spotify]; Blinding Lights — The Weeknd [qobuz]<br>artists: Lilo Li [tidal] | artists: Lilo Li [tidal]<br>tracks: Blinding Lights — The Weeknd [After Hours (Explicit); qobuz FLAC 24-bit/44.1 kHz]; Blinding Light — Miss Li [Chinese style; tidal FLAC 16-bit/48 kHz]<br>albums: After Hours — The Weeknd [spotify]; Blinding Lights — The Weeknd [qobuz] |
| `gangsta's paradise` | dev | 4.65 → 1.00 | tracks: Gangsta's Paradise (feat. L.V.) (LP Version) — Coolio [Gangsta's Paradise; qobuz FLAC 16-bit/44.1 kHz]; Gangsta's Paradise — Lofi Fruits Music [90s Oldschool Lofi Hip Hop; qobuz FLAC 24-bit/44.1 kHz]<br>albums: Gangsta's Paradise  (25th Anniversary - Remastered) — Coolio [qobuz]; Gangsta's Paradise — State of Mine [qobuz]<br>artists: Gangsta's Paradise [qobuz]; Coolio [qobuz+spotify+tidal] | albums: Gangsta's Paradise  (25th Anniversary - Remastered) — Coolio [qobuz]; Gangsta's Paradise — State of Mine [qobuz]<br>tracks: Gangsta's Paradise (feat. L.V.) (LP Version) — Coolio [Gangsta's Paradise; qobuz FLAC 16-bit/44.1 kHz]; Gangsta's Paradise — 2WEI [Escape Velocity; qobuz FLAC 16-bit/44.1 kHz]<br>artists: Coolio [qobuz+spotify+tidal] |
| `the microphones the glow pt 2` | holdout | 1.00 → 1.00 | tracks: The Glow, Pt. 2 — The Microphones [The Glow, Pt. 2; tidal FLAC]; The Glow, Pt. 2 — Microphones [The Glow, Pt. 2; qobuz FLAC 16-bit/44.1 kHz]<br>albums: The Glow, Pt. 2 — The Microphones [tidal]; The Glow, Pt. 2 — Microphones [qobuz]<br>artists: The Microphones [spotify+tidal]; Microphones [qobuz] | tracks: The Glow, Pt. 2 — The Microphones [The Glow, Pt. 2; tidal FLAC]; The Glow, Pt. 2 — Microphones [The Glow, Pt. 2; qobuz FLAC 16-bit/44.1 kHz]<br>albums: The Glow, Pt. 2 — The Microphones [tidal]; Little Bird Flies into a Big Black Cloud — The Microphones [tidal]<br>artists: The Microphones [spotify+tidal]; Microphones [qobuz] |
| `hotle california` | dev | 4.50 → 1.06 | tracks: Hotel California (2013 Remaster) — Eagles [Hotel California (2013 Remaster); qobuz FLAC 24-bit/192 kHz]; Hotel California (Live On MTV, 1994) — Eagles [Hell Freezes Over (Remaster 2018); qobuz FLAC 16-bit/44.1 kHz]<br>albums: California — Mr. Bungle [tidal]; California — Diplo [tidal]<br>artists: Hotel California [qobuz+tidal]; Randy California [tidal] | artists: Hotel California [qobuz+tidal]; Randy California [tidal]<br>tracks: Hotel California (2013 Remaster) — Eagles [Hotel California (2013 Remaster); qobuz FLAC 24-bit/192 kHz]; Hotel California (Live On MTV, 1994) — Eagles [Hell Freezes Over (Remaster 2018); qobuz FLAC 16-bit/44.1 kHz]<br>albums: California — Mr. Bungle [tidal]; California — Diplo [tidal] |

### Mobile

#### mobile: hierarchy and accuracy (typical latency)

| Metric | dev before | dev after | Δ | Δ% | holdout before | holdout after | Δ | Δ% |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Lead section accuracy | 0.327 | 0.925 | +0.599 | +183.3% | 0.373 | 0.970 | +0.597 | +160.0% |
| Song's album in albums | 0.281 | 0.952 | +0.671 | +239.0% | 0.217 | 0.889 | +0.671 | +308.9% |
| Song's artist in artists | 0.533 | 0.919 | +0.386 | +72.4% | 0.655 | 0.867 | +0.211 | +32.3% |
| Artist query shows their songs | 0.854 | 0.854 | +0.000 | +0.0% | 0.920 | 0.920 | +0.000 | +0.0% |
| Artist query shows their albums | 0.833 | 0.875 | +0.042 | +5.0% | 0.760 | 0.840 | +0.080 | +10.5% |
| Top-1 (leading section) | 0.571 | 0.816 | +0.245 | +42.9% | 0.552 | 0.866 | +0.313 | +56.8% |
| Tracks top-1 | 0.750 | 0.774 | +0.024 | +3.2% | 0.821 | 0.857 | +0.036 | +4.3% |
| Albums top-1 | 0.338 | 0.831 | +0.493 | +145.8% | 0.433 | 0.800 | +0.367 | +84.6% |
| Artists top-1 | 0.587 | 0.867 | +0.280 | +47.6% | 0.578 | 0.906 | +0.328 | +56.8% |
| Tracks MRR | 0.809 | 0.829 | +0.019 | +2.4% | 0.873 | 0.899 | +0.026 | +2.9% |
| Albums MRR | 0.416 | 0.838 | +0.422 | +101.3% | 0.456 | 0.832 | +0.376 | +82.6% |
| Artists MRR | 0.644 | 0.875 | +0.231 | +35.8% | 0.650 | 0.906 | +0.257 | +39.5% |
| Tracks nDCG@5 | 0.664 | 0.688 | +0.024 | +3.6% | 0.745 | 0.774 | +0.029 | +3.9% |
| Albums nDCG@5 | 0.341 | 0.613 | +0.273 | +80.0% | 0.320 | 0.619 | +0.299 | +93.4% |
| Artists nDCG@5 | 0.655 | 0.874 | +0.218 | +33.3% | 0.673 | 0.900 | +0.227 | +33.8% |
| Forbidden in top 5 | 0.272 | 0.116 | -0.156 | -57.5% | 0.269 | 0.045 | -0.224 | -83.3% |
| Duplicates in top 10 (per query) | 0.993 | 0.578 | -0.415 | -41.8% | 1.194 | 0.866 | -0.328 | -27.5% |
| Correct copy | 0.855 | 0.857 | +0.002 | +0.3% | 0.800 | 0.800 | +0.000 | +0.0% |
| Correct album edition | 1.000 | 0.949 | -0.051 | -5.1% | 1.000 | 1.000 | +0.000 | +0.0% |
| Artist disambiguation | 0.833 | 0.854 | +0.021 | +2.5% | 0.880 | 0.920 | +0.040 | +4.5% |

#### mobile: speed, fast latency

| Metric | dev before | dev after | Δ | Δ% | holdout before | holdout after | Δ | Δ% |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| First results p50 (ms) | 513 | 327 | -186 | -36.3% | 495 | 328 | -167 | -33.7% |
| First results p95 (ms) | 528 | 704 | +176 | +33.3% | 530 | 640 | +110 | +20.8% |
| Settled p50 (ms) | 643 | 425 | -218 | -33.9% | 640 | 387 | -253 | -39.5% |
| Settled p95 (ms) | 767 | 774 | +7.000 | +0.9% | 756 | 640 | -116 | -15.3% |
| Top-5 reshuffles after first paint | 0.367 | 0.565 | +0.197 | +53.7% | 0.463 | 0.403 | -0.060 | -12.9% |
| Lead-section changes | 0.313 | 0.000 | -0.313 | -100.0% | 0.448 | 0.000 | -0.448 | -100.0% |
| Requests to the server | 10.898 | 9.204 | -1.694 | -15.5% | 10.955 | 10.134 | -0.821 | -7.5% |
| Upstream searches/lookups | 9.891 | 7.898 | -1.993 | -20.2% | 9.940 | 8.746 | -1.194 | -12.0% |
| Ranking CPU per publish p50 (ms) | 3.137 | 2.492 | -0.645 | -20.6% | 3.177 | 2.637 | -0.541 | -17.0% |
| Ranking CPU per publish p95 (ms) | 6.096 | 6.214 | +0.118 | +1.9% | 8.058 | 6.659 | -1.398 | -17.4% |

#### mobile: speed, typical latency

| Metric | dev before | dev after | Δ | Δ% | holdout before | holdout after | Δ | Δ% |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| First results p50 (ms) | 983 | 987 | +4.000 | +0.4% | 955 | 995 | +40.000 | +4.2% |
| First results p95 (ms) | 1538 | 1654 | +116 | +7.5% | 1492 | 1693 | +201 | +13.5% |
| Settled p50 (ms) | 2759 | 2010 | -749 | -27.1% | 3006 | 1924 | -1082 | -36.0% |
| Settled p95 (ms) | 4907 | 4107 | -800 | -16.3% | 5846 | 5634 | -212 | -3.6% |
| Top-5 reshuffles after first paint | 1.850 | 2.020 | +0.170 | +9.2% | 1.881 | 1.985 | +0.104 | +5.6% |
| Lead-section changes | 0.986 | 0.014 | -0.973 | -98.6% | 1.000 | 0.030 | -0.970 | -97.0% |
| Requests to the server | 10.714 | 9.048 | -1.667 | -15.6% | 10.746 | 9.881 | -0.866 | -8.1% |
| Upstream searches/lookups | 9.714 | 7.837 | -1.878 | -19.3% | 9.731 | 8.537 | -1.194 | -12.3% |
| Ranking CPU per publish p50 (ms) | 2.952 | 2.710 | -0.242 | -8.2% | 3.093 | 2.843 | -0.250 | -8.1% |
| Ranking CPU per publish p95 (ms) | 5.979 | 6.341 | +0.362 | +6.1% | 7.198 | 6.844 | -0.355 | -4.9% |

#### mobile: speed, slow-spotify latency

| Metric | dev before | dev after | Δ | Δ% | holdout before | holdout after | Δ | Δ% |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| First results p50 (ms) | 983 | 987 | +4.000 | +0.4% | 955 | 995 | +40.000 | +4.2% |
| First results p95 (ms) | 1584 | 1626 | +42.000 | +2.7% | 1492 | 1680 | +188 | +12.6% |
| Settled p50 (ms) | 6759 | 5947 | -812 | -12.0% | 7242 | 5919 | -1323 | -18.3% |
| Settled p95 (ms) | 12116 | 11863 | -253 | -2.1% | 11589 | 11884 | +295 | +2.5% |
| Top-5 reshuffles after first paint | 1.830 | 1.980 | +0.150 | +8.2% | 1.716 | 2.149 | +0.433 | +25.2% |
| Lead-section changes | 1.000 | 0.014 | -0.986 | -98.6% | 1.000 | 0.045 | -0.955 | -95.5% |
| Requests to the server | 10.687 | 8.918 | -1.769 | -16.5% | 10.582 | 9.642 | -0.940 | -8.9% |
| Upstream searches/lookups | 9.687 | 7.714 | -1.973 | -20.4% | 9.567 | 8.343 | -1.224 | -12.8% |
| Ranking CPU per publish p50 (ms) | 2.978 | 2.642 | -0.335 | -11.3% | 3.035 | 2.732 | -0.303 | -10.0% |
| Ranking CPU per publish p95 (ms) | 5.668 | 6.141 | +0.473 | +8.4% | 6.765 | 6.423 | -0.342 | -5.1% |

#### mobile: speed, fail-qobuz latency

| Metric | dev before | dev after | Δ | Δ% | holdout before | holdout after | Δ | Δ% |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| First results p50 (ms) | 707 | 550 | -157 | -22.2% | 707 | 550 | -157 | -22.2% |
| First results p95 (ms) | 1538 | 1338 | -200 | -13.0% | 729 | 550 | -179 | -24.6% |
| Settled p50 (ms) | 2777 | 2041 | -736 | -26.5% | 3006 | 1982 | -1024 | -34.1% |
| Settled p95 (ms) | 4907 | 4107 | -800 | -16.3% | 5846 | 5272 | -574 | -9.8% |
| Top-5 reshuffles after first paint | 1.796 | 2.918 | +1.122 | +62.5% | 1.701 | 3.015 | +1.313 | +77.2% |
| Lead-section changes | 0.993 | 0.102 | -0.891 | -89.7% | 1.000 | 0.075 | -0.925 | -92.5% |
| Requests to the server | 8.619 | 9.769 | +1.150 | +13.3% | 8.821 | 10.612 | +1.791 | +20.3% |
| Upstream searches/lookups | 7.619 | 8.612 | +0.993 | +13.0% | 7.806 | 9.478 | +1.672 | +21.4% |
| Ranking CPU per publish p50 (ms) | 2.108 | 1.793 | -0.315 | -14.9% | 2.255 | 1.775 | -0.480 | -21.3% |
| Ranking CPU per publish p95 (ms) | 4.209 | 4.639 | +0.429 | +10.2% | 4.924 | 4.961 | +0.037 | +0.8% |

#### mobile, typical: leading section, expected (rows) × shown (columns), all queries, before → after

| Expected | tracks | albums | artists |
|---|---|---|---|
| tracks | 0 → 86 | 0 → 12 | 102 → 4 |
| albums | 0 → 2 | 0 → 36 | 39 → 1 |
| artists | 0 → 3 | 0 → 0 | 73 → 70 |

#### mobile, typical: by category

| Category | n dev / held out | Lead dev | Lead held out | Top-1 dev | Top-1 held out | Tracks MRR | Albums MRR | Artists MRR | Forbidden |
|---|---|---|---|---|---|---|---|---|---|
| album | 10 / 5 | 0.00 → 1.00 | 0.00 → 1.00 | 0.20 → 1.00 | 0.00 → 0.80 | — → — | 0.95 → 0.94 | 0.18 → 0.93 | 0.07 → 0.13 |
| album-artist | 13 / 4 | 0.00 → 1.00 | 0.00 → 0.75 | 1.00 → 1.00 | 0.75 → 0.50 | 1.00 → 1.00 | 0.53 → 0.97 | 0.97 → 0.94 | 0.29 → 0.24 |
| artist | 12 / 5 | 1.00 → 1.00 | 1.00 → 1.00 | 0.92 → 1.00 | 1.00 → 1.00 | 0.85 → 0.87 | — → — | 0.97 → 1.00 | 0.06 → 0.00 |
| artist-like-word | 10 / 5 | 1.00 → 1.00 | 1.00 → 1.00 | 1.00 → 1.00 | 1.00 → 1.00 | 0.73 → 0.79 | 1.00 → 1.00 | 1.00 → 1.00 | 0.07 → 0.00 |
| classical | 5 / 3 | 0.00 → 0.80 | 0.00 → 1.00 | 0.20 → 0.40 | 0.00 → 0.00 | 1.00 → 1.00 | 1.00 → 1.00 | 1.00 → 1.00 | 0.13 → 0.13 |
| common-word | 4 / 4 | 0.00 → 1.00 | 0.50 → 1.00 | 0.00 → 0.75 | 0.50 → 1.00 | 0.63 → 0.75 | 0.80 → 1.00 | 0.25 → 0.88 | 0.00 → 0.00 |
| diacritics | 8 / 2 | 0.38 → 1.00 | 1.00 → 1.00 | 0.88 → 1.00 | 1.00 → 1.00 | 1.00 → 1.00 | 0.41 → 1.00 | 0.90 → 1.00 | 0.40 → 0.10 |
| disambiguation | 3 / 0 | 1.00 → 1.00 | — → — | 1.00 → 1.00 | — → — | 0.75 → 0.78 | — → — | 1.00 → 1.00 | 0.00 → 0.00 |
| edition | 10 / 7 | 0.00 → 1.00 | 0.00 → 1.00 | 0.30 → 1.00 | 0.29 → 0.71 | 1.00 → 1.00 | 0.33 → 0.85 | 0.43 → 0.88 | 0.41 → 0.12 |
| exact-title | 16 / 7 | 0.00 → 1.00 | 0.00 → 1.00 | 0.00 → 0.88 | 0.00 → 1.00 | 0.93 → 0.96 | 0.00 → 0.69 | 0.09 → 0.91 | 0.00 → 0.04 |
| feat | 12 / 4 | 0.00 → 0.92 | 0.00 → 0.75 | 0.42 → 0.83 | 0.75 → 0.75 | 0.97 → 0.97 | 0.20 → 1.00 | 0.59 → 1.00 | 0.63 → 0.19 |
| karaoke | 9 / 3 | 0.00 → 1.00 | 0.00 → 1.00 | 0.22 → 1.00 | 0.67 → 1.00 | 0.96 → 1.00 | 0.02 → 0.83 | 0.40 → 1.00 | 0.33 → 0.00 |
| long-tail | 9 / 3 | 0.44 → 0.89 | 0.67 → 0.67 | 1.00 → 0.89 | 1.00 → 0.67 | 0.69 → 0.76 | 0.87 → 1.00 | 1.00 → 1.00 | 0.00 → 0.00 |
| non-latin | 5 / 2 | 0.60 → 0.60 | 0.50 → 1.00 | 0.60 → 0.60 | 1.00 → 1.00 | 0.57 → 0.57 | — → — | 0.76 → 0.79 | 0.57 → 0.29 |
| partial | 11 / 5 | 0.45 → 0.73 | 0.40 → 1.00 | 0.45 → 0.45 | 0.20 → 1.00 | 0.74 → 0.78 | 0.61 → 0.75 | 0.47 → 0.59 | 0.19 → 0.00 |
| popular | 2 / 1 | 1.00 → 1.00 | 1.00 → 1.00 | 1.00 → 1.00 | 1.00 → 1.00 | 0.83 → 0.83 | — → — | 1.00 → 1.00 | 0.00 → 0.00 |
| punctuation | 17 / 10 | 0.24 → 0.94 | 0.40 → 0.90 | 0.76 → 0.76 | 0.70 → 0.90 | 0.78 → 0.81 | 0.28 → 0.61 | 0.80 → 0.96 | 0.30 → 0.15 |
| self-titled | 5 / 4 | 1.00 → 1.00 | 1.00 → 1.00 | 1.00 → 1.00 | 1.00 → 1.00 | 0.94 → 0.94 | 1.00 → 1.00 | 1.00 → 1.00 | 0.22 → 0.00 |
| song-artist | 28 / 11 | 0.00 → 0.96 | 0.00 → 1.00 | 0.93 → 0.82 | 0.91 → 1.00 | 0.92 → 0.92 | 0.08 → 0.73 | 0.95 → 1.00 | 0.87 → 0.21 |
| title-track | 11 / 4 | 0.00 → 1.00 | 0.00 → 1.00 | 0.27 → 0.91 | 0.25 → 1.00 | 0.87 → 0.87 | 0.58 → 0.97 | 0.34 → 0.93 | 0.27 → 0.13 |
| typo | 10 / 5 | 0.70 → 0.70 | 0.80 → 1.00 | 0.40 → 0.40 | 0.60 → 0.80 | 0.54 → 0.54 | — → — | 0.59 → 0.41 | 0.27 → 0.07 |
| variant | 7 / 3 | 0.00 → 1.00 | 0.00 → 1.00 | 0.14 → 0.71 | 0.00 → 0.67 | 0.77 → 0.77 | — → — | 0.29 → 0.80 | 0.40 → 0.10 |

#### mobile: 10 biggest wins

| Query | Split | Utility before → after | Before | After |
|---|---|---|---|---|
| `lose yourself instrumental` | holdout | 0.00 → 5.50 | artists: Fort Minor [tidal]; Richard Carter [tidal]<br>tracks: Lose Yourself (Instrumental) — Eminem [8 Mile (Music From And Inspired By The Motion Picture (Expanded Edition)); qobuz FLAC 16-bit/44.1 kHz]; Lose Yourself  (Instrumental Version) — D-Push [Deutsch Rap und Hip Hop Instrumental Beats, Vol. 1; qobuz FLAC 16-bit/44.1 kHz]<br>albums: Lose Yourself (Instrumental) — Beacon From Mars [tidal]; 2020 Best Coffee Shop & Wine Bar – Lose Yourself in Relaxing and Instrumental Jazz Collection, Extraordinary Nice Day, Joyful Moments, Cafe Music, Jazz Bar Rhythms, Taste Delicious Wine, Relaxing Black Coffee — Coffee Shop Jazz, New York Jazz Lounge, Wine Bar Akademie [tidal] | tracks: Lose Yourself (Instrumental) — Eminem [8 Mile (Music From And Inspired By The Motion Picture (Expanded Edition)); qobuz FLAC 16-bit/44.1 kHz]; Lose Yourself (Instrumental) — Tough Rhymes [Hip Hop Instrumentals; tidal FLAC]<br>albums: 8 Mile (Music From And Inspired By The Motion Picture (Expanded Edition)) (Music From And Inspired By The Motion Picture (Expanded Edition)) — Various Artists [qobuz]; Lose Yourself (Instrumental) — Beacon From Mars [tidal]<br>artists: Eminem [qobuz+spotify] |
| `random access mem` | holdout | -0.43 → 4.90 | artists: Random Access Memory [tidal]; Random Access Melodies [qobuz]<br>tracks: Random Access Memory [RAM] — Bryson Tiller [Bryson Tiller; qobuz FLAC 24-bit/44.1 kHz]; Random Access Memory — System Reset [Connection Lost; qobuz FLAC 24-bit/44.1 kHz]<br>albums: Random Access Memories — Daft Punk [spotify]; Random Access Memories (Drumless Edition) — Daft Punk [tidal] | albums: Random Access Memories — Daft Punk [qobuz]; Random Access Memories - 50 Electronic Chillout Lounge Tracks, Vol. 1 — Various Artists [qobuz]<br>tracks: Random Access Memory [RAM] — Bryson Tiller [Bryson Tiller; qobuz FLAC 24-bit/44.1 kHz]; Random Access Memory — System Reset [Connection Lost; tidal FLAC 24-bit/44.1 kHz]<br>artists: Daft Punk [spotify] |
| `bad guy justin bieber` | dev | 0.17 → 5.50 | artists: Justin Bieber [spotify]; Janja [tidal]<br>tracks: bad guy (with Justin Bieber) — Billie Eilish [bad guy (with Justin Bieber); qobuz FLAC 16-bit/44.1 kHz]; BadGuy - Billie Eilish - Justin Bieber - Remake — Swattrex [What Do You Mean; qobuz FLAC 16-bit/44.1 kHz]<br>albums: bad guy (with Justin Bieber) — Billie Eilish, Justin Bieber [spotify]; bad guy (with Justin Bieber) — Billie Eilish [qobuz] | tracks: bad guy (with Justin Bieber) — Billie Eilish [bad guy (with Justin Bieber); qobuz FLAC 16-bit/44.1 kHz]; BadGuy - Billie Eilish - Justin Bieber - Remake — Swattrex [What Do You Mean; qobuz FLAC 16-bit/44.1 kHz]<br>albums: bad guy (with Justin Bieber) — Billie Eilish [qobuz]<br>artists: Billie Eilish [qobuz+spotify+tidal] |
| `levitating remix` | dev | 0.40 → 5.50 | artists: Trinix Remix [tidal]; Ombre2Choc Remix [tidal]<br>tracks: Levitating (feat. Madonna and Missy Elliott) [The Blessed Madonna Remix] — Dua Lipa [Levitating (feat. Madonna and Missy Elliott) [The Blessed Madonna Remix]; qobuz FLAC 24-bit/44.1 kHz]; Levitating (feat. DaBaby)  (Don Diablo Remix) — Dua Lipa [Levitating (feat. DaBaby)  (Don Diablo Remix); qobuz FLAC 24-bit/44.1 kHz]<br>albums: Levitating remix — Eye'z [qobuz]; Levitating (feat. Madonna and Missy Elliott) [The Blessed Madonna Remix] — Dua Lipa, Madonna, Missy Elliott [tidal] | tracks: Levitating (feat. Madonna and Missy Elliott) [The Blessed Madonna Remix] — Dua Lipa [Levitating (feat. Madonna and Missy Elliott) [The Blessed Madonna Remix]; qobuz FLAC 24-bit/44.1 kHz]; Levitating (Chambord Remix) — RUFUS DU SOL [Inhale / Exhale Remixed, Vol. 2; qobuz FLAC 24-bit/44.1 kHz]<br>albums: Levitating (feat. Madonna and Missy Elliott) [The Blessed Madonna Remix] — Madonna [qobuz]; Levitating (feat. Prakriti Kakar & Sukriti Kakar) [Amaal Mallik Remix] — Amaal Mallik [qobuz]<br>artists: Dua Lipa [qobuz+spotify] |
| `rumours` | dev | 0.20 → 5.00 | artists: Rumours [qobuz]; The Rumours [qobuz]<br>tracks: Dreams - 2001 Remaster (2001 Remaster) — Fleetwood Mac [Rumours; spotify Ogg Vorbis 160 kbps]; The Chain (2001 Remaster) — Fleetwood Mac [Rumours (2001 Remaster); qobuz FLAC 24-bit/96 kHz]<br>albums: Rumours — Fleetwood Mac [spotify]; Rumours — Artzz [tidal] | albums: Rumours (2001 Remaster) — Fleetwood Mac [qobuz]; Rumours — Ivorian Doll [qobuz]<br>tracks: Dreams - 2001 Remaster (2001 Remaster) — Fleetwood Mac [Rumours; spotify Ogg Vorbis 160 kbps]; The Chain (2001 Remaster) — Fleetwood Mac [Rumours (2001 Remaster); qobuz FLAC 24-bit/96 kHz]<br>artists: Fleetwood Mac [spotify+tidal] |
| `creep acoustic radiohead` | dev | -0.30 → 4.50 | artists: Kurt Cobain [tidal]; AcousticTrench [tidal]<br>tracks: Creep (Acoustic) — Radiohead [Creep EP; qobuz FLAC 16-bit/44.1 kHz]; Creep — Acoustic Heartstrings [Acoustic Guitar Renditions of Radiohead; qobuz FLAC 16-bit/44.1 kHz]<br>albums: Creep EP — Radiohead [spotify]; In Rainbows — Radiohead [tidal] | tracks: Creep (Acoustic) — Radiohead [Creep EP; qobuz FLAC 16-bit/44.1 kHz]; Creep — Acoustic Heartstrings [Acoustic Guitar Renditions of Radiohead; qobuz FLAC 16-bit/44.1 kHz]<br>albums: Creep EP — Radiohead [tidal]; Creep (Acoustic Guitar Karaoke Instrumentals) (Acoustic Guitar Karaoke Instrumentals) — Sing2Guitar [spotify]<br>artists: Radiohead [qobuz+spotify+tidal] |
| `billie jean` | holdout | 0.73 → 5.50 | artists: Billie Jean [qobuz]; BillieJean [qobuz]<br>tracks: Billie Jean (Single Version) — Michael Jackson [Thriller; qobuz FLAC 24-bit/176.4 kHz]; Billie Jean — Susan Wong [511; qobuz FLAC 24-bit/96 kHz]<br>albums: Billie Jean — ICARUS, 2S Gee [tidal]; Billie Jean — Bay Swag, Sheff G [tidal] | tracks: Billie Jean (Single Version) — Michael Jackson [Thriller; qobuz FLAC 24-bit/176.4 kHz]; Billie Jean — The Civil Wars [Between the Bars; qobuz FLAC 16-bit/44.1 kHz]<br>albums: Thriller — Michael Jackson [qobuz]; Billie Jean — EDEN [qobuz]<br>artists: Michael Jackson [qobuz+spotify+tidal]; Billie Jean [qobuz+tidal] |
| `superstition` | dev | 0.73 → 5.50 | artists: Superstition [qobuz]; Superstition Saint [qobuz]<br>tracks: Superstition (Album Version) — Stevie Wonder [Talking Book; qobuz FLAC 24-bit/192 kHz]; Superstition (Single Version) — Stevie Wonder [The Definitive Collection; qobuz FLAC 16-bit/44.1 kHz]<br>albums: Superstition — VILLFORTH [tidal]; Superstition — Run River North [qobuz] | tracks: Superstition (Album Version) — Stevie Wonder [Talking Book; qobuz FLAC 24-bit/192 kHz]; Superstition — Quincy Jones [You've Got It Bad Girl; qobuz FLAC 16-bit/44.1 kHz]<br>albums: Talking Book — Stevie Wonder [qobuz]; The Definitive Collection — Stevie Wonder [qobuz]<br>artists: Stevie Wonder [qobuz+spotify+tidal]; Superstition [qobuz+tidal] |
| `empire state of mind` | dev | 0.73 → 5.50 | artists: New York Empire State of Mind [qobuz]; Empire State of Mind (Black History) [qobuz]<br>tracks: Empire State Of Mind — Jay-Z [The Blueprint 3; qobuz FLAC 16-bit/44.1 kHz]; Empire State of Mind — Glee Cast [Glee: The Music, Volume 4; qobuz FLAC 16-bit/44.1 kHz]<br>albums: Empire State Of Mind — JAŸ-Z, Alicia Keys [tidal]; Empire State Of Mind  (Remix) — Trinix Remix [qobuz] | tracks: Empire State Of Mind — Jay-Z [The Blueprint 3; qobuz FLAC 16-bit/44.1 kHz]; Empire State of Mind — Glee Cast [Glee: The Music, Volume 4; qobuz FLAC 16-bit/44.1 kHz]<br>albums: The Blueprint 3 — Jay Z [qobuz]; Empire State Of Mind — Jay Z [qobuz]<br>artists: Jay Z [qobuz+spotify+tidal]; New York Empire State of Mind [qobuz+tidal] |
| `hotel california live` | dev | 0.65 → 5.40 | artists: Hagar Schon Aaronson Shrieve [tidal]; Eagles [spotify]<br>tracks: Hotel California (Live On MTV, 1994) — Eagles [Hell Freezes Over (Remaster 2018); qobuz FLAC 16-bit/44.1 kHz]; Hotel California  (Live at The Forum, Los Angeles, CA, 10/20-22/1976) — Eagles [Hotel California  (40th Anniversary Expanded Edition); qobuz FLAC 24-bit/96 kHz]<br>albums: HOTEL CALIFORNIA (Live) — Brian Houston [tidal]; Hotel California (Live) — Aspen Meadow Band [qobuz] | tracks: Hotel California (Live On MTV, 1994) — Eagles [Hell Freezes Over (Remaster 2018); qobuz FLAC 16-bit/44.1 kHz]; Hotel California (Live at the Roadrunner) — Sammy Rae & The Friends [The If It All Goes South Tour (Live); qobuz FLAC 24-bit/48 kHz]<br>albums: Hell Freezes Over (Remaster 2018) (Remaster 2018) — Eagles [qobuz]; Hotel California (Live From The Forum, Inglewood, CA, 9/12, 14, 15/2018) — Eagles [tidal]<br>artists: Eagles [qobuz+spotify] |

#### mobile: 10 worst remaining

| Query | Split | Utility before → after | Before | After |
|---|---|---|---|---|
| `blinding ligths` | dev | -1.00 → -1.00 | artists: Blinding Lights [qobuz]; Hard Lights [tidal]<br>tracks: Blinding Ligths — Mr Jham [Blinding Ligths; tidal FLAC]; Blinding City Ligths — DJ Gold Fox [DJ Gold Fox the Great Hits, Vol. 1; tidal FLAC]<br>albums: Blinding Ligths — Mr Jham [spotify]; Baby Can I Hold You / Nikita / Blinding Ligths (Ao Vivo) — Grupo Rapadura [qobuz] | albums: Blinding Ligths — Mr Jham [qobuz]; Baby Can I Hold You / Nikita / Blinding Ligths (Ao Vivo) — Grupo Rapadura [qobuz]<br>tracks: Blinding Ligths — Mr Jham [Blinding Ligths; qobuz FLAC 16-bit/44.1 kHz]; Blinding City Ligths — DJ Gold Fox [DJ Gold Fox the Great Hits, Vol. 1; spotify Ogg Vorbis 160 kbps]<br>artists: Mr Jham [spotify] |
| `宇多田ヒカル` | dev | 1.06 → -1.00 | artists: 宇多田ヒカル／宇多田ヒカル [qobuz]; 田馥甄 [tidal]<br>tracks: 宇多田ヒカル — 恋と嘘 [夜に聴きたいエモい曲; tidal FLAC]; 宇多田 ヒカル — The Boy Who Drink Stars [杉並区; qobuz FLAC 16-bit/44.1 kHz]<br>albums: 宇多田ヒカル 作品集 VOL-1 — オルゴールサウンド J-POP [tidal]; 宇多田ヒカル 作品集 VOL-2 — オルゴールサウンド J-POP [tidal] | tracks: 宇多田ヒカル — 恋と嘘 [夜に聴きたいエモい曲; tidal FLAC 24-bit/48 kHz]; 宇多田 ヒカル — The Boy Who Drink Stars [杉並区; qobuz FLAC 16-bit/44.1 kHz]<br>albums: 夜に聴きたいエモい曲 — 恋と嘘 [tidal]<br>artists: 恋と嘘 [tidal]; 宇多田ヒカル／宇多田ヒカル [qobuz] |
| `방탄소년단` | dev | 3.50 → -0.85 | artists: 방탄소년단 . [qobuz]; BTS [spotify]<br>tracks: 방탄소년단 — K9theGr8 [방탄소년단; tidal FLAC]; Butter (방탄소년단) — FUKUSHU BAND [Butter (방탄소년단); tidal FLAC]<br>albums: DNA (From "BTS 방탄소년단") — Nicolás Iaciancio [qobuz]; Butter (방탄소년단) — FUKUSHU BAND [qobuz] | tracks: 방탄소년단 — K9theGr8 [방탄소년단; tidal FLAC 16-bit/44.1 kHz]; Butter (방탄소년단) — FUKUSHU BAND [Butter (방탄소년단); tidal FLAC 16-bit/44.1 kHz]<br>albums: 방탄소년단 — K9theGr8 [tidal]; DNA (From "BTS 방탄소년단") — Nicolás Iaciancio [qobuz]<br>artists: K9theGr8 [tidal]; 방탄소년단 [qobuz+tidal] |
| `mr bright` | dev | 0.10 → -0.20 | artists: Mr Bright [qobuz]; Mrbright  [tidal]<br>tracks: Na-meya — Mr Bright [Na meya; qobuz FLAC 16-bit/44.1 kHz]; with you — Mr Bright [Na meya; qobuz FLAC 16-bit/44.1 kHz]<br>albums: Legal hustlers (feat. Freaky j, Classic baalo, Mr bright & Mr wanted)  (Special Version) — Lux sweet [qobuz]; Future Looks Bright (feat. Mr V) — Max Dean [qobuz] | artists: Mr Bright [qobuz+tidal]; Mr Bright Starz [qobuz]<br>tracks: with you — Mr Bright [Na meya; qobuz FLAC 16-bit/44.1 kHz]; Na-meya — Mr Bright [Na meya; qobuz FLAC 16-bit/44.1 kHz]<br>albums: OLUWA TOO GOOD — Mr Bright [qobuz]; PAS PAREIL — Mr Bright [qobuz] |
| `dark side of the m` | dev | -0.03 → 0.00 | artists: Dark Side of the Moon [qobuz]; The Dark Side of the Moon [qobuz]<br>tracks: The Dark Side Of The Moon — M Official [The Dark Side Of The Moon; tidal FLAC]; Cruise Control (FYH346) [Dark Side Track Of The Week] (AndyG & Alex M Remix) — Jordan Suckley [FYH346 - Find Your Harmony Radio Episode #346; qobuz FLAC 24-bit/44.1 kHz]<br>albums: The dark side of the Mooood — M A I K [tidal]; The Dark Side Of The Moon — M Official [tidal] | artists: —<br>tracks: The Dark Side Of The Moon — M Official [The Dark Side Of The Moon; tidal FLAC 16-bit/44.1 kHz]; Cruise Control (FYH346) [Dark Side Track Of The Week] (AndyG & Alex M Remix) — Jordan Suckley [FYH346 - Find Your Harmony Radio Episode #346; qobuz FLAC 24-bit/44.1 kHz]<br>albums: The Dark Side Of The Moon — M Official [tidal]; Dark Side Of The Power — Goncalo M [qobuz] |
| `the beatels` | dev | 4.50 → 0.00 | artists: The Beatles [spotify]; Billy Vera & The Beaters [qobuz]<br>tracks: Krabbelaar — BeatELS [Koelbloedig; qobuz FLAC 24-bit/48 kHz]; Hertentrein — BeatELS [Koelbloedig; qobuz FLAC 24-bit/48 kHz]<br>albums: The Beatles (Remastered 2009) — The Beatles [spotify]; The Beatles (White Album) [Super Deluxe] (White Album / Super Deluxe) — The Beatles [qobuz] | tracks: Krabbelaar — BeatELS [Koelbloedig; qobuz FLAC 24-bit/48 kHz]; Bakfiets — BeatELS [Koelbloedig; qobuz FLAC 24-bit/48 kHz]<br>albums: Koelbloedig — BeatELS [qobuz]<br>artists: — |
| `blinding li` | dev | 1.00 → 1.00 | artists: Blinding Lights [qobuz]; Blinding Lights Noises [qobuz]<br>tracks: Blinding Lights — The Weeknd [After Hours (Explicit); qobuz FLAC 24-bit/44.1 kHz]; Blinding Lights — Teddy Swims [Blinding Lights; qobuz FLAC 24-bit/44.1 kHz]<br>albums: Blinding Light Of Heaven: Robert Fripp @ 80, Vol. 28 — David Sylvian, Robert Fripp [tidal]; Blinding Lights — The Weeknd [spotify] | artists: Lilo Li [tidal]<br>tracks: Blinding Lights — The Weeknd [After Hours (Explicit); qobuz FLAC 24-bit/44.1 kHz]; Blinding Light — Miss Li [Chinese style; tidal FLAC 16-bit/48 kHz]<br>albums: After Hours — The Weeknd [spotify]; Blinding Lights — The Weeknd [qobuz] |
| `gangsta's paradise` | dev | 0.48 → 1.00 | artists: Gangsta's Paradise [qobuz]; Dr. Dre [tidal]<br>tracks: Gangsta's Paradise (feat. L.V.) (LP Version) — Coolio [Gangsta's Paradise; qobuz FLAC 16-bit/44.1 kHz]; Gangsta's Paradise — Lofi Fruits Music [90s Oldschool Lofi Hip Hop; qobuz FLAC 24-bit/44.1 kHz]<br>albums: Gangsta's Paradise — Coolio [spotify]; Gangsta's Paradise — Bishop Snow [tidal] | albums: Gangsta's Paradise  (25th Anniversary - Remastered) — Coolio [qobuz]; Gangsta's Paradise — State of Mine [qobuz]<br>tracks: Gangsta's Paradise (feat. L.V.) (LP Version) — Coolio [Gangsta's Paradise; qobuz FLAC 16-bit/44.1 kHz]; Gangsta's Paradise — 2WEI [Escape Velocity; qobuz FLAC 16-bit/44.1 kHz]<br>artists: Coolio [qobuz+spotify+tidal] |
| `the microphones the glow pt 2` | holdout | 3.00 → 1.00 | artists: The Microphones [spotify]; Liz Harris [tidal]<br>tracks: The Glow, Pt. 2 — The Microphones [The Glow, Pt. 2; tidal FLAC]; The Glow, Pt. 2 — Microphones [The Glow, Pt. 2; qobuz FLAC 16-bit/44.1 kHz]<br>albums: The Glow, Pt. 2 — The Microphones [spotify]; It Was Hot, We Stayed in the Water — The Microphones [spotify] | tracks: The Glow, Pt. 2 — The Microphones [The Glow, Pt. 2; tidal FLAC]; The Glow, Pt. 2 — Microphones [The Glow, Pt. 2; qobuz FLAC 16-bit/44.1 kHz]<br>albums: The Glow, Pt. 2 — The Microphones [tidal]; Little Bird Flies into a Big Black Cloud — The Microphones [tidal]<br>artists: The Microphones [spotify+tidal]; Microphones [qobuz] |
| `hotle california` | dev | 0.70 → 1.06 | artists: Hotel California [qobuz]; Randy California [tidal]<br>tracks: Hotel California (2013 Remaster) — Eagles [Hotel California (2013 Remaster); qobuz FLAC 24-bit/192 kHz]; Hotel California (Live On MTV, 1994) — Eagles [Hell Freezes Over (Remaster 2018); qobuz FLAC 16-bit/44.1 kHz]<br>albums: Hotel California (2013 Remaster) (2013 Remaster) — Eagles [spotify]; Hotel California (Deluxe) (Deluxe) — Tyga [tidal] | artists: Hotel California [qobuz+tidal]; Randy California [tidal]<br>tracks: Hotel California (2013 Remaster) — Eagles [Hotel California (2013 Remaster); qobuz FLAC 24-bit/192 kHz]; Hotel California (Live On MTV, 1994) — Eagles [Hell Freezes Over (Remaster 2018); qobuz FLAC 16-bit/44.1 kHz]<br>albums: California — Mr. Bungle [tidal]; California — Diplo [tidal] |

### Parity

#### Mobile vs desktop (all queries)

| Metric | Desktop before | Mobile before | Desktop after | Mobile after |
|---|---:|---:|---:|---:|
| Lead section accuracy | 0.794 | 0.341 | 0.939 | 0.939 |
| Song's album in albums | 0.586 | 0.263 | 0.933 | 0.933 |
| Song's artist in artists | 0.837 | 0.573 | 0.902 | 0.902 |
| Artist query shows their songs | 0.877 | 0.877 | 0.877 | 0.877 |
| Artist query shows their albums | 0.849 | 0.808 | 0.863 | 0.863 |
| Top-1 (leading section) | 0.762 | 0.565 | 0.832 | 0.832 |
| Tracks top-1 | 0.778 | 0.772 | 0.800 | 0.800 |
| Albums top-1 | 0.505 | 0.366 | 0.822 | 0.822 |
| Artists top-1 | 0.725 | 0.585 | 0.879 | 0.879 |
| Tracks MRR | 0.830 | 0.829 | 0.851 | 0.851 |
| Albums MRR | 0.578 | 0.428 | 0.836 | 0.836 |
| Artists MRR | 0.782 | 0.646 | 0.885 | 0.885 |
| Tracks nDCG@5 | 0.686 | 0.689 | 0.715 | 0.715 |
| Albums nDCG@5 | 0.463 | 0.334 | 0.615 | 0.615 |
| Artists nDCG@5 | 0.793 | 0.661 | 0.882 | 0.882 |
| Forbidden in top 5 | 0.117 | 0.271 | 0.093 | 0.093 |
| Duplicates in top 10 (per query) | 1.603 | 1.056 | 0.668 | 0.668 |
| Correct copy | 0.826 | 0.837 | 0.839 | 0.839 |
| Correct album edition | 0.863 | 1.000 | 0.964 | 0.964 |
| Artist disambiguation | 0.849 | 0.849 | 0.877 | 0.877 |
| First results p50 (ms) | 1270 | 973 | 993 | 993 |
| First results p95 (ms) | 1775 | 1538 | 1680 | 1680 |
| Settled p50 (ms) | 2631 | 2865 | 1994 | 1994 |
| Settled p95 (ms) | 5987 | 5275 | 4390 | 4390 |
| Top-5 reshuffles after first paint | 2.921 | 1.860 | 1.953 | 2.009 |
| Lead-section changes | 0.070 | 0.991 | 0.019 | 0.019 |
| Requests to the server | 13.953 | 10.724 | 9.126 | 9.308 |
| Upstream searches/lookups | 12.883 | 9.720 | 8.056 | 8.056 |
| Ranking CPU per publish p50 (ms) | 11.196 | 2.989 | 2.738 | 2.724 |
| Ranking CPU per publish p95 (ms) | 26.621 | 6.345 | 7.853 | 6.479 |

Queries where mobile's leading section or top song differs from desktop: 165 before, 0 after.

### Live (noisy)

Desktop path only, against the development server with all three services signed in, 20 queries (every 11th label), three rounds. Each round ran the final code then the baseline code (`e6abf35` in a worktree with the same harness), each as a cold pass then a warm pass, with 5.5 minutes between passes so every cold pass missed the server's 5-minute search cache. "Cold" still has the server's persistent Spotify metadata cache and the services' own caches warm. "Settled" here is the last update with every service answered. One run per round per version: treat differences under ~150 ms as noise; the final code's first cold round (946 ms p50 against 372 ms in rounds 2–3) shows how much a single round moves.

| Pass | Metric | Baseline | Final | Δ |
|---|---|---:|---:|---:|
| Cold | First results p50 (ms) | 534 | 418 | −116 |
| Cold | First results p95 (ms) | 1598 | 1576 | −22 |
| Cold | Settled p50 (ms) | 2198 | 2060 | −138 |
| Cold | Settled p95 (ms) | 4858 | 3725 | −1133 |
| Cold | Requests per search | 12.3 | 6.7 | −5.6 |
| Warm | First results p50 (ms) | 513 | 214 | −299 |
| Warm | First results p95 (ms) | 1348 | 673 | −675 |
| Warm | Settled p50 (ms) | 1999 | 257 | −1742 |
| Warm | Settled p95 (ms) | 4363 | 2158 | −2205 |
| Warm | Requests per search | 11.7 | 6.3 | −5.4 |

Per-round first-results p50, cold: baseline 587 / 542 / 534 ms, final 946 / 372 / 372 ms. Live searches are faster than the simulated typical profile because recording measured each request the first time the server ever saw it.

## 4. Changes

Each change is its own commit, measured on the dev split while being made, then on both splits with every suite run. Effects are desktop, typical latency, dev | held out, measured against the commit before.

### Kept

| Commit | Change | Target | Measured effect |
|---|---|---|---|
| `6e35234` | `categoryOrder` scores each section by its best entry's fit to the query (title share for songs and albums, name share for artists) times its backing: reciprocal rank in each service's own answer and, for artists and albums, how many of each service's first ten songs are theirs. Self-titled albums count for their artist. Computed once in the session; `SearchView` uses it. | Hierarchy | Lead accuracy 0.782 → 0.918 \| 0.821 → 0.955; top-1 0.755 → 0.796 \| 0.776 → 0.866. |
| `607bfe0` | The phone uses desktop's first page per service (catalog search + the enrichment, now `utils/catalogSearch.ts`), the same session with album lookups, the session's ranked artists and albums, and draws sections in the session's order (sections after the songs follow the first five). | Parity | Phone lead 0.327 → 0.918 \| 0.373 → 0.955; forbidden 0.272 → 0.143 \| 0.269 → 0.075. Cost first paint and CPU, recovered later. |
| `44f2f48` | Warm only shown TIDAL copies and the leading song's hidden ones. | Upstream requests | 13 → 10 per query \| 13 → 10; copy accuracy unchanged. |
| `5a64448` | Completion lookups only for the leading song and others by its artist, not covers or namesakes. | Speed, requests | First results p50 1300 → 1004 \| 1220 → 1013 ms; settled p50 2654 → 2046 \| 2630 → 2010 ms; reshuffles 2.91 → 2.03 \| 2.69 → 1.99; upstream 10 → 7.9 \| 8.6; correct copy 0.841 → 0.857 \| 0.800. |
| `da5129e` | Under song intent, the named song's artist outranks acts merely named like the song; same-name artist cards follow every distinct name. | Artists accuracy | Artists top-1 0.741 → 0.860 \| 0.766 → 0.891; duplicates 1.524 → 1.238 \| 1.776 → 1.522. |
| `5399129` | Under song intent, the leading song's own release leads the albums section; other artists' same-titled releases follow. | Albums accuracy, consistency | Albums top-1 0.535 → 0.831 \| 0.467 → 0.800; song's album shown 0.629 → 0.952 \| 0.500 → 0.893; forbidden 0.143 → 0.122 \| 0.075 → 0.045. |
| `5e19423` | Drop the letter-by-letter catalog retry ("r u m o u r s") for 4–8 letter words. | Speed | Settled p95 4533 → 4113 ms; reshuffles 2.14 → 2.05; lead changes 0.054 → 0.034; never improved a result. |
| `9f81fca` | Service discovery starts with the debounce and is reused for a minute (desktop refreshes it on sign-in changes); phone debounce 300 → 150 ms. | First paint | Desktop first p50 1004 → 987 \| 1005 → 995 ms; phone 1154 → 987 \| 1155 → 995 ms. |
| `1f9aa0c` | A shown song keeps a place-weighted bonus (0.05 for the first) when later answers rerank. | Reshuffles | Reshuffles 2.05 → 1.96 \| 2.03 → 2.02; held-out settled p95 6723 → 6165 ms; tracks top-1 0.766 → 0.774. |
| `246ac04` | One ranking per publish, shared by completion planning and the snapshot. | CPU | CPU per publish p50 8.8 → 7.8 ms desktop, 7.9 → 5.8 ms phone (noise ≈ 20%). |
| `14d9f58` | Each song once before any song is repeated (single/album versions, remasters, remixes of a listed song follow every distinct song; remakes stay behind). | Duplicates | Duplicates 1.224 → 0.571 \| 1.537 → 0.881; forbidden 0.122 → 0.116. |
| `70442fd` | The phone runs desktop's leading-song warming (`utils/searchWarmup.ts`). | Phone copy | Phone correct copy 0.767 → 0.800 held out. |
| `5c254f9` | Album identities and credits, folded titles, performance kinds, artist keys, variant factors and per-query fits are worked out once per entry instead of every publish. Results byte-identical. | CPU | CPU per publish p50 7.7 → 2.7 ms desktop, 8.5 → 2.8 ms phone (held out). |
| `2bb33b3` | The section leading on screen keeps the lead unless another overtakes it by 0.1. | Lead changes | Lead changes 0.034 → 0.014 \| 0.075 → 0.030; lead accuracy 0.918 → 0.925 \| 0.955 → 0.970. |
| `bcf7308` | Unless an edition is asked for, a standard edition is the album's card; deluxe and anniversary reissues stay among its versions. | Edition | Correct edition 0.831 → 0.949 \| 0.958 → 1.000; duplicates 0.571 → 0.578 \| 0.881 → 0.866. |

Harness-only commits: `6016acb` (reshuffles by section, copy swaps), `d74f74c` (nDCG distinct items, re-scored baseline).

### Tried and reverted

| Change | Measured (dev) | Why reverted |
|---|---|---|
| No playback warming at all | Upstream 13 → 8.1, copy unchanged on dev | Lost a correct copy on the held-out set: the leading song's hidden TIDAL copies matter (became `44f2f48`'s narrower rule). |
| Warm only shown copies (no hidden ones) | Upstream 13 → 9.1 | Same held-out copy loss. |
| Early release for artist and album intents (`settled()` generalized) | First p50 1004 → 1020 ms, reshuffles 2.136 → 2.150 | No gain. |
| Tie-break by found order instead of sound quality | Reshuffles unchanged, duplicates 1.224 → 1.231 | No gain. |
| Hold 0.1 instead of 0.05 | Reshuffles 1.959 → 1.884 | Top-1 0.810 → 0.803, artists top-1 0.860 → 0.853. |
| Merge window / deadline 800 / 1300 ms | First p95 1654 → 1254 ms | Reshuffles 1.959 → 2.327. |
| Merge window / deadline 1000 / 1500 ms | First p95 1654 → 1427 ms | Reshuffles 1.959 → 2.204. |
| Release before Spotify-side completion lookups end | No metric moved | No gain. |
| First intent model (presence on N services instead of native rank) | Lead 0.782 → 0.810, top-1 0.755 → 0.701 | Obscure songs named like an album are on every service; native rank separates them. |
| Deadline 1500 ms, merge window unchanged | First p95 1654 → 1650 ms | Reshuffles 1.959 → 2.000. |
| Artist fit must exceed half the query (`> 0.5`) | Fixes `blinding li` | Lead 0.925 → 0.918, top-1 0.816 → 0.810, duplicates 0.578 → 0.599. |

## 5. Held-out metrics that got worse

Desktop, typical latency: no aggregate held-out metric got worse (hierarchy, accuracy, speed, requests and CPU tables above).

Remaining held-out regressions, all listed, compared with the baseline:

- **Phone speed against the phone's old path.** First results p50 955 → 995 ms and p95 1492 → 1693 ms (typical), reshuffles 1.88 → 1.99, copy swaps 0.03 → 0.19, request p95 16 → 19, and under fail-qobuz reshuffles 1.70 → 3.02 and requests 8.8 → 10.6. The old phone drew each service's raw artist and album rows as soon as they arrived and ran no completion lookups or playback warming; it was fast to first paint and wrong about what to lead with two times in three. The phone now runs desktop's pipeline, so its numbers equal desktop's, which are better than desktop's own baseline on every one of these. Shorter merge windows and deadlines were tried to win back the first-paint gap; each cost more reshuffles than it saved (section 4).
- **Qobuz failing.** Artist disambiguation 0.920 → 0.880 on both platforms: one held-out query's top artist becomes a same-named act when Qobuz, which held the right one, is down. Correct edition 1.000 → 0.955: no query flipped; one more query now has an album to judge, and it fails.
- **Per category.** Classical held-out top-1 0.33 → 0.00: `bach cello suite 1` now leads with albums, where the label has no album to score (albums are an accepted lead for it). `umbrella feat jay-z` (feat) now leads with albums instead of the song.

## 6. Limits

- **Simulated vs live.** All tables except "Live" replay responses recorded once on 2026-11-27 from one account in one region. The typical profile replays each request's first, coldest latency, so it is slower than steady-state use; the live run shows the same direction at smaller magnitudes for first paint and larger ones for warm searches.
- **Noise.** Simulated metrics are deterministic (three baseline runs identical). CPU time varies 7–22% at p50 and 27–74% at p95 between identical runs; only the desktop CPU change (11 → 2.7 ms p50) is far outside that. Live numbers are single runs per round.
- **Fixture growth.** Changes that issued requests nobody had recorded were filled from the live server once (`--fill`). Those answers are from later in the same day than the original recording.
- **Labels.** Written by one person from general music knowledge; artist identity is by name, with disambiguation checked through the artist credited on known songs. Classical labels check title words only, not performer or composer.
- **Not tested.** Typing sequences (keystroke prefetch and cancellation were not changed or measured; every query is measured from its final keystroke); the single-provider filter; local files (not part of streaming search); the phone UI on a device (the section order change is checked by type-checking, the phone test suite and the benchmark, not by eye); server changes (none were made, so `cargo test` covers only that nothing else broke).
- **Not done.** Spotify still has no artist or album search of its own. The web player's `searchDesktop` persisted query returns artists and albums without a developer app, but its hash changes with Spotify's web player and could not be verified without changing the running server. Spotify's catalog page also fetches IDs five per upstream call (`SEARCH_PAGE_SIZE`), which keeps it near 1.7 s; raising it was not measurable offline. A "top result" card was not added: with the lead section right 94% of the time, the section order already does that job.
- **Test suites.** `desktop` (`bun run test`, which isolates files): 146 pass, 6 fail; plain `bun test`, which runs every file in one process, fails the same 20 tests at the baseline and at the end (24–25 failures counting repeats, varying between runs). The 6 isolated failures also fail at the baseline: `mobileClient.test.ts` and related phone-client tests (queue patching, pairing, P2P bridge, startup delegation) that predate this pass and touch no search code. `mobile`: 35 pass. `server`: 251 pass, 2 fail, 6 ignored; the failing tests (`full_audio_downloads_outlive_the_api_timeout_but_stalled_reads_fail`, `real_mock_socket_ack_then_async_event`, and on another run `bounded_download_accepts_complete_body_and_rejects_interruption_and_oversize`) are loopback timing tests, unchanged by this pass, that failed on the first run before any change as well.

## 7. Reproduce

```sh
# Offline benchmark (about 4 minutes), compared with bench/baseline.json:
bun run search:bench --compare
# Dev split only, one platform and profile, while tuning:
bun run search:bench --split=dev --platforms=desktop --profiles=typical --compare
# Report tables (bench/baseline.json against bench/results/latest.json):
bun run search:report
# Three runs, written to bench/baseline.json:
bun run search:bench --baseline
# Record fixtures again, or fill requests nobody recorded, from a signed-in server:
AMBRA_BENCH_SERVER=http://127.0.0.1:38147 bun run search:bench record
AMBRA_BENCH_SERVER=http://127.0.0.1:38147 bun run search:bench --fill
# Live timings (20 queries, cold then warm):
bun run search:bench live --rounds=3

cd desktop && bun run build && bun test
cd mobile && bun run test
cd server && cargo test
```

`cargo test` rebuilds `target/debug/ambra-server`; while that server is running on Windows, set `CARGO_TARGET_DIR` to another directory.
