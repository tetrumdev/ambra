# Spotify playback on the independent Ambra Server

Ambra Server owns Spotify authentication, catalog, library, playlists, availability,
Connect integration, and lossy playback through librespot. Ambra's session controller
owns the queue, position, history, and track transitions. Optional Soloist renders only
the selected track with `--single-track`; its events verify rendering and never own the queue.

Desktop and mobile remain independent clients. Neither client bundles, starts, hosts,
installs, or updates Ambra Server or Soloist. Local music continues without a server.
Install and start [Ambra Server separately](cross-device-playback.md), then connect clients.
Spotify administration is available only on the server machine through its CLI/local API.
Paired remote clients receive sanitized status and existing server streams.

## Automatic quality

After `ambra-server login spotify`, playback requests **High** through librespot
(160 kbps preferred). No Soloist executable, API key, pairing, or consent is required.
The legacy `AMBRA_SPOTIFY_QUALITY` override no longer controls this automatic policy.
Existing internal lossy tiers remain available to other callers.

Lossless becomes preferred automatically when lossless support is enabled, a compatible
unexpired binary is installed, the key and matching paired Spotify account are present,
the capture backend is available, and the development forwarding gate permits playback.
Installing, downloading, unpaired, expired, incompatible, or failed capture states use High.
A valid existing build remains usable while its replacement downloads.

The renderer stays pinned during an active stream. Capability improvements apply at the
next track or playback initialization boundary, including seek, resume, and output restart.
Outputs without live PCM support use librespot. While optional lossless is enabled,
Spotify tracks are not speculatively preloaded, so the server can select quality at each
track boundary. Ordinary playback retains preloading when lossless support is disabled.

A live load or capture failure stops the old renderer and retries through the existing
session using librespot and the saved position. This preserves the generation, queue,
and history count. The server never splices a second renderer into the existing PCM body.
The next track can use Soloist again after capability recovers. Capability is rechecked
approximately every 30 seconds; network maintenance has its own daily limit. A failed
capture keeps the reported preference at High until a subsequent initialization verifies
capture successfully. A binary inspection alone cannot restore the Lossless claim.

`GET /api/spotify/playback/status` exposes `preferredQuality`, `effectiveRenderer`, and
`effectiveQuality`. The legacy `backend` field now describes the preferred renderer,
not a user setting. `effectiveRenderer` is null when no Spotify output is selected.
The session's `audioQuality` reports the actual renderer and requested quality.
Captured S32LE PCM does **not** prove Spotify delivered 24-bit or even lossless source audio;
`sourceFormatVerified` remains false.

## Optional server setup and consent

Run these commands in a terminal on the independently running server:

```sh
ambra-server login spotify
ambra-server spotify soloist setup
ambra-server spotify status
ambra-server spotify soloist key
ambra-server spotify soloist pair
```

`setup` explains direct downloads and automatic maintenance, links Spotify's conditions,
and requests explicit consent. Declining leaves ordinary High playback available. After
consent, installation runs in the background. Enter your personal key through the hidden
prompt; `key` also supports entering it later. Once status shows installation complete,
run `pair`. Open the official Spotify application on the same network, using the same
Spotify account, and select **Ambra Soloist Pairing**. Pairing has a five-minute deadline.
No backend or quality switch follows pairing.

Other commands:

```sh
ambra-server spotify soloist check       # Inspect current capability and maintenance state
ambra-server spotify soloist reset       # Remove pairing; retain personal key
ambra-server spotify soloist sign-out    # Remove pairing/key; disable optional lossless
ambra-server spotify soloist disable     # Disable lossless and revoke future download consent
```

There is no manual executable path, install, refresh, quality, or backend command/API.
Legacy settings import the configured executable into managed storage when validation
succeeds. The original executable remains untouched. Old backend selection migrates to
lossless enablement, but **never** grants download consent. Keys, sessions, playlists,
and listening history remain in their existing stores. Failed imports retain their
migration path and diagnostic for retry. A compatible previous managed build can be
restored automatically; expired builds cannot become usable through rollback.

## Binary lifecycle and security

