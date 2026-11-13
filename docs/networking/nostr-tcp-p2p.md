# Nostr-signaled native TCP P2P

## Result and qualification

On November 13, 2026, the school Mac connected automatically to the home Kubuntu
server using Nostr signaling, TCP simultaneous opening, Ambra Noise, and Ambra's
real HTTP/2 handlers. Three batches completed **9/9 TCP/443 connections**,
including six immediate reconnections without re-pairing. They verified **448 MiB** of WAV
file responses, uploads, concurrent API requests, and byte ranges. The final
five-round batch authenticated in **3.509–4.305 seconds**, with a median of
**3.747 seconds**. Measured download throughput ranged from
**1.713 to 3.466 MiB/s**.

These are physical cross-network results, not an echo fixture or loopback NAT
simulation. The test used the real checkout server, its approval flow, its device
credentials, `ConnectionManager`, `/api/session`, and `/api/music/local/files/`.
WARP stayed disconnected. Tailscale carried administrative SSH and the initial
owner-approved enrollment only. The application sockets used native `en0` and
`wlo1`, with public peer addresses. Router mapping was disabled in the isolated
test server, and the client had no public TCP endpoint hints. The probe rejects
any selected method other than `TcpPunch`.

**This is not a production-readiness claim.** TCP/443 worked on this network pair;
two completed attempts with unprivileged home ports failed. There is no proven
general NAT success rate, physical mobile result, Windows simultaneous-open
support, audible playback test, or physical network-handoff test. The optional
privileged-port launcher supplies a finite socket pool. See the limitations below.

Sanitized measurements are in [evidence.json](results/nostr-tcp-2026-11-13/evidence.json).
Private keys, tokens, raw logs, and packet captures are excluded.

A final instrumented run adds one authenticated connection, 48 MiB of exact audio,
18 concurrent requests, and a 3.544-second setup. Noise takes 81.2 ms. Candidate
offer-to-answer takes 952.3 ms on the client clock, including home STUN gathering.
Observed publication-to-authenticated-reception intervals are 242.5 ms for the
offer and 194.1 ms for the answer on the two host clocks. An independent timestamp
probe over an already established administrative SSH channel estimates home clock
offset at -27.0 ms with a ±20.2 ms round-trip bound. Corrected one-way estimates
are therefore 269.5 and 167.0 ms, with that clock uncertainty and local
queueing/verification included. SSH never conveys a candidate or application body.
These control measurements are separate from TCP/Noise and application throughput.


## Baseline and earlier evidence

Both checkouts started clean at historical `c10b38f`. The Mac's local `main` had
63 commits absent from the current origin and lacked 281 origin commits. Neither
checkout was reset. Both switched to `feat/nostr-tcp-p2p`, based on current
`origin/main`, `d94258887c840b2a1941332a28293e080528c91f`. The old branches and
commits remain available. No applicable repository or ancestor `AGENTS.md` was
present. Nothing was pushed during implementation and physical validation.

The October [school report](school-wifi-2026-10-29.md) supplies the starting
mechanism: TCP STUN at Nextcloud TCP/443, a retained mapping socket, shared local
ports, simultaneous active opens, and a home TCP/443 candidate. Its warning about
SYN proxies and sequence translation still applies. A fast `connect()` is not
proof of reaching the peer. Every new path must finish pinned Noise and device
authorization. This implementation removes the Python stream adapters and
out-of-band candidate files from that experiment.

The [November public TCP report](public-tcp-2026-11-06.md) describes a different
method: router-forwarded TCP with a signed admission knock. That method remains
available as `Public`. TCP punching uses its paired-device admission invariant,
not its router configuration or endpoint cache. The earlier
[cross-network report](cross-network-2026-10-28.md) also remains relevant to UDP
filtering, transport buffering, and the difference between management and data
paths. Neither old throughput figures nor the absence of a relay flag qualifies
a new native path by itself.

## Architecture

The control path is:

1. Read the existing protected Ed25519 device seed.
2. Derive a separate application-specific secp256k1 signing key using HKDF-SHA256,
   salt `ambra/nostr/signaling/v1`, and context `secp256k1`.
