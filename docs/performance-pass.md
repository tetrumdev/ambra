# Performance pass — 2026-09-17

Implemented improvements prioritize visible response time and reliable playback.

- Native playback promotes an in-flight next-track preload when selected, reusing its decoder and switching from the 6-second speculative target to the existing 500ms startup target. Superseded preparations stop between decode operations. A failed speculative preload leaves normal queue advancement able to retry instead of failing the current playback session. Startup and steady-state buffer sizes otherwise remain unchanged.
- Qobuz stream resolution coalesces overlapping requests per track. Its existing 30-minute URL lifetime and account-local provider state remain unchanged. The 128MiB audio-segment cache now evicts least recently used entries instead of oldest inserted entries.
- Provider session restoration runs concurrently. Initial library loading retries connection failures during server startup, cancels retries on unmount, and still surfaces HTTP/provider errors without retrying them. Local library scans and cached-library parsing run on blocking workers; sorting computes each normalized key once. Artwork quality resolution checks its cache before fetching missing UPC metadata and overlaps independent dimension lookups.
- Track, search, queue, and compact-player covers use a shared thumbnail endpoint. Tidal/Qobuz request provider thumbnail variants; Spotify artwork is resized once for normal thumbnail display. Concurrent consumers share the download and transformation. A 512-entry server LRU, cacheable HTTP responses, 192 retained decoded thumbnails, and a separate three-image large-artwork budget keep recent covers available. Large album-grid artwork retains its original resolution.
- Background palettes use those same cached thumbnails, analyzed at 64×64 on blocking-worker threads, independently of high-quality cover discovery. They never fetch or decode full-size covers solely for palette extraction. Palette results are coalesced and cached by artwork identity. Advancing within one album no longer remounts its large cover.
- The next queued cover is prefetched. Missing artist-portrait searches begin within 1200px of the viewport instead of queuing the whole library.
- Memoized track rows skip unchanged playback-clock renders. Hover uses CSS and a cancellable warm-up timer. Row containment was evaluated and removed after a scroll-jump check exposed delayed cover visibility.
- The gradient renders its soft field at a maximum 960px longest edge, measures size through ResizeObserver, and pauses animation while the document is hidden. Live reduced-motion changes are respected.

## Measurements

Local macOS development measurements; these are not production or live-provider latency guarantees.

A temporary React Profiler harness rendered 1,000 tracks in a 1440×900 headless Chromium window, with stable track objects and new parent callbacks on each simulated playback tick. Across 20 ticks, React render duration fell from 477.7ms total to 79.8ms in the first run and 89.2ms in the final check (approximately 5–6× faster). Ten hover cycles previously caused 20 commits totaling 539.4ms; the changed version caused zero commits. Play-click dispatch, three-row Shift selection, a 30,000px scroll jump, loaded visible covers, and unchanged scroll extent were checked. Temporary instrumentation was removed.

The server artwork integration test used an 800×800 PNG served over loopback. Ten concurrent consumers shared one upstream download and transformation, completing in 79ms in a debug build. A subsequent cache lookup took 9µs. The test also checks shared palette results and a 256px output image. Run it with:

```sh
cd server
cargo test concurrent_covers_and_palettes_share_one_download -- --nocapture
```

At 1920×1080 and 1.5 device scale, browser inspection confirmed that the gradient render target changed from 2880×1620 to 960×540: nine times fewer fragments per frame. Reduced-motion screenshots retained the same smooth field. This is a fragment-count measurement, not a claim of nine times higher FPS.

## Validation and limits

- `cd desktop && bun run build && bun test`: build succeeds; 133 tests pass.
- `cd server && cargo test --quiet`: 40 tests pass.
- `cd desktop/src-tauri && cargo test --lib --quiet`: 23 tests pass; three existing environment-dependent tests remain ignored.
- Native regressions cover prepared-source reuse, speculative failure isolation, cancellation, seek validation, HLS restore, and buffer sizing. An existing macOS test-fixture failure was corrected by setting accepted test sockets to blocking mode.
- `git diff --check` passes. Existing unrelated working-tree changes were preserved.

