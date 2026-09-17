# Performance pass — 2026-09-17

Implemented improvements prioritize visible response time and reliable playback.

- Native playback promotes an in-flight next-track preload when selected, reusing its decoder and switching from the 6-second speculative target to the existing 500ms startup target. Superseded preparations stop between decode operations. A failed speculative preload leaves normal queue advancement able to retry instead of failing the current playback session. Startup and steady-state buffer sizes otherwise remain unchanged.
- Qobuz stream resolution coalesces overlapping requests per track. Its existing 30-minute URL lifetime and account-local provider state remain unchanged. The 128MiB audio-segment cache now evicts least recently used entries instead of oldest inserted entries.
- Provider session restoration runs concurrently. Initial library loading retries connection failures during sidecar startup, cancels retries on unmount, and still surfaces HTTP/provider errors without retrying them. Local library scans and cached-library parsing run on blocking workers; sorting computes each normalized key once. Artwork quality resolution checks its cache before fetching missing UPC metadata and overlaps independent dimension lookups.
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