The server downloads only from Spotify's official HTTPS CDN, after consent. Current
archives are `soloist_release_x86_64.tar.gz`, `soloist_release_arm64.tar.gz`, and
`soloist_release_arm32.tar.gz` for Linux, `soloist_release_osx_arm64.tar.gz` for macOS,
and `soloist_release_windows_x86_64.zip` for Windows. On 2026-10-27, all five downloaded
archives contained **1.3.10.20**, build timestamp **1793102484**. The native macOS executable
reported `soloist 1.3.10.20 build 1793102484 (20261027) (g19412df6ea) (macos/aarch64)`.
Its `--help` retains Ambra's required options, including `--initial-volume`. All five
executables retain the six managed audio preference keys. This is binary/CLI evidence;
it does not establish real-account lossless delivery. No executable is bundled in Ambra
artifacts or mirrored by Ambra.

Startup inspects the installed build. Network checks start at build age 76 days and
repeat approximately every 24 hours. Builds expire at 90 days; exit code 10 also requests
an immediate refresh attempt. Conditional ETag requests avoid repeated downloads.
Failed attempts are throttled, persisted, and reported without replacing a usable build.

Installation uses a separate cross-process update lease, private staging directories,
bounded HTTPS requests, trusted redirects restricted to the official CDN host, and
128 MiB compressed/256 MiB expanded limits. Extraction rejects traversal, absolute paths,
symlinks, hard links, special entries, duplicate executables, oversized metadata, and
unsupported archive extensions. It validates native CPU/executable identity before running
bounded `--version` and `--help` probes. Unknown preference/API families fail closed.

The compatibility contract accepts the known Soloist **1.3.7.*** and **1.3.10.*** families
and required CLI options. The current 1.3.10.20 build uses the same preference keys as
the original 1.3.7 integration. Versions must have four numeric components. Unknown
families and changed CLI options fail closed before promotion. New patch builds within
these families may install automatically. A new family requires Ambra compatibility
verification; the last compatible build remains installed if validation fails.
The WebSocket parser also rejects failed authentication, mismatched tracks, and missing
playback confirmations at runtime.

Validated binaries live at `soloist/bin/<sha256>/soloist[.exe]` under the server data root.
An atomic `managed.json` pointer retains current and previous versions. Running renderers
keep their immutable binary path; updates never stop them. Failed validation or promotion
preserves the old pointer. Interrupted staging is cleaned under the update lease.

`spotify-playback.json`, `soloist/api-key`, and `soloist/session/` use the server config
root. Audio/cache and private capture use the server cache root. Existing `AMBRA_CONFIG_DIR`,
`AMBRA_DATA_DIR`, and `AMBRA_CACHE_DIR` overrides apply. Unix files/directories are private;
Windows uses the user's application-data ACLs. Credentials are separate from binaries.
The key is never serialized into status or logs. Soloist requires the key in process
arguments, so same-user process inspection can see it; Ambra never logs those arguments.

## Capture and transport coverage

Linux retains its private PulseAudio daemon, isolated sink/FIFO, verified Soloist PID,
unity gain, S32LE stereo at 44,100 Hz, bounded transport, and cleanup. The private daemon
loads no physical audio modules. Soloist receives private PulseAudio and disabled host
PipeWire routing variables; stream startup verifies the actual sink input. PipeWire hosts
still need classic `pulseaudio` and `pactl` installed. Short paths without whitespace are
required for PulseAudio module/socket arguments. No physical audio hardware is required.

macOS Apple Silicon uses Core Audio process taps on macOS 14.2 or newer. A process-specific
`CATapDescription` with `CATapMuted` suppresses physical output while preserving tap audio.
Soloist starts at volume zero; the server installs the tap before requesting unity volume.
A private aggregate device and lightweight I/O callback feed a bounded atomic ring.
Native Float32 or Int32 converts to the existing S32LE stereo transport. Unsupported rates
fail rather than silently resample. The server embeds its audio recording usage description;
grant system audio recording permission to the server's launching application when prompted.
Missing permission, headless audio sessions, device changes, or overflow cause controlled fallback.
Core Audio cannot pause the renderer through a tap; bounded overflow fails without dropping samples.

