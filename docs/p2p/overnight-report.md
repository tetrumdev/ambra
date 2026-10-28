# HyperDHT performance and reliability report

Work started October 27 and continued October 28, 2026. Starting commit on both machines: `c5e72a3`. The original overnight result was left uncommitted for review. The later user-requested commit integrates five existing origin commits; see [commit integration validation](commit-integration.md). The physical measurements below describe the original overnight tree, not the subsequently combined version. No production pairing, music-library change, privileged helper, or system security change was performed.

## Summary

The connection manager now reuses healthy DHT state, races LAN and HyperDHT with a 250 ms LAN preference, and shares one establishment worker across callers. Authenticated replacement sessions can supersede obsolete sessions without waiting for expiration. Handshake discovery races three forwarding candidates and remembers successful candidates. Probe cancellation and socket ownership now stop unnecessary background work while preserving restrictive-NAT budgets.

Two additional transport defects were confirmed: the listening UDX stream could send its queued encrypted greeting before knowing the remote endpoint, and cancellation of an async UDX stream could detach its reliability processor. Both are fixed and covered by regressions.

The physical debug run improved from 2/4 completed connections to 10/10. Successful warm connection latency after changes was p50 939 ms / p95 1081 ms. This is a small, uncontrolled sample on a shared LAN using public DHT signaling and NAT hairpinning. It does not establish independent cross-network traversal success or an audio-throughput improvement.

## Confirmed causes and implemented changes

### DHT ownership and recovery

- [`Client::ready`](../../crates/ambra-net/src/hyperdht.rs) detects a finished supervisor or a changed native-interface/address fingerprint. Ordinary unreachable peers retain the healthy node, bootstrap state, routing table, and UDP binding.
- Failed bootstrap removes the unhealthy node. Explicit shutdown destroys and joins its supervisor. Node Drop and DHT/swarm supervisor guards cancel children rather than detaching them.
- The server acceptor and announcement task also have abort-on-drop ownership and are joined during shutdown.
- Regressions verify reuse after failed lookup, replacement after actual supervisor failure, replacement of stale network state, and explicit shutdown.

The fingerprint observes interface/address changes. It cannot detect every gateway, captive-portal, or NAT mapping change that leaves all interface addresses unchanged. UDP rebinding is recovered through a new pinned session; this does not add in-place UDX endpoint migration.

### Connection racing and single-flight coordination

[`manager.rs`](../../crates/ambra-net/src/manager.rs) starts LAN immediately and HyperDHT after configurable `Timing.lan_grace` (250 ms by default), or immediately when LAN fails. Pwnat remains optional and capability-gated, after both paths fail.

Only encrypted transports pinned to the selected server participate. Losing attempts are dropped before one winner receives the device bearer. Device authorization has a separate 15-second bound. This avoids competing authorization state. Existing healthy sessions are reused.

A short mutex section creates or subscribes to one owned connection worker. Watch receivers publish its result to all callers; cancelling a waiter does not cancel other waiters or the worker. Shutdown cancels and joins the worker. Tests cover 32 concurrent waiters, cancellation of the first waiter, one authorization, and shutdown during authorization.

Known closed sessions get one immediate reconnect. Repeated brief sessions and failed attempts retain retry backoff. LAN retries cached hints once after discovery when its original dials have already failed, covering listener startup after a restart. HTTP requests are still sent once; ambiguous mutations are never automatically replayed.

### Authenticated session replacement

[`server/src/access.rs`](../../server/src/access.rs), [`server/src/network.rs`](../../server/src/network.rs), and [`transport::Session`](../../crates/ambra-net/src/transport.rs) maintain server-local session generations. Bearer and pinned device-key validation occur before supersession. A newer authorized session closes the old session; an old late request receives 409 and cannot reclaim the device. Revocation closes registered sessions when the configuration changes.

The vendored swarm accepts a replacement encrypted transport while retaining resource limits. Generation-qualified slot release prevents an obsolete close/failure event from erasing the replacement reservation. Tests retain five encrypted sessions while reconnecting and verify independent encrypted exchanges, obsolete cleanup, wrong-bearer/wrong-key rejection, supersession, and revocation enforcement.

