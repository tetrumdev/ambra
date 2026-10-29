# Autonomous physical P2P engineering — October 28, 2026

## Scope and preservation

The MacBook remains on its existing personal hotspot. Kubuntu remains on home Wi-Fi. Tailscale is used only for SSH administration. No WARP update, VPN connection, route change, or host firewall change was performed.

Both source trees were inspected before editing. The Mac was clean at `3b6653dc335f52729146a2d51a1f3f9207b576e8`. Kubuntu was at `7a3fd75` with eight previous investigation files. Each file's Git blob hash matched its committed version at `origin/main`. A binary diff and the untracked file were copied to `~/.local/state/ambra-session-20261028` on Kubuntu. The complete original changes also remain in the stash named `pre-autonomous-p2p-20261028`. Kubuntu then fast-forwarded to `3b6653d`. No reset, force push, installed application replacement, or user profile modification was performed.

The previous handoffs, optional pwnat documentation, implementation, and `bfcba1e` were reviewed. The Windows handoff identifies two unclosed issues: BBR Startup never exits on a continuously backlogged cellular stream, and heavy loss can stall delivery. These are hypotheses to reproduce, not assumed results for this hotspot.

## Invariants

- Application data must use a native physical path. Overlay addresses cannot make a physical test pass.
- Noise pins the selected Ed25519 identity before application authorization. Pairing and bearer authorization remain server owned.
- pwnat remains optional and disabled by default. Raw ICMP availability does not establish router compatibility.
- UDX counts each packet delivery once, bounds pending writes, wakes stalled writers, and preserves flush/shutdown acknowledgement semantics.
- Diagnostics use isolated profiles, explicit timeouts, bounded packet counts, and no production control listener.
- Reports distinguish physical tests, localhost impairment simulations, and unavailable measurements.

## Engineering log

1. Verified default routes: Mac `en0` via hotspot; Kubuntu `wlo1` via home router. Overlay interface exists solely for administration. Initial free space: Mac 35 GiB, Kubuntu 13 GiB.
2. Started clean-revision networking tests and example builds on Mac, and current-revision server/example builds on Kubuntu. The existing user server remains running and untouched.
3. Reviewed upstream pwnat README at <https://github.com/samyk/pwnat>. Its FAQ explicitly says it works behind many NATs and firewalls, not all. It requires known server public IP, related ICMP error translation, and matching UDP flows. Ambra deliberately uses documentation destination `192.0.2.1`, QUIC reliability, and pinned Noise instead of upstream's general proxy protocol. Its fixed-port/ICMP assumptions remain conditional.
4. Added an opt-in native diagnostic example with interface classification, transaction-checked STUN, mapping observations, public HyperDHT bootstrap/ping/lookup timing, raw socket capability, timestamped JSON, and address redaction by default. It does not load user identities or bearer tokens.

## Root causes and targeted corrections

### UDX congestion and reliability

Six independent regressions failed on the previous code and passed after the corrections:

