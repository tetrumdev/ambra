# Windows server ↔ Mac Desktop cross-network session — October 28, 2026

This session tested the independent Ambra Server on the operator's Windows tower against the real Ambra Desktop on a MacBook, across separate networks. It found that school Wi-Fi blocks HyperDHT at the network level, and that the Windows-to-Mac stream was starved by four transport defects. The fixes made server-hosted playback continuous on a cellular hotspot and through a VPN. Release builds of the fixed code are installed on both machines. The operator committed the code fixes as `bfcba1e` ("hopefully this fixes p2p") and pushed them to `origin/main`.

## Machines, revisions, and topology

| | Windows tower (server) | MacBook (Desktop client) |
|---|---|---|
| Repository | `C:\Users\ewph\Documents\ambra` | `/Users/alexrivkin/WebstormProjects/ambra` |
| Before | `7a3fd751d1674f03da91ce40d0e4c2016c13dd0c`, clean | `7a3fd751d1674f03da91ce40d0e4c2016c13dd0c`, clean |
| After fast-forward | `081335f4fbdf6f46c6446347df46d18244d6cf39` | `081335f4fbdf6f46c6446347df46d18244d6cf39` |
| Network | Home, public `74.104.161.129`; default routes `192.168.1.1` (metric 10) and `192.168.50.1` (metric 20) | School Wi-Fi `en0` `10.29.25.146`, then home, then cellular hotspot `172.20.10.4` (carrier IP `107.77.225.166`) |
| Administration | SSH `ewph@100.64.111.72` over Tailscale (admin only) | Local |

Both repositories were fast-forwarded with `--ff-only`. Existing stashes were left untouched. Server identity: `861faecb0a715f79184f8146038842aafbc080efb05251f8daf10956d8b2beff`. This is a different Mac and server from the October 27/28 reports, which used another Mac and a Kubuntu server.

Tailscale carried only SSH administration. ProtonVPN was used for some tests with the operator's agreement; those results are labelled VPN-assisted below.

## 1. School Wi-Fi blocks HyperDHT (external restriction, not an Ambra bug)

With ProtonVPN off, a minimal independent dht-rpc PING (not Ambra code) was sent to the 3 bootstrap nodes and to 60 live DHT nodes. The 60 nodes were collected via FIND_NODE.

| Path | Bootstrap replies | 60-node replies |
|---|---|---|
| School `en0` | 0/3 | **0/60** |
| Same Mac through ProtonVPN | 3/3 | 60/60 |
| Windows tower at home | 3/3 | **60/60** |

UDP traceroutes from school (3 probes per port) found that the school allows UDP only to certain **destination ports**. The same result held toward the home IP and toward a DHT node:

- Allowed past the school edge (`208.58.177.213` / `209.6.175.113`): UDP 53, 123, 443, 19302.
- Dropped inside the school network at hop 3 (`10.30.10.2`): UDP 500, 3478, 4500, 8443, 40123, 49737.
- ICMP traceroutes reached the internet on both paths.

Payload is irrelevant, because plain traceroute packets were dropped the same way. HyperDHT needs UDP to DHT node ports (4973x and others) and to arbitrary hole-punched ports, so it cannot work from this school network. Moving traffic onto an allowed port would be evading the school's controls, so that was not done.

Other school NAT observations:

- Egress uses two public IPs (`208.58.177.214` for Google, `209.6.175.114` for others). This looks like policy routing.
- Source ports are usually preserved, but not always (Cloudflare `:53` mapped `51143` to `13861`).

The real Desktop on school Wi-Fi fails at the first stage and reports it correctly:

```
WARN peeroxide_dht::rpc: DHT bootstrap failed: no reachable routing nodes bytes_sent=516 bytes_received=0
Transport attempt failed method=HyperDHT ... error=DHT error: bootstrap failed: no reachable DHT nodes; public UDP may be blocked
```

That failure took 4.0 s after start. Rounds then retry with an immediate retry followed by a 5 s period, which is correct.

