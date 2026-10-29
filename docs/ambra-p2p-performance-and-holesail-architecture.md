# Ambra P2P Performance Audit and HoleSail-Inspired Architecture Improvements

**Status:** Read-only, evidence-based synthesis; no files in the Ambra repository changed.  
**Ambra revision reviewed:** [`bd9841ed7cdcc1c5371f04cae730db215217099d`](https://github.com/tetrumdev/ambra/commit/bd9841ed7cdcc1c5371f04cae730db215217099d) (`fix(net): harden P2P recovery and diagnostics`, October 28, 2026).  
**Scope:** Ambra server session/playback, desktop decoder, native HyperDHT/UDX transport, mobile client, and relevant design principles from HoleSail/Holepunch.  
**Evidence standard:** Existing physical results are distinguished from static-code cost calculations. No new live LAN/WAN benchmarks, fixes, or regression tests were performed as part of this combined report. Codex's independent in-memory accounting probe is described as reported evidence, not a new test run by this report's author.

## Executive summary

Ambra's P2P playback can feel much slower than LAN even though it uses broadly the same primitives as HoleSail: HyperDHT discovery, UDP hole punching, encrypted streams, and reliable UDX data transfer. The strongest **actionable code findings** are not solely in networking: the server holds an operation lock while awaiting remote audio loading, the UDX pacer loses its calculated delay and overcounts in-flight packets, and several decoder paths still require complete HTTP bodies before yielding audio bytes. There are also avoidable queue transfers and clones, a quadratic send-loop scan, and a mobile event-listener leak.

**The most important fix to investigate first is interruptible server-side playback preparation.** A faster transport will not make pause, skip, or seek responsive if commands are blocked by a long-running load holding the same server lock. Next come deterministic pacer fixes, then progressive startup/HLS reads, then queue and mobile cleanup.

HoleSail is **a reference architecture, not a drop-in solution**. Its JavaScript HyperDHT client/server use reusable sockets and the mature native Holepunch UDX stack. Ambra can adopt validated behaviors and tests without integrating HoleSail, replacing its Rust clients, bundling a JS runtime, or weakening its existing pairing and authorization design. The physical Internet will still have greater RTT, jitter, and occasional packet loss than LAN; a LAN-like *listening experience* must come from transport efficiency **and** sufficient audio buffering.

## 1. Current measured performance and what it proves

The repository's recorded physical tests used a MacBook on a personal hotspot and a Kubuntu server on home Wi-Fi, with the real application-data path over native public HyperDHT/UDX. All table values came from **debug builds**.

| Measurement | Before | After | Interpretation |
|---|---:|---:|---|
| Sustained 44 MiB encrypted transfer | 0.469 MiB/s | **0.488 MiB/s** | About 4% throughput gain, not LAN parity |
| Exact WAV transfer median | 0.464 MiB/s | 0.484 MiB/s | Similar small improvement |
| Authenticated warm reconnect median | 2.510 s | **2.382 s** | Modest improvement; tails remain variable |
| Concurrent API poll median | 578 ms | **533 ms** | Test fixture includes intentional 100 ms server delay |
| Concurrent API poll p95 | 997 ms | **747 ms** | Still noticeable under transfer load |
| Fixed long stress tests | — | **One pass, one timeout/stall** | Reliability not conclusively solved |

**Source:** [`docs/networking/autonomous-2026-10-28.md`](https://github.com/tetrumdev/ambra/blob/bd9841ed7cdcc1c5371f04cae730db215217099d/docs/networking/autonomous-2026-10-28.md) and its linked structured results. The report also records zero buffering samples in a *specific* recovered 45-second physical desktop test, sampled once per second; this is not proof of universal uninterrupted or acoustically verified playback.

0.488 MiB/s is approximately **4.09 Mbit/s**. For context, stereo 16-bit/44.1-kHz PCM is approximately 1.41 Mbit/s, whereas stereo 24-bit/96-kHz PCM is approximately 4.61 Mbit/s before protocol overhead. Actual FLAC bitrate varies, and the observed 0.488 MiB/s is a test result—not a proven physical link cap or proof that UDX alone caused it. Source upload speed, mobile-radio behavior, congestion, packet retransmissions, and client consumption could all matter.

**Do not interpret successful STUN/DHT discovery as guaranteed streaming reachability**, or a one-time long stress failure as proof of a particular *new* congestion bug. Per-stream loss and retransmission denominators are not yet available for the physical tests.

## 2. Actual code path and why remote playback feels slower

For a remote file playback request, the relevant inspected path is:

1. **Server session and endpoint orchestration:** `server/src/session.rs` selects the output and asks a remote endpoint to load and play the source; control commands acquire the same `core.operation` mutex.
2. **Desktop native decoding:** `desktop/src-tauri/src/native_audio/decoder.rs` opens HTTP media sources, obtains range data and feeds a Symphonia decoder. Some paths have progressive reads; others still collect whole bodies.
3. **Client's native HTTP bridge:** `crates/ambra-net/src/bridge.rs` forwards allowed HTTP requests to `ConnectionManager`.
4. **Persistent authenticated transport:** `crates/ambra-net/src/manager.rs` reuses a healthy encrypted HTTP/2 connection and shares concurrent establishment attempts.
5. **Noise-framed transport and UDX:** `crates/ambra-net/src/transport.rs` batches encrypted writes; `vendor/libudx/src/native/stream.rs` queues and transmits UDP packets with pacing, congestion windows, ACKs, and retransmission.
6. **Server audio response:** The server sends audio bodies over the same established logical path; data then reaches the decoder and native audio output.

This architecture adds no *required* data relay, but it necessarily adds WAN RTT, jitter, NAT establishment, and physical uplink/downlink constraints compared with a healthy local LAN.

### Important distinction: symptoms vs. demonstrated bottlenecks

- **Demonstrated source-level defects:** server operation lock spans remote waits; pacer deadline overwrite; pacer double-count; whole-response startup/HLS reads; repeated queue fetch/clones; quadratic queue scan; mobile listener retention.
- **Measured outcomes without an isolated cause:** 0.488 MiB/s sustained throughput, API polling latency, multi-second reconnects, and one long stress timeout.
- **Already repaired defects:** serialized encrypted-frame ACK waits, initial BBR delivery-sampling bugs, duplicate SACK/cumulative-ACK accounting, old RTO behavior, unbounded writes, large post-startup HTTP range blocking, and particular playback ownership/reconnect bugs.

## 3. Specific actionable inefficiencies, ranked

### 3.1 High — Server operation lock blocks playback commands during remote preparation

**Evidence:** [`server/src/session.rs:571`](https://github.com/tetrumdev/ambra/blob/bd9841ed7cdcc1c5371f04cae730db215217099d/server/src/session.rs#L566-L578), [`:727`](https://github.com/tetrumdev/ambra/blob/bd9841ed7cdcc1c5371f04cae730db215217099d/server/src/session.rs#L724-L745), [`:853`](https://github.com/tetrumdev/ambra/blob/bd9841ed7cdcc1c5371f04cae730db215217099d/server/src/session.rs#L845-L868).

- `step()` holds `core.operation` while awaiting remote device selection and `load_native_audio`.
- `command()` acquires that same mutex for play/pause/skip/seek/output/queue-related actions.
- A slow remote load therefore serializes unrelated control operations behind the load. Codex reported an ordinary remote-command wait of **up to 15 seconds** before timeout, with native preparation itself having a **20-second** deadline. These are source-derived budgets, **not observed median command latencies**.

**Minimal complete fix:** Keep the existing preload worker but split preparation from state commit. Capture the generation, selected output and endpoint instance under the lock; release the operation lock during remote endpoint I/O; reacquire and commit only when generation and output instance are still current. Support interruption/cancellation of superseded preparations. Simply removing the lock without stale-result rejection is unsafe.

**Expected impact:** **High for responsiveness**, particularly pause, skip, seek and output changes during slow Internet loading. This may not change the maximum number of MiB/s transferred.

**Correctness checks:** Seek/skip races, device replacement, pause during load, repeated play commands, stale load completions, ownership/revocation, and current preloading/transport generation tests.

### 3.2 Medium — UDX pacer discards calculated delay and wakes every millisecond

**Evidence:** [`vendor/libudx/src/native/stream.rs:1647`](https://github.com/tetrumdev/ambra/blob/bd9841ed7cdcc1c5371f04cae730db215217099d/vendor/libudx/src/native/stream.rs#L1641-L1654), [`:1701`](https://github.com/tetrumdev/ambra/blob/bd9841ed7cdcc1c5371f04cae730db215217099d/vendor/libudx/src/native/stream.rs#L1696-L1705).

The sender computes `pacing_delay` and resets `pacing_sleep` to the calculated deadline. But after processing the batch, when data remains queued, it **unconditionally resets the same sleep to 1 ms**. That can replace a longer, valid pacing deadline and impose unnecessary wakeups. When the congestion window remains full, the sender can wake roughly **1,000 times/second** despite being unable to send new data; this is an upper-order source-derived estimate, not a measured CPU profile.

**Minimal fix:** Retain the calculated token deadline. When blocked by the congestion/receive window, wait for the already available ACK/RTO or data-queued notification instead of busy-like 1-ms polling. Preserve the current burst allowance and queued-data wakeup behavior.

**Expected impact:** **Medium**, with possible CPU and pacing improvements. No evidence supports enlarging the burst cap.

**Correctness checks:** Timed pacing under load, eventual wake after ACK, idle-to-active transition, retransmission deadline handling, loss/reordering and no sender starvation.

### 3.3 Medium — UDX congestion-window check counts newly sent packets twice

**Evidence:** [`vendor/libudx/src/native/stream.rs:1631`](https://github.com/tetrumdev/ambra/blob/bd9841ed7cdcc1c5371f04cae730db215217099d/vendor/libudx/src/native/stream.rs#L1627-L1638), [`:454`](https://github.com/tetrumdev/ambra/blob/bd9841ed7cdcc1c5371f04cae730db215217099d/vendor/libudx/src/native/stream.rs#L449-L477).

The sender's loop uses `guard.inflight() + batch.len()` when evaluating the congestion window. Yet `register_sent()` already inserts every newly batched packet into `outgoing`, the data structure scanned by `inflight()`. The extra `batch.len()` can therefore prematurely block transmission during a batch.

**Source-derived count:** Codex's deterministic accounting probe reported that an empty **10-packet** window admits only **5 packets** when pacing tokens permit; with **5 free slots**, it admits **3**. The normal two-packet pacing burst limits the frequency of worst-case behavior. These are not direct observed throughput measurements.

**Minimal fix:** Remove `+ batch.len()`, keeping the existing `inflight()` count and its congestion/receiver-window checks. Compare against upstream native UDX accounting for confidence, but do not transplant code blindly.

**Expected impact:** **Medium**, possibly greater when the current shortfall prevents effective window utilization.

**Correctness checks:** Respect peer receive and congestion windows, avoid excess sends, handle SACK/retransmission accounting, and preserve flush/shutdown semantics.

### 3.4 Medium — Startup/probe and HLS decoder paths still block on entire HTTP responses

**Evidence:** [`desktop/src-tauri/src/native_audio/decoder.rs:675`](https://github.com/tetrumdev/ambra/blob/bd9841ed7cdcc1c5371f04cae730db215217099d/desktop/src-tauri/src/native_audio/decoder.rs#L672-L697), [`:777`](https://github.com/tetrumdev/ambra/blob/bd9841ed7cdcc1c5371f04cae730db215217099d/desktop/src-tauri/src/native_audio/decoder.rs#L771-L782), [`:844`](https://github.com/tetrumdev/ambra/blob/bd9841ed7cdcc1c5371f04cae730db215217099d/desktop/src-tauri/src/native_audio/decoder.rs#L832-L850), [`:517`](https://github.com/tetrumdev/ambra/blob/bd9841ed7cdcc1c5371f04cae730db215217099d/desktop/src-tauri/src/native_audio/decoder.rs#L511-L521).

Although large post-startup ranges were made progressive in the earlier fix, the initial 128 KiB range and some small refills call a helper that collects the full response via `response.bytes()` before returning data. HLS initialization and media resources also get collected into memory before being consumed.

At **0.488 MiB/s**, **128 KiB / 0.488 MiB/s ≈ 0.256 s** of pure transfer time, excluding RTT and overhead, before the bytes become available via this helper. Traversing the first 1 MiB in 128 KiB pieces is **eight requests** if all pieces are individually requested; request behavior and caching can affect the real total. Whole HLS resources add their own blocking download delay.

**Minimal fix:** Make these existing small-range requests progressively consumable while retaining bounded seek probes. Stream HLS resources one at a time, validate HTTP content ranges and total lengths, resume after the last successfully delivered byte, and cache only completed responses. Retain support for valid HTTP 200 fallback behavior.

**Important rejected experiment:** A previous 1 MiB-startup-request change reportedly worsened seek times from **3.3–3.8 s** to **5.5–7.8 s**. Do **not** blindly increase initial read size. See [`docs/networking/cross-network-2026-10-28-windows.md`](https://github.com/tetrumdev/ambra/blob/bd9841ed7cdcc1c5371f04cae730db215217099d/docs/networking/cross-network-2026-10-28-windows.md#L140).

**Expected impact:** **Medium**, potentially important for seek and start times over slow WAN paths.

**Correctness checks:** Exact range offsets, content length, bounded probing, retries, seeking, HLS init/media order, and uninterrupted progressive decode.

### 3.5 Medium for long phone queues — Repeated full queue transfers during ownership checks

**Evidence:** [`mobile/src/phoneEndpoint.ts:116`](https://github.com/tetrumdev/ambra/blob/bd9841ed7cdcc1c5371f04cae730db215217099d/mobile/src/phoneEndpoint.ts#L111-L123), [`mobile/src/client.ts:325`](https://github.com/tetrumdev/ambra/blob/bd9841ed7cdcc1c5371f04cae730db215217099d/mobile/src/client.ts#L313-L330), [`follow()`](https://github.com/tetrumdev/ambra/blob/bd9841ed7cdcc1c5371f04cae730db215217099d/mobile/src/client.ts#L256-L279).

The phone endpoint refreshes session state before selecting the output, loading audio, and playing. `refreshSession()` requests `/api/session` without supplying the known queue revision, whereas the normal follow loop already uses revision-based omission (`queue=${view.queueRevision}`).

**Concrete cost:** An initial device-selection-plus-load sequence can transfer **two additional full serialized queue snapshots**, followed by JSON parsing/rebasing. The bytes depend on queue size; no measured queue-size distribution is available.

**Minimal fix:** Request fresh ownership fields while sending the known queue revision; keep full-snapshot fallback if `accept()` cannot apply an omitted queue. Do not skip output ownership validation.

**Expected impact:** **Medium on mobile with large queues**, low for short queues.

**Correctness checks:** Queue changed between requests, server restart/instance change, revoked output ownership, old-server compatibility, and fallback behavior.

### 3.6 Medium for large queues — The server deeply clones unchanged queue JSON repeatedly

**Evidence:** [`server/src/session.rs:332`](https://github.com/tetrumdev/ambra/blob/bd9841ed7cdcc1c5371f04cae730db215217099d/server/src/session.rs#L331-L345), [`:433`](https://github.com/tetrumdev/ambra/blob/bd9841ed7cdcc1c5371f04cae730db215217099d/server/src/session.rs#L428-L454).

`queue()` obtains a clone of the cached `serde_json::Value`; session views call it again before deciding whether the unchanged queue needs inclusion in the response. Codex reports the server driver reads roughly every **250 ms**, implying approximately **four full queue clones/second** in that path, plus controller view requests.

**Minimal fix:** Store an immutable cached `Arc<Value>` snapshot. Reuse it for reads; clone to owned JSON only when a mutation or response serialization requires it. Invalidate/update on queue revision changes and preserve current locks.

**Expected impact:** **Medium for very large queues** and high controller/view frequency; not a primary WAN throughput cause.

**Correctness checks:** Invalidation, concurrent readers/writers, queue revision consistency, and serialization/ownership rules.

### 3.7 Low — Quadratic packet-send queue scanning

**Evidence:** [`vendor/libudx/src/native/stream.rs:1632`](https://github.com/tetrumdev/ambra/blob/bd9841ed7cdcc1c5371f04cae730db215217099d/vendor/libudx/src/native/stream.rs#L1627-L1637) and [`:477`](https://github.com/tetrumdev/ambra/blob/bd9841ed7cdcc1c5371f04cae730db215217099d/vendor/libudx/src/native/stream.rs#L475-L483).

Each send-loop iteration recomputes `queued_bytes` by scanning the remaining queue and calls `inflight()`, which scans outstanding packet records. This becomes O(n²) when draining a large queue one packet at a time.

**Source-derived queue visits:** A 64 KiB write split into **56 packets** entails at least **1,596** queued-packet visits if drained in sequence (`56 + ... + 1`). A 1 MiB write of **889 packets** entails **395,605** visits, excluding blocked checks and the outstanding-packet scans. These are operation counts, **not measured elapsed time**.

**Minimal fix:** Maintain an exact queued-byte counter within the existing protected stream state, updating enqueue, dequeue, retry, clear, and shutdown paths. If profiling later implicates the outstanding-packet scan, consider an equally carefully maintained inflight counter separately.

**Expected impact:** **Low until profiling establishes significant CPU time**. Do after responsiveness and pacer correctness fixes.

**Correctness checks:** Byte-total invariants under every queue mutation, partial writes, retransmissions, failures, and cleanup.

### 3.8 Low — Mobile polling retains abort listeners

**Evidence:** [`mobile/src/client.ts:265–275`](https://github.com/tetrumdev/ambra/blob/bd9841ed7cdcc1c5371f04cae730db215217099d/mobile/src/client.ts#L262-L279).

Each poll adds an `abort` listener to both the main signal and the current foreground wake signal, but the `finally` removes only the main listener. A wake signal held over repeated polls can accumulate callbacks until it aborts or is discarded. Under a **hypothetical one-poll/second** rate, that is approximately **3,600 callbacks/hour**; actual long-poll frequency and lifetime may differ.

**Minimal fix:** Retain a reference to the wake signal used for that iteration and remove its listener in the same `finally`. Preserve foreground waking and abort propagation.

**Expected impact:** **Low** for WAN data throughput; avoids unnecessary retained callbacks and foreground wake work.

**Correctness checks:** Abort races, foreground/background transition, resumed polling, and teardown.

## 4. What HoleSail's architecture teaches Ambra — without using HoleSail

### Actual architecture comparison

| Area | HoleSail / Holepunch reference | Ambra today | Recommended lesson |
|---|---|---|---|
| Peer discovery | `hyperdht` DHT node; public bootstrap and key-based connection | Rust `peeroxide-dht` HyperDHT client with persistent node | Keep persistent DHT state; compare resolution/reconnect timing |
| NAT traversal | HyperDHT-assisted direct UDP hole punching with reusable sockets | Direct HyperDHT/UDX + optional pwnat | Preserve authenticated direct transport; reuse successful sockets/routes where safe |
| Reliable UDP | Holepunch native UDX transport | Ambra vendored Rust libudx | Use native UDX behavior as a test oracle for pacing, ACKs, congestion and flow control |
| Encrypted streams | HyperDHT's encrypted stream abstractions | Noise over adapted framed SecretStream | Maintain bounded streaming and batching without per-frame ACK serialization |
| TCP/UDP service interface | Local tunnel/proxy around arbitrary TCP or UDP service | Native HTTP bridge + persistent HTTP/2 session | **Do not blindly copy tunnel-per-connection behavior**; HTTP/2 reuse may be better for music APIs |
| Lifecycle | `ready()`, `pause()`, `resume()`, `close()`; reusable sockets | Connection manager plus server/output lifecycle | Ensure cancellation/reconnect does not invalidate playback intent or retain dead listeners |
| Music buffering | Generic bytes; not music-aware | Native decoder and queue/output ownership | Make buffering, preparation, command cancellation and prefetch audio-aware |

**Primary references:** [HoleSail repository](https://github.com/holesail/holesail), [current `@holesail/core`](https://github.com/holesail/core), [HoleSail client](https://github.com/holesail/holesail-client/blob/main/index.js), [HoleSail server](https://github.com/holesail/holesail-server/blob/main/index.js), [HoleSail TCP tests](https://github.com/holesail/core/blob/main/test/tunnel-tcp.js), and [Ambra networking](https://github.com/tetrumdev/ambra/tree/bd9841ed7cdcc1c5371f04cae730db215217099d/crates/ambra-net). Current core declares `hyperdht ^6.34.0`; HoleSail's client/server use `{ reusableSocket: true }`.

### 4.1 Adopt native UDX *semantics* as a correctness reference

HoleSail's core advantage here is **the upstream transport implementation and operational history**, not a magical zero-latency mechanism. Compare Ambra against Holepunch UDX on identical data and impairment profiles, focusing on:

- Congestion-window and receive-window accounting, including newly registered packets.
- Calculated pacing deadlines and event-driven wakeups.
- Delivery-rate sampling, BBR startup/steady state, and pacing tokens.
- Selective and cumulative acknowledgment accounting, retransmission timeouts, and reordered packets.
- Bounded writes, backpressure, graceful `flush()`/shutdown, and packet MTU handling.

Implement the smallest proven corrections inside the existing Rust stack. Do not replace it wholesale, increase pacing bursts on intuition, or assert the Rust language is intrinsically responsible for slower throughput.

### 4.2 Keep and refine the good parts Ambra already has

Ambra's `ConnectionManager` already coalesces concurrent connection establishment and reuses a healthy authenticated HTTP/2 connection; `hyperdht::Client` owns a lazy DHT node rather than bootstrapping per API request. These are efficient and should stay. HoleSail's current TCP proxy creates a tunnel for each new local TCP connection, which is not automatically more efficient for a multi-request music client. Preserve Ambra's LAN preference, identity pinning, server-side authorization and distinct server/client responsibilities.

### 4.3 Optimize for music, where HoleSail does not

A generic tunnel cannot make a slow load interruptible or prefetch enough decoded seconds for jitter resistance. Ambra can outperform a generic tunnel in *perceived playback smoothness* by:

- Releasing the server operation lock while waiting for remote load I/O, with generation-checked completion.
- Returning startup and HLS audio incrementally, not necessarily with larger requests.
- Maintaining a measured safety margin of decoded/buffered audio without excessive startup or seek delays.
- Keeping buffered playback alive through bounded reconnection and preserving user play/pause intent.
- Minimizing unnecessary queue synchronization across remote and phone clients.

### 4.4 Do not confuse DHT signaling with an Internet relay or a firewall bypass

Neither HoleSail nor Ambra removes the latency inherent in an actual WAN path. HyperDHT helps peers discover and establish direct streams; it is not equivalent to placing the server on the local subnet. HoleSail still depends on usable UDP and DHT reachability. Ambra's school-network investigation observed **zero replies from 60 tested DHT endpoints** while the home control reached them; using HoleSail's architecture alone cannot fix a network that filters those packets. pwnat also failed on the tested physical path because required ICMP/NAT behavior did not materialize.

**Source:** [`docs/networking/cross-network-2026-10-28.md`](https://github.com/tetrumdev/ambra/blob/bd9841ed7cdcc1c5371f04cae730db215217099d/docs/networking/cross-network-2026-10-28.md), [`docs/networking/autonomous-2026-10-28.md`](https://github.com/tetrumdev/ambra/blob/bd9841ed7cdcc1c5371f04cae730db215217099d/docs/networking/autonomous-2026-10-28.md).

## 5. Paths inspected that do *not* justify changes now

These are important negative findings; they should not be turned into speculative refactors:

| Area already examined | Existing behavior | Decision |
|---|---|---|
| Connection establishment | Shared in-flight worker, active connection reuse; no DHT handshake per API call ([`manager.rs:271`](https://github.com/tetrumdev/ambra/blob/bd9841ed7cdcc1c5371f04cae730db215217099d/crates/ambra-net/src/manager.rs#L267-L324)) | Preserve; instrument phase timing |
| Server audio proxy | Streams response bodies rather than aggregating entire audio response ([`api.rs:2435`](https://github.com/tetrumdev/ambra/blob/bd9841ed7cdcc1c5371f04cae730db215217099d/server/src/api.rs#L2428-L2450)) | No blanket proxy rewrite |
| Local audio files | Async file reads ([`local_music.rs:204`](https://github.com/tetrumdev/ambra/blob/bd9841ed7cdcc1c5371f04cae730db215217099d/server/src/local_music.rs#L196-L218)) | Not the obvious WAN bottleneck |
| Qobuz links | Cached URLs and coalesced overlapping lookups ([`qobuz.rs:523`](https://github.com/tetrumdev/ambra/blob/bd9841ed7cdcc1c5371f04cae730db215217099d/server/src/providers/qobuz.rs#L515-L540)) | Preserve cache and reuse |
| Artwork and React | Artwork disk reads use `spawn_blocking`; caches bounded; track rows memoized and lists virtualized (Codex audit) | No evidence for broad frontend memoization or image rewrites |
| Encrypted framing | Previous 16 KiB stop-and-wait effect corrected by bounded batching ([`transport.rs`](https://github.com/tetrumdev/ambra/blob/bd9841ed7cdcc1c5371f04cae730db215217099d/crates/ambra-net/src/transport.rs)) | Keep test coverage; do not re-fix |
| Historical UDX bugs | Earlier BBR sampling, duplicate ACK/RTO bugs and unbounded writes corrected in `bd9841e` | Do not claim these are still open |

Also, the small linear LAN address deduplication check and the bounded stream-copy buffers have no current evidence of material CPU cost in steady-state playback. The newly identified quadratic *UDX* send-loop scan is real, but remains lower priority than command lock contention and pacing correctness.

## 6. Priority-ordered implementation and verification plan

| Priority | Minimal change or investigation | Success criterion | Safety invariant |
|---:|---|---|---|
| **1** | Make server remote-loading preparation interruptible, with generation/output-instance checks | Pause/seek/skip do not wait behind a stalled load | Stale loads never overwrite newer commands; device ownership preserved |
| **2** | Correct pacer in-flight accounting; retain computed deadlines and notification-driven waking | Deterministic window/pacer tests pass; no 1-ms wake loop under full cwnd | Congestion and receive windows, ACK/flush and burst limits preserved |
| **3** | Make initial/probe 128 KiB ranges and HLS resources progressively readable | Lower first-audio/seek delay on impaired WAN without regressions | Exact byte offsets, range validation, retry/resume, cache correctness |
| **4** | Add measured buffer occupancy and network-delivery timing; tune prefetch only if beneficial | Fewer actual audio underruns under controlled jitter/loss | No unbounded buffering, unbounded latency or broken seek behavior |
| **5** | Use revision-aware phone refresh and immutable server queue snapshots | Fewer transferred queue bytes and clone allocations | Current ownership, revisions and fallback retained |
| **6** | Remove leaked mobile wake-signal listeners | Stable listener count over long sessions | Abort and foreground refresh still work |
| **7** | Maintain queue-byte total in UDX and profile packet-loop CPU | Reduced CPU/queue visits if this path is hot | Exact byte total and queue cleanup semantics |
| **8** | Only then test separate control stream/connection against shared HTTP/2 | Improved p95 control latency under streaming, if measurable | No conflict with authenticated single-session supersession |

**Controlled performance comparison:** On the same Mac-hotspot/Kubuntu-home topology, run **three** pathways where possible: direct LAN TCP as a local baseline; Ambra native HyperDHT/UDX; and upstream HoleSail/native UDX as a *test-only baseline*, not an Ambra dependency. Use the same byte-exact payload sizes, packet impairments, warm/cold connect definitions, and enough repetitions to characterize variability. Time the following separately:

- DHT bootstrap, peer lookup, NAT hole punch, Noise handshake, HTTP/2 initialization, authorization.
- Time to first usable audio byte, time to audible startup if measurable, and seek/load/command latency.
- Sustained MiB/s, per-stream ACK/retransmission/RTO counts, pacing timers, cwnd, bytes in flight, CPU and memory.
- Concurrent control request p50/p95, body gaps, decoded audio buffer seconds, underruns, and recovery after forced disconnection.

If upstream HoleSail/native UDX is much faster on the **same** real network, isolate the protocol/implementation divergence. If it is similarly slow, focus on common network conditions and end-to-end audio/server behavior rather than assuming the transport rewrite will help.

### Verification checklist

- [x] Specific actionable findings include file/line references, code-path mechanism and a concrete cost or a clearly labeled derived estimate.
- [x] Findings ranked High/Medium/Low with smallest proposed fix.
- [x] Existing already-efficient paths and corrected historical bugs identified.
- [x] Basic correctness invariants reviewed for each proposed fix.
- [ ] Proposed changes implemented — **not done**.
- [ ] Proposed changes regression-tested — **not done**.
- [ ] New live LAN vs. P2P vs. HoleSail benchmarks — **not done**.
- [ ] Physical user-audible long-session performance verified — **not done**.

## 7. Final conclusion

The latest Ambra commit improved real transport correctness, but the measured sustained throughput still only reached **0.488 MiB/s**, and an extended transfer still stalled in one run. **Codex's code audit identifies more precise, actionable causes of perceived slowness than the throughput figure alone:** a lock blocking interactive commands during remote loads; pacer timer and in-flight accounting defects; decoder startup/HLS full-body waits; plus avoidable queue and mobile overhead.

**Fix server command responsiveness first, then pacer correctness, then remaining whole-body decoder waits.** Borrow from HoleSail only where its underlying HyperDHT/UDX implementation provides measurable, testable design guidance. Keep Ambra's native Rust networking, persistent HTTP/2 connection reuse, independent server/client architecture, authenticated device ownership and audio-specific buffering. Target a **LAN-like listening experience**, not physically impossible zero-WAN-latency behavior.

---

### Reference repositories and reports

- [Ambra, pinned commit `bd9841e`](https://github.com/tetrumdev/ambra/tree/bd9841ed7cdcc1c5371f04cae730db215217099d)
- [Autonomous physical networking report and results](https://github.com/tetrumdev/ambra/blob/bd9841ed7cdcc1c5371f04cae730db215217099d/docs/networking/autonomous-2026-10-28.md)
- [Cross-network investigation, decoder and batching history](https://github.com/tetrumdev/ambra/blob/bd9841ed7cdcc1c5371f04cae730db215217099d/docs/networking/cross-network-2026-10-28.md)
- [Windows networking and rejected larger startup-range experiment](https://github.com/tetrumdev/ambra/blob/bd9841ed7cdcc1c5371f04cae730db215217099d/docs/networking/cross-network-2026-10-28-windows.md)
- [HoleSail CLI project](https://github.com/holesail/holesail)
- [HoleSail core](https://github.com/holesail/core)
- [HoleSail client](https://github.com/holesail/holesail-client)
- [HoleSail server](https://github.com/holesail/holesail-server)

**Repository edit status: none.** This report is a separate Markdown artifact.