1. **Startup could remain application-limited forever.** The initial `u32::MAX` delivery sentinel was compared with ordinary unsigned `>`. Upstream C uses serial-number comparison; the first delivery must follow that sentinel. The Rust comparison now uses wrapping serial subtraction. A backlogged sender can supply bandwidth samples that allow BBR to leave Startup.
2. **SACK and cumulative ACK counted the same delivery twice.** A selectively acknowledged packet retained its rate metadata and delivered again when the cumulative ACK caught up. SACK now consumes that metadata. Cumulative acknowledgements also avoid delayed RTT measurements from already-SACKed packets. SACK processing visits actual outstanding packets rather than iterating an untrusted numeric range.
3. **Duplicate ACKs could suppress RTO indefinitely.** Every acknowledgement reset the timer, even if the oldest missing packet did not advance. A deterministic test sends duplicate ACKs every 50 ms after withholding a packet's acknowledgement. The previous code never retransmits within 1.6 seconds; the fix retransmits at its one-second deadline. Only cumulative progress restarts the RTO.
4. **Old SACKs repeatedly retransmitted the same packet.** Fast retransmit clears the packet's loss flag. The next ACK rediscovered that same old gap without fresh evidence and sent it again. Loss detection now also requires a selectively acknowledged packet sent at least as recently as the missing packet's latest transmission. RTO remains available when no newer delivery exists. This prevents a burst of duplicate ACKs from creating a retransmission storm.
5. **One large write bypassed the advertised memory bound.** `poll_write` checked the existing backlog, then copied the caller's entire buffer. A 4 MiB write passed a 64 KiB window. It now returns a permitted partial write limited to the remaining window. Empty writes return immediately without allocating packets or acknowledgement work. Flush and FIN still wait for all preceding acknowledgements.
6. **Loss-only ACK processing reused a previous rate sample.** Delivery timestamps and RTT remained in the controller across ACK batches. A later loss-only update manufactured another sample from the previous delivery. Each batch now starts with empty sample metadata, and the delivery timestamp changes only when a new packet is delivered.

The two-packet pacing burst, adaptive 64 KiB–1 MiB write window, per-packet RTT timestamps, Karn exclusion, and Windows timer change from `bfcba1e` remain. No higher burst allowance or new congestion algorithm was introduced.

### Server transport recovery

`server/src/p2p.rs` kept its configuration cancellation token after a remote listener exited. Its restart condition depended on a configuration edge, so an enabled listener could stay down until the operator toggled networking. Both remote listener owners now supervise exits with 1, 2, 4, 8, 16, and capped 30-second delays. A healthy 30-second run resets backoff. Cancellation stops retries and allows up to three seconds for listener cleanup. A paused-clock regression verifies retry spacing and cancellation. Healthy listeners and authenticated sessions are reused.

The final audit found a second startup recovery defect: a server whose initial DHT bootstrap failed kept retrying announcements against that same terminally failed actor. The listener never exited, so supervision alone could not repair it. `hyperdht::serve` now checks the initial bootstrap result, closes the failed swarm and sockets, reports the bootstrap error, and returns to its owner for backoff and fresh-node creation. A closed-bootstrap regression previously hung until its eight-second test deadline; it now returns the real failure and clears running/announced state. LAN initialization remains independent. Performance samples below precede this final startup-only guard; its regression runs on both systems and a fresh physical pairing/reconnect checks the final server build.

That final physical check passes fresh pairing, authorization, exact WAV/range verification, and an authenticated reconnect in 2.337 seconds. Both endpoint routes are verified again as `en0` and `wlo1`. The two final 176,444-byte WAV transfers match exactly. The closed-bootstrap fault itself is a localhost regression on each OS, not a claim that a physical firewall was changed or disabled for testing.

### pwnat diagnostics and helper

The installed one-shot helper reports structured health and moves a descriptor out of the standard-input/output/error range before inheritance. Both physical systems verify non-root UID/EUID after opening the raw socket. The installer never grants privileges to Ambra itself, never creates a setuid executable or sudoers entry, and documents removal.

Client failure reports distinguish raw socket creation, UDP binding, QUIC establishment, stream creation, and Noise identity verification. Server status counts emitted Echo requests, send errors, accepted ICMP quotations, and UDP punches. This distinguishes missing privileges from router incompatibility without exposing a privileged network listener.

### Audio recovery discovered by physical automation

The first Desktop run could not select its fixture because a library import does not populate the session's queue catalog. The probe now appends only its published fixture to that catalog through the normal revision-checked queue API. The debug Desktop driver can select its own default output, waiting for the frontend's shared-playback agent rather than starting a competing agent.

