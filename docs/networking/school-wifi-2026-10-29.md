# School Wi-Fi: native TCP peer connectivity demonstrated

## Answer and qualification

**Yes: these two machines can exchange Ambra's authenticated, encrypted application data over the school's native Internet connection, without WARP, a Tailscale data path, port forwarding, or an application relay.** The demonstrated method is coordinated TCP simultaneous opening toward the home laptop's public **TCP/443** candidate. The Mac uses an ordinary unprivileged source port. Both peers keep the source port used for TCP STUN and initiate connections to the exchanged public candidates at the scheduled time.

The existing Ambra Noise and HTTP/2 stack transfers **94 MiB in 30.393 seconds** and, on a fresh connection, **196 MiB in 60.555 seconds**. The second run completes 208 concurrent control polls. WARP is disconnected and the Mac Tailscale backend reports stopped during native setup; the peer routes are `en0` and `wlo1`. Captures show the public peer socket traffic on both computers and thousands of matching encrypted payload prefixes.

**This is an experimental transport demonstration, not a shipped automatic fallback.** A small adapter on each endpoint connects the established public TCP socket to an isolated Ambra fixture. It reuses Ambra's existing identity-pinned Noise, HTTP/2, authorization header and byte-exact streaming workload. It does not change production transport selection, relax LAN/overlay policy, or expose a new production API. Fresh production pairing, the real desktop player, mobile operation and hours-long reliability are not qualified here.

The network also rewrites TCP sequence numbers and acknowledges some SYNs before the other physical endpoint sees them. A SYN proxy or other TCP middlebox is present. “Native peer connectivity” here means peer-authenticated application data over the existing physical Internet path, with no configured application relay or VPN. **An unmodified, middlebox-free end-to-end TCP handshake is not claimed.** That distinction matters when interpreting unusually fast `connect()` results.

Machine-readable measurements, timestamps, endpoints and limitations are in [the evidence file](results/school-wifi-2026-10-29/evidence.json). The [throughput figure](results/school-wifi-2026-10-29/throughput.html) compares individual observed runs; it is not an interleaved performance experiment.

## Environment and preservation

Testing took place on October 29, 2026. Timestamps in the evidence are Unix seconds or UTC logs.

| Item | School Mac | Home Kubuntu |
|---|---|---|
| Physical interface | `en0` | `wlo1` |
| Physical IPv4 | `10.29.33.171` | `192.168.86.220` |
| Gateway | `10.29.33.1` | `192.168.86.1` |
| Public TCP candidate | `208.58.177.214` | `74.104.161.161` |
| Public UDP STUN candidate | `209.6.175.114` | `74.104.161.161` |
| Global IPv6 on physical interface | None | None |
| Starting Git HEAD | `5c8633f` | `ffd5e3446fd2242b089f75326b86a276fc637594` |

Both checkouts start clean. Both fetch remote references; neither resets, overwrites local work, changes branches or pushes. The networking libraries have no committed source difference between these two revisions. The Mac's new changes remain experimental tools, one fixture option and this report. The home checkout remains clean. No applicable `AGENTS.md` exists in the checked repository/ancestor paths.

The earlier cross-network, autonomous and HoleSail architecture reports, current HyperDHT implementation, manager, TCP/Noise adapter and pwnat implementation were reviewed. Existing playback, pacing and bootstrap recovery fixes were preserved.

SSH uses `llewyn@100.95.127.9` through Tailscale only for preparation and collection. Tailscale reports DERP `nyc` for management. No SSH port forwarding, SSH data pipe, router change, firewall change, global networking sysctl or security disablement is used. The normal installed server remains untouched. Test identities, private keys, credentials, captures and builds stay in private temporary directories outside Git.

## 1. Confirmed restrictions and observations

### UDP reachability is selective and changes during the session

Native Google STUN on UDP/19302 and Nextcloud STUN on UDP/443 answer in successful observation windows. Typical measured RTTs are about 17–24 ms and 102–149 ms respectively. The same socket observes the same school public IPv4 and source port across those two destination paths. The two Google hostnames sometimes resolve to the same IP; they are not counted as independent destination addresses.