The previously observed 30.45-second independent-network reconnect was not reproduced under those original conditions. Sequential deadlines, stale reservations, and greeting retransmission were confirmed mechanisms that add delay; this report does not assign that exact observation to a single cause.

### Discovery and handshake forwarding

[`vendor/peeroxide-dht/src/hyperdht.rs`](../../vendor/peeroxide-dht/src/hyperdht.rs) races at most three forwarder RPCs. They replay byte-identical Noise IK message 1 with one ephemeral and stream ID. Only one validated response continues into hole punching and UDX, preventing competing Noise state.

A bounded cache holds at most 128 peers and eight addresses per peer. Successful hints expire after five minutes; recent failures receive a 30-second cooldown and lower ranking. Candidates are deduplicated and ranked using latency/failure history. Untrusted peer records cannot change the pinned key. FIND_PEER and FIND_NODE fallbacks remain.

Optimistic hints have a one-second handshake grace. Once a valid reply arrives, the full hole-punch/UDX window remains. Slow supplied hints are retained for a full-timeout fallback even when fresh discovery is empty or FIND_NODE fails. A delayed-reply regression exercises this compatibility case.

Losing RPCs are pruned from standalone in-flight and pending queues without retry or routing-health penalties. A regression observes no retransmission after cancellation and confirms the DHT remains healthy.

### NAT probes, socket allocation, and cancellation

[`holepuncher.rs`](../../vendor/peeroxide-dht/src/holepuncher.rs) and [`socket_pool.rs`](../../vendor/peeroxide-dht/src/socket_pool.rs) retain the 256-socket ceiling, 1,750-probe limits, and original spacing/windows. No traversal probability claim depends on reducing those budgets.

Production probe handling runs in the socket routing task, removing the extra receive adapter. SocketRef and Holepuncher Drop cancel owned workers. Probe loops and birthday allocation check the same atomic receive-success flag and use interruptible waits. Allocation yields every 16 sockets so receive processing can stop further work.

Probe sends wait for initial socket writability and execute immediately while scoped TTL is set; the prior TTL is restored, including on send errors. Connection success carries the actual winning birthday socket, preserving its NAT mapping instead of always selecting the primary socket.

Receiving a probe ends local probing; final application usability still requires the pinned encrypted stream and device authorization. Raw probe receipt alone is not counted as authenticated traversal success.

### UDX and server concurrency

The existing 1472-byte IPv4 UDP payload cap remains. Tests exercise 1200- and 1400-byte UDP payload paths, packet loss, reordering, retransmission, backpressure, sustained transfer, and heartbeat. The cap addresses 1500-byte IPv4 interface fragmentation; paths below the 1200-byte transport base remain outside this validation.

[`stream.rs`](../../vendor/libudx/src/native/stream.rs) no longer drains queued greetings to `0.0.0.0:0` before the listening firewall hook commits an endpoint. The new regression fails against original source with a three-second timeout and passes with the fix.

[`UdxAsyncStream`](../../vendor/libudx/src/native/async_stream.rs) owns its processor and registration. Drop cancels queued writes and removes registration immediately. Reliable final delivery requires awaiting `flush()` or `shutdown()` before dropping; an existing async-stream fixture now explicitly flushes. This lifecycle contract is documented in the vendored patch notes.

`SwarmConfig.max_parallel = 2` limits outgoing queued attempts. It does not limit accepted incoming sessions. It remains unchanged; incoming admission and session limits remain bounded. The HTTP/2 adapter and audio buffers were not rewritten.

## Measurements

Percentiles use nearest-rank over successful observations. Failed attempts are listed separately rather than silently excluded from success-rate claims. Cold samples are single observations, not distributions.

### Physical debug comparison

Mac client, Kubuntu fixture server; both debug builds. Each round creates a new pinned encrypted HTTP/2 session using the same ephemeral client identity and DHT node, checks the fixture authorization endpoint, and validates a 2 MiB response. LAN shortcut is disabled. Application traffic is direct; SSH control uses Tailscale.

Both machines use native `192.168.86.0/24` addresses behind the same router. These results exercise public discovery and NAT hairpinning, not separate internet access networks.

