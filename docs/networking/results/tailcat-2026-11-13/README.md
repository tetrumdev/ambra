# Tailcat physical validation — November 13, 2026

The school MacBook and home Kubuntu laptop ran production Ambra networking,
real server approval/token authorization, Noise, HTTP/2, uploads, concurrent API
requests, and exact FLAC transfers. This directory contains sanitized evidence.
Raw logs, addresses containing pre-shared keys, credentials, and audio are excluded.

## Implementation and security

See [the architecture](../../tailcat.md) for the pinned Tailcat C ABI, bounded
Rust adapter, persistent protected WireGuard identity, encrypted Nostr discovery,
native-only initial races, listener supervision, and authenticated native upgrades.
The implementation source commit is `c74115f`, following `1daeb30`, `0f618f5`,
`bd17295`, and `7f9af02`. Subsequent evidence/diagnostic changes do not change the
production transport. Both repositories use `feat/tailcat-final-fallback`; no PR
or remote push was required.

Native selection tests cover each successful LAN/public/TCP-punch/HyperDHT/pwnat
candidate preventing Tailcat. The final physical smoke records all four earlier
native attempts timing out or failing before Tailcat; pwnat is unavailable on
this Mac and skipped. Timed-out shared native engines are retired before creating
the Tailcat client. Cryptographic rejection and device authorization failure stop
selection, including standby and upgrade paths.

Server keys and pre-shared keys persist independently of Ambra identity keys.
Restart preserves them; intentional test-only rotation changes them, causing the
old cache to fail before encrypted, pinned discovery recovers. Invalid bearer
credentials and revoked devices fail against the real server. The WireGuard layer
does not currently bind its ephemeral client keys to a device allowlist; the
signed knock, Noise identity, and per-request device authorization remain required.

## Physical path and performance

The client route uses `en0`; the server uses `wlo1`. WARP stays disconnected and
neither machine selects a Tailscale exit node. Native probes contain no Tailscale
or LAN endpoint hints, verify public authenticated TCP peers, and sample sockets.
Tailscale SSH carries orchestration commands and socket diagnostics. Separate
management-overlay Noise enrollment sessions bootstrap/re-enroll isolated test
credentials; enrollment is excluded from all measured connectivity/performance
results. Every measured API/audio request uses native public TCP or Tailcat DERP.
See [path verification](network-path-verification.json) and individual reports.

The three dedicated native TCP runs authenticate in 3.540, 6.512, and 3.754 seconds.
Tailcat never starts in these runs. The first two run during remaining compilation;
the last runs with the home host idle. They verify 241,764,556 downloaded audio
bytes, plus uploads, ranges, and concurrent controls.

The first three bounded DERP transfers authenticate in 1.527, 0.759, and 0.720
seconds after diagnostic native budgets are set to zero. These durations exclude
the normal production native timeout window and are not a reason to prefer Tailcat.
All three use DERP region 1. The 45-second observation never shows direct UDP.

| Method | Dedicated connection checks | Download rate | RTT / responsiveness | Exact lossless bytes |
| --- | --- | --- | --- | --- |
| Native Nostr TCP | 3/3 | 4.663–5.312 MiB/s | Server TCP RTT samples 9.673–49.913 ms; API samples in reports | Verified |
| HyperDHT | Bootstrap fails; 516 bytes sent, zero received | Unavailable | Fresh UDP STUN works; DHT bootstrap/pings do not | No transfer |
| Pwnat | Client raw-ICMP capability unavailable; skipped | Unavailable | Unavailable | No transfer |
| Tailcat direct | No upgrade observed in 45 seconds | Unavailable | Unavailable | No direct-path claim |
| Tailcat DERP | 7 authenticated audio runs; controlled failures reported separately | 0.415–2.409 MiB/s in bounded runs | Measured discovery RTT and API latency appear in recovery/smoke reports | Verified |

The chart in [benchmark-rates.html](benchmark-rates.html) uses all three native
and seven bounded DERP audio runs. Individual recovery and smoke tests are
separately reported.
The sample size is not a general NAT success-rate estimate.

The test audio is a 10-second, 5,494,649-byte lossless excerpt of existing music,
not random bytes or synthetic silence. Its whole-file average is about
0.524 MiB/s, including container/metadata payload; that is not a steady audio
bitrate. Source metadata is 24-bit/44.1 kHz stereo, with an uncompressed PCM
ceiling of about 0.252 MiB/s. Observed rates exceed that PCM rate, but these
short file transfers do **not** establish reliable sustained playback or capacity
for higher sample rates. Initial burst rates must not be mistaken for sustained relay capacity.
No private cross-network DERP service was available, and no public relay service
was deployed. Public-relay tests remain bounded functional transfers, including
one deliberately paced drain test, rather than sustained saturation benchmarks.

