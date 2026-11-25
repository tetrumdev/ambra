# Networking validation

These are historical measurements from isolated Ambra fixtures and physical tests. Each result describes the tested transport and topology. Throughput and timing depend on the network, traffic mix, and build profile.

## HyperDHT and UDX

A physical separate-network test paired Desktop with an independent Linux server, resumed after reconnect, and verified lossless WAV responses and byte ranges. Limiting UDP payloads to 1,472 bytes on a 1,500-byte IPv4 path resolved fragmentation and stalled transfers. Reusing the encrypted enrollment connection avoided competing sessions with the same device key.

Same-router release-build tests used pinned Noise sessions and 2 MiB transfers. They exercised public discovery and NAT hairpinning.

| Metric | Before | After |
| --- | --- | --- |
| Completed rounds | 2 of 4 | 10 of 10 |
| Cold connection, one observation | 4,481 ms | 5,664 ms |
| Successful warm connection, p50 / p95 | 1,405 / 1,405 ms, one success | 488 / 523 ms, nine successes |
| 2 MiB throughput, p50 / p95 | 0.421 / 0.429 MiB/s | 0.433 / 0.454 MiB/s |

The modified Linux and macOS fixtures completed twelve 256-socket allocation rounds each. The Linux baseline exhausted resources at 246 sockets during round four. Lifecycle fixes stopped unused background tasks and released connections and sockets on failure or cancellation. The samples support improved warm reliability and resource cleanup. Cold setup and transfer throughput varied.

### Separate-network pacing and playback

Windows-to-macOS tests found four throughput bottlenecks in UDX: ACK-gated writes, RTT samples taken from the start of a burst, pacing credit lost while the scheduler slept, and the Windows timer interval. The adaptive write path reached 0.44 MiB/s, compared with 0.24 MiB/s originally. A fixed 1 MiB write size reached 0.47 MiB/s while raising the fixture’s p95 control latency from 1.271 to 3.152 seconds. The adaptive path kept p95 at 1.381 seconds.

The October 29 matched debug workload measured the effect of pacing changes during encrypted HTTP/2 transfer and concurrent control requests.

| Metric | Baseline | Updated pacing |
| --- | --- | --- |
| Transfer rate | 0.508 MiB/s | 2.376 MiB/s |
| API latency, p50 | 514.3 ms | 289.7 ms |
| API latency, p95 | 622.1 ms | 762.4 ms |
| Body delivery gaps over 250 ms | 1 | 17 |

An earlier separate-network run transferred 44 MiB at 0.469 MiB/s before the October 28 changes and 0.488 MiB/s afterward. The smaller gain reflects a different revision and workload.

The final physical run after the stream close-notice fix verified five fresh reconnects, six exact WAV transfers, and 20 native-confirmed controls. Median WAV transfer time fell from 19.564 to 3.486 seconds. Median fresh authenticated reconnect was 2.475 seconds, compared with 2.261 seconds originally. The final 45-second playback sample reported zero post-start buffering samples and zero cumulative underruns. Probe peak RSS rose from 36,560 to 62,320 KiB.

A separate stress run completed all twelve authenticated connections across four concurrent fixture clients. Its subsequent 120-second single-stream stage transferred 314 MiB at 2.609 MiB/s while completing 307 API polls. The p50 and p95 poll latencies were 257.4 and 479.6 ms. Network conditions and workloads differed from the matched pacing test.

## Other remote transports

| Method | Observed result | Test limits |
| --- | --- | --- |
| [Router-forwarded TCP](public-tcp.md) | The public listener required authenticated admission and carried the normal encrypted API and audio traffic. | Depends on the router and upstream connectivity. |
| [Nostr-signaled TCP](nostr-tcp-p2p.md) | Nine of nine physical TCP connections in three batches. The final five-round batch authenticated in 3.509–4.305 seconds and transferred 1.713–3.466 MiB/s. | One physical network pair. Windows WAN, mobile device, and roaming coverage was incomplete. |
| [pwnat](pwnat.md) | A compatible isolated NAT fixture passed end-to-end. A physical hotspot-to-home test stopped before QUIC setup because no ICMP quotations reached the server. | Requires compatible NAT behavior and raw ICMP on each participating host. |
| [Tailcat](tailcat.md) | Seven authenticated DERP audio runs transferred exact bytes at 0.415–2.409 MiB/s. In a same-session comparison, three native TCP runs reached 4.663–5.312 MiB/s. | Short, bounded transfers. No direct Tailcat upgrade was observed in the 45-second physical observation. |

A restricted-network report recorded selective UDP reachability and successful native TCP on a particular network pair. Treat each result as evidence about that route. The authenticated handshake and verified application bytes established the working path.

Tailcat qualification also covered authorization failure, offline deadlines, ranges, uploads, and replacement by a native transport while a response was in flight. At the time, physical iOS and Android execution and sustained relay playback remained open.

## Reproduce with your own fixture

Run the automated transport and server tests from the repository root.

```sh
cargo test --locked --manifest-path crates/ambra-net/Cargo.toml
cargo test --locked --manifest-path server/Cargo.toml
cargo test --locked --manifest-path crates/ambra-mobile-bridge/Cargo.toml
```

The [network smoke test](../../scripts/test-native-network.py) uses the real server and client with isolated state. The [interop scripts](../../scripts/network-interop) and [native examples](../../crates/ambra-net/examples) exercise individual paths. Early public DHT interoperability passed Rust-to-Node exact echo and Rust-to-Rust HTTP/2. The Node-to-Rust transport handshake passed, but the Node harness stalled during the HTTP/2 stream.

For physical reports, record the platforms, selected transport, topology, build profile, fixture size, sample count, latency percentiles, and integrity checks. Store raw logs and test configuration privately.