| Metric | Original | Modified |
| --- | --- | --- |
| Completed rounds | 2/4 | 10/10 |
| Cold connection | 10055 ms | 7621 ms |
| Successful warm connection p50 / p95 | 5515 / 5515 ms (one success) | 939 / 1081 ms (nine successes) |
| Failed warm rounds | 2 reached 45-second deadline | 0 |
| Transfer throughput p50 / p95 | 0.293 / 0.326 MiB/s | 0.340 / 0.367 MiB/s |

The sample does not prove a throughput improvement. The modified debug client used 79.11 seconds wall time, 3.16 seconds user CPU, 1.29 seconds system CPU, and 15,613,952 bytes maximum resident memory (`/usr/bin/time -l`). A server sample showed approximately 20 MB RSS and 14 file descriptors; this is not a peak measurement.

Controlled local dead-first-forwarder/reconnect observations after the greeting fix: 14.650, 10.293, 9.291, 9.320, and 8.572 ms. These are loopback tests, not internet latency.

### Allocation comparison

The benchmark performs 12 full 256-socket allocation/destroy rounds, without reducing the unsuccessful traversal window. It samples Tokio active tasks immediately after allocation.

- Original Kubuntu run: three complete 256-socket rounds, then resource exhaustion at 246 sockets in round four.
- Repeated original-source run with task metrics: sampled 1023, 2031, 3023, and 3975 active tasks across those rounds; round four again stopped at 246 sockets.
- Modified Kubuntu run: all 12 rounds reached 256 sockets, with 512 sampled active tasks every round.
- Modified Mac run: all 12 rounds reached 256 sockets, with 512 sampled active tasks every round; allocation took approximately 8–10 ms.
- Kubuntu modified allocation took approximately 51–69 ms during concurrent build activity. Baseline and modified allocation timings were not controlled for profile/load sufficiently to claim an allocation-latency improvement. The repeatability/resource cleanup improvement is measured.

The sampled task counts include routing, receive, adapter, and outstanding fire-and-forget send tasks where applicable. They are not process-wide historical peaks. Tests verify early allocation stop after probe receipt and retention of the complete failed-attempt socket window. They do not establish real symmetric-NAT traversal success rates.

Raw observations are preserved in [`results/`](results/), with an [interactive latency chart](results/latency.html).

### Matched release comparison and sustained streaming

Both sides used optimized release builds. No compilation ran on Kubuntu during these measurements. These are still sequential, small samples over the same router, not a controlled internet trial.

| Metric | Original release | Modified release |
| --- | --- | --- |
| Completed rounds | 2/4 | 10/10 |
| Cold connection (one observation) | 4481 ms | 5664 ms |
| Successful warm p50 / p95 | 1405 / 1405 ms (one success) | 488 / 523 ms (nine successes) |
| Failed warm rounds | 2 at 45 seconds | 0 |
| 2 MiB throughput p50 / p95 | 0.421 / 0.429 MiB/s | 0.433 / 0.454 MiB/s |

No cold-start improvement or material throughput improvement is established. Warm reliability improved in both debug and release observations. The manager's 250 ms race removes the deterministic three-second sequential LAN wait when LAN stalls; that behavior is proved separately with paused-time tests.

Four simultaneous fixture clients completed **12/12** connections (three rounds each). Their initial cold connections ranged 6.22–9.26 seconds. Warm p50/p95 was 531/915 ms. These clients use pinned Noise identities and the fixture bearer; production device-key/bearer supersession is covered separately by the server access regression. This is not four physical devices paired into production configuration.

A single persistent encrypted HTTP/2 connection transferred **26 MiB in 60.50 seconds**, validating all bytes, while completing **142 concurrent API polls**. Throughput was 0.430 MiB/s (approximately 3.6 Mbit/s). Poll latency was p50 333 ms / p95 390 ms, including the fixture's intentional 100 ms handler delay. No request or integrity error occurred. One body-delivery gap exceeded 250 ms, with a maximum of 339 ms. Gap timing includes initial response and response boundaries; it does not measure audible interruptions. This throughput does not establish support for every high-resolution audio bitrate.

