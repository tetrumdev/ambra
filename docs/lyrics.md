# Lyrics integration

Ambra keeps its existing `/api/lyrics` route, playback clock, and lyrics page. Provider adapters now return one segment-based wire model. Every displayed line, including plain text and line-only synchronization, contains text segments. Word and finer timings use the same renderer. The response retains `plainLyrics`, `hasWordSync`, and the legacy `words` alias alongside `segments`.

## Provider selection

Requests use title, artist, album, duration, recording version, ISRC, and Spotify ID when available. The server also accepts an optional Apple Music ID. Ambra currently has no Apple Music track provider to populate that ID automatically.

Providers run in this order:

1. AMLL: exact ISRC/platform lookup, then a bounded metadata search for suitable detailed synchronization.
2. lrc.red: direct ISRC retrieval or a bounded metadata search for detailed synchronization.
3. LRCLIB: signature lookup, then search for a matching word-timed revision when needed.
4. If no detailed result exists, select the best-synchronized remaining result (line before plain), preferring LRCLIB, then lrc.red, then AMLL among equals.
5. If no valid result exists, return `unavailable`. Explicit instrumental records return `instrumental`.

Detailed synchronization requires multiple nonempty segments with valid, distinct timing windows. A TTML `Word` declaration or LRCLIB `hasWordSync` flag does not qualify a record by itself. Subword text pieces remain separate segments. The API uses `segment` for finer timings whose linguistic unit is unknown; `syllable` additionally requires explicit source semantics and internal text boundaries. Rendering follows supplied timings without creating syllables or inserting spaces.

Exact recording IDs take precedence over spelling differences. A different ISRC does not reject a record, because reissues of one performance (remasters, compilations, deluxe editions) carry their own ISRCs and should show the same lyrics; lrc.red and AMLL also search by metadata when the ISRC lookup lacks word timing. Titles are compared without release notes: remaster, year, edition, mono/stereo, single/album version and featured-artist annotations are ignored, while notes such as live, acoustic, remix, edit or demo still distinguish versions. Artists match when the lead artist on either side is credited on the other. Near-identical title spellings (at least 90% alike, within two characters in length) are accepted only with a matching duration. Metadata-only matches otherwise require matching album or close duration; AMLL, which reports no duration, may match on title and artist alone when its timed lyrics span at least half of the recording. Searches use the title without release notes and the lead artist. The final fallback chooses the best synchronization (word, then line, then plain) before provider order. Search candidates rank album/duration agreement, and retrieval revalidates metadata. AMLL timestamps extending more than five seconds beyond the known track duration are rejected. Conservative matching can miss valid lyrics with different titles or artist spellings, especially when recording IDs are absent.

A valid fallback survives a subsequent timeout, malformed revision, or API failure. Detailed AMLL results stop all later provider calls. Only matched candidates are downloaded; no catalog or database download is needed.

## Timing and rendering

The response includes nullable millisecond start/end times, synchronization quality, source, original format, language, singers, translations, romanization, background vocals, and playback offset. Original text order and whitespace remain authoritative. Background vocals keep their own timings and singers. Explicit overlapping ends remain intact. Missing ends use the next timing boundary for display only. A final line without an end is held for twice the song's median line spacing (4–15 seconds, never past the known track duration), so a long instrumental ending does not keep it highlighted.

The renderer updates progressive CSS text gradients directly at animation frames. React does not rerender for each frame or word boundary. Line-only lyrics receive uniform line highlighting. Lead lines and background vocals can highlight simultaneously. Translation and romanization rows remain separate and retain language metadata. Singer labels, bidirectional text, scripts without spaces, and reduced-motion preferences are supported.

The lyrics page shares the player's artwork-colored swirl, with full-size artwork and a lyric column on wide windows and a compact heading on smaller windows. Active lines brighten and grow, surrounding lines soften by distance, and detailed timings drive a feathered word sweep and glow. An exact critically damped spring scrolls the first visual line of the active group into view, with a separately eased stagger across surrounding groups. Fractional scroll position is retained independently of browser scroll rounding. Wrapped lines and annotations do not change the anchor; reflow above the active line compensates the scroll position without restarting its motion. Pause dots retain a fixed anchor while their slot expands or collapses. Seeks and window resizes snap to the new position. Pausing does not restart the renderer or reset its scroll position; hidden views stop scheduling lyric frames.

Scrolling, touch, and keyboard browsing suspend automatic following. “Back to current line” resumes following. Clicking a timed lead or background line seeks through the player's existing seek command, accounting for the lyric offset. Untimed translations and plain lyrics remain readable text. The Lyric motion selector in Settings > General persists `system`, `full`, or `reduced` in the existing preferences. System mode follows live OS preference changes; Full explicitly enables lyric movement even when Windows disables system animations. Reduced removes scrolling motion, scaling, blur, and word glow while preserving timing highlights. Background motion continues to use the separate Animate swirl preference.

Browser playback reads the media element's current time directly. Native playback interpolates its existing 200 ms status samples, with advancement capped at 250 ms between samples. Pause, buffering, seeking, and track changes reset or stop interpolation. Native timing precision still depends on the audio status sampling and delivery latency; no audio-device sample clock is exposed to the webview.

