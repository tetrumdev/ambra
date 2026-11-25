# Spotify server implementation report

## Result and outstanding requirement

The independent Ambra Server now automatically requests High through librespot unless
compatible Soloist lossless rendering is available. Soloist remains an isolated renderer;
librespot retains Spotify integration and the existing session retains queue/history authority.

Server-managed downloads, updates, consent, migration, fallback, status, Linux capture, and
native macOS capture are implemented. Windows now uses WASAPI process capture with an
optional signed VB-CABLE driver installed only on the independent server. Runtime checks
require a silent virtual route before Soloist can deliver audio. A missing driver or failed
route retains High. The implementation and cross-target checks do not establish physical
Windows playback; native integration validation remains required.

Normal server builds, including release builds, support Soloist after setup and pairing.
The development-only feature, build-profile gate, and environment opt-in have been removed.
Capture availability, enabled lossless support, a compatible unexpired build, the personal
key, and matching Spotify accounts still determine readiness. No real-account native
playback has been verified.

## Files changed or added

- `server/Cargo.toml`, `server/Cargo.lock`: archive handling and server-only Windows bindings.
- `server/build.rs`, `server/Info.plist`: server-only Core Audio helper and permission metadata.
- `server/src/cli.rs`: consent/setup, automatic policy, and removal of manual controls.
- `server/src/providers/spotify.rs`: automatic High at 160 kbps; existing internal tiers retained.
- `server/src/session.rs`: renderer pinning, controlled recovery, actual quality, and history protection.
- `server/src/soloist/mod.rs`: capability policy, maintenance lifecycle, administration, and status.
- `server/src/soloist/config.rs`: enablement/consent and legacy settings migration.
- `server/src/soloist/binary.rs`: managed lookup without PATH installation; existing identity/version validation retained.
- `server/src/soloist/updater.rs`: direct downloads, validation, ETags, staging, rollback, and diagnostics.
- `server/src/soloist/runtime.rs`: process targeting before native capture and muted native startup.
- `server/src/soloist/capture.rs` moved to `server/src/soloist/capture/linux.rs`: private PulseAudio retained.
- `server/src/soloist/capture/mod.rs`: shared platform interface and private directory handling.
- `server/src/soloist/capture/macos.rs`, `macos.m`: process tap, private aggregate, bounded ring, and conversion.
- `server/src/soloist/capture/windows.rs`, `windows/`: WASAPI capture, exact PCM conversion,
  per-process virtual routing, owned Windows job, and opt-in native tests.
- `server/src/soloist/windows_driver.rs`, `windows_driver/setup.ps1`: optional consented
  direct download, pinned archive, Authenticode verification, and elevated vendor installer.
- `server/src/soloist/tests.rs`, `server/tests/fixtures/soloist.c`: lifecycle, migration, policy, and compatibility fixtures.
- `desktop/src/api/spotifyPlayback.ts`: status-only API; obsolete administration helpers removed.
- `desktop/src/components/SpotifyPlaybackSettings.tsx`: preferred quality and effective renderer display.
- `desktop/tests/serverBoundary.test.ts`: client/server dependency, build-hook, and source regression guards.
- `scripts/check-client-package.py`, `scripts/tests/test_client_package.py`: reject
  server/Soloist and virtual driver components in desktop and mobile distributions.
- `.github/workflows/server.yml`: normal release server tests on Windows, macOS, and Linux.
- `docs/spotify-soloist.md`, `docs/cross-device-playback.md`, `docs/local-clients.md`: current setup, ownership, and limitations.
- `docs/spotify-soloist-implementation.md`: this report.

No desktop/mobile runtime, packaging configuration, dependency, native playback engine,
DSP, or startup lifecycle was changed. No shared protocol change was necessary.

## Automatic policy and lifecycle

Missing, downloading, unpaired, expired, incompatible, or unavailable Soloist selects High.
Ready Soloist selects Lossless where capture is available. A usable installed
build remains available during updates. Existing streams retain their renderer until a safe
boundary. Ordinary lossy playback retains preloading when optional lossless is disabled. Capture/load failure stops the old stream and retries the same session position
through librespot without advancing the queue or adding another history count. A failed
capture remains reported unavailable until a subsequent initialization verifies capture.

Consent is explicit through `ambra-server spotify soloist setup`. There is no client setup
or backend selector. All five official archives were downloaded from Spotify on 2026-10-27
for the compatibility follow-up. Each contains 1.3.10.20, build timestamp 1793102484,
and the six existing managed preference keys. Native macOS `--version` and `--help`
probes passed. The binary evidence does not prove real-account lossless delivery.

The updater checks at startup and approximately daily, starting proactive network checks
at build age 76 days. Expiration is 90 days; exit code 10 requests refresh. Downloads enforce
HTTPS, trusted redirects, size/time bounds, safe extraction, native identity, expiration,
CLI options, and the known `1.3.7.*` and `1.3.10.*` compatibility families. Immutable digest paths and an
atomic current/previous manifest protect active playback and rollback. Credentials and
pairing remain separate. Legacy installation migration never grants network consent.

## Normal server build verification

The default server now includes Soloist playback without a Cargo feature, a special
build profile, or an environment opt-in. The `forwardingEnabled` status field remains
true for client compatibility; lossless enablement and capture/readiness fields still
describe whether Soloist can play.

A regression test first failed under the old default-build gate, then passed after
its removal. It installs a validated native fixture and verifies normal-build quality
selection, account matching, required credentials, disabled lossless support, and
unavailable capture. The default and optimized release server suites each pass with
184 tests and one optional CDN test ignored. Both client boundary tests also pass.
These account-free checks do not establish real Spotify playback or source quality.

## Compatibility follow-up verification