Audible startup, track gaps under real network jitter, full application launch timing, and Windows hardware behavior were not measured. Cancellation is cooperative between native decode operations; an already-blocked network read still follows existing request timeouts. Thumbnail persistence uses the WebView/browser HTTP cache rather than introducing another disk store.

# Performance pass 2 — 2026-09-30: startup, persistence, and the backend boundary

Scope: the desktop↔backend boundary only (Rust commands, persistence, scanning, server startup). No component, markup, or styling changes.

## What was wrong, and the fix

| Bottleneck | Cause | Fix |
|---|---|---|
| First render waited on IPC | `main.tsx` did `await hydratePersistentStorage()` before `render()`; the call read and shipped the whole state file (including the full streaming-library JSON) | The app renders immediately from WebView storage. Hydration runs in the background and remounts only if the durable copy was newer. |
| Main-thread stalls on every save | `save_persistent_state`/`load_persistent_state` were sync Tauri commands (run on the main thread) and `fsync`ed | Commands are `async` and do disk I/O on the blocking pool. |
| Whole state rewritten constantly | Every `setPersistentItem` serialized *all* keys (library cache, playlists, queue…) over IPC and rewrote one blob; playback position did this every 5 s | Durable state is one file per key plus a revision file. The frontend sends only changed keys, coalesced with a 750 ms debounce, flushed on hide/pagehide. No-op writes (same value) are dropped before touching the revision. |
| Launch transferred state that was already current | The disk copy was always returned | `load_persistent_state(knownUpdatedAtMs)` returns only the revision when the WebView is current (a few bytes). Legacy `desktop-state.json` is read and migrated transparently. |
| Full tag scan on every launch | `scan_music` read tags (and inspected FLAC headers) for every file each time, serially | A size+mtime index (`library-index.v2.json`) reuses unchanged tracks; new/changed files are read on a small worker pool at low QoS (macOS `UTILITY`). The rescan is also deferred 1.5 s when a cache is already displayed. |
| Base64 cover per track | Embedded art was stored as a `data:` URI on *every track*, in `library.json`, through IPC, and in the JS heap | Covers are written once per unique image (content-addressed files under `$APPCACHE/covers`, added to the asset scope). The frontend already handled file paths. |
| Every backend response replaced all state | `setServerTracks(loaded)` created fresh objects for an unchanged library, invalidating memos and re-serializing/re-persisting it | `reconcileTracks` keeps existing identities and the array identity when nothing changed (100k tracks: ~30 ms). Mount-time re-saves are skipped. |
| Server port opened only after all three providers authenticated over the network | `try_join!` of Tidal/Qobuz/Spotify restoration ran before `bind` | The port opens first; providers restore concurrently in the background. Provider-dependent routes wait (max 20 s, then 503, which the app treats as "keep cache"); `/api/health` and `/api/artwork/*` answer immediately. |
| 5 Hz main-thread command | `native_audio_status` was a sync command | Now `async`. |

## Measurements

Local macOS (Apple Silicon), release build, synthetic PCM WAV libraries, `cargo test --release --lib scan_benchmark -- --ignored --nocapture`:

| Files | Old: serial full scan, every launch | New: warm incremental scan |
|---|---|---|
| 1,000 | 34 ms | 7 ms |
| 10,000 | 330 ms | 80 ms |
| 100,000 | 7,794 ms | 841 ms |

Cold first-ever scans are *not* much faster at 100k files (parallel 7.1 s vs serial 7.8 s): workers run at low priority on purpose so audio and UI are not disturbed, and these files are tag-light. The win is that the cold path now happens once, not per launch. Real libraries with large embedded art and FLAC seektable work cost more per file and so benefit more from being skipped. Not measured: real-world libraries, non-SSD storage, Windows.