The same Nextcloud IP, `46.225.95.169`, answers native UDP/443 but not native UDP/3478. Home answers UDP/3478. Cloudflare STUN on UDP/3478 also answers home and WARP, but not school in these samples. This establishes different reachability by destination path/port. It does not identify a particular firewall rule or device.

Several later native windows lose even the normally successful STUN replies. Replies subsequently return, including before the final synchronized native tests. These timeouts are retained. There is no evidence sufficient to attribute the variation to a rate limit, intrusion prevention, AP behavior or a particular NAT. A timeout is not automatically called packet loss.

Binding UDP source port 443 requires the temporary descriptor launcher. Google STUN/19302 does not answer that source port on **either** physical network, while Nextcloud/443 does. That specific failure cannot be attributed to school filtering.

### Approved STUN ports do not provide arbitrary peer UDP

The strongest UDP comparison uses fresh, same-socket STUN candidates, an out-of-band exchange before disconnecting management, synchronized peer processes and captures at both physical interfaces. It tests four socket pairs:

| School public candidate | Home public candidate |
|---|---|
| `209.6.175.114:58562` | `74.104.161.161:42924` |
| `209.6.175.114:443` | `74.104.161.161:443` |
| `209.6.175.114:19302` | `74.104.161.161:19302` |
| `209.6.175.114:49737` | `74.104.161.161:49737` |

For each pair, each machine emits **45 authenticated STUN Binding requests and 45 opaque HMAC probes** during the recorded 45-second window. The traffic is paced at one request per second per payload type. Neither physical receiver capture sees a peer probe. That is **360 probes emitted from each machine, zero observed at the opposite physical interface**. Six additional full-ICE STUN requests in each direction also receive no peer answer.

This is stronger than bootstrap failure: changing the port, exchanging candidates independently of the DHT and sending genuine STUN checks to the peer still does not establish UDP. It does **not** prove that a school IP allowlist alone caused the failure. Both captures are behind their NATs; destination-dependent translation or filtering at either edge remains possible. No router WAN capture or school firewall policy is available.

The capture also contains separately identifiable background Tailscale UDP discovery packets on 41641 despite the CLI reporting stopped. They are excluded from these probe totals. The successful Ambra experiment uses public TCP peer sockets on physical interfaces, not those discovery packets or an overlay data path.

### NAT and established mappings

Native STUN samples show port preservation and no destination-dependent mapping across the responding Google/Nextcloud paths. This is an observation, not a complete RFC 5780 classification. In particular, the public mapping for an unanswered destination cannot be observed.

RFC 5780 same-IP alternate-port probes add a useful limitation: the first requested response from an uncontacted alternate port also times out at home. After explicitly contacting UDP/3478, home receives its normal response and a requested alternate response from 443. This is consistent with endpoint-dependent filtering; it prevents claiming that home is an unrestricted full-cone NAT. School still does not answer a normal request to 3478. The server advertises the same IP at its alternate port, so address-dependent filtering cannot be fully classified.

### TCP works under a specific controlled configuration

Fresh TCP STUN on Nextcloud TCP/443 reports source-port-preserving candidates on both machines. Reusing those local ports for a listener and outgoing connection, with `SO_REUSEADDR`/`SO_REUSEPORT`, establishes an authenticated stream when **both peers initiate toward each other** and home uses public TCP/443.

Two controls fail:

* **Passive home listener, TCP/443:** the Mac reports a TCP connect, but its authenticated exchange times out; home receives no corresponding connection. Passive listening after TCP STUN is insufficient.
* **Mutual opening, home TCP/48500:** fresh candidates and the same Noise fixture fail. Captures show school SYNs leaving and home SYNs leaving, with none reaching the other physical interface during the bounded observation. This tests one high port, not every high TCP port.

The positive source-port controls matter: the Mac succeeds with source 443, then with unprivileged sources **48504, 48505 and 48511**. A privileged Mac application is unnecessary. Home must bind source/listener port 443 for the demonstrated configuration.