3. Find the server's signed Nostr identity binding by its already pinned Ambra key.
4. Exchange NIP-44 encrypted, Ed25519-authenticated control events through public
   WSS relays.
5. Gather fresh native TCP candidates and coordinate simultaneous opening.
6. Authenticate sockets with the existing admission knock and Noise transport.
7. Nominate one socket, then run the existing HTTP/2 session and bearer authorization.

The data path is the client TCP socket directly to the server TCP socket, through
existing network routing/NAT/middleboxes. `transport::secure`, `transport::adapt`,
`HttpConnection`, and `transport::serve` retain ownership of encryption, streaming,
HTTP/2 flow control, and trusted `RemotePeer` metadata. There is no music protocol,
loopback adapter, proxy, VPN, or third-party application-data relay in this method.

`signaling.rs` owns Nostr and authenticated control envelopes. `tcp_punch.rs` owns
socket construction, TCP STUN, candidate validation, and authenticated socket
racing. `tcp_punch/session.rs` owns the client/server signaling state machines and
server attempt/session lifetimes. Existing pairing, access middleware, and
transport code remain the authorities for device authorization.

## Why Nostr and which relays

`nostr-sdk` 0.45.6 and `nostr` 0.45.7 provide maintained implementations of Nostr,
secp256k1 signing, WSS, and NIP-44. The SDK's subscription, verification,
deduplication, and connection APIs avoid inventing WebSocket or encryption
protocols. Nostr supplies existing public control infrastructure; users need no
Nostr account, relay identity setup, deployed rendezvous server, or Ambra service.

Default independent relays are:

- `wss://relay.primal.net`
- `wss://relay.nostr.net`

Both were tested from both physical machines with subscriptions, publication
acknowledgments, verified identity lookup, and three encrypted bidirectional
exchanges. At least one relay must work for both peers. Defaults are not an
availability guarantee. Operators can change the library caller's explicit relay
list; ordinary desktop/mobile users need no relay configuration.

| Relay | School ready, ms | Home ready, ms | Encrypted round trips, ms | Qualification |
| --- | ---: | ---: | --- | --- |
| relay.primal.net | 580.9 | 1116.4 | 484.2, 365.3, 606.4 | Passed |
| relay.nostr.net | 955.0 | 942.1 | 611.4, 602.2, 634.6 | Passed |
| nostr.oxtr.dev | 779.3 | 1378.2 | 618.7, 413.1, 403.1 | Passed cross-network; not a default |
| nos.lol | — | — | — | TLS/subscription worked; publications timed out |
| relay.damus.io | — | — | — | Publications timed out; not qualified |
| relay.nostr.band, nostr.mom, relay.nostr.bg | — | — | — | Publications timed out; not qualified |
| relay.ditto.pub | — | — | — | Capability probe could not connect |

A separate school capability probe tested several custom event kinds. It confirmed
that reaching HTTPS or receiving `EOSE` does not establish publish/delivery support.
Oxtr initially acknowledged a binding marker without independent delivery in that
probe, although the later real binding/encrypted exchange passed. Two demonstrated
defaults are preferable to relying on that ambiguous capability sample.

Each pool uses one to five configured relays, WSS on TCP/443, a six-second connect
budget, and three-second publication acknowledgments. Per-relay reconnect delays
increase exponentially from one to 60 seconds, with up to 1.02 seconds of jitter.
Reconnect tasks stop with their owner. The SDK restores subscriptions on reconnect.
All publications start concurrently; the first acknowledged relay wins. A failed
relay does not add its full timeout to a healthy relay's control exchange.

## Identity, discovery, and protocol

No pairing payload or saved server record needs a new secret or field. A previously
paired client already knows the server's Ed25519 public key. The server publishes
an application-specific kind `30078` record with `d=ambra/signaling/v1/<Ed25519 key>`.
The record contains only version, public Ed25519 key, public Nostr key, and an
Ed25519 signature. The outer event must also verify under that same Nostr key.
Records expire locally after 24 hours and are refreshed every six hours. NIP-40
expiration tags are hints to relays; local checks are authoritative.

