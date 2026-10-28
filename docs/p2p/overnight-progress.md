# HyperDHT reliability work — 2026-10-27

## Environment and preservation

- Starting HEAD: `c5e72a3` on both Mac and Kubuntu (`llewyn@100.106.252.60`). Both worktrees were clean.
- SSH access works. SSH uses Tailscale; this does not demonstrate public UDP traversal.
- Mac began with approximately 2.8 GiB free. Removed generated `server/target`, `desktop/src-tauri/target`, `crates/ambra-net/target`, `desktop/dist`, and selected old Ambra test/reference directories in `/private/tmp`. Free space afterward: 40.81 GiB. No identities, configuration, music, or installed application removed.
- Builds will use debug information disabled and incremental compilation disabled. Stop local builds well before the 1 GiB free-space floor.
- No push, merge, reset, or production configuration change is authorized or planned. Changes will be synchronized to the clean Kubuntu checkout for verification.

## Verified source evidence at current HEAD

- Manager still uses sequential LAN / HyperDHT / optional pwnat, holds `connecting` mutex across network I/O, and destroys the DHT after ordinary connection failure.
- Client lazily owns one DHT but does not check its supervisor task for failure.
- HyperDHT candidate attempts remain sequential with no successful-forwarder cache.
- Holepunch loops check `punching`, while receive adapters update a different atomic success flag. Birthday allocation can therefore continue after a received probe.
- SocketRef owns a routing JoinHandle without a Drop implementation; dropping it detaches the routing task.
- HyperDHT supervisor races child JoinHandles by value; cancellation can detach both child tasks.
- `max_parallel = 2` is documented as an outgoing-attempt limit, not an incoming-client limit. Investigating accept path before changing it.

## Validation in progress

- Kubuntu baseline `cargo test --manifest-path crates/ambra-net/Cargo.toml` with two build jobs, no incremental compilation, no debug information. Log: `/tmp/ambra-overnight-baseline.log` on Kubuntu.

## Implemented and focused validation

- Removed the manager's DHT destruction after ordinary peer failures. Client detects finished DHT supervisor tasks and changed native-interface addresses, and reinitializes those nodes only.
- DHT and swarm supervisors now own abort-on-drop child guards. Swarm probe workers belong to their individual handshake; cancellation and completion release them.
- LAN starts immediately; DHT starts after a configurable 250 ms grace period. Pwnat remains capability-gated, after both paths fail. Only the winning encrypted transport receives device credentials.
- A watch channel shares one bounded connection worker across callers. Cancelling a waiter does not cancel the worker. Shutdown joins it. Known closed sessions receive an immediate first reconnect.
- LAN cached hints retry once after discovery when initial dials all failed, covering listener startup during server restarts.
- Incoming Noise-authenticated transports may reconnect while an old transport remains open. Generation-qualified cleanup cannot erase a newer connection reservation. Server bearer/device-key validation precedes session supersession; late old requests cannot reclaim the device.
- Three concurrent forwarder requests replay byte-identical IK message 1 with one stream id. Only one validated reply proceeds to UDX/holepunch establishment. Successful forwarders have bounded per-peer history, five-minute expiry, latency ranking, and recent-failure cooldown. Fresh FIND_PEER and FIND_NODE fallbacks remain.
- Dropped forwarder RPCs explicitly prune their in-flight requests and retries without marking routing nodes unhealthy.
- Holepunch receive handling is folded into each socket's routing task. SocketRef and Holepuncher now cancel owned tasks on Drop. Allocation checks the shared success flag and yields every 16 sockets. Failed attempts still receive all 256 sockets and unchanged probe limits/windows.
- Scoped low TTL restores the prior socket TTL before UDX traffic. Added an explicit initial writable wait after binding; tests caught and corrected Tokio's first-send WouldBlock condition.
- A further source bug used the primary socket even when a birthday socket received the successful probe. Success events now carry the winning socket.

## Measurements and caveats so far

- Original Kubuntu Ambra-net baseline passed (15 unit tests, 2 direct-only tests, 13 native integration tests).
- Current Mac networking suite passed after connection-manager/session changes; additional discovery tests are being added.
- Current Mac DHT library: 400 tests passed before the final winning-socket adjustment.
- Original Kubuntu birthday benchmark reached 256 sockets for three rounds, then hit resource exhaustion at 246 sockets in round four. This is a measured baseline failure; no traversal-rate claim follows from it.
- Physical Mac and Kubuntu use the same native LAN (192.168.86.0/24). Public-DHT tests disable the LAN shortcut but still exercise this router's NAT hairpin behavior, not independent cross-network NATs.
- Baseline physical public-DHT test: 2/4 successful 2 MiB streams; two reconnects hit the 45 s test deadline. Successful connection times: 10055 ms and 5515 ms. Full logs remain in /tmp on each machine while work continues.
- Remote noninteractive sudo is unavailable. Unprivileged user/network namespace creation fails with `Operation not permitted`. User-space packet proxies cover loss, delay, reordering, and MTU tests without changing host networking.