Mac release client maximum RSS was 13,762,560 bytes for ten rounds, 20,922,368 bytes for four concurrent clients, and 6,782,976 bytes for the sustained test. Their wall/user/system times were 59.16/0.73/2.28 s, 31.12/0.80/2.30 s, and 66.87/1.03/3.10 s respectively. Baseline four-round client used 106.40/0.10/0.32 s and maximum RSS 10,551,296 bytes; most baseline time was failed waiting, so CPU totals are not comparable work.

Server sampling at one-second intervals over the modified release stages observed maxima of 25,669,632 bytes RSS, 23 FDs, 14 UDP sockets, and 24.93% of one CPU core. At completion it returned to two UDP sockets and eleven FDs before fixture shutdown. Baseline samples peaked at 10,096,640 bytes RSS, 13 FDs, four UDP sockets, and 11.98% CPU while completing much less work. These are sampled maxima, not exact instantaneous peaks or a matched CPU/memory efficiency comparison.

Retransmission counters were not enabled in these physical timing runs; packet-retransmission totals are therefore unavailable. Deterministic proxy tests exercise retransmission behavior, and debug tracing now supports future targeted measurement. Bootstrap-count behavior is proved through node-identity/port reuse and recovery regressions rather than fabricated public-network counter totals.

The SecretStream frame writer already coalesces its prefix and encrypted payload at HEAD. Its acknowledgement-boundary regression passes. That existing optimization was preserved.

## Diagnostics

Structured tracing covers DHT startup/bootstrap readiness, FIND_PEER/FIND_NODE discovery duration, forwarder attempt count and failure reason, pinned Noise handshake duration, connection/authentication duration, HTTP/2 initialization, encrypted bytes/duration, NAT classes, hole-punch socket/probe counts, fast retransmissions, and existing RTO retransmissions.

Use targeted filters such as `RUST_LOG=ambra_net=debug,peeroxide_dht::hyperdht=debug,peeroxide_dht::holepuncher=debug,libudx::native::stream=debug`. Measurements include public keys and network addresses, never bearer values or pairing secrets. Per-packet tracing remains disabled unless explicitly requested by the logging filter. There is no always-on sampling service.

## Automated validation and commands

Local Rust commands use `CARGO_TARGET_DIR=$PWD/crates/ambra-net/target CARGO_INCREMENTAL=0 CARGO_PROFILE_DEV_DEBUG=0`, usually with two build jobs. Kubuntu uses its own shared target. Generated artifacts remain ignored by Git.

- `cargo test --manifest-path crates/ambra-net/Cargo.toml`: final Mac gate passes 17 unit, 4 direct-only policy/integration, and 15 native integration tests. Kubuntu final synchronized gate also passes 17 unit, 4 direct-only policy/integration, and 15 native integration tests.
- `cargo test --manifest-path vendor/peeroxide-dht/Cargo.toml --lib`: 400 passed.
- `cargo test --manifest-path vendor/peeroxide/Cargo.toml --lib`: 25 passed. Its doctest has an existing missing `hex` example dependency; no library failure.
- Native UDX selection (`--lib --test firewall_hook --test async_stream --test stream_lifecycle --test mtu_probing --test network_sim --test throughput --test multiplexing --test socket --test errors`): 114 passed. Additional `relay`, `stream_relay`, and `wire_format` selections: 14 passed. Full upstream interop run cannot pass because `vendor/tests/node/udx-large-transfer.js` and related external Node fixtures are absent.
- `cargo test --manifest-path server/Cargo.toml access::`: 9 passed on Mac, including the new authorization/supersession regression.
- Kubuntu full modified server: 188 passed, 9 failed, 2 ignored under its default umask. Original source reproduces the same nine failures (187 passed, 9 failed, 2 ignored; original lacks the added regression). Modified serial run with per-command `umask 022`: 194 passed, 3 failed, 2 ignored.
- Desktop `bun run test`: 85 static tests, 5 discovery tests, 3 local-playback tests, and 8 startup tests pass. Two startup tests fail; remaining seven TSX suites were run independently and pass.
- Desktop `bun run build`: passed TypeScript and production Vite build.
- Desktop Rust `cargo test --manifest-path desktop/src-tauri/Cargo.toml --lib`: 45 passed, 1 failed, 1 ignored. The failure reproduces in isolation.
- Mobile Rust bridge: 1 passed; mobile JavaScript: 5 passed.
- `cargo clippy --manifest-path crates/ambra-net/Cargo.toml --lib`: passes with an existing collapsible-if warning in pwnat. Changed Rust additions were formatted; unrelated vendor formatting was reduced. `git diff --check` passes.