## 2. HyperDHT with the Windows server works where UDP is allowed

This is the first end-to-end run with the Windows server. Through ProtonVPN, the first cold connection took:

- DHT bootstrap 3.07 s, FIND_PEER 1.27 s, pinned Noise 239 ms.
- Punch to `74.104.161.129:54436`, device authorization 162 ms.
- Full round **9.76 s**.

The server logged the peer at the VPN exit `159.26.96.76:33650`, as a direct authenticated UDX stream with no relay. Library listing worked. Later cold connections on the hotspot took 6.6–15.3 s.

The client classifies ProtonVPN and carrier NATs as RANDOM (`firewall=3`). Against the consistent Windows NAT, birthday-socket punching took 4–24 s. That matches expected probe luck and is not a defect. Note that the `verified_addr` in `final punch sent` logs is the relay-observed server address, not the punch target.

## 3. Transport defects found and fixed

Playback of server-hosted tracks stuttered badly ("plays ~1 s, silence 5–10 s"). The 16-bit/44.1 kHz FLAC test track ("Ode to Sleep") needs about **127.5 KB/s** (1020 kbps). The server delivered about 87–100 KB/s, so position advanced at 0.77× real time.

The following were ruled out by measurement:

- **Server CPU:** 10% of one core.
- **The Qobuz proxy:** a release fixture serving memory showed the same rate.
- **Seeking or restarting:** the position never moved backward.
- **The VPN:** with VPN off the rate was 0.0885 MiB/s; with VPN on, 0.0887.

### 3.1 UDX writes waited for the previous write's ACK

**File:** `vendor/libudx/src/native/async_stream.rs`

**Defect:** `poll_write` returned `Pending` while the previous write's remote ACK was outstanding. That made every UDX write stop-and-wait. During playback each write was about one 16 KiB frame, so throughput was about 16 KiB per RTT. Server BBR showed inflight averaging 4.9 packets against cwnd 15.

**Fix:** keep a FIFO of unacknowledged writes, and let `poll_write` queue until about two congestion windows (`2 × cwnd × max_payload`, clamped to 64 KiB–1 MiB). `poll_flush` and `poll_shutdown` still wait for every ACK, and FIN waits for prior writes.

**Results** (release, Mac sender, school + VPN):

| Bound | Throughput | Poll latency p50/p95 |
|---|---|---|
| Original | 0.24 MiB/s | 846/1271 ms |
| Fixed 1 MiB (rejected) | 0.47 MiB/s | 2199/3152 ms |
| **cwnd-adaptive (kept)** | **0.44 MiB/s** | **707/1381 ms** |

**Regression proof:** the original code accepted only 1 unacknowledged write ("only 1 unacknowledged writes were accepted"); the fix passes.

### 3.2 BBR RTT and send-interval samples used the send-burst start time

**Files:** `vendor/libudx/src/native/congestion/rate.rs`, `congestion/mod.rs`, `stream.rs`

**Defect:** RTT was computed as `now − info.first_sent_ts`. That value is the start of the current send burst, and it only resets when inflight reaches 0. On a busy stream it aged for seconds; a sample of `min_rtt_ms=9873` was logged on a 52 ms path. Every 10 s, at ProbeRtt entry, BBR adopted such a sample. cwnd then sat at its floor of 4 packets (about 105 KB/s, below the track's bitrate). The send-interval term was always 0, because both operands were the same burst start.

**Fix:** `PacketRateInfo` now records each packet's own `sent_ts` and a `retransmitted` flag. RTT uses `sent_ts` and skips retransmitted packets (Karn's rule). The packet's own send time feeds the stream's `first_sent_ts`, matching Linux `tcp_rate_skb_delivered` and C udx. Afterwards, cwnd held at 12–15 instead of collapsing to 4. Existing rate tests were updated for the new fields.

### 3.3 Pacing token bucket lost credit

**File:** `vendor/libudx/src/native/congestion/pacing.rs`