## Final gate progress

- Queued server-greeting regression fails against original libudx after three seconds and passes with the pacing gate. Final async-stream Drop owns processor cancellation and registration removal; successful callers explicitly flush before dropping queued writes.
- Final Mac Ambra-net gate: 16 unit, 3 direct-only policy, and 15 native integration tests passed. Final DHT library: 400 passed. Final swarm library: 25 passed. Native UDX selection: 114 passed, including loss/reordering, MTU variation, cancellation, sustained transfer, and heartbeat.
- Desktop production build passed. Remaining seven TSX suites passed independently after the two existing startup-suite failures stopped the aggregate command.
- Kubuntu original server baseline reproduces the same nine failures as the modified default run (permission-sensitive Soloist fixtures, audio-output restart fixtures, and a write-behind benchmark path). A serial modified run with per-command `umask 022` passes 194 and fails only the same two audio restart fixtures and write-behind benchmark. No unrelated server fixes applied.
- Server acceptor and announcement tasks now have abort-on-drop ownership and are joined at explicit shutdown. Swarm spawn acquires DHT task ownership before its first post-spawn await.
- Release before/after builds and bounded physical concurrency/streaming benchmarks remain in progress. Mac remains above 37 GiB free.

- Final review found that a slow supplied forwarder could be dropped after the optimistic grace when discovery was empty. The full fallback now retains those hints, including when FIND_NODE fails. A delayed-reply integration regression passes in 1.03 seconds.
- Added native-network fingerprint replacement coverage. Repeated brief successful sessions now back off after one immediate reconnect, avoiding a hot loop against a flapping server.
- Desktop Rust gate: 45 passed, one ignored, one failure in unchanged `native_audio::tests::releasing_a_paused_device_does_not_reopen_the_song` (`worker.decoder.is_none()`, line 2298). The isolated exact test reproduces the failure. No audio implementation change made.

## Physical release results

- Matched release profiles, public DHT, native same-LAN endpoints: baseline 2/4 connections; two warm attempts hit 45 seconds. Modified 10/10; warm p50 488 ms / p95 523 ms. Cold single observations: baseline 4481 ms, modified 5664 ms; no cold-start improvement established.
- Four simultaneous fixture clients: 12/12 completed across three rounds each. Warm p50 531 ms / p95 915 ms. Initial per-client cold times ranged 6.22–9.26 seconds.
- Sustained encrypted HTTP/2: 26 MiB in 60.50 seconds (0.430 MiB/s), 142 concurrent API polls, p50 333 ms / p95 390 ms including the fixture's 100 ms server delay. Integrity and requests passed. One body-delivery gap exceeded 250 ms (maximum 339 ms); this includes response boundaries and is not an audible-interruption measurement.
- Server 1 Hz sampling over all modified release stages: maximum RSS 25,669,632 bytes, 23 FDs, 14 UDP sockets, CPU 24.93% of one core. After clients shut down, UDP sockets returned to two and FDs to eleven. Baseline had much less active traffic, so CPU/memory are not a comparable efficiency benchmark.
- Shared framing was already coalesced at HEAD; verified and preserved it. The HTTP/2 adapter, audio buffers, congestion control, 1472-byte cap, and NAT budgets were not changed to improve benchmark numbers.

## Completed verification

- Final synchronized Kubuntu suites pass: Ambra-net 17 unit + 4 direct-only + 15 native; DHT 400; swarm 25; server access 9. Final Mac suites and UDX cancellation/MTU/loss gates also pass as recorded in results/test-summary.txt.
- All owned physical fixture processes exited. Final server sampling returned to two UDP sockets / eleven FDs before shutdown. No production services or configuration were changed.
- Full report, raw benchmark/resource observations, test summaries, and an interactive latency chart are in docs/p2p/. Changes remain uncommitted on both original checkouts. No push or merge.

## User-requested commit integration

- Origin was five commits ahead (`b0ba37b`); rebased the overnight changes onto those commits rather than replacing them.
- Preserved upstream TTL serialization, 75-second manager traversal budget, NAT sampling, passive socket registration/selection, and handshake bounds.
- Reused upstream multi-socket cleanup ownership in the async stream adapter. Added cancellation coverage for both primary and alternate registrations.
- A valid Noise reply with unusable UDX parameters previously cancelled and skipped alternate candidates. A regression reproduces the skipped fallback; retries now use fresh Noise state and stream IDs while retaining the concurrency bound.
- Updated test results and the historical scope of physical benchmarks are in commit-integration.md.
