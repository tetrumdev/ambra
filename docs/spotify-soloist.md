# Experimental Spotify Soloist playback

## Ownership and compatibility

The Spotify provider continues to own catalog, OAuth, playlists, library operations, and
librespot file playback. `session.rs` remains the sole queue and transport authority.
Soloist is an optional audio renderer: each requested track gets a `--single-track` run.
Spotify Connect queue events are observations only and never modify the Ambra queue.
Pairing uses a separate, finite `--pair` process, not a persistent Connect player.

Existing settings without Soloist configuration continue to use librespot. The new
configuration is stored separately from server pairing settings and Spotify credentials.
Rolling back means selecting librespot or running an older Ambra version; existing
credentials, native playlists, library data, queue, and listening history remain intact.
Older output clients lack the live PCM capability and cannot be selected for Soloist
unless the administrator explicitly permits librespot fallback before track startup.
No fallback occurs after a Soloist stream has begun.

## Audio boundary

Linux uses a private classic PulseAudio daemon without physical-device modules. Soloist
gets private PulseAudio and PipeWire runtime paths; an observed sink input with its PID
must appear on the private sink before capture is released. A fresh sink and FIFO are
created for every run. Capture is signed 32-bit little-endian PCM, 44,100 Hz, stereo.
There is no silence-based track detection or silence trimming. Playback events, process
exit, and delivered frame counts determine boundaries. An unexpected track is an error.

The live transport uses an explicitly framed PCM HTTP body, without Content-Length or
byte ranges. This preserves all captured bits without an encoder subprocess or extra
codec dependency. At 352,800 bytes/s (2.8224 Mbit/s) it costs more bandwidth than FLAC.
FLAC is suitable for future bandwidth optimization but is unnecessary for this initial
single-output LAN experiment. Stream IDs are unique, single-consumer, and bound to a
session generation. Seeking, recovery, and output handoff create new streams. EOF is
explicit; a dropped connection is an error, not a successful end of track.

The desktop decoder feeds PCM through the existing output, volume, and DSP path.
Requested quality and capture format are separate. The public Soloist API does not
verify Spotify's original codec or bit depth. S32LE capture is not evidence of a 24-bit
FLAC source.

## Permission boundary

Spotify documents playback on the device running Soloist. It does not document permission
for server-to-remote-client PCM redistribution. Ambra therefore does not enable Spotify
audio forwarding in release builds. Local development requires all three: a debug build,
the `experimental-soloist-forwarding` Cargo feature, and the runtime environment variable
`AMBRA_EXPERIMENTAL_SOLOIST_FORWARDING=1`. This is a development experiment, not evidence
of distribution permission. No Soloist executable or API key is bundled or downloaded.

## Setup

Use a Spotify Premium account with access to Soloist and the desired quality tier. Obtain
the executable and a personal API key directly from Spotify. Ambra does not generate keys,
download builds, or bypass account or regional restrictions.

1. Start Ambra Server and sign in to Spotify normally. In a terminal on the server,
   `ambra-server login spotify` completes librespot login first, then offers optional
   Soloist setup. Noninteractive login leaves Soloist setup to a later command.
2. In **Settings → Services → Spotify playback** on the server machine, choose Soloist.
   Enter the executable's absolute server path, or leave it empty to locate `soloist`
   on the server's PATH. Executables must be native, executable, and not group/world writable.
3. Enter the personal key in the password field and save. The key is never returned by
   status or settings APIs. On Unix, Ambra uses private directories and mode-0600 files;
   Windows uses the current user's application-data directory and its inherited ACLs.
4. Choose **Pair through Spotify**. Open the official Spotify app on the same network,
   using the account already connected to Ambra, and select **Ambra Soloist Pairing**.
   Pairing has a five-minute deadline. Check status until pairing is saved.
5. Select quality, save, and choose an updated Ambra desktop app as the shared output.
   The default quality ceiling is Lossless. Actual source quality can be lower.

Equivalent commands, run on the server machine with the server already running:

