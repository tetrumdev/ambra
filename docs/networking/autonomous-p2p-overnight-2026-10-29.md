# Autonomous P2P optimization — October 29, 2026

## A. Executive summary

Ambra's Rust HyperDHT transport now preserves pacing credit earned while the scheduler sleeps. On the actual Mac hotspot to Kubuntu home Wi-Fi path, the matched 90-second encrypted HTTP/2 workload improved from **0.508 to 2.376 MiB/s (4.67×)**. A complete 10,584,044-byte WAV transfer fell from a median **19.564 seconds to 3.170 seconds** in the six-transfer playback qualification preceding the final reconnect fix. These are measured debug-build results, not release estimates.

Server and native desktop preparation are interruptible. Pause, seek, skip and output changes no longer need to wait for a stalled remote load. Endpoint generations and cancellation prevent stale completions from replacing newer playback intent. Initial ranges and HLS resources become readable progressively, without increasing request sizes. Mobile ownership checks avoid redundant full queues, and polling releases foreground listeners.

Saturation still exposes transport limitations: the 90-second optimized run's API median improved from 514 to 290 ms, but its p95 increased from 622 to 762 ms and p99 reached 1,453 ms. Native UDX remains faster on the same workload. No claim of universal LAN parity, controlled improvement in native startup time, or user-verified audible quality is made.

The retained automation pairs isolated identities, transfers exact synthetic WAV data, operates the real desktop output, samples playback, exercises controls and restarts its private server. It preserves normal pairing and authorization; no unauthenticated production control endpoint was added.

## B. Architecture findings and decisions

The [primary architecture report](../ambra-p2p-performance-and-holesail-architecture.md) was read completely before editing, alongside the October 28 investigations. Each of its eight concrete findings still existed at `bd9841e`:

| Finding | Implementation and verification | Status |
|---|---|---|
| §3.1: session operation mutex spans remote I/O | `OutputOperation` releases the lock around endpoint/provider waits; command epoch and endpoint instance fence completion. Cancelled endpoint waiters unregister synchronously. Slow-load and provider-retry races reproduce the old block and pass after correction. | Implemented |
| §3.2: calculated pacing deadline replaced by 1 ms | Sender retains the computed deadline and waits for ACK/window/RTO notifications when blocked. ACK=0 window updates wake it. Measured blocked wakes fall from 44 to 1 per 100 ms. | Implemented |
| §3.3: inflight batch counted twice | Admission uses packets already registered in flight exactly once. Deterministic ten-slot test admits ten instead of five. Window limits remain enforced. | Implemented |
| §3.4: startup, probes and HLS collect complete bodies | Progressive initial/small ranges and one HLS resource at a time; complete-response caching, validated range/length, exact resume offset and HTTP 200 compatibility. Withheld-body tests return before completion. | Implemented |
| §3.5: phone refresh repeatedly transfers unchanged queues | Send known revision; fetch a full snapshot if an instance change makes the omitted queue unusable. Ownership checks remain. | Implemented; no physical phone test |
| §3.6: unchanged server queues cloned repeatedly | Cache immutable `Arc<Value>` snapshots; make owned JSON only when required by a full response. Existing queue/revision/concurrency tests pass. | Implemented; allocation/time benefit not profiled |
| §3.7: queued bytes scanned each send iteration | Exact byte counter maintained at enqueue/dequeue/cleanup; invariant and transport tests cover accounting. Outstanding packet scan remains. | Implemented; CPU benefit not separately measured |
| §3.8: foreground abort listeners retained | Remove both iteration listeners in `finally`; 100-poll regression retains zero instead of 100. | Implemented |

HoleSail's useful pattern is a persistent reusable authenticated transport, plus mature native UDX semantics. Ambra already coalesces dials, keeps a lazy DHT node and multiplexes HTTP/2. Those mechanisms were preserved. There is no tunnel per API call, Node runtime in production, bundled client server, new framing protocol or replacement encryption.