### Reproducing the isolated physical fixture

Build on both machines with `cargo build --release --manifest-path crates/ambra-net/Cargo.toml --examples`. Start `crates/ambra-net/target/release/examples/hyperdht_server` on the server machine and wait for `ANNOUNCED`; copy its printed ephemeral public key. The fixture exits after 300 seconds following announcement, so start a fresh instance for a long batch.

On the client machine, run:

```sh
crates/ambra-net/target/release/examples/connection_bench SERVER_KEY 10
crates/ambra-net/target/release/examples/connection_bench SERVER_KEY 3 4
crates/ambra-net/target/release/examples/streaming_bench SERVER_KEY 60
```

The benchmark token is the existing public fixture token. No production pairing approval or configuration is needed. Each command is bounded. Baseline binaries were built from an isolated archive of starting HEAD with the benchmark example copied in; the original checkouts were never reset.

### Unrelated failures left visible

- Server permission-sensitive Soloist fixtures: six `InvalidExecutable` failures under the remote default umask. Per-command `umask 022` resolves those fixture failures without changing system settings.
- Server audio fixtures: `session::driver_tests::reopening_the_output_resumes_the_current_song_and_clears_offline_error` and `soloist_output_restart_keeps_position_generation_and_history` fail in both original and modified source.
- Server `write_behind::tests::write_behind_benchmark`: missing temporary file (`NotFound`) in both original and modified source.
- Desktop `clientStartup.test.tsx:156`: application-mounted identity assertion; `:292`: shared-playback checkbox assertion. Frontend code is unchanged.
- Desktop Rust `native_audio::tests::releasing_a_paused_device_does_not_reopen_the_song`, `native_audio.rs:2298`: `worker.decoder.is_none()`. Audio code is unchanged; the exact isolated test also fails.

No unrelated audio or Soloist implementation was changed to make this task appear green.

## Limits and manual follow-up

- Independent public-internet NAT traversal, real symmetric-NAT success rates, restrictive enterprise firewalls, and physical network switching remain unverified. Both available machines share a LAN. Tailscale SSH connectivity is not traversal evidence.
- Existing user-space UDP proxies cover deterministic loss, delay, reordering, and MTU behavior. Unprivileged network namespaces are unavailable (`Operation not permitted`); no host networking policy was changed.
- The original overnight tree registered the passive UDX hook only on the primary socket. The later integration preserves upstream multi-socket registration and winning-socket selection, with regression coverage. Real symmetric-NAT traversal success remains unverified.
- Server restart/reconnect and credential preservation are covered by isolated integration fixtures. Production identities were not loaded. No interactive pairing, locked-device approval, microphone/audio-output access, or real library was used.
- Sustained encrypted byte integrity and API concurrency are tested. Audible interruptions, hardware decoder underruns, internet packet retransmission totals on separate networks, and real high-bitrate listening require a later physical listening session.
- Windows, iOS, and Android native builds were not available here. Shared Rust networking and mobile bridge checks pass on Mac/Linux; this is not a cross-platform build certification.
- After review, run the isolated fixture on two separate internet access networks, then test production pairing/restart/network switching with normal device authorization. No re-pairing or production migration is required by this change.

## Environment and repository state

Mac started with approximately 2.8 GiB free. Only generated Ambra targets, old builds, and selected old temporary test/reference directories were removed, recovering approximately 40 GiB. Builds use a shared target, reduced debug information, and disabled incremental compilation. Storage stayed well above the requested 1 GiB floor; the final measurement is approximately 36 GiB free.

At the end of the overnight run both Git checkouts retained their original commit and synchronized task diff. The user subsequently requested committing and pushing all changes; integration details are recorded separately. The progress log and benchmark observations are part of the reviewable diff. Test fixtures use ephemeral identities and the existing public fixture token; no production credentials are stored.