An early, unsynchronized plaintext attempt reaches an HTTP endpoint returning `HTTP/1.1 400 Bad Request`, not the authenticated peer. Later **synchronized Noise-only** connections succeed. Therefore the early HTTP response does not prove a TLS-only content rule. Synchronization, NAT state and authenticating the actual peer are essential.

### QUIC and IPv6

Native HTTP/3 to Google completes with TLS verification and ALPN `h3` at `216.239.38.120:443`. Its 404 response is a successful transport control: that URL is absent, but HTTP/3 works. The test forces IPv4, avoiding an earlier inconclusive automatic-address-family timeout.

A genuine QUIC connection to the home laptop's UDP/443 fails after eight seconds despite fresh same-socket candidates and outbound punching. Seven client QUIC datagrams leave the Mac in the recorded window; none is seen at the home physical receiver. Thus QUIC support at an approved public destination does not establish arbitrary peer QUIC reachability.

Neither physical interface has a global IPv6 address. Overlay and link-local IPv6 addresses are not viable native cross-network candidates here. No IPv6 connectivity success is claimed.

## 2. WARP findings

Initial mode is `Warp`, with MASQUE configured for HTTP/3 and HTTP/2 fallback; WARP starts disconnected. No DNS-only or local-proxy mode is selected.

During the successful HyperDHT comparison:

* The peer route changes from `en0` to `utun11`; MTU changes from 1500 to 1280.
* `warp-cli tunnel stats` reports **MASQUE (HTTP/2)** to **162.159.198.2**, using TLS 1.3.
* Cloudflare's trace reports `warp=on` and HTTP public IP `104.28.203.246`.
* STUN and the home HyperDHT accept logs observe peer IP **104.28.235.246**. Actual accepted peer ports include 49437, 49552, 49580 and 49307.
* An inner-interface capture contains DHT/peer UDP. The physical capture contains the outer Cloudflare connection. The tunnel counters increase to approximately 4.6 MB sent and 95.2 MB received.

HyperDHT completes **3/3 fresh fixture connections**, taking 25.608, 7.880 and 4.966 seconds, with verified 2 MiB downloads. An independent streaming connection transfers **80 MiB in 30.692 seconds**, or **2.607 MiB/s**, with 85 successful concurrent polls.

WARP does not simply produce a more permissive NAT. The same UDP socket gets different mapped ports for Google, Nextcloud and Cloudflare under WARP, whereas successful native samples preserve the port across the responding paths. WARP changes the route, egress network and encapsulation. The DHT and peer UDP no longer cross the school edge as native packets addressed to those UDP destinations.

A later WARP TCP control reports **MASQUE (HTTP/3)** to the same Cloudflare tunnel endpoint. Therefore WARP is not universally converting UDP to TCP, and the school does not universally prohibit QUIC. Both outer tunnel modes are observed. The common difference is that traffic travels through the allowed Cloudflare tunnel/path and its egress network.

The resulting HyperDHT stream remains end-to-end Noise authenticated and no Ambra data relay is enabled. However, **Cloudflare forwards the underlying traffic**. It does not satisfy the native objective. An inner public peer endpoint or `data relay disabled` log alone is insufficient to call that result native.

The TCP simultaneous-open WARP comparison does not authenticate. Its candidate is collected through WARP, management is restored to exchange it, and WARP reconnects before the check. The evidence explicitly marks this reconnect/candidate caveat. Combined with observed destination-dependent translation, this is **not a definitive failure of every TCP traversal method under WARP**. The successful native TCP runs do not have that caveat.

## 3. Methods and implementations tested