A test-only HyperDHT 6.34.1 / udx-native 1.22.0 server exposes the same byte-exact HTTP/2 fixture and 100 ms poll. Its native libudx pin is `9c9a0e7`. Inspecting upstream `update_pacing_time` confirmed that elapsed-time credit should survive scheduler delays. The Rust two-packet fixed credit ceiling discarded that credit. The fix keeps the initial two-packet allowance and bounds accumulated credit by the congestion window, while each send still observes both congestion and receive windows. Growing a window does not mint tokens; shrinking it clips existing credit. No arbitrary fixed buffer, MTU, timeout or concurrency increase was made.

The report's buffer instrumentation recommendation is implemented as `decodedBufferSeconds` and cumulative `underruns`. Existing prefetch limits remain: the physical fixture produced no native underruns, so there was no evidence justifying larger buffers. These counters measure software state, not acoustic output.

A separate control connection remains deferred. Current device authentication supersedes older sessions; another connection requires an explicit lifecycle/authorization design. HTTP/2 already supplies concurrent streams, and UDX still shares packet ordering. Blindly splitting connections would add correctness risk without isolating the measured tail cause.

Pwnat remains optional and unchanged. The existing Linux capability launcher passed its unprivileged health check. Mac raw ICMP was unavailable without new administrator authentication, which was prohibited. The earlier physical failures and simulated NAT limitations remain relevant; no new successful physical pwnat result is claimed. HyperDHT continues working independently.

## C. Code changes and regression proof

### Playback ownership and cancellation

Files: `server/src/session.rs`, `server/src/endpoints.rs`, `server/src/soloist/tests.rs`.

The session mutex previously serialized commands behind endpoint selection, load and provider retry. Waiting now releases the mutex; after reacquiring it, generation and endpoint identity decide whether a result can commit. Provider cleanup finishes joining safely rather than being abandoned halfway through cleanup. Endpoint waiter guards remove cancelled requests, and restarted instances invalidate old waiters.

A two-second delayed endpoint regression blocked the original code; after the fix, pause/next/seek completed together in approximately 23 ms. A separate provider-lock regression reproduced a Play retry blocking Pause beyond 400 ms and passes with the retry wait outside the session lock. Existing queue, gapless history, replacement, revocation and generation checks were retained.

### Native audio preparation and progressive reads

Files: `desktop/src-tauri/src/native_audio.rs`, `native_audio/decoder.rs`, `remote_endpoint.rs`.

The audio worker now observes commands while the existing preloader prepares a decoder. A newer mutating command interrupts the old preparation; cancellation is not reported as decoder failure. Repeated Play reuses pending preparation. A seek publishes its requested position before waiting, so interruption preserves the requested intent. Remote load/seek acknowledge enqueueing and report eventual status through the existing endpoint protocol.

A real HTTP fixture withheld its response body. Original Pause exceeded 400 ms; the corrected worker responded in approximately 0.025 ms in the focused run. This is a local deterministic regression, not WAN pause latency. Startup-range and HLS regressions blocked beyond 500 ms before correction and returned in approximately 11 ms afterward. Additional tests cover exact continuation, truncated resources, Content-Range corruption, HTTP 200 fallback, sequence ordering and unknown HLS content length.

Initial 128 KiB and subsequent 4 MiB request sizes remain unchanged. A seekable direct HTTP 200 source with no known length still collects its body for compatibility; that path is not fully progressive. Provider-specific FLAC and physical HLS playback were not exercised.

### Transport scheduling and lifecycle

Files: `vendor/libudx/src/native/stream.rs`, `congestion/mod.rs`, `congestion/pacing.rs`, `async_stream.rs`, `socket.rs`.

Correct window accounting and event-driven deadlines remove avoidable sender stalls/wakeups. The exact queued-byte counter removes repeated send-queue scans. Preserving earned pacing credit addresses the largest measured transfer bottleneck: a coarse-scheduler regression delivers 202 rather than 52 packets under the same rate budget.

A real private-server restart initially required 23.681 seconds to authenticate; desktop logs showed `KeepAliveTimedOut`. Dropping an established async UDX stream previously aborted its processor silently. Drop now sends a best-effort, nonblocking existing UDX DESTROY frame before local cleanup. Completed acknowledged graceful FIN is exempt. No detached send task or socket-readiness wait is introduced. If the datagram cannot be sent or is lost, the existing keepalive remains the fallback. A new regression fails before the change and receives the close notice within 200 ms afterward. This improves cooperative shutdown detection, not power-loss or blackholed-network detection.

