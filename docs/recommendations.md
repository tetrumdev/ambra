# Local Discover recommendations

AMBRA's Rust server owns Discover. It reads the existing synchronized
`ambra.listening-history.v1` state, follows explicit artist/genre relationships in
bundled SQLite metadata, ranks artists, and resolves ordinary playable tracks
through the existing music providers. Desktop clients only fetch and display the
results. Discover is the final horizontal row on Home and uses the existing song
cards, artwork loader, playback menu, queue, and playback resolver.

There are no artist vectors, nearest-neighbor searches, precomputed neighbor
lists, collaborative filtering, user comparisons, machine learning, personalized
provider recommendation endpoints, or external recommendation services.

## Release data and licensing

The release snapshot was extracted on **2026-10-26**. Both sources permit
commercial use and redistribution under **CC0 1.0**, including paid app-store
builds. The application source license is independent of the metadata license.

* [Wikidata structured-data licensing](https://www.wikidata.org/wiki/Wikidata:Licensing):
  `P434` MusicBrainz artist IDs, `P136` explicit genre statements, English genre
  labels/aliases, `P279` subclass edges, and Spotify (`P1902`), TIDAL (`P4576`),
  and Qobuz numeric (`P11578`) artist IDs. Available English artist labels are
  retained as aliases; MusicBrainz canonical names avoid an expensive Wikidata
  label join for the complete artist set.
* [MusicBrainz data license](https://musicbrainz.org/doc/About/Data_License):
  only core `artist` and `artist_alias` tables from the
  [2026-10-24 core archive](https://data.metabrainz.org/pub/musicbrainz/data/fullexport/20261024-102842/mbdump.tar.bz2).
  Retained fields are stable artist IDs, names, aliases, and disambiguation
  comments. The extractor checks the archive's CC0 notice. It scans names and
  aliases across the core tables to detect collisions, but retains only the
  matching artist subset and collision flags needed by this subset.

MusicBrainz community tags, ratings, annotations, biographies, supplementary
exports, Last.fm data, listening events, recordings, releases, artwork, and audio
are **not** included. Provider metadata remains transient or in AMBRA's existing
private state/caches; it is never folded into the redistributable CC0 asset.

Measured release coverage:

| Item | Count |
| --- | ---: |
| Artists | 128,657 |
| Artist–MusicBrainz ID links | 134,058 |
| Artists enriched from MusicBrainz core | 128,590 |
| Genres | 3,549 |
| Artist–genre links | 183,408 |
| Normalized artist alias links | 245,079 |
| Ambiguous names blocked from name matching | 33,771 |
| Explicit genre hierarchy edges | 3,424 |
| Artist–provider ID links | 42,077 |

SQLite occupies **29,048,832 bytes** (27.70 MiB). The bundled gzip occupies
**15,933,748 bytes** (15.20 MiB). Together they occupy 44,982,580 bytes
(42.90 MiB), excluding the server's existing code. Coverage derives from real
source statements, not hand-selected artists. English genre labels and usable
artist identities are required; Wikidata's original extract contained 132,013
artist entities and 3,581 distinct genre entities before validation/filtering.

`server/assets/recommendations.sqlite.manifest.json` records exact sizes,
coverage, extraction dates, the pinned core archive, SQLite version, and SHA-256
digests. The same provenance is stored inside SQLite's `metadata` table.
`scripts/recommendations/sources.json.gz` is the sanitized CC0 build snapshot;
it is development input and is not embedded in the server.

## Reproduce or refresh the database

The generator uses Python's standard library during development/release
preparation. Python, Bun, Node.js, Wikidata, and MusicBrainz are not runtime
requirements for recommendations. Runtime SQLite is compiled into Rust through
`rusqlite`'s bundled feature.

From the repository root, rebuild completely offline:

```sh
python3 scripts/recommendations/build.py
python3 -m unittest discover -s scripts/recommendations -p 'test_*.py'
```

The checked-in snapshot produces the measured asset with Python 3.13 and SQLite
3.53.1. SQLite/zlib versions can affect binary layout/compression; provenance
records the SQLite version. The generator sorts records, fixes gzip timestamps,
checks foreign keys and integrity, and vacuums the database. Rebuilding twice in
the same toolchain produces identical bytes. A release validation also compares
an independently rebuilt full corpus with the committed asset.

To take a new snapshot, remove only the ignored extraction cache and run:

```sh
rm -rf scripts/recommendations/snapshots
python3 scripts/recommendations/build.py --fetch \
  --musicbrainz-dump https://data.metabrainz.org/pub/musicbrainz/data/fullexport/20261024-102842/mbdump.tar.bz2
```

Choose a newer dated official CC0 core archive when updating the dataset. The
argument is pinned rather than following a mutable `LATEST` URL. Extraction
checkpoints resume interrupted work; changing the core archive requires clearing
those checkpoints. Wikidata queries retrieve only the required relationships and
IDs. The MusicBrainz reader streams past area tables, reads artist and alias
tables, and stops immediately afterward. It does not download/process the rest
of the multi-gigabyte archive. Expect several hundred MB of decoded build input
and more build-time memory than the compact runtime database uses: global name
collision detection deliberately checks artists outside the retained genre set.

Review the regenerated source snapshot, manifest, coverage, and licenses before
committing all three release artifacts. No source download occurs during server
startup or application installation.

## Schema and packaging

`server/assets/recommendations-schema.sql` defines schema version 1:

* `artists`: compact integer Wikidata ID (the numeric part after `Q`), canonical
  name, and disambiguation.
* `artist_mbids`: 16-byte UUIDs linked to artists. Multiple explicit MusicBrainz
  IDs for one Wikidata artist are preserved. An ID shared by different artist
  entities is ambiguous and never resolves by ID alone.
* `artist_aliases` / `ambiguous_artist_names`: normalized names and explicit
  collision exclusions. Canonical names participate in the same lookup.
* `genres` / `genre_aliases`: Wikidata identifiers, labels, aliases, and measured
  artist frequencies.
* `artist_genres`: explicit artist–genre edges, indexed in both directions.
* `genre_parents`: explicit `P279` edges whose endpoints are both retained
  genres. Reverse edges have an index; self-edges are excluded.
* `artist_provider_ids`: stable catalog identities, indexed in both directions.
* `metadata`: licensing and build provenance.

Prepared statements and indexed lookups serve the graph. Ranking does not scan
the artist table per request. Compact UUIDs, integer Wikidata IDs, and normalized
alias tables avoid duplicated strings and unnecessary indexes.

Rust embeds the compressed asset and manifest using `include_bytes!` and
`include_str!`. Consequently standalone server binaries and
`cargo install --path server --locked` all contain exactly the same metadata.
On first useful Discover request, a blocking worker validates/decompresses the
asset into AMBRA's existing cache directory, keyed by its content digest. It
validates SHA-256 and schema version and opens SQLite **read-only** with
`query_only`, a 2 MiB page cache, and untrusted schema execution disabled. A
process-wide extraction lock prevents races between readers. Startup never waits
for extraction, ranking, or catalogs. Private listening state stays in its
existing server data directory; the recommendation database is immutable.

## Taste and deterministic ranking

Constants live beside the relevant Rust calculation rather than being scattered
through UI code. They can be tuned in later releases without changing playback
or user state.

1. For every listening entry, use its existing play count (default 1) and latest
   timestamp. Split collaborative artist credits evenly. Aggregate artist plays
   and their play-weighted recency.
2. Recency is `0.35 + 0.65 / (1 + age_days / 45)`. Artist preference is
   `ln(1 + total_plays) * mean_recency`. Logarithmic growth prevents one very
   frequently played artist from overwhelming all other interests.
3. Use up to 128 strongest artist seeds. Distribute each seed's weight across
   its explicit genres, divided by the square root of its genre count. Retain
   all recognized played artists for discovery penalties, including non-seeds.
4. If an artist cannot be matched safely, existing track/album genre names can
   supply fallback signals. Normalize and deduplicate those names, accept only
   known genre aliases, and apply the same repetition/recency normalization.
   Provider genres supplement missing identity metadata rather than doubling
   every already-matched artist's signal.
5. Keep the strongest 16 genres and normalize their weights. Follow explicit
   one-hop parent/child edges at weight **0.20**. Limit expansion to the 12
   populated adjacent genres with greatest coverage per source genre.
6. Query artists attached to these genres. Specificity multiplies contributions
   by `ln(1 + artist_count / genre_artist_count)`. Broad genres therefore carry
   less information. Shared genre combinations add **0.18** per additional
   matching genre, capped at four additional genres.
7. New artists retain weight 1. Saved playlist artists receive **0.25**.
   Already-played artists receive **0.15 / (1 + artist_preference)**. Existing
   streaming library track IDs and played/saved recordings are excluded during
   track resolution.
8. A stable integer mixer uses artist ID and UTC day to add up to **25%**
   rotation among strong candidates. Broad genres use a daily rotating indexed
   window of at most **4,096** artists; niche genres are exhaustive. No
   precomputed artist-neighbor lists exist.
9. Select up to **24** artists greedily, dividing each score by
   `1 + 0.60 * selected_count_for_dominant_genre`. This promotes genre variety.
   Resolve at most one recording per artist and return at most **12** tracks.
   Recording selection also uses a stable daily track-ID hash.

Opening Home does not randomly shuffle the row. Identical server history,
saved state, provider sessions, metadata, and day yield the same ranking.
Listening changes may legitimately change it during that day. Reasons name
actual seed genres; hierarchy-derived results name the source genre.

## Catalog resolution, refresh, and failure behavior

`server/src/api/discover.rs` adapts ranked artists to existing catalog search and
metadata-loading code. No new streaming path or provider credentials reach the
client. Spotify metadata resolution retains existing market/playability checks;
TIDAL and Qobuz retain their existing availability filtering. Playback uses
normal AMBRA track identities and the existing provider playback endpoints.

Stable catalog IDs take precedence. Without IDs, both the local alias lookup and
the catalog result must be unambiguous: exact normalized canonical/alias names,
a nonempty catalog artist ID, and only one matching artist identity on the
search page. Names known to collide anywhere in the scanned MusicBrainz core
are rejected. Diacritics and word boundaries are preserved; there is no fuzzy
artist matching. Locally imported, unplayed tracks from validated artists can
resolve immediately before searching connected services.

Each generation spends at most **24 catalog searches**, with at most **2 artist
resolutions** concurrently and at most **8 tracks per search page**. Existing
provider internals bound metadata concurrency and reuse their own caches. The
search endpoint's seven-second timeout is retained; Discover adds an
eight-second lookup timeout and a 100-second generation deadline.

A single background generation serves concurrent Home requests and continues
when a client navigates away. Successful artist/provider matches cache for 24
hours; validated negative results cache for 6 hours. The cache holds at most 512
matches. Provider failures back off exponentially from 60 seconds to 30 minutes;
recognizable rate-limit failures receive at least 5 minutes. Failed requests do
not poison the negative-result cache. Safe stale matches can survive outages
for up to seven days. These caches are bounded, process-local server caches and
reset on restart; user listening history remains persistent and synchronized.

Results cache for one hour, keyed by history, playlist state, streaming library
IDs, local catalog contents, UTC day, connected services, and session epoch.
Unrelated queue-position or UI-state writes do not invalidate them. Sign-in and
sign-out invalidate provider matches/results, and old in-flight sessions cannot
commit afterward. Played/saved tracks are removed from stale results while new
results generate. Errors retry after one minute. Recording deduplication checks
provider identity, ISRC, and normalized title/artist, including catalogs missing
an ISRC.

The desktop hook debounces history changes, normally refreshes at most once a
minute, polls active jobs every two seconds, and refreshes on provider changes,
focus, online events, and server reconnection. Abort controllers and sequence
checks reject responses from old requests or unmounted views. Existing server
URL/token helpers preserve remote pairing and media rebasing. Loading/status
text uses a live region; cards retain horizontal scrolling, reduced-motion
behavior, and keyboard navigation. Playback menu items are native buttons with
focus restoration, arrow navigation, and Escape support.

## API and privacy

`GET /api/recommendations/discover?limit=12` is read-only. Limits clamp to 1–12.
Responses contain `tracks`, `reasons` keyed by track ID, `generatedAt` in Unix
milliseconds, `status`, and optional `refreshAfterMs`. Track metadata uses the
existing provider contract, or existing imported local-track objects, and the
client converts it through the normal playback abstraction.

Statuses are `loading`, `ready`, `insufficientHistory`, `noProviders`, `noMatches`,
`providerUnavailable`, `databaseUnavailable`, and `stateUnavailable`. Empty
history produces an honest empty result. Errors affect only Discover. Cached
playable tracks remain visible when safe. Responses use `Cache-Control:
no-store` and remain inside the existing access-policy/CORS middleware.

The taste profile, ranking, SQLite database, and synchronized history remain on
the listener's AMBRA server, whether local or remote from the desktop. Ordinary
catalog searches reveal selected artist names to the connected music provider;
no history, play counts, taste weights, genre profile, or user comparisons are
uploaded. There is no centralized account, analytics, telemetry, recommendation
service, recurring license fee, or runtime Wikidata/MusicBrainz request.

## Validation and limitations

Rust tests cover read-only/versioned databases, real bundled coverage, indexed
lookups, stable and ambiguous IDs, aliases, missing databases, taste weights,
specificity, hierarchy, combinations, discovery penalties, diversity, rotation,
fallback genres, provider identity checks, unavailable tracks, deduplication,
positive/negative caches, outages/backoff, hard lookup budgets, sign-out races,
and a synchronized-history-to-playable-local-track vertical integration.
Frontend tests cover API conversion/media rebasing, cancellation, Home row
order, loading/empty states, artwork/metadata cards, every playback/queue action,
keyboard menus, reconnects, and stale responses. Build tests use deterministic
fixtures and require no external datasets or credentials.

Wikidata genre coverage is incomplete and culturally uneven. Some genres lack
English labels. Sparse, ambiguous, or missing metadata can produce fewer than
12 results or an empty row. Global MusicBrainz collision checks can reject
legitimate alternate identities conservatively. Catalog search covers only its
first eight tracks; services may contain homonyms absent from both source data
and that page. Stable provider IDs reduce this uncertainty but are incomplete,
especially for Qobuz. Market rights and catalog availability can change after a
match was cached. Taste uses existing last-play timestamps, not a fabricated
full event stream. Saved playlist metadata is usable where synchronized tracks
exist; the server does not fetch an entire streaming library just to infer
additional artist signals.

Automated provider tests exercise the real adapter and matching/caching boundary
with fixture transport outcomes. Live, authenticated provider playback still
requires account-specific manual validation; tests never read personal service
credentials or require paid API access.

## Implementation files

* Server integration: `server/src/main.rs`, `server/src/api.rs`,
  `server/src/user_state.rs`, `server/Cargo.toml`, `server/Cargo.lock`.
* Engine: `server/src/recommendations/{mod,database,taste,ranking,tests}.rs`.
  Catalog/background adapter: `server/src/api/discover.rs` and
  `server/src/api/discover/tests.rs`.
* Bundled data: `server/assets/README.md`, `recommendations-schema.sql`,
  `recommendations.sqlite.gz`, `recommendations.sqlite.manifest.json`.
* Release pipeline: `scripts/recommendations/{build.py,test_build.py,sources.json.gz,.gitignore}`.
* Desktop: `desktop/src/api/server.ts`, `desktop/src/hooks/useDiscover.ts`,
  `desktop/src/components/HomeView.tsx`, `desktop/src/components/TrackPlaybackMenu.tsx`,
  `desktop/tests/discoverApi.test.ts`, `desktop/tests/discoverHome.test.tsx`,
  `desktop/package.json`, `desktop/bun.lock`. Existing Home CSS is reused.
* Documentation: `README.md` and this document.

Validation on this change: 146 Rust tests, 40 frontend tests, two generator tests,
strict TypeScript/Vite production build, optimized standalone `cargo install`,
byte-identical offline corpus regeneration, and an isolated installed-binary
HTTP smoke check. The smoke check confirms empty-history/no-provider states,
automatic real bundled database extraction, responsive health requests, and
foreign-origin rejection. New Rust modules pass rustfmt; repository-wide
formatting differences and existing Clippy warnings predate this feature.
