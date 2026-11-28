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

_Filled in below once the harness is finished._