The Nostr key is deterministically derived from the existing private seed, rather
than copied from the Ed25519 secret scalar. Its protected storage is therefore the
existing seed file: server `network-identity.key`, desktop
`client-network-identity.key`, and mobile `ambra-device-identity.key`. Existing
exclusive creation, regular-file checks, Unix 0600 permissions, and corruption
failure behavior remain in force. Windows storage still relies on the user's
application directory ACL. There is no new credential file to drift across
reconnections. An unverified Nostr key never replaces a pinned Ambra identity.

Control events use custom ephemeral kind `28333`, `p` recipient tags, and NIP-40
expiration. Content is NIP-44 v2 encrypted. Inside encryption, an Ed25519-signed
payload contains protocol version, sender, intended recipient, Nostr author,
128-bit random session ID, attempt number, issued/expiry times, random nonce, and
one message:

- `Offer`: client candidates.
- `Answer`: server candidates.
- `Ready`: client confirms candidate receipt and readiness.
- `Start`: server supplies an absolute millisecond start time.
- `Connected` or `Failed`: bounded outcome notifications, not authorization grants.

Ed25519 signatures use domain `ambra/nostr/control/v1` followed by a zero byte and
serialized typed JSON. The Nostr signature, encrypted author binding, intended
recipient, existing paired-device policy, inner signature, time bounds, and replay
cache must all pass. Unknown fields and invalid candidate types are rejected.
Ephemeral delivery, deletion, and storage are never assumed.

Control lifetime is at most 90 seconds. Future timestamps tolerate 30 seconds;
start coordination requires clocks within 15 seconds of its timestamp. Nonces are
remembered in a bounded 4096-entry cache. The server keeps at most 64 recent attempt
tombstones so a fresh nonce cannot resurrect a completed session. Messages from a
different Nostr author cannot enter an existing attempt. Out-of-order phases do
not allocate attempts; only an admitted `Offer` can do that. Repeated offers,
answers, readiness, and start messages tolerate lost and duplicate relay delivery.
The current connector uses attempt zero; each manager retry creates a new session
and freshly gathered candidates.

Already paired devices whose historical records contain no device public key must
still enroll through the existing approved flow. Guessing an identity from a token
would weaken admission and is not attempted. New remote enrollment through this
TCP method is deliberately unavailable; pair locally or through an existing
approved enrollment path first.

## TCP candidates and socket ownership

The implementation uses RFC 6544's simultaneous-open concept, not full ICE-TCP.
It currently supports IPv4 host/public and server-reflexive candidates, with
`tcp_type=simultaneous_open`. LAN is handled by the existing preferred method;
private addresses, overlays, loopback, multicast, documentation/benchmark ranges,
zero ports, and IPv6 are rejected as punched public candidates.

Candidate gathering enumerates up to four native IPv4 interfaces. Each attempt
binds an explicit local address and port, configures `SO_REUSEADDR` and
`SO_REUSEPORT`, and binds to the physical interface (`IP_BOUND_IF` on macOS;
`SO_BINDTODEVICE` on Linux). It connects that socket to `stun.nextcloud.com:443`,
sends an RFC 5389 Binding request, checks the transaction/cookie/frame/attributes,
and reads a bounded IPv4 mapped address. A held control socket retains the observed
mapping while a separate reused-port listener and outgoing sockets prepare.
There is no UDP STUN or router mapping operation in this module.

Both peers publish their fresh candidates before readiness/start coordination.
The server schedules opening about 1200 ms ahead. Each side listens and actively
dials from the observed local port, with up to six paced dials, seven-second TCP
connect deadlines, eight-second authentication deadlines, at most eight concurrent
socket tasks, and a 24-second punch window. At most 16 candidate-source accepts
enter authentication. Source IP filtering is an optimization; identity proof is
mandatory. Mapping stability across different destinations is **not** assumed or
inferred from STUN alone. Unchanged local/public ports were observed in the
physical successful samples.

TCP direction does not determine Noise role. The Ambra client always initiates
Noise; the server always responds. Before responding, the server verifies the
existing fixed-size signed knock against the currently paired key and replay
cache. The subsequent Noise key must equal the key that knocked and the key in
the admitted signaling attempt. The client pins the server key. This prevents a
SYN proxy or unrelated HTTP endpoint from qualifying as a successful candidate.