| Method | Implementation and result | Classification |
|---|---|---|
| Current HyperDHT/UDX | Existing Rust diagnostics, three configured bootstraps, fixture client/server; native `BootstrapFailed`, WARP succeeds | Working through WARP; native failure |
| Out-of-band UDP punching | `path_probe.py`; real STUN and HMAC payloads on four exact peer socket pairs | Native failure with synchronized captures |
| Full ICE over UDP | `ice_probe.py`, aioice 0.10.2; controlling/controlled roles, actual STUN candidates, only global remote candidates, no TURN | Both native agents time out after 20 s |
| Direct peer QUIC | `quic_probe.py`, aioquic 1.7.0; actual socket STUN, pinned certificate, HMAC client admission, UDP/443 | Native handshake fails; no data throughput |
| Public QUIC control | Verified HTTP/3 to Google over IPv4/443 | Native success; not peer connectivity |
| pwnat | Existing `pwnat_probe` and raw-ICMP launcher; isolated fixture, explicit public endpoint | Native and WARP fail at `quic_connect` |
| TCP/443 with outer TLS | `tcp_punch.py`; TCP STUN, scheduled mutual opening, pinned TLS and HMAC admission | Native encrypted data success |
| TCP/443 with Ambra Noise | Same opening mechanism; endpoint-local adapters carry existing Ambra Noise/HTTP2 | Native success; preferred experimental result |
| Passive TCP/443 | Same fixture and candidates, home outgoing dials disabled | Fails authenticated exchange |
| Mutual TCP/48500 | Same fixture, fresh candidates, unprivileged home port | Fails; no cross-interface SYN delivery |
| IPv6 | Physical interface/routing inspection | No global physical candidate |

Full ICE here means the aioice UDP state machine, not only a hand-written STUN request. The TCP prototype implements simultaneous-open primitives; it is not presented as a complete RFC 6544 ICE-TCP implementation.

Pwnat's former local privilege problem is resolved for testing: the existing helpers open raw ICMP and drop root. Each client attempt emits 17 ICMP signaling requests according to its socket-level counter, then reaches the five-second QUIC deadline. The home fixture emits Echo requests without send errors but accepts zero valid ICMP quotations and sends zero UDP punches. This does not locate the ICMP drop or prove every quotation reached the physical wire. Extra privilege is not a traversal solution; pwnat remains optional and disabled by default.

Custom bootstrap support exists in `HyperDhtConfig.dht`, but the transport remains UDP/UDX. No authorized, independently reachable public bootstrap on another path is available for deployment. A new bootstrap at home is not promoted as a solution when direct, separately signaled UDP/443 checks already fail. A successful bootstrap would still need a successful peer data path. HoleSail/Hypercore reuse HyperDHT/UDX traversal; their transport maturity does not turn these UDP failures into TCP connectivity.

## 4. Best demonstrated solution and performance

The simplest successful experiment uses **existing Ambra Noise over coordinated public TCP/443**, without outer TLS. The endpoint-local adapters add no third-party data hop. SSH is disconnected on the Mac for native tests and is never the fixture data carrier.

The data chain is: Mac Rust HTTP/2 client; existing pinned Noise; Mac loopback adapter; public TCP peer socket; home loopback adapter; independent home Rust Noise/HTTP2 fixture. The benchmark's existing `lan_noise_http2` label describes its endpoint-local adapter entry, **not the physical network topology**. The public TCP captures, peer logs, identities and network-state manifests establish the cross-network path.

| Individual observed run | Verified data | Duration | MiB/s | Poll p50 / p95 / p99 |
|---|---:|---:|---:|---|
| Native TCP, Noise, Mac source 48505 | 94 MiB | 30.393 s | 3.093 | 183.5 / 449.8 / 922.4 ms |
| Fresh native TCP, Noise, Mac source 48511 | 196 MiB | 60.555 s | 3.237 | 178.1 / 271.9 / 342.5 ms |
| Native TCP/TLS, Noise, Mac source 48504 | 96 MiB | 30.347 s | 3.163 | 191.7 / 288.1 / 484.5 ms |
| WARP HyperDHT/UDX | 80 MiB | 30.692 s | 2.607 | 230.3 / 487.8 / 695.5 ms |

All bodies are exact 2 MiB fixtures and check every byte. Poll handlers deliberately wait 100 ms. These sequential debug runs use different times and Python adapters; they do not establish a universal TCP performance advantage.