### Mobile and maintained automation

Files: `mobile/src/client.ts`, `mobile/tests/sessionNetwork.test.ts`; `desktop/src-tauri/src/{lib.rs,network_test.rs}`; `scripts/pwnat/cross-network.py`; `scripts/network-interop/{benchmark.py,throughput-reference.cjs}`; three `crates/ambra-net/examples/*bench*`/fixture examples.

Mobile refresh reuses the existing queue-revision protocol and retains full fallback. The polling test checks 100 successful iterations and teardown; strict TypeScript checks also pass.

The debug stdin driver adds queue/next commands through normal authenticated revision-guarded APIs. Both an isolated `AMBRA_DATA_DIR` and the explicit debug test flag are required for private WebView storage. Normal startup and release configuration remain unchanged. The cross-network harness gives each server a unique ID, records executable SHA-256 values, samples native playback at a selectable interval, records accepted versus native-confirmed controls, preserves incremental evidence on failure and verifies a private-server restart. Restart explicitly resumes after authentication because existing server policy restores paused state.

The transport harness supports bounded concurrent connection tests and an encrypted TCP/Noise/HTTP2 loopback reference. Both harnesses inspect actual public authenticated endpoints and routes on both computers; a selected transport label alone is insufficient. Reference Node is a development fixture only.

## D. Before-and-after benchmarks

All Rust measurements use unoptimized debug builds with debug symbols/incremental compilation disabled. Sessions ran sequentially on the fixed hotspot/home topology, with identical synthetic payloads. Cellular conditions vary over time; these are repeated workloads, not simultaneous controlled network emulation. Five connection/control samples do not justify p95/p99 claims. API poll samples do; baseline p99 was not recorded.

| 90-second physical workload | Original `bd9841e` | Initial scheduling/accounting fixes | Earned-credit fix | Native reference server |
|---|---:|---:|---:|---:|
| Transferred MiB | 46 | 54 | 214 | 430 |
| Actual duration, seconds | 90.491 | 90.198 | 90.076 | 90.310 |
| MiB/s | 0.508 | 0.599 | **2.376** | 4.761 |
| Concurrent API poll samples | 146 | 157 | 197 | 215 |
| API p50, ms | 514.3 | 474.1 | **289.7** | 282.3 |
| API p95, ms | 622.1 | 716.2 | **762.4** | 498.6 |
| API p99, ms | Not recorded | 922.7 | **1,452.7** | 606.5 |
| Body gaps over 250 ms | 1 | 1 | **17** | 3 |
| Largest body gap, ms | 255.5 | 472.5 | **1,337.1** | 606.4 |
| Sequential connections | 5/5 | 5/5 | 5/5 | 5/5 |

Each stream verifies 2 MiB of identical bytes, while a concurrent poll includes an intentional 100 ms handler delay. The native reference uses optimized native code and Node; it is useful protocol/implementation evidence, not a fair release-language comparison. Its speed gap remains unresolved.

The first connection in the original run was 4,699 ms; later connections were 1,824–2,147 ms. With earned credit, the first was 8,568 ms and later connections 1,876–2,026 ms. Public DHT/NAT setup did not show a consistent cold-connection gain. A warm round reuses the DHT node but deliberately opens a fresh authenticated connection; it is not a reused-HTTP/2 API measurement.

The encrypted TCP/Noise/HTTP2 **loopback** reference measured 10.530 MiB/s over 15 seconds, five connections at 12.7–15.4 ms, and 64 API polls at p50 130.8, p95 144.0, p99 158.0 ms. Its shorter duration and local path prohibit calling it a physical LAN comparison.

### Physical native playback and controls

The fixture is a deterministic 60-second stereo 44.1 kHz 16-bit WAV, 10,584,044 bytes including header. Transfers check every byte. Native playback uses the production decoder and real Mac default output. There was no human listening or acoustic capture.

The original valid desktop baseline supplied 45 one-second samples, first playing at 1,134.9 ms and no post-start buffering samples. A later optimized qualification supplied 421 samples over 45 seconds, first playing at 2,044.4 ms, no backward progress and zero reported underruns. Sampling cadence differed; earlier profiles also shared normal WebView storage and fixed server IDs. **No controlled native startup improvement is established.** Final isolation prevents that cache contamination in future tests. Transfer first-byte medians were essentially unchanged: 105.7 versus 106.0 ms.