The 1.3.10.20 compatibility fix was reproduced by failing regression tests before the
allowlist changed. Both the default and experimental-feature server suites pass with
184 tests and one opt-in CDN test ignored. That CDN test also passed separately on
Apple Silicon macOS: automatic download, extraction, native identity/CLI validation,
installation, and a forced conditional recheck all completed without account credentials.
Both client boundary tests pass; this follow-up changes no client code or dependencies.

New regression coverage includes strict version families, current build metadata,
tar/ZIP installation and upgrade, automatic preferences, failed-update preservation,
rollback across families, and uninterrupted Librespot playback after installation failure.
An updater lease now explicitly unlocks on drop, preventing a briefly inherited process
descriptor from retaining the lease after maintenance finishes.

## Windows capture follow-up

The driverless investigation checked Spotify's documented Windows output support and
Microsoft's process-loopback and volume APIs. No documented per-process silent render
route was found. Process capture alone does not suppress physical output, while changing
session or physical endpoint volume is unsuitable for isolated lossless forwarding.

The optional server CLI setup now downloads VB-CABLE Pack45 directly from the vendor
only after separate terminal consent. It verifies an exact SHA-256 package hash, safe
bounded extraction, the vendor installer's Authenticode publisher, and the driver catalog
before Windows elevation. The vendor's interactive installer and reboot remain explicit.
The setup restores physical playback/microphone defaults if the installer selects its
cable, configures the dedicated cable's stereo format, and disables Listen monitoring.
No background task, client, remote API, or ordinary playback can install the driver.

For playback, the managed Soloist process starts suspended and at zero volume. A
single-process kill-on-close job prevents orphaned or unverified helper renderers.
Versioned private Windows policy interfaces route only that process to the cable.
WASAPI captures only its process tree. Actual active sessions, stereo format, unity
gain, and silent monitoring state are verified before PCM delivery and during playback.
Overflow, discontinuity, missing routes, unsupported APIs, or activation failure retain
the existing controlled fallback through librespot and the shared session.

The complete Windows server and its tests cross-check with
`cargo check --manifest-path server/Cargo.toml --locked --target x86_64-pc-windows-gnu --tests`.
The normal Windows release executable also builds and links with
`cargo build --manifest-path server/Cargo.toml --locked --release --target x86_64-pc-windows-gnu`.
The updated default and release server suites each pass 189 tests, with one optional
CDN test ignored. Both client source-boundary tests and both distribution-scanner tests
pass. Windows conversion and archive safety tests execute on macOS. A native Windows smoke
test covers suspended routing, exact synthetic stereo PCM, and cleanup without Spotify
credentials; it is opt-in and has not run on this macOS host. No physical speaker silence
or real-account Spotify lossless delivery is claimed from compilation or fixture results.

## Verification performed during the initial implementation

On this Apple Silicon macOS host:

- `cargo build --manifest-path server/Cargo.toml --locked`: independent server build passed.
- `cargo test --manifest-path server/Cargo.toml`: **178 passed**.
- The former experimental-feature suite and release forwarding-gate check passed before the development gate was removed. They are superseded by normal-build readiness coverage.
- Clippy with the former experimental feature passed with repository warnings, including a platform-specific unused error variant.
- `cargo test --manifest-path desktop/src-tauri/Cargo.toml --lib`: **33 passed**.
- `bun run --cwd desktop test`: **83 passed** across the script's isolated test invocations.
- `bun run --cwd mobile test`: **5 passed**.
- `bun run --cwd desktop build`: passed; existing Vite chunk-size warning remains.
- Focused client boundary tests: **2 passed** after final guard expansion.
- Package scanner fixtures: clean desktop/mobile accepted; server and Soloist rejected in both forms.
- Native macOS helper: strict clang compilation and callback tests passed for Float32/Int32, planar/interleaved layouts, alignment, and overflow.
- Windows module: isolated `x86_64-pc-windows-gnu` check and test compilation passed. No Windows executable ran.
- Linux route/format parser tests ran on macOS. Linux hardware-free PulseAudio smoke test did not run.
- Diff whitespace and sensitive-file checks passed.

The full server suite includes account-free Spotify, Qobuz, Tidal, lyrics, recommendations,
playlists, history, authorization, synchronization, and playback-session regressions. Client
suites cover local playback without a server, startup with no/unreachable server, DSP,
stream decoding, queue behavior, and independent server connection flows. These results
do not establish live provider playback or mobile application packaging on native devices.

## Remaining limitations

- Windows requires the optional signed server-only driver, a compatible routing API,
  configured stereo format, and a logged-in Windows audio session. Native playback and
  physical speaker-silence verification remain outstanding.
- Real Spotify account playback, physical isolation/silence, permission prompts, device changes,
  long-duration memory, and native network recovery remain unverified on all platforms.
- macOS requires 14.2+, recording permission, an audio session, and supported native 44,100 Hz stereo audio. Unsupported formats and ring overflow fall back to High.
- Native Windows execution and full Linux server builds were not performed here.
  Full Windows server/test cross-checks are compilation evidence only.
- Soloist 1.3.10.20 is now supported alongside 1.3.7.*. Further families require explicit Ambra compatibility verification; unknown APIs never replace the last compatible build.
- No client installer or mobile package was produced. Archive installation/update tests use account-free native fixtures through tar and ZIP HTTP responses. The opt-in official CDN smoke test installs and rechecks the actual host archive without account credentials.
- Spotify remote PCM distribution permission remains unresolved. Normal builds now support Soloist; this does not establish redistribution or forwarding permission.

Desktop and mobile remain entirely separate from the independently installed server. They
receive streams, display server-reported status, and keep their own local playback/output/DSP.
They never install, download, bundle, launch, host, or capture Soloist or Ambra Server.