The next physical run started 16-bit, 44.1 kHz stereo playback, then lost playback when its output agent restarted. This exposed a real server defect already covered by two failing tests in the previous handoffs: `drive` explicitly called `pause_disconnected_output` for a newly authorized output instance, clearing the core's play intent before reload. The server now preserves play/pause intent when reloading an online, restarted output. Existing replay generation, confirmed position, queue, and listening history remain intact. Truly offline outputs still use the existing pause policy. Both existing failing regressions and a new identified-paused-output regression verify the intended behavior. Physical retesting follows below.

The server fix restored automatic playback after a forced reconnect, but a 45-second physical run still showed approximately six seconds of silence. `Root` treated every intermediate connection state as a change to local playback ownership. That unmounted the shared player, paused the native engine, and restarted the output agent even while decoded audio remained available. The client now retains an established shared owner during the same selected server's bounded reconnect/authentication attempt. Terminal failure still releases the owner and enables independent local playback. An already-shared session can also be turned off explicitly while disconnected. The new React integration regression failed before this change and passes after it; the local-playback preservation tests pass.

A long fixture stress run also exposed a diagnostic defect: if its concurrent API poll timed out, `streaming_bench` returned before printing transfer metrics. It now prints partial byte/gap/throughput data and the poll error before returning failure. One physical stress run did encounter long retransmission backoff; it is retained as a failed run rather than removed from the success rate or presented as a throughput win.

## Diagnostic tools

- `network_diagnose` is a native Cargo example. It classifies interfaces, probes three STUN destinations from one socket, checks matching transactions and bounds, reports destination-dependent mapping observations, measures HyperDHT bootstrap and per-bootstrap ping, and optionally finds/connects to a selected public key. Its default JSON redacts interface addresses and public mappings. `--connect` establishes pinned encrypted transport only; it does not bypass device authorization.
- `udp-peer.py` sends 100 authenticated probes from each explicitly bound physical interface. A random 32-byte shared token passes through stdin; no token is logged. It rejects overlay/loopback routes, validates public peer endpoints, and limits same-sized responses. Missing probes are reported as unanswered, not falsely classified as network packet loss.
- `cross-network.py` creates private profiles and a separate standalone server, approves only its own test pairing over SSH, uploads a deterministic PCM WAV, verifies exact range/full bytes, reconnects repeatedly, and records timestamped transfer/authorization metrics. It checks the routes to the actual authenticated public endpoints on both machines. Optional real debug Desktop automation uses isolated credentials and the existing native player. Normal user profiles and the existing server remain untouched.

Build and run:

```sh
CARGO_INCREMENTAL=0 cargo build --manifest-path crates/ambra-net/Cargo.toml --examples --locked
crates/ambra-net/target/debug/examples/network_diagnose
crates/ambra-net/target/debug/examples/network_diagnose --peer PUBLIC_KEY --connect
python3 scripts/pwnat/cross-network.py llewyn@100.106.252.60 --rounds 8
```

The physical harness expects Kubuntu's checkout-built server at `server/target/debug/ambra-server`. `--probe` selects a preserved baseline executable. Management uses Tailscale SSH; no audio is copied through SSH. The server binds an isolated ephemeral HTTP port because binding only loopback intentionally disables remote networking. The local administration boundary still checks actual loopback origin.

## Results

Sanitized measurements are in [the structured results](results/autonomous-2026-10-28.json). [The interactive chart](results/autonomous-2026-10-28.html) shows the actual native playback samples. All performance numbers below use **debug builds**. Percentiles use nearest rank; p95 is the maximum in these small connection samples. These are observations on two real networks, not a statistical guarantee.

### Physical methods and before/after measurements

Both machines retained their existing physical connections. The client authenticated a public server UDP endpoint and routed it through `en0`. The server accepted the cellular public endpoint and routed it through `wlo1`. The harness independently verifies both endpoint routes and rejects overlay or loopback data routes. Tailscale carries only SSH management and test pairing approval. Fixture data, WAV uploads/downloads, and actual Desktop playback use native public HyperDHT/UDX with pinned Noise. No WARP update or connection, VPN route, forwarding rule, or host firewall change occurred.