Five operations of each type used the normal server session API and native output. The original controls run had 15 seconds warmup; the optimized run had 45 seconds. Treat this comparison as observed behavior, not an isolated causal latency estimate:

| Native-confirmed median, ms | Original controls | Optimized before close notice |
|---|---:|---:|
| Pause | 533.3 | 113.4 |
| Resume | 983.3 | 452.3 |
| Seek to 10 seconds | 783.2 | 451.0 |
| Skip to queued fixture | 221.4 | 227.9 |

These measurements distinguish API acceptance from actual native state. The skip fixture repeats the same source; different-provider track switching is unverified. Queue mutations preserve the catalog/history and use queue revision guards.

Sampled probe peak RSS increased from 36,560 KiB in the first original run to 57,664 KiB in the optimized pre-close run. These are once-per-second OS snapshots of the probe, not desktop/server memory profiles. No broad CPU or memory improvement is claimed. The sender wake reduction is a focused scheduler measurement. Packet-loss rate, per-stream retransmission/RTO totals, desktop CPU and provider resource cost were not comprehensively measured.

## E. Real cross-network qualification

Mac: `en0`, hotspot address `172.20.10.12`, gateway `172.20.10.1`. Kubuntu: `wlo1`, home Wi-Fi address `192.168.86.220`, gateway `192.168.86.1`. SSH used `llewyn@100.95.127.9` only for process/configuration/log management. Application connections used authenticated encrypted HyperDHT/UDX with public endpoints routed over `en0`/`wlo1`, excluding overlay/private transport. No network was switched and no routing/firewall configuration was changed.

The fixture tests perform ordinary approval of isolated pairing requests through the server's local management CLI, then use the resulting authenticated remote session. Identities, tokens and profiles remain private temporary artifacts and are excluded from committed evidence. Physical tests cover exact audio transfer, repeated fresh connections, concurrent API/audio, forced desktop reconnect, native playback advancement, pause/resume/seek/skip and cooperative server restart. They do not establish all NAT compatibility or long-term music playback quality.

## F. Validation and remaining limitations

- Mac server: 207 passed, one ignored. Linux server: 204 passed, one failed, two ignored; `write_behind::tests::write_behind_benchmark` fails with `NotFound`, separately retained. Linux tests ran with subprocess `umask 022`; host permissions were not changed.
- Focused UDX gate on Mac: 75 unit and 47 integration tests passed, including cancellation, network impairment, MTU, backpressure and graceful shutdown. DHT: 415 passed; swarm: 26 passed. Final close-notice integration gate is recorded in the evidence summary.
- Desktop's broader run recorded 56 passed, one failed and one ignored before the latest small diagnostics addition. `native_audio::tests::releasing_a_paused_device_does_not_reopen_the_song` expects no decoder after output release, whereas the unchanged implementation intentionally retains decoder/PCM. This failure remains; no assertion was weakened. Final counts are recorded below after qualification.
- Mobile focused suite: seven passed; strict TypeScript check passed. Frontend production build and client/server package separation check passed. Standalone local playback is checked separately below.
- Physical pwnat, physical mobile, Windows, Linux desktop audio, provider account playback, Spotify/Qobuz behavior under impairment, FLAC seeks and actual HLS over this WAN remain unverified. Unit/source compatibility is not physical platform proof.
- No power loss, Wi-Fi transition or blackholed transport test was performed. A best-effort close datagram cannot replace keepalive in those cases. Media retry relies on existing bounded decoder recovery. Server restart restores paused state; the harness explicitly resumes it.
- The final saturation run and native reference leave meaningful UDX tail/performance work. A RACK/tail-loss-probe redesign was not attempted without packet-level causal evidence.

## G. Commits