If both active opens succeed, two independent sockets can exist. Only the client
nominates a successful Noise socket, using a small versioned marker inside Noise
and a one-byte acknowledgment before HTTP/2 starts. Other handshake tasks are
dropped. This avoids peers selecting opposite TCP sockets and is transport
negotiation, not a second application/music protocol.

## TCP/443 and optional privileges

Normal mode uses an ephemeral source/listener port on both devices. It requires
no helper. That mode failed in two completed school-to-home trials during this
session. TCP/443 on the home side succeeded. The Mac always used an unprivileged
source port; its full application never needed root.

`scripts/tcp-punch-bind.py` is an **explicit opt-in, one-shot launcher**. Through
sudo, it prebinds 128 IPv4 TCP/443 sockets at an operator-specified native address,
clears supplementary groups, drops UID/GID to the invoking user, and execs the
requested command with inherited descriptors. The Rust owner validates the pool,
sets nonblocking/interface options, takes ownership once, and consumes descriptors
for STUN, listening, and bounded active attempts. The physical Ambra server ran as
UID 1000. Nothing installs a service, changes capabilities/sysctls/firewall/router
settings, stores a sudo password, or leaves a privileged daemon running.

The pool is finite. Exhaustion or an unavailable TCP/443 binding produces a clear
transport failure; other configured methods remain available. Restart the launcher
to obtain another pool. A server address change also requires a fresh helper
binding. This tradeoff avoids granting a long-running process unrestricted bind
privileges. It is a remaining operational limitation, not an invisible permanent
privilege solution. Fixed-port attempts are serialized to avoid multiple
`SO_REUSEPORT` listeners distributing a peer's connection to the wrong attempt;
existing established sessions can continue while the next attempt starts.

## Connection manager and application integration

`Method::TcpPunch`, `ConnectingTcpPunch`, and `ConnectedTcpPunch` are distinct from
`Public`. LAN and public TCP retain their existing immediate race. After the
250 ms LAN grace, TCP punching and HyperDHT race concurrently. TCP punching does
not wait for HyperDHT's 75-second budget; its own budget is 65 seconds. Optional
pwnat remains the final capability-gated fallback. A fast authenticated LAN path
avoids starting Nostr/TCP discovery on the client.

Only the existing successful `/api/network/session` authorization response causes
`ConnectedTcpPunch`. A signed signal or completed TCP/Noise handshake alone does
not. Revocation applies before candidate work, at knock/Noise admission, and in
normal per-request access checks. Unknown devices cannot use this listener to
reach pairing or HTTP routes.

Server P2P enable/disable and application cancellation own the relay pool, pending
attempts, socket tasks, and HTTP sessions. Client cancellation drops the relay
owner, mapping/listener, losing attempts, and pumps. Network-change notifications
and reconnection use the same manager lifecycle, gathering fresh candidates
without changing the stored device identity. The desktop settings label is
`Direct TCP (Nostr)`. Mobile consumes the shared manager/status path without a new
JavaScript networking implementation.

The new method does not start speculative upgrades to TCP punching while another
healthy connection is active. Existing LAN recovery and 30-second retirement
behavior are unchanged. Consequently, unlimited draining of very long requests
during an existing LAN/public upgrade is **not** newly guaranteed. Actual physical
roaming and uninterrupted audible playback through such an upgrade remain open
validation items.

Existing router-forwarded TCP stays separate. `AMBRA_DISABLE_PORT_MAPPING=1`
explicitly disables its router operations in the server; this was set throughout
native validation. The new module itself only reuses the pure public-address
predicate from `portmap.rs` and never calls UPnP/NAT-PMP discovery or mapping.

## Security, resources, and dependencies

Relay operators can observe IP addresses, persistent Nostr authors, recipients,
timing, sizes, and the public Ambra-to-Nostr identity binding. They cannot read
candidates, readiness/start details, nonces, or session IDs. No bearer, private key,
or application body enters Nostr. Relays can censor, delay, replay, retain, reorder,
or flood messages; authentication, local expiration, replay caches, phase guards,
resource limits, retries, and multiple relays reduce those risks. They cannot make
an unpaired device an authorized Ambra peer or cause a configured data relay fallback.
A compromised paired device can still request bounded TCP work toward public
addresses; revocation removes that permission. This is not a defense against a
fully compromised endpoint or a relay withholding all traffic.