The 60-second native run has **208 successful polls**, no poll error, one body gap above 250 ms and a maximum gap of **289.8 ms**. The 30-second Noise run has 96 successful polls and a maximum gap of 264.2 ms. Initial HMAC exchange RTTs are 205.1 and 246.5 ms; these include setup/middlebox effects and are not steady-state path RTT estimates.

A separate paced TLS test sends **5,120,000 exact bytes**, nominally 2.048 Mbit/s, over 20.576 seconds. The largest receive gap is 174.5 ms. It demonstrates sustained audio-sized encrypted traffic, not actual acoustic playback.

Home kernel sampling during the long native run reports six retransmissions, 6,755 retransmitted bytes and six DSACK duplicates. A late sample reports RTT `14.536/3.356 ms`, minimum 7.283 ms and RTO 215 ms. Those TCP ACK measurements may describe a middlebox-facing TCP leg. They are not a proven end-to-end peer RTT or physical packet-loss percentage. DSACK also prevents treating every retransmission as actual loss.

### Path verification

Both endpoints log the selected public socket tuple. The Mac route is `en0` through its school gateway; the home route is `wlo1` through its home gateway. The Noise fixture pins the independent home identity and checks authenticated responses and exact bodies.

For the native Noise run, bounded captures share **8,895 distinct 32-byte home-to-Mac payload prefixes** and 38 in the reverse direction. The separate TLS pacing captures share 1,773 home-to-Mac prefixes. This matches the actual peer payload across both physical captures, not merely a discovery record or a SYN/ACK.

TCP sequence numbers differ between the two captures; the network performs sequence translation/proxying. Captures intentionally stop at a packet budget and do not cover every saturation byte. Matching-prefix counts are path evidence, not packet delivery ratios. Failed-run comparisons must also restrict time and socket pairs: an early local capture-cleanup defect allowed a bounded capture to continue into a later control. The harness now signals the entire isolated capture process group, and final checks find no capture process left running.

## 5. Recommended Ambra changes

1. **Keep HyperDHT as a direct UDP option. Add a native TCP candidate path.** Introduce a responsible TCP connector/listener module in `crates/ambra-net/src/`, using the installed `socket2`, Tokio and existing `transport::secure`/`HttpConnection`. Do not weaken `lan::is_local` or overlay rejection to make public TCP look like LAN. Do not add outer TLS merely because the first successful test used it: Noise-only works.
2. **Separate signaling from the data socket.** Publish short-lived, identity-bound TCP candidates through an HTTPS rendezvous/control path independent of blocked DHT bootstrap. Discover TCP candidates using TCP: the school's UDP STUN public IP is different and must not be reused as a TCP hint. Exchange source ports, candidate generation, expiration and a coordination budget. The demonstrated SSH signaling is a diagnostic mechanism, not a production requirement. A control rendezvous is not an application-data relay.
3. **Own socket lifecycle and cancellation centrally.** Extend `manager.rs`'s existing bounded connection race with a distinct TCP method. Preserve pinned server identity, normal pairing/device authorization, session supersession, HTTP/2 reuse, cancellation and no mutation replay. Fresh reconnects need fresh candidates/source ports; observed `EADDRINUSE`/`EADDRNOTAVAIL` during repeated identical tuples are local socket-state failures, not firewall measurements.
4. **Give the server an explicit restricted-network TCP/443 capability.** Extend supervised listener ownership in `server/src/p2p.rs`. Home currently has an unprivileged-port floor of 1024. The experiment opens a finite pool of port-443 sockets in a one-shot helper and drops to UID 1000 before running the probe. Production needs an explicitly approved installation/binding mechanism, port-conflict handling and replenishable socket ownership. Do not run Ambra as root or lower the host's global privileged-port threshold. No permanent capability or helper installation is made here.
5. **Use ICE principles where they solve a measured problem.** Candidate exchange, checks, nomination, peer-reflexive discovery and consent are useful. Adding UDP ICE alone does not solve the observed school path. A complete ICE-TCP solution may be appropriate, but the successful prototype is not yet that implementation. Prefer maintained traversal primitives and bounded coordination over extrapolating a port-prediction algorithm from a few mappings.
6. **Retain an optional encrypted relay for other restricted networks.** Prefer LAN, successful direct UDP and demonstrated direct TCP candidates. A relay remains necessary when neither path is viable, but it is not required by the successful native experiment and does not count as its success.