Windows x86-64 includes native WASAPI process-tree loopback using
`ActivateAudioInterfaceAsync`, `AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK`,
`PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE`, `IAudioClient`, and `IAudioCaptureClient`.
The implementation negotiates Float32 stereo at 44,100 Hz, converts to S32LE, bounds its
queue, and cleans up COM resources. It requires Windows build 20348 or newer and an audio session.
**Windows lossless remains disabled:** process loopback does not suppress physical rendering,
and Soloist exposes no supported silent WASAPI output route. Session muting cannot be assumed
to preserve captured PCM; muting the global endpoint would affect unrelated audio. The server
fails before launching Soloist and uses High. This is an unresolved platform requirement.
No third-party virtual drivers or global audio changes are introduced.

All capture implementations remain under `server/src/soloist/capture/`. The shared interface
covers initialization, process targeting, route verification, bounded reads, cancellation,
and cleanup. The framed PCM protocol remains unchanged: S32LE 44,100 Hz stereo, bounded
32 KiB frames, explicit END/error, one authorized output consumer, no range seeking or recording.
Other client outputs retain their existing lossy transport. Client volume and DSP remain local.

## Distribution and forwarding restrictions

Spotify's downloads page prohibits redistributing Soloist archives/binaries. Ambra instead
links the official page and performs an administrator-consented direct download from Spotify.
This does not establish permission to forward Spotify PCM to remote clients. Review the
[Developer Terms](https://developer.spotify.com/terms) and
[Developer Policy](https://developer.spotify.com/policy) before distribution or commercial use.

The existing forwarding gate remains intact. Distributable/release builds always use High
through librespot. Only a debug development server built with
`--features experimental-soloist-forwarding` **and** started with
`AMBRA_EXPERIMENTAL_SOLOIST_FORWARDING=1` can attempt Soloist forwarding. Neither consent
nor a client setting bypasses this gate. The restriction does not disable librespot,
Qobuz, Tidal, local music, catalog access, or other server features.

## Verification

Account-free tests cover automatic quality, stream pinning, controlled fallback, history,
consent/migration, archive validation, expiry/exit 10, compatibility, rollback, process
ownership, authorization, and bounded PCM. Native macOS callback tests cover conversion,
channel layouts, alignment, and overflow. Windows code is cross-checked for compilation;
this is not a Windows playback test. Linux parser tests also run on macOS.

```sh
cargo test --manifest-path server/Cargo.toml
cargo test --manifest-path server/Cargo.toml --features experimental-soloist-forwarding
cargo test --manifest-path desktop/src-tauri/Cargo.toml --lib
bun run --cwd desktop test
bun run --cwd mobile test
bun run --cwd desktop build
```

Client source/build regression guards live in `desktop/tests/serverBoundary.test.ts`.
`scripts/check-client-package.py` inspects desktop bundles/installers and mobile APK/AAB/IPA
contents for server/Soloist executables. Release CI runs the desktop package check and
builds the standalone server separately.

The download pipeline tests install and upgrade native fixtures through both tar and ZIP
responses, configure global/per-user preferences, preserve credentials and the previous
build, and reject unknown versions, missing startup controls, expired builds, and downgrades.
A separate opt-in smoke test exercises the official CDN without credentials or pairing:

```sh
cargo test --manifest-path server/Cargo.toml official_cdn_installs_and_rechecks_without_credentials -- --ignored
```

The ignored Linux synthetic test requires PulseAudio tools and a Linux host:

```sh
cargo test --manifest-path server/Cargo.toml linux_private_sink_captures_synthetic_pcm_without_hardware -- --ignored --nocapture
```

Real-account playback, physical speaker silence, unrelated-audio isolation, long-run memory,
permission prompts, device changes, and network recovery require native integration tests.
Do not claim those tests passed from fixture or compilation results. No native Spotify
playback has been physically verified during this implementation.

References: [Spotify Soloist](https://developer.spotify.com/documentation/soloist),
[downloads](https://developer.spotify.com/documentation/soloist/reference/downloads-and-updates),
[CLI](https://developer.spotify.com/documentation/soloist/reference/command-line),
[Music Assistant](https://github.com/music-assistant/server/tree/dev/music_assistant/providers/spotify_connect/soloist),
[private PulseAudio reference](https://github.com/music-assistant/server/blob/dev/music_assistant/helpers/pulse_capture.py),
[Microsoft process loopback sample](https://learn.microsoft.com/en-us/samples/microsoft/windows-classic-samples/applicationloopbackaudio-sample/),
[Apple process taps](https://developer.apple.com/documentation/coreaudio/capturing-system-audio-with-core-audio-taps).