The standalone server test performs fresh pairing, authorizes the existing encrypted session, rejects consumed enrollment replay, restricts local administration, verifies a byte range and every WAV byte, and then reconnects repeatedly. A second fixture interleaves baseline and fixed clients against the **same current server and DHT identity**, reducing time/target bias. These fixture clients verify encrypted transport and the test fixture token; they do not replace the real pairing tests.

| Measurement | Before | After | Sample/meaning |
| --- | --- | --- | --- |
| Real server pairing success | 1/1 | 1/1 | Primary comparison profiles; additional physical profiles also paired successfully |
| Authenticated reconnect success | 5/5 | 8/8 | Same production LAN/HyperDHT/pwnat policy |
| Reconnect median / p95 | 2.510 / 2.704 s | 2.382 / 3.096 s | Includes a successful authenticated session request; tail did not improve |
| Cold encrypted connection success, interleaved | 5/5 | 5/5 | Fresh client/DHT node for every attempt; same current fixture server |
| Cold connection median / p95, interleaved | 4.496 / 4.967 s | 4.115 / 5.575 s | Includes the first authorized fixture response; small, variable samples |
| Exact WAV transfer median | 0.464 MiB/s | 0.484 MiB/s | Six baseline and nine final 2,116,844-byte transfers |
| Sustained encrypted transfer | 0.469 MiB/s | 0.488 MiB/s | Both deliver 44 MiB exactly; 93.77 / 90.17 s actual duration |
| Concurrent API median / p95 during sustained transfer | 578 / 997 ms | 533 / 747 ms | 134 / 141 successful polls; fixture includes a 100 ms server delay |
| HTTP audio first-byte median / p95 | Unavailable | 129 / 343 ms | Body first byte, not audible startup |
| Device authorization request | Unavailable | 59 ms | One observed request, separate from operator approval/SSH timing |
| Native audio startup | Unavailable | At most 1.65 s | First playing sample at 1 Hz; PCM 16-bit/44.1 kHz/stereo, 1411.2 kbps |

The separate, non-interleaved cold fixture batches also remain in the JSON: all five connections succeed in each batch, but the later batch is slower. Cellular/DHT variation and background build load affect these runs. The interleaved comparison does not establish a universal latency improvement, and neither p95 connection metric improves.

### Actual Desktop playback and interruption recovery

The same isolated Desktop pairing and server identity were reused for the playback recovery iterations. This tests authenticated reconnection independently of enrollment. A valid 60-second PCM WAV is served by the independent Kubuntu server. The real signed debug Desktop uses its ordinary bridge, queue, output registration, decoder, and native Core Audio output. It receives a forced transport close during playback; no GUI interaction or manual listening is required.

- With the server playback-intent fix but before the frontend ownership fix, 45 status samples show five paused samples after startup. The native position resets temporarily and ends at 37.43 seconds. The network reconnect itself takes 2.076 seconds, so the additional pause comes from frontend ownership changes rather than connection establishment alone.
- With both fixes, all 45 samples complete successfully. After startup there are **zero paused samples, zero buffering samples, and zero backward position steps**. Position advances to 43.92 seconds. The forced authenticated reconnect takes 2.187 seconds while buffered native playback continues.
- The final Desktop reaches a sampled peak RSS of 121.8 MiB; median OS-reported `ps` CPU is 12.5%. These figures include the debug UI, decoder, network, and status commands. They are not an isolated CPU benchmark or a long-term leak proof. Baseline production CPU/memory impact is unavailable.
- Audio status is sampled once per second. The test proves native decode/output progress and the reported absence of interruptions at that resolution. **No human listening or acoustic loopback measurement is claimed.**

### Fresh reachability, RTT, jitter, and loss observations

