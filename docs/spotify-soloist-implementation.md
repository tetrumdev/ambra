# Spotify server implementation report

## Result and outstanding requirement

The independent Ambra Server now automatically requests High through librespot unless
compatible Soloist lossless rendering is available. Soloist remains an isolated renderer;
librespot retains Spotify integration and the existing session retains queue/history authority.

Server-managed downloads, updates, consent, migration, fallback, status, Linux capture, and
native macOS capture are implemented. Native Windows process-loopback code is implemented
and cross-target checked, but **Windows lossless remains disabled**. Safe physical speaker
suppression has not been established with Soloist's supported Windows interface. The guard
returns High before launching Soloist. This means the full requested Windows playback
requirement is not complete; this report does not claim complete cross-platform playback.

The release forwarding restriction remains intact on every platform. Release builds continue
through librespot even after Soloist setup. No real-account native playback has been verified.

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
- `server/src/soloist/capture/windows.rs`: guarded WASAPI process-tree capture and conversion.
- `server/src/soloist/tests.rs`, `server/tests/fixtures/soloist.c`: lifecycle, migration, policy, and compatibility fixtures.
- `desktop/src/api/spotifyPlayback.ts`: status-only API; obsolete administration helpers removed.
- `desktop/src/components/SpotifyPlaybackSettings.tsx`: preferred quality and effective renderer display.
- `desktop/tests/serverBoundary.test.ts`: client/server dependency, build-hook, and source regression guards.
- `scripts/check-client-package.py`: rejects server/Soloist in desktop and mobile distributions.
- `docs/spotify-soloist.md`, `docs/cross-device-playback.md`, `docs/local-clients.md`: current setup, ownership, and limitations.
- `docs/spotify-soloist-implementation.md`: this report.

No desktop/mobile runtime, packaging configuration, dependency, native playback engine,
DSP, or startup lifecycle was changed. No shared protocol change was necessary.

## Automatic policy and lifecycle

Missing, downloading, unpaired, expired, incompatible, or unavailable Soloist selects High.
Ready Soloist selects Lossless where capture and forwarding are allowed. A usable installed
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

## Verification performed during the initial implementation

On this Apple Silicon macOS host:

- `cargo build --manifest-path server/Cargo.toml --locked`: independent server build passed.
- `cargo test --manifest-path server/Cargo.toml`: **178 passed**.
- Same full server suite with `--features experimental-soloist-forwarding`: **178 passed**.
- Release forwarding-gate test with the experimental feature: passed; runtime opt-in also cannot enable release forwarding.
- `cargo clippy --manifest-path server/Cargo.toml --all-targets --features experimental-soloist-forwarding`: passed with repository warnings, including a platform-specific unused error variant.
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

- Windows speaker suppression remains unresolved; Windows lossless is disabled.
- Real Spotify account playback, physical isolation/silence, permission prompts, device changes,
  long-duration memory, and native network recovery remain unverified on all platforms.
- macOS requires 14.2+, recording permission, an audio session, and supported native 44,100 Hz stereo audio. Unsupported formats and ring overflow fall back to High.
- Native Windows and full Linux server builds were not executed here. Windows module checks are narrower than a full server build.
- Soloist 1.3.10.20 is now supported alongside 1.3.7.*. Further families require explicit Ambra compatibility verification; unknown APIs never replace the last compatible build.
- No client installer or mobile package was produced. Archive installation/update tests use account-free native fixtures through tar and ZIP HTTP responses. The opt-in official CDN smoke test installs and rechecks the actual host archive without account credentials.
- Spotify remote PCM distribution permission remains unresolved. Release gates stay enforced, without disabling ordinary Spotify or other providers.

Desktop and mobile remain entirely separate from the independently installed server. They
receive streams, display server-reported status, and keep their own local playback/output/DSP.
They never install, download, bundle, launch, host, or capture Soloist or Ambra Server.