SDK messages are limited to 16 KiB, events to 12 KiB, encrypted content to 8 KiB,
and decrypted payloads to 4 KiB. Candidates are limited to four, inboxes to eight
messages, global attempts to eight, sessions to 64, and fixed-port attempts to one.
The SDK's event tracker is a bounded 35,000-entry LRU; notifications use bounded
128-entry channels. The underlying WebSocket implementation has bounded defaults
of 16 MiB per frame and 64 MiB per assembled message before SDK validation. These
are larger than the application limits and remain a memory-pressure risk under a
malicious relay, particularly on mobile; no claim of an independent denial-of-service
or cryptographic audit is made. Existing HTTP/Noise framing and flow-control limits
are reused.

Nostr cryptography comes from the maintained Nostr/RustCrypto/secp256k1 libraries;
existing Noise/Ed25519 implementations remain unchanged. Manifest/lock changes
add the SDK, NIP-44 support, HKDF-SHA256, and URL validation. `cargo audit` on the
network crate's lock reports zero vulnerability entries and two **pre-existing**
informational warnings: `xsalsa20poly1305 0.9.1` renamed/unmaintained
(`RUSTSEC-2023-0037`) and `rustix 1.1.5` extended-attribute buffer unsoundness
(`RUSTSEC-2026-0486`). Both versions existed at the baseline. This task does not
migrate unrelated existing dependencies. An audit database check is not a security
audit of this integration.

## Reproduction and use

Build the updated server and clients. Keep their original network identity files.
Pair and approve the device using the existing flow before leaving home. Enable
server P2P with `ambra-server network p2p on`; upgraded paired clients automatically
try the new method after LAN grace. `network status` reports `tcpPunch.running`
and its last error. Client status reports `ConnectedTcpPunch` only after authorization.

For the restrictive network demonstrated here, explicitly start the home server
through the optional launcher. Stop that server normally before changing its bind
method; do not start a duplicate server against the same storage.

```sh
cargo build --manifest-path server/Cargo.toml
# Use the actual physical IPv4 and absolute repository/binary paths.
sudo python3 /absolute/ambra/scripts/tcp-punch-bind.py 192.168.86.220 \
  /usr/bin/env AMBRA_DISABLE_PORT_MAPPING=1 \
  /absolute/ambra/server/target/debug/ambra-server serve
```

Do not install the launcher setuid, change host firewall protections, or run the
whole server as root. On another home network, first try normal unprivileged mode.
There is no promise that port 443 or any TCP simultaneous-open configuration can
traverse every NAT/firewall pair. A failure must remain a failure.

Permanent diagnostics:

```sh
cargo build --manifest-path crates/ambra-net/Cargo.toml \
  --example nostr_probe --example relay_capabilities --example tcp_punch_probe

# Generate independent private test profiles; exchange only their public keys.
nostr_probe identity /private/server-profile
nostr_probe identity /private/client-profile
nostr_probe listen /private/server-profile CLIENT_ED_KEY wss://relay.primal.net
nostr_probe send /private/client-profile SERVER_ED_KEY wss://relay.primal.net

# Probe acknowledgments AND independent delivery, not just TLS connectivity.
relay_capabilities wss://relay.nostr.net

# The real server must already be running in isolated storage.
# Enrollment uses an existing pinned encrypted path and owner approval.
tcp_punch_probe enroll /private/client-profile SERVER_ED_KEY ENROLL_ADDRESS:SECURE_PORT
ambra-server pair approve CODE

# Run mode has no LAN/public/DHT/pwnat winner available and asserts TcpPunch.
RUST_LOG=ambra_net=debug tcp_punch_probe run /private/client-profile SERVER_ED_KEY 5
```

The examples above denote built executables under
`crates/ambra-net/target/debug/examples/`. Run `pair approve` on the server with the
same isolated storage environment as the serving process. `tcp_punch_probe` keeps
its token mode 0600, never prints it, uploads an 8 MiB synthetic WAV, checks every
returned byte, checks ranges and concurrent `/api/session` requests, then closes
and reconnects. It does not play through a hardware output or exchange candidates
through SSH. `RUST_LOG=ambra_net=debug` records local phase timing without dumping
plaintext control payloads.