API samples measure application round trips, including server work. Kernel TCP
RTT and Tailcat discovery RTT use different mechanisms and are labeled separately.
Under-load API samples sometimes exceed one second on DERP; complete samples are
retained rather than summarized as uniformly responsive. These tests validate
HTTP transport; physical audible playback remains unverified.

## Recovery and correctness evidence

- [Native baseline](native.json) and [idle-host run](native-idle-host.json): direct TCP,
  repeated reconnects, exact audio, concurrent controls, and no Tailcat activation.
- [Fresh discovery](tailcat-fresh-discovery.json): deleted secret cache, encrypted
  Nostr discovery, authenticated DERP HTTP/2 and FLAC delivery.
- [Forced DERP](tailcat-forced-derp.json): process-local upstream diagnostic knobs
  disable direct UDP; no firewall or school infrastructure change.
- [Path observation](tailcat-path-observation.json): DERP remains selected through
  45 seconds; direct establishment time is unavailable.
- [Restart and upgrade](restart-and-native-upgrade.json): cached address works
  after restart, then production maintenance authenticates native TCP.
- [In-flight upgrade](in-flight-native-upgrade.json): a paced 5,494,649-byte FLAC
  response remains exact while the selected method changes from Tailcat to TCP.
- [Offline bounds](offline-bounded.json) and [same-manager recovery](toggle-recovery.json):
  failed attempts finish; restoring the listener allows the next round to connect.
- [Identity lifecycle](identity-lifecycle.json) and [rotation](key-rotation.json):
  restart preserves identity; rotation invalidates old cache and discovery recovers.
- [Invalid credential](invalid-credential.json) and [revocation](revoked-device.json):
  expected denial, with no protected authenticated session.
- [Final source smoke](final-source-smoke.json): final production source, real
  re-enrollment, exact FLAC transfer, and exhausted native attempts before Tailcat.
- [Middle/suffix seeks](middle-and-suffix-seeks.json): exact middle-file and suffix
  HTTP ranges, in addition to the normal early range checks.
- [Idle resources](idle-server.json): short whole-server samples with all native
  listeners enabled; this is not a long-duration CPU or leak guarantee.

The local private-DERP tests additionally exercise real Tailcat with no public
Nostr dependency, invalid credentials, revocation, malformed addresses, protected
storage, canceled bootstrap with a dead relay, shutdown, and engine retirement.
Existing tests cover network interruption, single-flight requests, streaming,
pairing, bridges, and no mutation replay. Those tests are local/simulated evidence,
not physical roaming between Wi-Fi networks.

## Builds and remaining acceptance gates

[validation.json](validation.json) records the complete matrix. macOS server and
desktop build; their final suites pass 241 and 69 tests respectively. Shared
networking passes 81 tests on macOS and 59 library tests on Kubuntu. Mobile host
tests pass. Go native/ABI tests and module checksum verification pass.

Android ARM64, ARMv7, and x86-64 release libraries build using NDK r27c, API 24,
and cargo-ndk 4.1.2. Both native libraries are bundled per ABI, ELF dependencies
and C ABI exports verify, and 64-bit LOAD segments align to at least 16 KiB.
See [Android packaging](android-packaging.json). No Android device or APK runtime
test is claimed. Windows GNU networking cross-builds; Windows app/server runtime
and MSVC release packaging remain unverified. Full Xcode is unavailable, so iOS
device/simulator builds remain blocked. See [macOS packaging](packaging.json).

The Kubuntu full server suite passes 238 tests with one failure and two ignored.
The failure is the unchanged write-behind benchmark reading a file after a fixed
400 ms sleep. The same original source fails in a standalone crate containing
only serde/JSON/Tokio, without Ambra networking or Go. Initial fixture permission
failures resolve with process umask 077; authentication checks were not relaxed.
See [baseline evidence](preexisting-linux-benchmark.json). That unrelated timing
failure remains a full-suite gate.

Remaining gaps: iOS builds, Windows runtime/MSVC packaging, physical mobile
operation, actual Wi-Fi handoff, audible playback, and sustained private-DERP
throughput. The implementation improves fallback connectivity, but these gaps
prevent an all-platform production-readiness claim.

## Reproduction and cleanup

Use the commands in [the architecture document](../../tailcat.md) and
`scripts/benchmark-tailcat.py` with an approved private probe profile. The scripts
use actual application requests and collect administrative socket evidence.
Normal production native timeout defaults remain intact.

Test servers use separate config/data/cache directories and disable router
mapping. Original production server, identities, repositories, SSH arrangement,
and network settings remain intact. Temporary credentials, audio excerpts, raw
logs, test profiles, private relay processes, and task-owned intermediate build
caches are removed after evidence collection. Necessary Go/NDK/cargo-ndk build
dependencies and packaged Android libraries remain available.
