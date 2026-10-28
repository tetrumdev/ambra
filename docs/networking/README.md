# Native networking: implementation and validation report

**Hotspot traversal follow-up:** see [hotspot traversal fixes](hotspot-traversal.md) for candidate-socket handoff, probe TTL isolation, NAT sampling retries, corrected timeout budgets, and outstanding live-device verification.

**Physical cross-network update (October 27, 2026):** see [the Mac cellular/Kubuntu home-Wi-Fi validation](cross-network-2026-10-27.md) for completed Desktop pairing, native HyperDHT audio playback, recovery checks, and the MTU fix. The original report below describes the earlier validation state.

This implementation adds a native Rust networking subsystem to the existing server, Tauri desktop backend, and an Expo native module. The allowed connection policy is LAN, native HyperDHT, optional independent pwnat, then offline. There is no application-data relay, VPN integration, port-mapping strategy, or fourth fallback.

**Validation is incomplete on physical devices and across distinct NATs.** The code and tests below are working progress, not a claim that every acceptance criterion has been verified. In particular, mobile device builds and pwnat NAT traversal have not been demonstrated. A Node-client HTTP/2 interoperability test also remains unresolved.

## 1. Existing functionality retained

The [initial audit](audit.md) records the state before implementation at `8e5df17`. The server executable, explicit startup/shutdown, process lock, local management API, configuration store, six-digit approval/denial, device listing/revocation, token hashing, music providers, library, queue, shared playback session, endpoint registration, command polling, and native playback engines remain in their existing owners.

Existing server device records deserialize with their token hashes intact. Desktop keeps host/join selection. An unavailable joined server never starts or selects a replacement server.

## 2. Components changed

LAN discovery and connection plumbing move into `crates/ambra-net`. The existing discovery message and port remain compatible, with public-key and secure-port hints added. Desktop no longer duplicates broadcast/interface handling. Legacy remote HTTP credentials now receive HTTP 426; genuinely local management retains its existing behavior. The old browser-only remote therefore cannot act as a secure remote client; use the native clients.

Mobile removes JavaScript hostname/address racing, Metro-host token probes, and MagicDNS selection. Its presentation, Expo Audio playback, queue synchronization, and endpoint protocol remain TypeScript/React Native. The old Tailscale development script remains available only for migration; application onboarding does not depend on it.

## 3. Shared Rust architecture

`crates/ambra-net/src` contains:

- `identity.rs`: stable Ed25519 seed persistence and validated public keys.
- `pairing.rs`: versioned public QR/link payloads.
- `lan.rs`: interface-aware discovery, local endpoint policy, dual-stack listeners, and Noise connections.
- `pwnat.rs`: independent ICMP construction/validation, capability checks, UDP punching, QUIC and Noise.
- `hyperdht.rs`: lazy known-key client node, native acceptor, announcements, lifecycle and status.
- `transport.rs`: bounded framed encryption adapters, HTTP/2, trusted remote-origin context and Axum dispatch.
- `manager.rs`: exactly three methods, authentication, deadlines, cancellation, health and reconnection.
- `bridge.rs`: fixed-destination, capability-protected application-local HTTP bridge.

`crates/ambra-mobile-bridge` exposes a small JSON C ABI and Android JNI entry point. Desktop depends directly on `ambra-net`. Mobile's Swift/Kotlin Expo module links the same Rust implementation. The server uses its existing Tokio runtime; lightweight UDX handles do not create separate Tokio runtimes. Mobile owns one native runtime with two workers.

A repository-wide Cargo workspace was deliberately avoided: the existing server and desktop have separate release scripts, lockfiles, and unrelated vendored patches. Path dependencies share networking without forcing that migration.

## 4. LAN behavior

IPv4 uses `AMBRA-DISCOVER/1` on UDP 38148, sent to each current interface's broadcast address. IPv6 uses the same protocol on a transient link-scoped multicast group, `ff12::a6b2`. Responses retain the incoming IPv6 scope. Discovery rejects malformed/oversized replies, invalid ports and nonlocal sources, and bounds the number of results. The responder limits replies per second.

Announcements are hints, not credentials. Only the selected public key can authenticate. Cached/manual endpoints work without discovery or Internet access. Default secure TCP port is 38149, independent of the existing HTTP management port 38147. An all-interface bind prefers one dual-stack socket. Public TCP sources are rejected; direct globally routed TCP is not an additional remote fallback. IPv4-mapped IPv6 and addresses on directly connected IPv6 subnets are recognized.

