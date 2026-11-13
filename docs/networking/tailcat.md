# Tailcat final fallback

Ambra embeds the real Tailcat implementation as its last connection method. Normal
users install only Ambra. There is no Tailcat CLI, Tailscale account, VPN, daemon,
helper executable, administrative forwarding service, or separate music protocol.

The verified physical combination is a macOS client on school Wi-Fi and a Kubuntu
server on home Wi-Fi. Windows GNU networking builds, but Windows runtime and MSVC
release packaging remain unverified. iOS and Android share the native-library
build path; their SDK builds remain blocked in this environment. This is not a
claim that every release platform has passed acceptance.

## Selection and authorization

The existing native race is preserved:

1. LAN and router-forwarded public TCP start together.
2. HyperDHT and Nostr TCP punching start after the existing 250 ms LAN grace.
3. Optional pwnat starts only after those attempts fail or time out, when available.
4. Tailcat starts only after that entire race and eligible pwnat attempt finish.

Each candidate must finish pinned Noise authentication before winning. Device
bearer authorization then runs once on the selected encrypted HTTP/2 connection.
A failed authorization does not start another transport. Explicit peer identity
rejections also stop selection, including cached addresses, standby promotion,
and background upgrades. Pairing over Tailcat is deliberately unavailable: only
previously paired devices can discover or enter this listener.

Native budgets remain LAN 3 s, public TCP 8 s, HyperDHT 75 s, TCP punching 65 s,
and optional pwnat 8 s. Tailcat has a 90 s outer budget, bounded discovery/dial
operations, and the existing 15 s device-authorization budget. A restrictive
network can therefore wait through the full native discovery window before
Tailcat starts. Failure returns through the existing offline/retry machinery.
Concurrent requests share the existing connection flight and HTTP/2 session.
Failed shared HyperDHT bootstrap actors and pwnat engines are retired before the
Tailcat client starts. Cryptographic Noise rejections are terminal; ordinary I/O
loss remains eligible for fallback.

## Native integration and lifetime

`crates/ambra-net/tailcat/go.mod` pins
`github.com/tailscale/tailcat v0.7.1-0.20261105151022-e00cdde6ff78`
(commit `e00cdde6ff787f801361ff85ed085775c775d4c5`). `go.sum` locks the
module graph. The upstream ABI is version 1. Ambra builds `cmd/libtailcat` with
the upstream omission tags, `-trimpath`, and `-mod=readonly`, then statically
links the Go archive into Rust on desktop/server and iOS. Android uses Go
`c-shared` because Go does not support `c-archive` there; the mobile build script
bundles `libambra_tailcat.so` beside the Rust bridge for each ABI. Android
loads that library through the Rust bridge's normal native dependency. Dependency license is retained beside the module.

`tailcat/native.rs` owns opaque ABI handles, allocation/free rules, deadlines,
and cancellation. Network calls and closure run on Tokio blocking workers.
Dropping an awaiting Rust future cancels its native token without freeing a
worker's buffers. Native connection closure interrupts both directions. Two
bounded 32 KiB transfer workers connect the native stream to a 64 KiB Rust duplex;
the existing Noise adapter and HTTP/2 flow control provide backpressure. This
adds bounded per-connection buffering and blocking workers, not full-file copies.
There is one engine per application connection, not per HTTP request.

Only Tailcat TCP port 38149 is registered in the userspace stack. Incoming streams
must pass Ambra's signed admission knock, replay checks, and Noise peer identity
binding. They dispatch through `transport::serve` with trusted `RemotePeer`, then
the normal server authorization middleware. Arbitrary ports and subnet forwarding
are not enabled. Existing audio uploads, streaming responses, ranges, APIs, device
tokens, and revocation remain the same handlers.

The server starts this listener asynchronously whenever remote networking and
Tailcat are enabled. It runs independently of HyperDHT bootstrap. Configuration
changes and shutdown cancel and join owned listeners. Unexpected termination uses
the existing supervisor's bounded 1–30 s backoff. No child process can be orphaned.

## Persistent identity and secure discovery

The server stores independently generated WireGuard private and pre-shared keys
in its data directory, `tailcat-identity.json`. They are separate from Ed25519 and
derived Nostr keys. Creation is exclusive, writes are synced, Unix files are
0600, and existing files must be regular protected files. Corrupt, missing-field,
or empty saved identities fail closed rather than silently rotating. Windows
storage relies on the application's user-directory ACL, as existing identities do.

The full Tailcat address includes a bearer-secret pre-shared key. It is never
placed in pairing QR codes, public server information, DNS, public Nostr bindings,
or network-status output. Its Rust `Debug` implementation is redacted. ABI error
strings are discarded in favor of sanitized status codes.

Two discovery paths exist:

- An authorized `/api/network/session` reply includes `tailcatAddress`. Clients
  save it in a separate 0600 `*.tailcat.json` sidecar beside the endpoint cache.
  The cache includes the pinned Ambra server key; another server's cache is ignored.
- An already paired client without usable cache sends `TailcatRequest` through
  existing Nostr signaling. `TailcatAddress` replies are NIP-44 encrypted and
  Ed25519 signed for that recipient. Existing binding verification, expiry,
  replay protection, fresh session IDs, sender/recipient checks, and paired-key
  admission apply. Responses are rate limited. The client matches the server's
  pinned identity, Nostr author, session, and attempt before using the address.