The code added in this investigation is deliberately outside production selection. The networking-library source, production authorization, existing transports and user profiles are unchanged.

## 6. Remaining obstacles and confidence limits

The positive conclusion is narrower than “TCP always works”: it concerns these physical networks, current public addresses, home TCP/443, exchanged candidates and mutual opening. Two independent Noise-only native streams, one Noise-over-TLS native stream and one paced TLS native stream pass. The management-mode Noise control also passes. These are useful repeated observations, not a statistically established long-term reliability rate.

Passive listening and one high-port TCP control fail. The precise NAT/firewall rule, source of sequence translation and TCP proxy behavior require edge-device visibility or network-operator logs. It would be incorrect to conclude that all school UDP, all QUIC, all high ports, or all alternative ICE candidate pairs are blocked.

Production still needs automatic authenticated signaling, TCP socket lifecycle/reconnect integration, server port-443 permission handling, real pairing and desktop/mobile qualification. The required synchronization tolerance and robustness to clock skew are not measured; success at a scheduled time does not prove millisecond synchronization is necessary. Network roaming, hours-long audio, outage recovery, many NAT combinations and contention for port 443 remain untested. A mobile client should not need privileged binding, but physical mobile qualification is absent.

## 7. Reproduction

### Build isolated fixtures

Use a private target directory and limited build jobs on each computer. Do not replace the installed server or invoke root application packaging.

```sh
export CARGO_TARGET_DIR=/tmp/ambra-school-build
export CARGO_INCREMENTAL=0 CARGO_PROFILE_DEV_DEBUG=0
cargo build --manifest-path crates/ambra-net/Cargo.toml -j 2 \
  --example hyperdht_server --example streaming_bench \
  --example connection_bench --example network_diagnose --example pwnat_probe
```

Build the same examples in `~/ambra` on Kubuntu while WARP is disconnected and Tailscale management works. `hyperdht_server --loopback` is an isolated authenticated fixture, not the installed music server.

### Run the automatic physical harness

Supply `REMOTE_SUDO_FILE` and, for captures, `LOCAL_SUDO_FILE` through a private credential prompt. Files must be private and outside the repository. Never put passwords in command arguments, documentation or Git. The harness creates private evidence directories, stages helpers outside the remote checkout, switches network modes, schedules both peers, runs the existing Rust fixture workload, collects logs and stops its processes. It leaves WARP off and Tailscale on.

```sh
python3 scripts/network-interop/cross-network-tcp.py \
  --host llewyn@100.95.127.9 \
  --local-bind 10.29.33.171 --remote-bind 192.168.86.220 \
  --client /tmp/ambra-school-build/debug/examples/streaming_bench \
  --remote-fixture /tmp/ambra-school-build/debug/examples/hyperdht_server \
  --remote-sudo-file "$REMOTE_SUDO_FILE" \
  --local-sudo-file "$LOCAL_SUDO_FILE" \
  --mode native --payload noise --mac-port 48511 --seconds 60
```

Choose a fresh free Mac source port after a recent run. Do not reuse a four-tuple still in TCP TIME_WAIT. Update physical bind addresses after changing networks.

The controlled variants use the same command with:

* `--passive`: disable home outbound opening; negative control.
* `--remote-port 48500`: high-port control; no privileged server bind.
* `--payload tls`: outer certificate-pinned TLS around the same Noise fixture.
* `--mode management`: Tailscale enabled, WARP disabled; public fixture sockets remain separate from SSH.
* `--mode warp`: Tailscale disabled for data testing, WARP enabled. Read the manifest's reconnect/candidate caveat before interpreting a failure.