Positive `offsetMs` advances highlighting by adding the offset to playback time. LRC `[offset:]` has this meaning. Lyricsfile 1.0's `metadata.offset_ms` semantics are explicitly unresolved in its draft specification, so Ambra does not apply that field. TTML offsets for alternate audio roles, such as lrc.red's spatial audio metadata, are not applied to ordinary playback because the applicable recording/offset convention cannot be established. These remain format limitations rather than guessed corrections.

Settings > General > Auto-sync lyrics (off by default, desktop app only) estimates one constant correction for lyrics timed against a different edit or master. The `detect_lyric_offset` Tauri command decodes the playing source a second time, measures centre-panned 250 Hz–4 kHz energy every 20 ms, and scores shifts within ±10 s by phrase/gap energy contrast plus energy rises at phrase starts. A shift is applied only when its peak stands well above the other shifts and a rival peak from repeated song structure; corrections under 150 ms are ignored. Results are kept in memory for the session only, and a newer request stops an older analysis. It cannot fix timings that are wrong in only some places, and dense mixes or centre-panned instruments can make the vocal signal unreliable; in those cases it leaves the timing unchanged.

Hovering the lyric column shows a Sync menu in the resume pill. It can run an analysis on demand (regardless of the setting), nudge the timing by ±0.1/0.5 s, reset the timing, or show a timed song as plain text. These choices are saved per track ID in local preferences (`ambra.lyrics-sync.v1`, most recent 2,000 tracks) and take precedence over automatic detection; lyric text itself is still never stored.

## Reliability

Lyrics and misses are never cached in memory, on disk, or in the browser HTTP cache. The local route returns `Cache-Control: no-store`; outgoing requests and client fetches also disable caching. The only retained provider state is request spacing and rate-limit cooldowns.

Each provider has a six-second total budget; individual HTTP requests have four-second timeouts. Calls to each provider are serialized and spaced by 250 ms. HTTP 429/503 responses establish shared cooldowns using numeric or HTTP-date `Retry-After`; absent/invalid headers use five seconds. Another provider can proceed immediately. The client has a 25-second overall deadline and aborts prior requests when tracks change. Provider futures are not detached, and stale client results are ignored.

Bodies are bounded to 2 MiB. XML DTDs and unknown entities are rejected; XML depth, nodes, lines, and segments are bounded. YAML parsing uses the existing library's recursion and alias-expansion limits, rejects duplicate required fields, and validates format versions, ranges, text reconstruction, and instrumental conflicts. Client wire validation rejects malformed data before animation. Provider failures are included in `failedProviders`; when failures leave no usable lyrics, the page offers retry rather than claiming a definitive catalog miss.

The TTML adapter supports the providers' absolute media-time profile, clock/second/millisecond/minute/hour timestamps, nested timed spans, agents, inline translations/romanization, keyed metadata annotations, and background vocals. General TTML frame/tick/SMPTE timing and arbitrary relative-time containers are not supported. Unsupported documents fail safely into other formats/providers. Provider parsers do not execute XML or render source markup as HTML.

## Documentation and licensing

Contracts verified against official documentation and live responses:

- AMLL: https://amll.dev/api/ttml/openapi.yaml and https://amll.dev/reference/http-api/overview
- lrc.red: https://lrc.red/llms.txt
- LRCLIB: https://lrclib.net/docs
- Lyricsfile: https://github.com/tranxuanthang/lyricsfile/blob/main/SPECIFICATION.md

AMLL's database README states that original contributor work is CC0, while imported data follows its original provider's sharing terms. The API implementation's MIT/Apache license does not license all lyric text. Free, keyless access to lrc.red or LRCLIB also does not establish redistribution rights for every lyric. Commercial redistribution rights have not been independently cleared. Ambra identifies the selected source and does not persist a lyric database.

## Build checks

```sh
cargo build --manifest-path server/Cargo.toml
bun run --cwd desktop build
rustfmt --edition 2024 --check server/src/lyrics.rs
git diff --check
```

Browser checks cover progressive fill, backward seeks, overlapping background vocals, pause/resume, syllable spans, line-only lyrics, plain annotations, stale request cancellation, and reduced motion. Live smoke checks returned AMLL detailed segments for Taylor Swift's “ME!”, lrc.red detailed segments for Queen's “Bohemian Rhapsody (Remastered 2011)”, a usable line fallback for “The Sound of Silence”, and a clean unavailable result for a nonexistent recording. All local lyrics responses carried `Cache-Control: no-store`.

Native packaged applications and other operating systems were not exercised end to end. Server and desktop build checks run on the current macOS host. Existing librespot lint and Vite chunk/import warnings remain outside this change.

## File inventory

Created:

- `server/src/lyrics/model.rs`
- `server/src/lyrics/formats.rs`
- `server/src/lyrics/ttml.rs`
- `server/src/lyrics/providers.rs`
- `desktop/src/types/lyrics.ts`
- `desktop/src/utils/lyricsTiming.ts`
- `docs/lyrics.md`

Modified:

- `server/src/lyrics.rs`
- `server/Cargo.toml`, `server/Cargo.lock` (direct use of existing transitive `httpdate` for HTTP-date cooldowns)
- `desktop/src/api/server.ts`
- `desktop/src/components/LyricsView.tsx`, `desktop/src/components/LyricsView.css`
- `desktop/src/utils/playbackClock.ts`
- `desktop/src/hooks/useAudioPlayer.ts`
- `desktop/src/components/AudioDecks.tsx`
- `desktop/src/App.tsx`