| Commit | Purpose |
|---|---|
| `b49cd79` | Interrupt session remote preparation; fence stale completion; immutable queues; endpoint cancellation cleanup; preserve primary report |
| `cd5233d` | Correct UDX pacing deadlines, full-window waking and exact window/queue accounting |
| `87d2229` | Avoid duplicate mobile queues and retained polling listeners |
| `6569d09` | Keep native controls responsive while decoder prepares; expose buffer/underrun state |
| `f2eb67d` | Progressively stream initial ranges and HLS, validate and resume resources |
| `2c4b392` | Preserve pacing credit across scheduler delays within the current window |
| `ab6571c` | Release session lock around provider retries and reject stale results |

Commit `755b80f` adds the verified best-effort UDX close notice. Later qualification, automation and cleanup commits are listed in the final addendum. Both repositories are synchronized by fast-forward Git bundle; existing Kubuntu stashes are preserved. No push or history rewrite is performed.

## H. Future recommendations

1. Capture packet-level delivery, ACK/SACK, RTO and scheduler traces under matched WAN impairment. Compare native UDX tail-loss/recovery semantics; optimize the measured cause of the p95/p99 regression. High impact, medium/high complexity.
2. Add controlled isolated cold-start, distinct-track FLAC/HLS and provider playback tests using the retained driver. Measure startup through confirmed native output and audible capture where available. High impact, medium complexity.
3. Validate dropped-route, sleep/wake and silent-peer recovery while streaming. Preserve pause intent and exact resume byte offsets. High reliability impact, medium complexity.
4. Evaluate a separately authenticated control transport only after session-supersession semantics and transport tail behavior are understood. Potential latency benefit, high architectural complexity.
5. Profile large-queue allocations and native playback memory before further queue/inflight counter or buffer tuning. Lower impact, low/medium complexity.
6. Run pwnat on a compatible physical NAT pair with preauthorized Mac raw ICMP, and test native mobile/Windows devices. Connectivity/platform coverage, environment dependent. Preserve working HyperDHT.

## Reproduction and evidence

Sanitized numeric results, native samples and regression summaries are under [results/overnight-2026-10-29](results/overnight-2026-10-29). Full private pairing transcripts, profiles, tokenized URLs and credentials are intentionally excluded. The baseline transfer run's overall `ok=false` reflects its obsolete desktop/frontend setup failure; its six verified WAV transfers and route checks succeeded. A fresh archived original desktop then supplied the valid playback/control baselines. The first native reference adapter incorrectly used Node-style callbacks with streamx and timed out; fixing its boolean/drain contract produced the matched successful run. These setup failures are not counted as transport performance results.

Build both checkouts with the same revision. Keep the desktop separate from the server, and run builds sequentially before benchmarks:

```sh
# On each host; choose a private target with sufficient free disk space.
export CARGO_TARGET_DIR=/path/to/private/target
export CARGO_INCREMENTAL=0 CARGO_PROFILE_DEV_DEBUG=0
cargo build --manifest-path server/Cargo.toml --bin ambra-server
cargo build --manifest-path crates/ambra-net/Cargo.toml --examples
# Mac: build frontend from desktop/, then the desktop binary.
(cd desktop && bun run build)
cargo build --manifest-path desktop/src-tauri/Cargo.toml --bin AMBRA

python3 scripts/pwnat/cross-network.py llewyn@100.95.127.9 \
  --remote-server /path/on/linux/to/ambra-server \
  --probe "$CARGO_TARGET_DIR/debug/examples/pairing_probe" \
  --desktop-binary "$CARGO_TARGET_DIR/debug/AMBRA" \
  --rounds 5 --audio-seconds 60 --playback-seconds 45 \
  --sample-interval .1 --exercise-controls --restart-server

python3 scripts/network-interop/benchmark.py --host llewyn@100.95.127.9 \
  --server /path/on/linux/to/hyperdht_server \
  --clients "$CARGO_TARGET_DIR/debug/examples" \
  --rounds 5 --seconds 90 --output /new/private/results
# Local reference: replace --host with --loopback and use a local server binary.
# Stress: --parallel 4 --rounds 3 --seconds 120.
```

Reference comparison requires `npm ci --prefix scripts/network-interop` on the fixture host and a Node version supporting `http2.performServerHandshake`. Pass `--reference-node /path/to/node` and `--server /path/to/throughput-reference.cjs`. No reference process is launched by production Ambra.

## Final qualification and cleanup

### Final physical playback (current binaries)