## Automated verification and remaining acceptance gaps

Verified on this Mac and/or the physical home machine:

- Network Rust suite: 49 unit tests, four direct-only integration tests, and 18
  native integration tests pass; one existing Tailscale-interface test is ignored.
- Full server suite: 241 pass, one existing test ignored.
- Desktop Rust check and frontend `bun run build` pass. Targeted server-link tests:
  11 pass. The full desktop suite passes 69 tests, with one existing test ignored.
- Mobile bridge host check and six host tests pass.
- Windows GNU cross-check of `ambra-net` passes; the new socket method explicitly
  returns unsupported there rather than claiming Windows traversal.
- Real-server integration script passes approval, authorization, upload/range,
  replay denial, administrative restrictions, revocation, toggles, and shutdown.
- Nostr tests cover serialization, invalid/unknown fields, encryption, binding,
  authorization, replay/cache bounds, skew/expiry, duplicate/out-of-order delivery,
  one dead relay, actual relay disconnection/reconnect, and subscription restoration.
- TCP tests cover candidate/STUN and inherited-descriptor validation, exact local-port reuse, simultaneous
  socket racing, Noise identity/admission, nomination, unauthorized rejection,
  HTTP/2 concurrency/ranges, and cancellation. Existing compatibility and recovery
  suites remain enabled.

Physical negative controls reject an unpaired signing identity after a bounded
candidate-exchange timeout, and an unknown server binding fails clearly. Two
unprivileged-home trials fail after the bounded punch window. An earlier probe's
cleanup mistakenly began another manager flight after failure; that flight was
cancelled and the diagnostic was fixed. It is not counted as a completed traversal
trial. Relay restart test synchronization also accounts for the SDK test relay's
nonpersistent `notify_waiters` shutdown notification; production socket closure
handling was not bypassed to make that test pass.

Actual iOS/Android build scripts were attempted. iOS stops at **Full Xcode is
required**; Android stops at **Install cargo-ndk and Android NDK first**. Only the
Apple Command Line Tools and host Rust target are usable for mobile work here.
No physical mobile binary or mobile network behavior is qualified.

Still unverified: actual audible desktop playback, many-hour stability, other NAT
combinations, physical Wi-Fi/cellular roaming, IPv6 punching, Windows socket reuse,
mobile battery/background behavior, and helper operation after pool exhaustion or
server-interface changes. A larger release qualification campaign and independent
security review remain necessary. The finite optional bind helper and WebSocket
prevalidation memory limits also deserve further production hardening.

## Changed files and cleanup

Implementation and tests:

- `crates/ambra-net/src/signaling.rs`
- `crates/ambra-net/src/tcp_punch.rs`
- `crates/ambra-net/src/tcp_punch/session.rs`
- `crates/ambra-net/src/identity.rs`
- `crates/ambra-net/src/lib.rs`
- `crates/ambra-net/src/manager.rs`
- `crates/ambra-net/examples/nostr_probe.rs`
- `crates/ambra-net/examples/relay_capabilities.rs`
- `crates/ambra-net/examples/tcp_punch_probe.rs`
- `crates/ambra-net/Cargo.toml` and `crates/ambra-net/Cargo.lock`
- `server/src/network.rs`, `server/src/p2p.rs`, and `server/Cargo.lock`
- `desktop/src/components/settings/ServerSettings.tsx` and `desktop/src-tauri/Cargo.lock`
- `crates/ambra-mobile-bridge/Cargo.lock`
- `scripts/tcp-punch-bind.py`
- `scripts/test-native-network.py` (explicitly disables router mapping in isolated regression runs)
- This report and `results/nostr-tcp-2026-11-13/evidence.json`.

The isolated server/probe processes, private profiles, test tokens/keys, synthetic
uploads, and raw diagnostics are removed after evidence extraction. The installed
home server, normal user profiles, original repositories/branches, software,
firewall, and physical network configuration are preserved. Generated build outputs and caches are disposable; rebuild the diagnostics after
cleanup. Permanent source, tests, reports, and sanitized evidence remain in Git.
No copied standalone test binary or raw capture is added to Git.