Both machines answer all three configured HyperDHT bootstrap pings. The Mac's baseline bootstrap takes 1.030 seconds, Kubuntu's 1.256 seconds; a later Mac bootstrap takes 4.524 seconds. Both machines obtain nine STUN replies from the three tested destinations. The same-socket samples do not show destination-dependent mapping, which is not a complete NAT classification and does not prove arbitrary peer UDP or ICMP support.

| Direct UDP control | Mac-initiated round trips | Kubuntu-initiated round trips |
| --- | --- | --- |
| Ephemeral-port answered probes | 93/100 | 100/100 |
| RTT median / p95 | 42.8 / 122.0 ms | 46.0 / 116.6 ms |
| Mean successive RTT variation | 14.5 ms | 11.8 ms |
| Fixed local port 48489 answered probes | 99/100 | 100/100 |
| Fixed-port RTT median / p95 | 90.6 / 458.1 ms | 84.0 / 419.4 ms |

These counters include initial mapping/opening effects. An unanswered request cannot distinguish request loss, response loss, filtering, or mapping incompatibility, so these are **not claimed as measured UDX packet-loss percentages**. Physical UDX loss percentage and audio retransmission ratio remain unavailable. Opt-in libudx debug logs provide retransmission and congestion events; they do not yet provide an unambiguous per-stream physical loss denominator.

The new isolated impairment test passes on both physical systems: a **simulated** loopback proxy applies 2% loss in both directions, 20 ms one-way delay, and ±5 ms jitter while pipelined writes transfer and gracefully shut down a 2 MiB stream with exact integrity. Existing 5%/10% loss, receive-window, reorder, MTU, cancellation, multiplexing, and sustained-throughput regressions also pass. These simulations do not replace physical NAT tests.

### pwnat: privileges work; this physical path does not

Both physical one-shot helpers open raw ICMP and then report non-root execution. The Linux child has `CapEff=0` and `NoNewPrivs=1`. The Mac helper is root-owned mode 0755 without setuid; Linux uses a root-owned, group-restricted mode-0750 copy with only `cap_net_raw=ep`. No application runs as root and no privileged remote interface is exposed. The helper remains an explicitly trusted descriptor launcher, not a packet-filtering broker: the child receives raw ICMP access, and arbitrary commands are never executed with root identity.

Both physical pwnat attempts fail. In the synchronized attempt:

- The Mac emits **17 Time Exceeded quotations** and QUIC attempts on `en0`.
- Kubuntu emits two Echo requests with zero send errors, but receives **zero valid quotations** and sends **zero UDP punches** on `wlo1`.
- Setup stops at `quic_connect` after its five-second budget. Noise/application authorization is never reached.
- A separate fixed-port direct-UDP control succeeds using measured public mappings, but the Mac mapping does not preserve local port 48489. This is an additional observed incompatibility with the protocol's fixed-port assumption; it does not prove the exact mapping during the preceding QUIC attempt.

The missing ICMP path lies between the two physical interfaces. The available captures cannot identify the particular router or carrier drop point. More privileges or a longer timeout cannot establish ICMP translation or port preservation. Physical pwnat throughput, RTT, streaming stability, and audio startup are therefore **unavailable**, not zero and not successful.

The isolated Linux NAT lab separately passes server-approved pairing, pinned QUIC/Noise, exact WAV/range bytes, and reconnect when the client router explicitly models compatible stateless ICMP translation. Ordinary conntrack client NAT and independently blocked ICMP both time out as expected, with the blocking counter verified and server health preserved. This is conditional **simulation** and cannot be compared directly with physical HyperDHT throughput. pwnat remains optional and off by default.

### Failure retained from long stress testing

The baseline 90-second fixture run passes. The first fixed stress run encounters long retransmission backoff and its concurrent control poll times out. Its previous diagnostic path discarded transfer statistics; the failure remains in the JSON and private logs. The diagnostic fix retains partial measurements on such failures. A repeat fixed run passes for 90.17 seconds, delivering 44 MiB with 141 successful control polls, one inter-body gap above 250 ms, and no observed RTO events in that fixture trace.