The final run passed all five fresh reconnects, six byte-exact WAV transfers, 20 controls, forced desktop reconnect and private-server restart. Routes verified `en0` and `wlo1` after the complete desktop workload. It used a unique test server ID and private debug WebView storage.

- WAV transfer median: **3,485.6 ms**, versus 19,564.0 ms originally (**5.61× faster**); six transfers each.
- Fresh authenticated reconnect median: **2,475.3 ms**, versus 2,260.6 ms originally; no improvement claimed.
- Native sampling: **423 samples / 45 seconds**; first playing at **1,266.8 ms**, zero backward progress, zero post-start buffering samples and zero cumulative underruns. The first nine samples include preparation; no audible quality measurement was made.
- Five native-confirmed controls each: pause median **271.4 ms** (max 732.9), resume **333.1 ms** (max 733.0), seek **482.5 ms** (max 717.9), skip **179.2 ms** (max 607.6).
- Cooperative server restart: authenticated after **17,682.2 ms**; resumed native output and advanced two seconds after **23,104.1 ms**. Previous run: 23,680.7 / 26,597.0 ms. These are one restart per revision, so the difference is not a stable latency estimate.
- Logs after the close-notice fix show stream closure and reconnect beginning at 06:21:49.026 UTC, then 15,632 ms in HyperDHT bootstrap/resolve/connect before authentication. There is no `KeepAliveTimedOut` in this final desktop log. The deterministic close-notice regression establishes the mechanism more strongly than a single WAN comparison.
- Sampled probe peak RSS: **62,320 KiB**, higher than the original 36,560 KiB. There is no claim of reduced resource use.

The final report records server source HEAD `f2eb67d` because Linux contained the six verified working source files during qualification; the pacing and provider changes were subsequently committed on Mac. Binary SHA-256 values are retained in the evidence. Final synchronization verifies the exact source blobs before discarding those own temporary working copies.

### Final transport stress

Four concurrent clients each opened three fresh authenticated connections: **12/12 succeeded**, including exact 2 MiB downloads per connection. A subsequent 120-second single streaming/control workload transferred **314 MiB / 120.363 seconds = 2.609 MiB/s**. Its 307 polls measured p50 **257.4 ms**, p95 **479.6 ms**, p99 **733.2 ms**; four body gaps exceeded 250 ms, maximum **434.6 ms**. Both peers' public endpoint routes were verified.

This run passed without disconnect or poll error. The streaming stage is one continuous transfer plus one poll loop; it does not represent four simultaneous audible players. The longer duration, connection stress prelude and changing cellular conditions make it a qualification result rather than a replacement for the matched 90-second comparison. Its lower tails do not erase the earlier reproducible observation of a worse p95. Enabled server RTO debug logging recorded no `retransmitting packets` events in this run; packet-level loss/SACK analysis is still needed.

### Final checks

The final native network gate passed **41 tests** (22 unit, four direct-only, 15 native integration), covering authorization/revocation, corrupt/truncated transport, cancellation without mutation replay, reconnect, ranges, upload and concurrent polling. Both platforms' close-notice UDX gates passed **122 tests**. UDX `clippy --lib -- -D warnings` passed. The final desktop gate remains **56 passed, one failed, one ignored**, including the new paused-restore diagnostics test. Both the failing decoder-retention test and its responsible method are byte-for-byte unchanged from `bd9841e`; no failure was hidden.

Standalone local playback frontend tests passed **three tests / 58 assertions**, including local audio, position, queue, playlists and settings across repeated live connection changes. The freshly launched signed desktop bundle passed the client package check: no server, Soloist or virtual driver. Python harness syntax and Node fixture syntax checks passed. The complete frontend production build and mobile TypeScript/focused tests passed earlier; no frontend product JavaScript changed afterward.

Final source and automation commits:

- `755b80f`: best-effort peer notification on aborted established UDX streams.
- `9784be9`: retain repeated-Play preparation and requested seek intent; accurate buffer/underrun diagnostics; strict mobile test types.
- `aa7c936`: private debug WebView storage, queue/next automation, binary hashes, physical controls/restart measurements, route validation, loopback/native reference and concurrency benchmark tooling.

Cleanup verification follows below.