**Defect:** `refill()` truncated elapsed time to whole milliseconds but always moved `last_refill` to `now`. The send loop calls it several times per wakeup, so most credit was discarded.

**Fix:** credit is computed in microseconds, and time that has not yet earned a whole byte stays uncredited. The burst cap stays at the original `2 × MSS`. `delay_for` now returns sub-millisecond precision, and one existing test expectation changed from 12 ms to 11.8 ms.

**Regression proof** (target 2,000,000 B/s):

| Case | Original code | Fixed |
|---|---|---|
| 15.6 ms timer ticks | 185,856 B/s | passes |
| Frequent sub-ms refills | 2,904 B/s | passes |

### 3.4 Windows 15.6 ms timer capped the server's sending

**File:** `server/src/main.rs`

**Defect:** Windows sleeps in about 15.6 ms ticks by default, and the pacer slept "1 ms" between sends. Windows-sent throughput was a fixed ~93 KB/s (about 64 packets/s, one per tick) regardless of RTT: 42 ms and 84 ms paths gave the same rate.

**Fix:** `ambra-server serve` calls `timeBeginPeriod(1)` on Windows. On Windows 10 2004 and later this applies only to this process and ends when it exits. It uses the existing `windows` crate features.

### Result

Playback on the hotspot with all fixes:

- The server bursts at 221–247 KB/s, then idles while the player's buffer is full.
- The native player advanced 1.0 s per wall-clock second over 37 s.
- The operator confirmed: "playback is working perfectly now".

| Measured on hotspot (debug Desktop, original decoder) | Time to audible |
|---|---|
| First play of a track | 14.5 s |
| Play from pause | 6.1 s, 2.9 s |
| Seek | 3.3–3.8 s |

## 4. Tried and rejected

- **Larger pacing burst (16 ms of data at pacing rate).** It exposed two deeper BBR defects (see §6). Startup never exited, and cwnd swung between 4 and 510. After the loss storm, delivery stopped entirely (stuck at 3,986 delivered packets). Reverted to the 2-packet burst.
- **Streaming the decoder's 1 MiB startup window in one request** instead of sequential 128 KiB ranges. Seeks became slower: 5.5–7.8 s against 3.3–3.8 s, because abandoned in-flight data costs more than the saved requests. Reverted (`desktop/src-tauri/src/native_audio/decoder.rs` is unchanged).
- **Suspected punch-target defect.** `verified_addr` in logs only looked wrong; the punch targets the advertised puncher sample. No change.

## 5. Windows and test-environment findings

- **Firewall:** HyperDHT handshakes time out silently if the exact server `.exe` path has no inbound allow rule. All existing `ambra-server.exe` paths have one. A new binary at a new path, or a dismissed firewall prompt, breaks remote connections without a clear error. A temporary rule was added for the benchmark fixture and removed again.
- **SSH lifetime:** processes launched with `Start-Process` from an OpenSSH session die when the session closes. Long-lived test servers were launched through WMI `Win32_Process.Create`.
- **Tray:** `ambra-server start` (which runs `serve --tray`) fails from a non-interactive session with `Error: Os { code: -2147467259, ... "Unspecified error" }` (`E_FAIL`).
- **Node interop tests:** the libudx Node.js interop tests (`stream_interop`, `udx_interop`, `wire_compat`; 9 tests) fail because the Node fixture cannot run. `stream_interop` fails identically on clean HEAD; the other 8 show the same symptom.
- **Remote endpoint reports:** while playing, reports arrive at p50 156 ms, p90 544 ms, max about 1 s. Late reports during bursts make the progress bar jump.
- **Test-driver caveat:** the debug Desktop's `--network-test-stdin` `uiTogglePlayback` clicks the real play button and can fight with an operator. `playTrack` only accepts tracks already in the server queue catalog.

## 6. Still open