`--local-sudo-file` is optional if captures are not wanted. It is required to reproduce the packet-level evidence. No low-port Mac bind is required by this harness. The home `tcp443-launch.py` creates ten bound sockets, drops root and executes the probe; it is not installed setuid and adds no daemon.

### Other diagnostics and evidence interpretation

```sh
python3 scripts/network-interop/stun-behavior.py --bind 10.29.33.171
/tmp/ambra-school-build/debug/examples/network_diagnose --include-addresses
python3 scripts/network-interop/test_path_probe.py
cargo test --manifest-path crates/ambra-net/Cargo.toml --lib --tests
```

`path_probe.py --help` documents private shared-key configuration, explicit binds, ready/peer files, bounded duration and scheduled start. Exchange signaling atomically before disabling management. `udp443-launch.py` provides an optional one-shot privileged UDP bind with a non-root child.

Full UDP ICE and QUIC diagnostics require test-only packages in an isolated virtual environment: `aioice==0.10.2`, `aioquic==1.7.0`. No production dependency is added. ICE ready files contain temporary credentials and must remain private. QUIC exchanges a public certificate; its private key stays on home. A failed candidate-preparation run is not a failed transport test.

Inspect public socket tuples in both event logs, the recorded route/interface and the two physical captures. A `connected` event alone is insufficient; require authenticated peer data and exact fixture completion. Do not count the benchmark's loopback adapter label as proof of either LAN or cross-network transport. Do not infer physical packet loss from unanswered probes, retransmissions, or budget-limited captures.

## Validation and final state

* Existing Ambra-net gate: **22 unit, four direct-only and 15 native integration tests pass**.
* STUN RFC 5769 authentication vector, malformed/truncated authentication and partial/atomic signaling tests: **four pass**.
* Diagnostic Python compilation, Rust fixture check and `git diff --check` pass.
* A focused process-group regression verifies that both the sudo monitor and its root capture child stop. A credential-exclusion check passes for all task files.
* Invalid early runs are excluded: partially written signaling, missing/unavailable candidate preparation, unsupported TLS 1.3 in Apple's old Python, and a diagnostic whose last DHT pings straddle WARP activation. The later pings are classified as WARP-assisted.
* No normal server, library, identity, pairing profile, route policy, router setting or firewall protection is replaced or disabled. Only temporary test processes run privileged bind/capture steps.

**Final networking: WARP disconnected; Tailscale enabled for management.** The public home route is again `en0`; home retains `wlo1` and Tailscale administration. Final process checks find no investigation probe or capture still running.

Private raw evidence remains under `/tmp/ambra-school-20261029` and the harness-generated `ambra-tcp-*` temporary directories on both computers. These include captures and temporary fixture credentials and must not be committed. The sanitized JSON is sufficient to inspect reported outcomes without those credentials.

## Primary references

* [RFC 8445: ICE](https://www.rfc-editor.org/rfc/rfc8445.html)
* [RFC 6544: TCP candidates and simultaneous open](https://datatracker.ietf.org/doc/html/rfc6544)
* [RFC 5780: NAT behavior discovery](https://www.rfc-editor.org/rfc/rfc5780.html)
* [RFC 5769: STUN test vectors](https://www.rfc-editor.org/rfc/rfc5769.html)
* [Cloudflare WARP modes](https://developers.cloudflare.com/warp-client/warp-modes/)
* [Cloudflare client firewall/tunnel endpoints](https://developers.cloudflare.com/cloudflare-one/team-and-resources/devices/cloudflare-one-client/deployment/firewall/)
* [pwnat upstream and its conditional NAT assumptions](https://github.com/samyk/pwnat)

Earlier context: [October 28 cross-network report](cross-network-2026-10-28.md), [autonomous investigation](autonomous-2026-10-28.md), [October 29 optimization report](autonomous-p2p-overnight-2026-10-29.md), and [HoleSail architecture review](../ambra-p2p-performance-and-holesail-architecture.md).