A failed cached tunnel can rediscover without repeating native selection. A
Noise identity failure cannot take that recovery path. Rotating the isolated
Tailcat key file is an explicit administrative operation; cached old addresses
then fail and authenticated discovery supplies the replacement. Never delete a
production identity merely to troubleshoot connectivity.

Revoked devices receive no discovery reply and fail signed admission on a cached
address. Existing middleware also checks current token/key authorization for
every protected request and closes revoked authorized sessions. WireGuard node
keys are currently ephemeral client keys; there is no additional device-to-
WireGuard allowlist. Possessing an old address can still reach the WireGuard
layer, but cannot authorize an Ambra device or access protected functionality.

## Path diagnostics and native recovery

`/api/local/network` reports sanitized Tailcat running/error status and whether
Tailcat is enabled. Native transports retain `nativeDataRelay: false`; Tailcat is
reported separately as relay capable. Client status reports `Tailcat`, its observed
`direct`, `derp`, or `unknown` path, and discovery-ping RTT. Unknown never means
direct. Direct diagnostics include the observed socket endpoint; DERP diagnostics
include the region number. Status is refreshed every 15 s while the connection
exists. Desktop settings distinguish these paths.

Tailcat uses DERP to bootstrap and attempts direct UDP automatically. A successful
HTTP request proves neither a direct path nor freedom from an installed VPN.
Physical evidence must inspect the path and operating-system routing. Tailcat's
upstream endpoint collection excludes Tailscale interface addresses; the physical
probe additionally rejects non-public direct peers and checks the Mac's route.
No direct Tailcat upgrade was observed during the recorded 45-second school test.

The existing maintenance loop checks LAN every 30 s and on network changes.
While on Tailcat, broader native probes run at most once per 120 s, with 12 s
background HyperDHT/TCP budgets. A replacement must finish Noise and device
authorization before installation. New requests then use it; existing responses
retain the existing 30 s retirement window. Diagnostics hold only a weak engine
reference, so retaining an old status/connection handle cannot retain its engine
after transport retirement. No ambiguous application request is replayed.

## Configuration and builds

Tailcat defaults to enabled when `p2p` remote networking is enabled. Disable only
this method with `ambra-server network tailcat off`; enable it with `on`.
Set `tailcatDerpMapUrl` in protected server configuration, or the existing local
configuration endpoint, to an HTTPS DERP-map URL for a custom relay environment.
The default uses Tailcat's public map without operator configuration. The chosen
relay details are embedded in the encrypted address, so clients need no separate
map configuration.

Public DERP is shared, rate limited, and has no sustained-throughput guarantee.
The recorded public-relay runs are bounded functional audio transfers. They do
not establish a relay capacity or concurrent-listener service guarantee. Sustained
benchmarks require a private relay; no public relay service was deployed here.

Build prerequisites are Rust, Go 1.27.4, and a target C compiler. Desktop/server
archives are included by Cargo automatically, including normal release builds.
CI installs the pinned Go toolchain. Windows cgo requires MinGW-w64; MSVC release
linking still needs validation on Windows. Android requires cargo-ndk and the NDK;
iOS requires full Xcode and its device/simulator SDKs. The existing mobile script
builds the same Rust/Go transport into Android libraries and the iOS XCFramework.
The podspec includes the required Apple frameworks. Neither mobile SDK build ran
successfully on this machine, so native mobile operation is unverified.

## Tests, reproduction, and limits

Run `cargo test --locked --manifest-path crates/ambra-net/Cargo.toml`. Its private
DERP fixture builds from the pinned Go module and uses loopback listeners only.
Tailcat tests disable public Nostr discovery; real Tailcat, Noise, HTTP/2, exact
streaming bytes, ranges, authorization denial, persistent key storage, cancellation,
native replacement, draining, and engine retirement are tested. Mock selection
tests cover every native winner, unavailable pwnat, exhaustion, and terminal
identity errors. Existing pairing/revocation and bridge tests remain in place.

The physical benchmark uses the existing `tcp_punch_probe` with an enrolled
private profile. The `tailcat` mode sets earlier native budgets to zero only in
that diagnostic binary. `roam` starts with those same constraints, then the normal
maintenance loop tests native paths using its background budgets. It holds an
actual FLAC response across the replacement. Production defaults do not change.

```sh
cargo build --locked --manifest-path server/Cargo.toml
cargo build --locked --manifest-path crates/ambra-net/Cargo.toml --example tcp_punch_probe
python3 scripts/benchmark-tailcat.py --probe /absolute/tcp_punch_probe \
  --profile /private/enrolled-profile --server-key PUBLIC_AMBRA_KEY \
  --audio /private/music-excerpt.flac --mode native --physical --output native.json
# Repeat with --mode tailcat or --mode roam.
# AMBRA_BENCH_IDLE_SECONDS=45 observes path discovery before audio transfer.
# TS_DEBUG_NEVER_DIRECT_UDP=true TS_DEBUG_ALWAYS_USE_DERP=true forces a DERP test.
```

Use the existing TCP/443 launcher documented in [Nostr TCP P2P](nostr-tcp-p2p.md)
for the isolated home server when required. Keep test config/data/cache separate,
disable test router mapping, enroll through the real approval flow, and restore
the operator's original processes and network state afterward. SSH is for process
control and socket inspection; it must not forward benchmark application traffic.

Sanitized physical reports and acceptance gaps are in
[the results directory](results/tailcat-2026-11-13/). HTTP byte validation is not
audible playback validation. Direct Tailcat, physical mobile roaming, Windows
runtime, long-duration private-DERP throughput, and arbitrary network interruptions
remain distinct from the demonstrated results.