```sh
ambra-server login spotify
ambra-server spotify soloist install /absolute/path/to/soloist
ambra-server spotify soloist key
ambra-server spotify soloist pair
ambra-server spotify status
ambra-server spotify backend soloist
```

The key command reads a hidden terminal prompt. Never put the key in shell arguments,
environment variables, screenshots, or bug reports. Soloist itself requires the key in
its child-process arguments; same-user process inspection can therefore see it. Ambra
does not print commands or retain raw third-party logs. Only fixed, classified errors
survive log processing.

Administration is limited to the server machine through the existing `/api/local/`
protections. Paired remote clients can read sanitized `/api/spotify/playback/status`.
Pairing tokens do not grant permission to configure an executable or key. For a headless
Linux server, use its CLI for key entry, installation, pairing, and backend selection;
quality/fallback can also be configured through its local settings API.

To run the development experiment on Linux:

```sh
# Debian/Ubuntu example; run the server as an ordinary user, not root.
sudo apt-get install pulseaudio pulseaudio-utils
cargo build --manifest-path server/Cargo.toml --features experimental-soloist-forwarding
AMBRA_EXPERIMENTAL_SOLOIST_FORWARDING=1 server/target/debug/ambra-server serve
```

Stop any existing server first. If Cargo uses a shared target directory, use the executable
path reported by Cargo instead. Keep configuration/data/cache environment overrides
consistent between the foreground server and CLI. A long or whitespace-containing Linux
cache path is rejected because PulseAudio module arguments and Unix sockets have path
limits; use a private short `AMBRA_CACHE_DIR` if needed. The opt-in enables a development
experiment only. Establish permission before distributing any audio-forwarding integration.

## Lifecycle, controls, and recovery

One manager serializes configuration changes and process ownership. A file lease excludes
overlapping Ambra sessions using the same pairing directory. Each stream owns a fresh
private sink, FIFO, process group, loopback WebSocket connection, and cancellation token.
Startup requires a matching track event, authenticated session, confirmed seek (when
requested), unity volume, and the Soloist PID as the only private sink input. The sink
must be stereo at 44,100 Hz; other input rates are rejected to avoid hidden resampling.

The WebSocket client reconnects with bounded backoff, queries playback after authenticated
connection, limits frame sizes, and distinguishes command acknowledgements from observed
playback changes. It implements local play/pause/seek/skip/volume/shuffle/repeat/activation
commands. The queue-driven renderer uses only the subset needed for one requested track.
It never activates a persistent Connect queue as a second authority.

Ambra pause cancels the renderer and pauses the selected output. Resume starts a new
single-track run at the server's saved position. Seek also starts a new run, with its
sink suspended until the seek is confirmed. Output handoff and output process restart
replace the stream. Unique stream IDs and session generations reject stale events;
history remains keyed by the canonical track and existing generation. Soloist never
speculatively preloads the next Spotify track. These operations can have audible startup
gaps; this integration does not promise gapless playback or multiroom synchronization.

Before startup, the suspended sink's pipe is drained at an explicit lifecycle boundary.
After startup, samples are never trimmed based on amplitude. Buffering pauses capture
demand; reads are paced slightly above real time, with a bounded burst. Full HTTP buffers
suspend the private sink instead of dropping samples. A stalled consumer fails after ten
seconds; source startup/buffering has a thirty-second deadline. Unexpected track changes,
lost authentication, capture failure, and partial tracks produce errors rather than
advancing the shared queue as if playback completed successfully.

Up to three startup restarts use 1/2/4-second backoff, only for process failures before
audio delivery. Once samples have been delivered, recovery requires an explicit playback
retry; Ambra never silently replays or changes backend mid-track. Fallback defaults to
**Report the error**. **Use librespot before starting the track** permits fallback only
when Soloist readiness fails before a live load begins, including unsupported outputs.
The session's `audioQuality.playbackBackend` reports the renderer actually selected.

Stop, cancellation, output disconnection, server shutdown, sign-out, and backend changes
terminate owned children. Unix shutdown sends TERM, waits two seconds, then kills the
process group if needed. Linux children also receive SIGKILL when their parent dies.
Stale capture directories and WebSocket discovery files are removed under the lease.
The next request creates a new sink after capture failure; audio is not spliced into an
already interrupted stream.