Persistence IPC: a playback-position update previously serialized the complete state (size dominated by the streaming-library cache, often megabytes); it now sends the one changed key. This is by construction, not a timed benchmark.

## Tracing

Development builds (or `localStorage["ambra.perf"]="1"`) record `js-start`, `first-render`, `first-commit`, `interactive`, `state-hydrated`, `local-cache-loaded`, `local-scan-done`, `server-synced`, long tasks, and operation timings. `window.__ambraPerf()` returns them; times are relative to Rust process start (`startup_elapsed_ms`). Set `AMBRA_PERF=1` to have the Rust side log scan and provider-restore timings.

## Tests added

- Rust desktop: `persistence` (current-client no-payload, per-key patches, deletes, key allow-list/path traversal, legacy migration), `library_index` (reuse, change detection, removals, ordering, parallel exactly-once), scan integration over real WAV files, content-addressed cover storage.
- Server: startup gate (immediate when ready, resumes waiters, times out, dropped sender, route allow-list).

## Not done (and why)

- **SQLite/FTS library and virtualized lists.** Ambra has no SQLite today, and the track/album lists render every row. Both are significant but are UI/architecture changes outside this pass's scope. At 100k tracks the list DOM will be the dominant cost before IPC is.
- **Playback progress re-rendering `App` ~5×/s.** A UI-side change; left alone.
- **Decoded-image memory for large local covers.** Covers are now files, but the WebView still decodes the full image for small thumbnails; generating a small local thumbnail would fix it.
- **Click-to-audio / gapless / seek timing.** Not measured or changed. Nothing in the audio pipeline was touched.
- **Windows:** the new code compiles only on macOS here (Windows platform crates are not available offline). The scan priority lowering is macOS-only.

# Performance pass 3 — 2026-09-30: persistent caches, write amplification, local covers

Scope is still the desktop↔backend boundary; no component or style changes.

| Bottleneck | Cause | Fix |
|---|---|---|
| Library cache silently failing at scale | The streaming-library cache (about 8 MB at 10k tracks) was saved into `localStorage`, which WebViews limit to roughly 5–10 MB; the error was swallowed and, because `setPersistentItem` writes `localStorage` first, it also never reached disk. It was also parsed synchronously and mirrored in full to disk on every change. | Moved to a Rust-managed file in the rebuildable cache directory (`load_streaming_cache` / `save_streaming_cache`, off the main thread). Saves are coalesced (1 s). A legacy `localStorage` copy is migrated once and removed, freeing quota and ending redundant syncing. The browser/dev build still uses `localStorage`. The size limit is an expectation about WebViews, not something I verified on your machines. |
| Metadata cache rewritten per track | Each provider `track_metadata` miss serialized and wrote the *entire* cache file synchronously while holding the cache lock. Adding an album to a library of M cached tracks cost N full rewrites. | `write_behind`: inserts schedule one coalesced write (1.5 s) on the blocking pool; an insert during a write schedules a follow-up. |
| Covers and palettes re-fetched every restart | The server's artwork cache (thumbnails and derived palettes) was memory-only. | Thumbnails and palettes persist under the cache directory (atomic writes, LRU-by-mtime pruning to a 256 MB budget, recently used entries touched). After a restart, covers and palettes are served from disk with no network and no recomputation. |
| Full-resolution local covers decoded for 76 px rows | The WebView decodes the whole source image. A 3000 px cover is about 34 MB decoded, and up to 192 are retained. | A background worker at low priority generates 512 px JPEG thumbnails once per distinct cover (cached by path, size and mtime; small, corrupt and unsupported images get a skip marker). Lists use the thumbnail; bigscreen and OS media controls still use the original. Thumbnails appear progressively through a `local-library-updated` event, with no rescan. |

## Measurements (macOS, Apple Silicon)