This is **one passed and one failed fixed stress run**, not a claim of fully resolved heavy-loss or long-duration reliability. These short tests do not qualify hours of unattended playback, all NATs, or all radio conditions. No burst cap was raised to conceal that remaining risk.

## Regression gates and builds

| Gate | macOS | Kubuntu |
| --- | --- | --- |
| Shared networking | 41 tests + STUN parser regression pass | 41 tests + STUN parser regression pass |
| libudx | 69 unit + 37 focused integration pass | 69 unit + 37 focused integration pass |
| Full standalone server | **202 pass, 1 ignored** | **199 pass, 1 fail, 2 ignored** with test-only umask 022 and one thread |
| Listener restart/cleanup | Both new regressions pass | Both new regressions pass |
| Real native networking examples | Build and physical tests pass | Build and physical server tests pass |
| Debug Desktop | Builds; driver regressions 2 pass | Not a Linux Desktop runtime test |
| TypeScript/frontend | Build passes; new recovery/opt-out tests 2 pass; local playback tests 3 pass | Source synchronized; frontend not run here |
| Package separation | Signed debug app inspection passes: no server/Soloist/virtual audio driver bundled | Standalone server remains independent |
| Static checks | libudx Clippy passes with `-D warnings`; net has one existing advisory; diff and sensitive-content guards pass | C helper builds with warnings as errors |

The Mac full Desktop Rust suite reports 50 passed, one pre-existing failure, and one ignored test. The failure is `native_audio::tests::releasing_a_paused_device_does_not_reopen_the_song`, which expects the decoder to be absent even though the existing implementation deliberately retains decoder/PCM when releasing a paused device. That behavior and test were not changed.

The original frontend startup suite has two failures on a temporary clean-HEAD copy: runtime app-mount stability and shared-server switching. The changed suite retains the same two failures, with ten passing tests including the two new regressions. They were not hidden by changing assertions or weakening playback checks; DOM identity comparisons use equivalent boolean checks to keep failure logs bounded.

Kubuntu's default group-writable test-file creation initially causes six unrelated Soloist fixture validation failures. Tightening **only the test subprocess's umask to 022** removes those six failures without weakening executable validation or changing host configuration. The remaining Linux failure is the unchanged `write_behind::tests::write_behind_benchmark`: it reads the asynchronous output before that file exists on this machine. The full Linux suite is not green. All networking, authentication, listener recovery, and server playback recovery tests pass.

## Installed state, preservation, and remaining work

Only the small ICMP helper is installed system-wide. New server and signed Desktop debug executables are built from the changed source and used in isolated physical tests. The normal installed Desktop, existing server process, user libraries, provider credentials, pairing profiles, routes, and Wi-Fi/hotspot associations are preserved. Test servers are stopped after use; the reusable harness also imposes a ten-minute server lifetime if administration disappears. Private test profiles/logs remain outside the repository. The original Kubuntu stash and private backup remain available.

The upstream pwnat documentation reviewed is pinned to [3a032f9](https://github.com/samyk/pwnat/blob/3a032f9b369d59d98c75842fb7b17033bbb46325/README.md). Its documented NAT compatibility limits agree with the observed conditional results. No upstream C implementation is copied into Ambra.

Further qualification should prioritize longer managed playback tests with packet captures during an actual radio outage, per-stream retransmission counters, additional physical NATs, and provider FLAC/CDN startup/seek behavior. No physical Windows/mobile, IPv6 traversal, or arbitrary restrictive-network guarantee is made. The implementation adds no mandatory relay, subscription, VPN, or forwarding requirement.

Code and sanitized evidence are synchronized on both machines. After the investigation, the user authorized committing and pushing this checkpoint. No production service replacement is performed. Remove the optional helper with the documented installer `--uninstall` command if no longer wanted. Preserve the original Kubuntu stash and private backup rather than applying them over this investigation.