1. **BBR Startup never exits** on cellular paths. Once pacing allows bursts, cwnd overshoots and losses subtract from cwnd, so it swings between 4 and 510 packets.
2. **Delivery stalls completely after heavy loss** (loss recovery or RTO path). Items 1 and 2 cap bursts at about 230 KB/s on a 5 MB/s link, and are the main remaining cause of start, skip, and seek latency. They must be fixed before raising the burst cap.
3. **Commands queue behind bulk audio.** About 320 KB of old-track audio sits in buffers below HTTP/2 (duplex pipe, pump, `BufWriter`, UDX window). A skip let the old song play for about 4 s.
4. **Startup reads are sequential.** The decoder reads its first 1 MiB as eight 128 KiB requests, and each costs a P2P round trip plus the CDN's first byte.
5. **Native school access** needs a network-policy change from the school. It cannot be done in software without evading the filter.
6. **pwnat was not physically tested.** Windows pwnat is explicitly disabled (no raw-ICMP path without Administrator). Even with Windows support, school Wi-Fi would block the UDP leg to the listener port. A fabricated Time Exceeded test was prepared (Windows `pktmon` capture saw 97 echo requests, 0 Time Exceeded), but it is unconfirmed whether the Mac sender was run. The result is therefore not evidence either way.
7. Reliability statistics (success rate, repeated cold/warm runs) and broader track/bitrate coverage are not established.

## 7. Installed state

Release builds of this code are installed on both machines. The Mac build matches commit `bfcba1e`. The Windows build came from the same source as uncommitted changes on `081335f`.

| | Installed | Backup |
|---|---|---|
| Windows | `C:\Users\ewph\.cargo\bin\ambra-server.exe` and `%APPDATA%\com.quantium.ambra\data\server-bin\ambra-server.exe`, SHA-256 prefix `2689773E91C1` | `ambra-server.exe.bak-20261028` beside each |
| Mac | `/Applications/AMBRA.app`, 0.2.1, ad-hoc signed, no server bundled; binary SHA-256 prefix `6b2c9fa6573c` | `~/Library/Application Support/com.quantium.ambra-app-backup-20261028/AMBRA.app` |

The Windows server runs headless (`serve`, launched via WMI) and logs to `%APPDATA%\com.quantium.ambra\data\server.log`. Restart it from the PC's own terminal (`ambra-server stop`, then `ambra-server start`) to get the tray back.

**Rollback:** copy the `.bak-20261028` files over the installed Windows binaries, and copy the backed-up `AMBRA.app` back into `/Applications`.

## 8. Changed files and checks

Code changes, with identical file hashes on both machines. The operator committed and pushed them as `bfcba1e`. The Windows checkout is still at `081335f`, with these changes uncommitted in its working tree:

- `server/src/main.rs`
- `vendor/libudx/src/native/async_stream.rs`
- `vendor/libudx/src/native/congestion/mod.rs`
- `vendor/libudx/src/native/congestion/pacing.rs`
- `vendor/libudx/src/native/congestion/rate.rs`
- `vendor/libudx/src/native/stream.rs`
Not in that commit:

- `AGENTS.md`: tests may be written and run, but must not be kept after they pass. This file is gitignored (`.gitignore:77`), so it stays local.
- `docs/networking/cross-network-2026-10-28-windows.md` (this report) and a link to it in `docs/networking/README.md`. These are uncommitted on both machines.

Temporary regression tests were written, run against original and fixed code, and then removed as `AGENTS.md` requires.

| Check | Result |
|---|---|
| libudx unit tests | 64 passed |
| libudx transport integration (`throughput`, `network_sim`, `async_stream`, `stream_lifecycle`, `multiplexing`) | 34 passed |
| libudx full suite | 136 passed, 9 failed (Node interop only, §5) |
| ambra-net `--tests` | 40 passed |
| Desktop decoder HTTP tests | 3 passed |
| `git diff --check` | clean |
| Release builds | server (Windows) and Desktop app bundle (Mac) succeeded; one pre-existing warning: `SinkStartupFailed` never constructed |

Session diagnostics (probe scripts, logs, benchmark output) are under `/tmp/ambra-xnet-20261028b/` on the Mac and `%TEMP%` on Windows. They are not part of the repository.