- **Metadata writes:** 20 inserts into a 10,000-entry cache (about 8 MB file): old 294 ms of synchronous rewrites in the request path, new 24 µs, with one write afterward (`cargo test --release write_behind_benchmark -- --nocapture`).
- **Artwork after restart:** upstream unreachable, thumbnail served in about 150 µs, palette already stored, zero downloads.
- **Cover thumbnail:** 3000×3000 JPEG (2.4 MB, about 34 MB decoded) → 512 px (196 KB, about 1 MB decoded) in 53 ms, once (`cargo test --release --lib thumbnail_benchmark -- --ignored --nocapture`).
- **JS library pipeline, for context** (synthetic Tidal-shaped tracks; startup parse+normalize, one save, derive, search): 10k tracks 22 / 6 / 7 / 1 ms; 100k tracks 219 / 61 / 74 / 12 ms. At 10k the data layer is cheap; rendering every row is the larger cost.

## Tests added

- Server: write-behind coalescing and follow-up writes, artwork persistence across a restart with the upstream down, LRU pruning.
- Desktop Rust: thumbnail generation (size, aspect ratio, idempotence, skip markers, invalidation on source change) and thumbnail attachment to tracks (one job per shared album cover).
- Frontend: streaming-cache migration, precedence and save coalescing; local cover source selection.

## Still not done

- **Virtualized lists, SQLite/FTS, and the `App`-wide re-render on each playback tick** (UI and architecture; see the discussion above).
- **Playlists and queue still live in `localStorage`** and can hit the same quota at extreme sizes. They hold user data, so moving them needs a migration design of its own.
- **Audio:** click-to-audio, gapless and seek timing were not measured or changed.
- **Windows:** not compilable here offline (platform crates unavailable). The scan and thumbnail workers lower their priority only on macOS.

# Performance pass 4 — 2026-09-30: bounded collection rendering

The large frontend collections now render a viewport-sized window instead of mounting every item. Track lists and long queues use fixed-height 76 px rows; artist and album grids measure their resolved column count, row height and gap after responsive layout. Two inert spacers retain the original scroll height, so native scrolling, the custom scrollbar and saved positions continue to use absolute offsets.

- Track lists and queues virtualize above 120 rows with ten overscan rows.
- Album and artist grids virtualize above 80 cards with three overscan rows. Grid measurements are cached between visits and resize anchoring keeps the same item in view when the column count changes.
- Scrolling only commits when the window crosses a four-row boundary. Layout reads happen when the rendered window or container geometry changes, not for every scroll event.
- A dragged track stays mounted during edge scrolling. Selection and Shift-range selection retain full-collection indexes even when most rows are absent from the DOM.
- Queue rows and library cards are memoized. `useQueue` retains the derived upcoming-entry array until queue state changes, so playback-clock renders no longer repeat its artwork-prefetch effect or rebuild the queue signature.
- Opt-in React Profiler counters report `render.track-list`, `render.queue`, `render.artist-grid`, and `render.album-grid` through `window.__ambraPerf()`.

## Measurements

A local Happy DOM/React harness compared deliberately simple rows, so these figures isolate React/DOM construction and do not include browser layout or Ambra artwork work. After a warm-up, mounting 10,000 unwindowed nodes took 94–102 ms. Mounting a 100,000-item virtual collection took 3.2–4.2 ms and created 24 item nodes. A separate regression test scrolls that 100,000-item collection to row 5,000, verifies that fewer than 50 items remain mounted, and checks listener cleanup.

The earlier Chromium profiler measurement remains the more representative row-render result: 1,000 real Ambra track rows took about 4 ms per parent update after memoization. Windowing makes that cost independent of total collection size; at a typical 800 px viewport the track list mounts about 24 rows instead of 10,000 or 100,000.

## Validation and limits

- `cd desktop && bun run build && bun test`: production build succeeds; 186 tests pass.
- `git diff --check` passes.
- Search results are not virtualized because the view intentionally caps each category at five items.
- Responsive geometry and fast scrollbar jumps are covered by pure window-math tests and a DOM hook test. The application was not launched in a real Tauri window during this pass, so a manual high-refresh scroll check on macOS and Windows remains useful.