## Pairing, storage, and refresh

Storage follows Ambra's existing roots (`AMBRA_CONFIG_DIR`, `AMBRA_DATA_DIR`, and
`AMBRA_CACHE_DIR` overrides apply):

- Config: `spotify-playback.json`, `soloist/api-key`, and `soloist/session/`.
- Data: versioned `soloist/bin/<sha256>/soloist` and `soloist/session.lock`.
- Cache: `soloist/audio/` (Soloist's bounded 512 MB cache) and temporary `soloist/capture/`.

Normal restarts retain key and pairing. Where Soloist's stored account directory can be
compared with librespot's canonical username, Ambra rejects mismatched or ambiguous
accounts. This is a local stored-session check, not a separate Spotify identity API.
**Reset pairing** removes Soloist's saved session but retains its key. **Sign out Soloist**
removes both and selects librespot. Disconnecting Spotify through Services first records
the deliberate disconnect, then stops Soloist and removes its authentication state.
It follows existing service cleanup rules without deleting native Ambra playlists.

Startup and optional daily checks inspect `soloist --version`, parse the build epoch,
and report refresh due after 76 days and expiration after 90 days. Exit code 10 is also
an expiration error. Checks inspect the installed executable; they do not query or
download a remote release. Automatic downloads remain unsupported until a permitted
distribution method and explicit consent flow are established.

Download a new build from Spotify, pause playback, then use **Install / refresh binary**
or `ambra-server spotify soloist install /absolute/path/to/new/soloist`. Ambra validates
the staged copy, flushes it, moves it into a digest directory, and atomically changes
the configured path. A running playback/pairing process blocks installation. Key and
session directories are separate and survive refresh. Failed validation/save leaves
the old configured executable available. Earlier digest directories remain available
for rollback: select their absolute executable path in local settings. An expired build
cannot be restored to usable playback merely by selecting it.

## Transport and platform limits

`shared/live_pcm.rs` specifies the protocol: magic/version, bounded JSON stream metadata,
then length-prefixed aligned PCM frames (maximum 32 KiB), explicit END, or bounded error.
Timestamps and start position are in metadata; sample counts give subsequent offsets.
The server queue has eight frames (at most 256 KiB of audio); the desktop HTTP reader has
two bounded chunks, followed by the existing bounded audio engine buffers. There is no
disk recording, offline export, fake content length, or byte-range seek. Dropping a body
cancels its producer. A stream allows one consumer and is bound to the selected endpoint;
other paired devices cannot take its audio URL. Host-local access remains trusted under
Ambra's existing policy. Use the existing protected/trusted LAN model; this change does
not add TLS to Ambra's HTTP connections.

Linux capture is implemented for official Soloist Linux CPU targets. The Linux implementation
has **not been exercised on a Linux host or real Soloist account during this change**.
macOS Apple Silicon and Windows x86-64 have binary/version management and pairing code,
but Core Audio process taps and WASAPI application loopback capture are not implemented.
Other Soloist platforms/architectures are rejected. Updated desktop clients implement
the PCM decoder; mobile/browser outputs do not advertise the capability and receive an
unsupported-output error unless pre-start librespot fallback is explicitly selected.

## Automated verification

Run without Spotify credentials:

```sh
cargo test --manifest-path server/Cargo.toml
cargo test --manifest-path server/Cargo.toml --features experimental-soloist-forwarding
cargo clippy --manifest-path server/Cargo.toml --all-targets --features experimental-soloist-forwarding
TAURI_CONFIG='{"bundle":{"externalBin":[]}}' cargo test --manifest-path desktop/src-tauri/Cargo.toml --lib
bun install --cwd mobile --frozen-lockfile
bun test desktop/tests
bun run --cwd desktop build
```

The Tauri override is only for a checkout without a generated bundled server sidecar.
Normal release builds generate that sidecar through the existing build scripts. Native
fixture tests require a C compiler (`cc`). Fixtures simulate version, pairing persistence,
invalid keys, and expiration without Spotify. Mock WebSockets test acknowledgements
separately from asynchronous events. HTTP tests exercise fragmented delivery, precise
PCM conversion, and missing END. Session tests exercise stale reports and history across
pause/resume/seek/skip. None of these prove real Spotify playback or physical isolation.

On Linux, run the ignored synthetic capture smoke test before real-account testing:

```sh
cargo test --manifest-path server/Cargo.toml linux_private_sink_captures_synthetic_pcm_without_hardware -- --ignored --nocapture
```

It creates synthetic PCM, routes `paplay` through the private sink, checks the process
identity/sample format/unity gain, reads nonzero PCM, and tears down the resources.
It does not record Spotify audio or claim original source bit depth.

## Manual Linux integration test (required before claiming working capture)

Use a user-installed supported Soloist build, Premium account, official Spotify app,
and an updated desktop output. Keep the server's speakers muted initially. Do not save
Spotify PCM to a file. Record results and timings as text, never credentials or audio.

1. Run the synthetic test, then start the gated debug server and complete pairing above.
   Restart the server and verify pairing persists. Verify lossless requested and S32LE
   44,100 Hz stereo appear separately from the unknown original source format.
2. Before playback, note host `pactl list short sink-inputs` (and `wpctl status` if the
   host uses PipeWire). During playback, use the capture directory's `native` socket:
   `pactl --server=unix:/absolute/capture/runtime/native --format=json list sinks` and
   `list sink-inputs`. Expect one `ambra` S32LE 2ch 44100Hz sink and one Soloist PID input,
   unmuted at 65536 volume. Inspect `list modules`: no ALSA/hardware sink modules.
   Compare host inputs again: Soloist must be absent. Only after these checks, carefully
   verify the server's physical output remains silent while the selected client plays.
   Stop immediately if routing differs; do not accept a PULSE environment variable alone
   as evidence of isolation.
3. Select a track through Ambra's queue. Measure time from command dispatch to the first
   output report with `isPlaying=true`, `buffering=false`, and advancing `currentTime`.
   Repeat five cold starts and five seeks; record median and maximum startup latency.
   Check captured metadata, not a catalog badge, for the transport format. Source codec
   or bit depth requires independent source evidence, which Soloist's public API lacks.
4. Run for at least thirty minutes. Sample server/desktop RSS (`ps -o rss= -p <pid>`) and
   buffering/position from `/api/session`; record maximum RSS and stall durations.
   Include a track with an intentionally silent intro and outro. Verify silence remains
   content, not a false end. Confirm one queue transition and one existing-rule history
   count per played generation, including after a client reconnect.
5. Exercise pause while buffering, resume, seek while buffering, rapid next/previous,
   selected-output handoff, app close/reopen, and server restart. Verify old stream URLs
   fail and late reports never advance the new track or resurrect paused playback.
   Switch Spotify to Qobuz/Tidal/local content and back; verify no stale Spotify audio.
6. Temporarily interrupt only the server's Internet connection while retaining the LAN.
   Test a short interruption and one longer than thirty seconds. Record recovery delay,
   buffering duration, and visible error. An interruption may fail the stream; an
   explicit play retry must create a new stream at the saved position without another
   history count. No mid-track silent fallback is allowed.
7. Replace the key with an invalid one, reset/re-pair, test a mismatched Spotify account,
   and disconnect Spotify while pairing and while playing. Verify children terminate,
   key/session removal persists after restart, and native Ambra playlists remain intact.
   Test missing PulseAudio, capture-daemon termination, and an expired official build if
   available. Verify specific errors and other providers still work.
8. Pause and install a newer official build. Verify saved pairing/key persist. Try an
   invalid executable and verify the old path remains configured. Inspect status near
   the expiration boundary using automated fixtures; do not change the host's clock.
9. From an unpaired client, status/audio requests must fail. From a paired remote client,
   status succeeds but `/api/local/spotify/...` fails. A different paired output must
   not consume the selected output's live stream. A normal release build with the
   runtime variable set must still report `forwardingEnabled: false`.

Real-account capture, speaker isolation, latency, long-run memory, and network recovery
measurements remain outstanding until this procedure runs on Linux. No verified Spotify
24-bit FLAC source claim is made.

## Change inventory and observed results

New files:

- `server/build.rs`: makes the development gate independent of release debug assertions.
- `server/src/soloist/{mod,binary,config,process,control,prefs,capture,runtime,tests}.rs`:
  configuration, lifecycle, local control, isolated capture, transport producer, and tests.
- `server/tests/fixtures/soloist.c`: native account-free subprocess fixture.
- `shared/live_pcm.rs`: shared framed PCM protocol and validation.
- `desktop/src-tauri/src/native_audio/live.rs`: bounded HTTP reader and PCM decoder.
- `desktop/src/api/spotifyPlayback.ts` and
  `desktop/src/components/SpotifyPlaybackSettings.tsx`: setup and sanitized status.
- `desktop/tests/soloistQuality.test.ts`: prevents capture precision becoming a source claim.
- `docs/spotify-soloist.md`: architecture, setup, limitations, and verification procedure.

Modified files:

- `server/{Cargo.toml,Cargo.lock}` and `server/src/main.rs`: dependencies, experimental
  feature, and module wiring.
- `server/src/{api,access,network,cli,session,endpoints}.rs` and
  `server/src/providers/spotify.rs`: lifecycle wiring, caller identity, setup, account
  identity, live playback dispatch, and generation/history protection.
- `desktop/src-tauri/{Cargo.toml,Cargo.lock}` and
  `desktop/src-tauri/src/{lib,native_audio,remote_endpoint}.rs`, plus
  `native_audio/decoder.rs`: shared protocol, live capability, decoding, and timeouts.
- `desktop/src/components/{ServiceSettings.tsx,SettingsView.css}`,
  `desktop/src/types/music.ts`, and `desktop/src/utils/audioQuality.ts`: existing settings
  integration and accurate requested/captured quality display.
- `docs/cross-device-playback.md`: integration link and distribution boundary.

Observed on Apple Silicon macOS during implementation:

- Server tests: 130 passed in both default and experimental-feature runs. One default
  run hit the existing write-behind benchmark's fixed 400 ms wait during parallel builds;
  the full default suite passed when rerun without that build contention.
- Desktop Rust tests: 29 passed, using the missing-sidecar checkout override above.
- Frontend tests: 31 passed after installing the existing mobile test dependencies.
- TypeScript/Vite production build and server release build passed. The Vite build keeps
  the existing large-chunk warning. Release server with both opt-ins still returned
  `forwardingEnabled: false`, selected librespot by default, and shut down cleanly on SIGTERM.
- The normal desktop build compiled and signed the macOS app, then failed in the DMG
  packaging script. `bun run --cwd desktop tauri build --bundles app` passed separately,
  including rebuilding the server sidecar. No installer was published.
- Server/desktop Clippy completed with existing repository warnings. Newly added Soloist
  modules and shared protocol pass rustfmt. Whole-project formatting checks still report
  existing formatting differences, also reproduced against unmodified HEAD files.
- Diff whitespace and sensitive-file checks passed, including a separate scan of new files.

These are software/fixture results on macOS. The Linux-only smoke test, real-account pairing
and playback, native Windows management, and Linux measurement procedure have not run here.

## References

- [Spotify Soloist documentation](https://developer.spotify.com/documentation/soloist)
- [Authentication](https://developer.spotify.com/documentation/soloist/concepts/authentication)
- [WebSocket API](https://developer.spotify.com/documentation/soloist/reference/websocket-api)
- [Downloads and updates](https://developer.spotify.com/documentation/soloist/reference/downloads-and-updates)
- [Music Assistant Soloist architecture](https://github.com/music-assistant/server/tree/dev/music_assistant/providers/spotify_connect/soloist)
- [Music Assistant provider backend](https://github.com/music-assistant/server/tree/dev/music_assistant/providers/spotify/backends)

Music Assistant is an architectural reference (Apache-2.0). Ambra's Rust integration is
independently written; it does not import Python code. Undocumented Spotify preferences
are isolated in `server/src/soloist/prefs.rs` and limited to tested version families.