Automatic discovery on iOS may be restricted by multicast entitlement/permission requirements. QR endpoint hints avoid requiring multicast. New interface membership after startup, restrictive Wi-Fi filters, global IPv6 LANs, and actual mobile discovery still require device testing.

## 5. Independent pwnat implementation

The implementation is independently written from the published [Autonomous NAT Traversal paper](https://samy.pl/pwnat/pwnat.pdf), [method description](https://sa.my/pwnat/), and [RFC 792](https://www.rfc-editor.org/rfc/rfc792). No GPL pwnat implementation source was read, copied, translated, linked, wrapped, vendored, or executed.

The server periodically sends a fixed ICMP Echo Request to documentation address `192.0.2.1`, creating whatever ICMP NAT state the network permits. The client retrieves a signed public candidate through the existing DHT or uses a validated pairing hint and sends an independently constructed Time Exceeded quotation of that Echo Request. The receiver validates checksums, lengths, protocol, fragment fields, target, identifier and sequence before learning the sender's IP. It sends bounded UDP probes from the QUIC socket. The client retries ICMP signaling during the bounded QUIC attempt. Application traffic uses QUIC reliability/congestion control and an inner Noise handshake pinned to the server's Ed25519 key.

The QUIC TLS certificate is ephemeral. The outer TLS certificate is not used as the Ambra identity; Noise verification completes before HTTP or a device token is sent. This permits one public identity across all transports without a custom certificate-signing protocol.

This narrow variant assumes preserved ICMP identifiers and the agreed UDP port on both NATs. It does not guess randomized ports or use STUN/DHT during its attempt. It is IPv4-only. The documentation destination is not an Internet service; upstream filtering of that destination may also prevent state creation. No compatibility with the original pwnat executable is claimed.

Raw ICMP capability detection never requests elevation or installs a helper. pwnat is now an explicit server opt-in. Linux/macOS can use a separately built, one-shot ICMP launcher that drops privileges before executing Ambra. Windows/iOS/Android skip pwnat explicitly. Compatible simulated NATs now pass real Ambra pairing, WAV streaming, and reconnect; physical Mac-to-Kubuntu pwnat remains untested pending manual Mac helper execution. Ordinary Linux client SNAT is verified incompatible with the fabricated ICMP error. See [the pwnat runbook](pwnat.md) and [dated results](pwnat-2026-10-27.md). Patent and other legal questions are separate from source-code copyright; independent implementation is not a blanket legal clearance or proof of patent freedom. Ambra itself remains GPL-3.0, independently of the avoided upstream source.

## 6. HyperDHT dependency and interoperability

The implementation pins peeroxide-dht/libudx/peeroxide 1.7.3. Upstream commit is `6ec917806480d769c16dfbf44a8d80413fcc0418` (July 12, 2026). These crates declare MIT OR Apache-2.0 and Rust 1.85; the DHT and UDX libraries forbid unsafe code. See [upstream](https://github.com/Rightbracket/peeroxide) and the [patch record](../../vendor/peeroxide-dht/AMBRA-PATCH.md).

The lower-level DHT API supplies known-public-key connection, public bootstrap, announcements, Noise and UDX. Its stock `run_server` does not deliver accepted application streams. Ambra therefore uses the peeroxide acceptor for passive hole-punch lifecycle, while performing identity announcements directly through `peeroxide-dht`. No client topic swarm is started. Announcements refresh every 60 seconds, and are reported successful only after acknowledgements. Public bootstrap failure does not block the local server.

Source review and live tests found upstream defects that required pinned patches: automatic data-relay following, incorrect passive signaling endpoint hints, duplicate handshake replies destroying the selected hole-punch session, and missing connection-slot release. Additional patches bound encrypted frames, distinguish truncated framing from clean EOF, reject relay configuration before sockets open, and avoid blocking acceptor startup on public bootstrap.

The alternative cowlicks `hyperdht` 0.1.1 was inspected. Its upstream identifies it as work in progress; it uses native libsodium/UDX dependencies and has a smaller API/maintenance baseline. It was not selected.

Observed on this macOS host against public bootstrap nodes:

- Rust client located a Node `hyperdht@6.34.1` reference server by public key and exchanged an exact encrypted echo over direct UDX.
- Rust acceptor announced on the public network. A native Rust client completed Noise authentication, HTTP/2, and a 2 MiB response.
- A Node reference client completed incoming Noise/UDX authentication after the passive-hole-punch fixes. The Node HTTP/2 harness received the initial settings frame, then stalled; complete Node-client HTTP streaming is **not verified**.

These are real public-network protocol tests, but both endpoints ran on one host/network. They do not prove traversal between separate routers, carrier-grade NAT, cellular networks, or sustained production interoperability. Neither the dependency nor these patches have received an independent cryptographic/security audit. Peeroxide contains its own libsodium-compatible secretstream implementation; its passing fixtures are interoperability evidence, not an audit.

## 7. Evidence that application relaying is disabled

The vendored low-level connector rejects authenticated `NoisePayload.relay_through` before establishing a relay connection. Its automatic relay-connection implementation is removed. The acceptor rejects any relay configuration before opening sockets. Ambra never starts a relay service or calls blind-relay APIs. An actual UDP/Noise regression test supplies an authenticated relay instruction and verifies `FirewallRejected`.

DHT nodes can forward discovery/handshake/hole-punch signaling. Those control messages are distinct from the authenticated direct UDX application stream. Upstream optional relay modules remain in the pinned dependency source for compatibility, but are not configured or used by Ambra. No claim is based merely on a field named `is_relayed`, which can describe signaling forwarding rather than the payload path.

## 8. Connection manager and HTTP adapter

The state model includes offline, discovery, each attempt, authentication, each connected method, reconnection and failure. The order is LAN, HyperDHT, then optional pwnat. LAN has a 3-second deadline, HyperDHT 15 seconds, pwnat 8 seconds (up to 3 seconds for signed discovery and 5 seconds for setup), and reconnect retry 5 seconds. `Timing` can be supplied by native callers. Missing public hints trigger a bounded signed DHT record lookup when raw ICMP is available. Unsupported raw ICMP fails without privilege prompts. Failed rounds reset stale DHT context. A stable connection is retained until loss; discovery does not replace it opportunistically.

Only a verified server with a successfully authorized `/api/network/session` response reaches a connected state. Enrollment remains `Authenticating`. HTTP/2 carries the existing methods, statuses, headers, streamed bodies, range requests and concurrent polling. Pumps use 16 KiB chunks and bounded duplex buffers. HTTP/2 supplies multiplexing and flow control. Encrypted frames are capped at 1 MiB before allocation. No song-sized buffering or transcoding is introduced by the adapter.

Remote streams dispatch directly into the existing Axum Router with trusted `RemotePeer` metadata, including a connection lifetime marker. No remote request is forwarded through a privileged loopback HTTP socket. Authorization is checked on every request. The server tracks authenticated live devices using those lifetime markers.

The application-local bridge binds only to `127.0.0.1` on an ephemeral port. It requires a 256-bit per-process path capability and exact Host, checks browser Origin, refuses absolute proxy destinations and local management paths, strips caller credentials, and injects only the selected device's remote bearer token. It never accepts arbitrary destinations. Media and saved URLs are rebased; device tokens and bridge capabilities are removed before shared persistence. Relative HLS segments inherit the bridge path and do not receive remote bearer tokens.

Mutations are never replayed after an ambiguous disconnect. Dropping a response cancels its stream. HTTP deadlines cover response headers, not an entire song. A 15-second HTTP/2 health ping with a 5-second timeout detects otherwise silent connections.

## 9. CLI and QR pairing

Existing commands retain their roles. Added commands:

```sh
ambra-server network status
ambra-server network diagnose
ambra-server network identity
ambra-server network p2p on
ambra-server network p2p off
ambra-server network endpoint 203.0.113.10:38149 # replace with your actual public endpoint
ambra-server pair qr
```

Status/diagnostics query the running server's local API. Identity reads the persistent public identity without creating a DHT node. Remote P2P toggles apply live; bind changes still require restart. Disabling P2P leaves LAN available. `config set discovery off` independently disables discovery.

`pair qr` renders a terminal QR code and prints the equivalent `ambra://pair/` link. Desktop Server settings displays the same QR information. The payload is versioned base64url-encoded JSON and contains only a public key, name and endpoint hints; it contains no invitation secret, device token, or administrative credential. Reusable public information does not authorize enrollment. A client still needs explicit six-digit approval. Loopback-only servers must enable sharing before creating a remote pairing link.

## 10. Authentication and migration

Server seed: `network-identity.key` in its configuration directory. Desktop device seed: `client-network-identity.key` in its application data directory. Mobile keeps its device seed in protected/no-backup native application storage. Unix files use mode 0600. Windows relies on the application's per-user data directory ACL; Windows ACL behavior has not been tested here.

Back up the server identity with its configuration. Corrupt, unreadable, incorrectly permissioned or unexpectedly sized key files fail closed; they are not silently regenerated. A restored server with a different key requires explicit re-pairing.

New device records bind bearer authorization to the Noise public key. Enrollment polling is also bound to that key. Request handles are one-time, expire after ten minutes, and disappear after credential delivery. Pending requests are bounded and rate-limited. Old token hashes remain readable, but clients with no pinned server key require explicit re-pairing. No random legacy server ID is accepted as a key-verification proof.

Regression tests cover a remote transport carrying loopback `ConnectInfo`, loopback Host, valid credentials and forged forwarding headers: it still cannot access `/api/local/`. Wrong tokens, wrong device keys and revoked devices are rejected. Truly local management remains available.

## 11. Desktop integration

Tauri uses `ambra-net` directly, with one stable bridge URL for the selected joined server. Existing fetch, native playback and remote endpoint agents use that URL. Connection status and active method are exposed through a Tauri command and the existing Server settings page. Pairing accepts a public link or manually bootstraps public hints from a local server address before encrypted enrollment.

Host mode continues to use a separately running local server. Startup remains explicit. Existing joins lacking a cryptographic key stay selected and display a re-pairing requirement. Desktop Rust builds/tests pass on this macOS host; Windows/Linux builds and sleep/Wi-Fi transitions remain unverified.

## 12. Mobile packaging and platform state

The local Expo module includes Swift/CocoaPods/XCFramework packaging and Kotlin/JNI/Gradle integration. Build scripts cover iOS device/simulator and Android arm64-v8a, armeabi-v7a and x86_64. Both Apple and Android Expo autolinking recognize the module. iOS prebuild succeeds. Host compilation and C ABI tests pass.

Actual mobile builds stop at environment prerequisites: **full Xcode is absent; Android NDK and cargo-ndk are absent**. There is no verified native iOS/Android binary or physical-device result. JNI, Swift linkage, ATS, camera scanning, background audio over the bridge, cellular UDP, battery behavior and app resumption require native-device validation.

Expo Go is unsupported. The app reports this rather than attempting a JavaScript fallback. Camera scanning reuses the public pairing link and the same approval flow. SecureStore keeps authorization credentials. Foreground resumption refreshes connectivity/session state. Existing legitimate audio background modes are preserved; no silent audio lease or continuously running networking service is added.

ATS exceptions are limited to the loopback bridge; broad Tailscale/private-range exceptions are removed. See Apple's [local networking](https://developer.apple.com/documentation/bundleresources/information-property-list/nsapptransportsecurity/nsallowslocalnetworking) and [IP exception](https://developer.apple.com/documentation/BundleResources/Information-Property-List/NSAppTransportSecurity/NSExceptionDomains) documentation, and Expo's [local module autolinking](https://docs.expo.dev/modules/autolinking/) documentation.

## 13. Playback and synchronization proof

The existing server/session/player suites continue to test queues, output switching, presence, long polling, playback reports and server-authoritative state. The real-server integration script pairs through encrypted LAN, approves via CLI, requests the real session, uploads synthetic audio bytes, reads a byte range through the private bridge, checks administrative denial, consumes an enrollment handle once, revokes the device, toggles P2P and stops cleanly.

The networking suite transfers 8 MiB incrementally while a concurrent long poll completes; it also tests 1 MiB upload echo, byte ranges, bridge restrictions, identity mismatch, failed authorization, cancelled mutations and reconnection to the same identity through the same bridge URL. IPv6 loopback is exercised where available.

No real provider account or physical audio device was used. Continuous audible playback, seek continuity during Wi-Fi/cellular transitions, buffered playback, Bluetooth/AirPlay/background behavior and multi-device audio synchronization over separate NATs remain unverified. The transport supplies stable addressing and reconnection, but no new automatic byte-range replay of an interrupted song is implemented. Existing player recovery remains responsible for resuming media.

## 14. Performance observations

On this Apple Silicon macOS host, optimized isolated tests measured authenticated LAN connection at 3.99 ms, and an 8 MiB transfer plus a concurrent 100 ms poll at 120.66 ms (about 66 MiB/s including the poll). These are synthetic loopback measurements, not WAN audio benchmarks.

A single optimized, idle public-DHT acceptor snapshot after announcement showed 0.0% CPU and 1,456 KiB resident memory reported by `ps`. Its unstripped executable was 7,053,488 bytes; clean shutdown took 0.544 seconds. This excludes music providers, is not the full server's incremental memory cost, and may reflect OS page compression. A short snapshot is not a long-duration stability/battery measurement.

## 15. Automated validation

Commands and final counts are recorded in [validation](validation.md). Native tests use real local sockets; mocks in priority tests are explicitly policy tests. Public interoperability is an opt-in development test. No loopback test is counted as proof of NAT traversal.

## 16. Dependencies and licenses

Primary additions are peeroxide/peeroxide-dht/libudx (MIT OR Apache-2.0), Quinn (MIT OR Apache-2.0), rustls (Apache-2.0 OR ISC OR MIT), rcgen (MIT OR Apache-2.0), socket2 (MIT OR Apache-2.0), if-addrs (MIT OR BSD-3-Clause), hex (MIT OR Apache-2.0), zeroize (Apache-2.0 OR MIT), Hyper/HTTP utilities (MIT), Tower (MIT), qrcode (MIT OR Apache-2.0), JNI bindings (MIT OR Apache-2.0), and Expo Camera/Modules Core (MIT). Existing Tokio, Serde and Axum dependencies are reused.

[Dependency metadata](dependencies.json) records resolved networking packages, versions, declared licenses and source repositories, including development and target-specific packages. It is generated evidence, not a legal opinion or a transitive security audit. The native application ships no Node/Bun networking runtime. Node reference tests are development infrastructure only.

## 17. Outstanding verification and limitations

- No demonstrated physical Mac-to-Kubuntu pwnat traversal. Compatible simulated NATs pass; strict Linux client NAT is incompatible. Mac raw ICMP requires manual operator action.
- No verified native mobile device build or physical mobile test.
- No cross-router/cellular NAT matrix or long-running network-transition/playback test.
- Node-client HTTP/2 streaming remains stalled after the first frame, despite successful Noise/UDX establishment; native Rust HTTP/2 transfer succeeds. Full bidirectional reference interoperability is not claimed.
- Windows/Linux builds and filesystem ACL behavior remain untested.
- Multicast restrictions and newly attached network interfaces need real-device testing.
- No independent cryptographic audit of peeroxide or the integration.
- Automatic media resume after an interrupted byte stream relies on existing playback behavior and is not proven by the synthetic transfer tests.

## 18. Test on actual devices

1. Build/install the server and desktop. Start the server explicitly. Run `network status` and retain its public identity.
2. Open Server settings, Show QR code, or run `pair qr`. Pair a second desktop or a native mobile development build. Verify and approve the six-digit code on the intended server.
3. On the same Wi-Fi, confirm `ConnectedLocal`. Remove Internet access while keeping the LAN available; repeat library, artwork, lyrics, streaming, seeking, queue and output operations.
4. Move the client to a different physical network. Keep the same selected server. Confirm either authenticated direct HyperDHT or a clear offline state. Record both NATs and OS versions. Verify that discovery/signaling nodes carry no application payload.
5. For pwnat validation, follow [the optional helper and isolated test instructions](pwnat.md). Use signed endpoint discovery where available. Keep production firewall policy unchanged and distinguish compatible simulated NATs from physical public-network proof. Mac elevation must be performed privately by the operator, only for the dedicated launcher.
6. Revoke the device while connected; verify new API calls and reconnection fail. Pair again explicitly. Test denial, expiry, changed server key and attempts to access local management remotely.
7. During real audio playback, test sleep/wake, Wi-Fi/cellular changes, offline periods, seeking after recovery, long polls, concurrent artwork/library traffic, two output devices, foreground resumption and locked-screen playback. Record audible results and streaming/range behavior.

Build/run the isolated automated test with:

```sh
cargo build --manifest-path server/Cargo.toml
cargo build --manifest-path crates/ambra-net/Cargo.toml --example pairing_probe
python3 scripts/test-native-network.py
```

For the reproducible public reference check, run `npm ci --prefix scripts/network-interop` followed by `python3 scripts/network-interop/check.py`. This installs Node dependencies only in the development test directory. For additional protocol probes, use `examples/hyperdht_probe.rs`, `examples/hyperdht_server.rs`, and `examples/http2_probe.rs`. Only test keys and synthetic payloads belong in the reference test environment. Production Ambra does not launch reference processes.
