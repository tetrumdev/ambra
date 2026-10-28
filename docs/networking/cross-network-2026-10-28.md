# Cross-network debugging handoff — October 28, 2026

## Stop point and result

The operator requested that testing stop to conserve AI usage, that this handoff be saved, and that the work be committed and pushed. **The complete original acceptance matrix is not finished.** Do not report reliable VPN-free school-network operation.

The latest real Desktop and independent Kubuntu server successfully played Qobuz **Redecorate** through WARP. After the final encrypted-frame batching fix, the operator explicitly confirmed: **“The sound is continuous.”** Before batching, progressive HTTP reads removed backward jumps, but the operator still heard intermittent cutouts. One forced transport reconnect subsequently succeeded, selected a different public UDP endpoint, authenticated again, loaded library data, and played the track. Twelve post-reconnect native samples advanced from 15.546 to 49.679 seconds without buffering, backward jumps, or decoder errors.

WARP was disconnected and the isolated debug Desktop was exited when testing stopped. The standalone Kubuntu debug server remains running. Existing normal Desktop data, server identity, pairing records, music, and provider configuration were preserved.

## Environment and authorization

- Mac repository: `/Users/eythanlawless/WebstormProjects/ambra`; macOS, Apple Silicon.
- Kubuntu: `ssh llewyn@100.106.252.60`, repository `/home/llewyn/ambra`. Tailscale is authorized **only for SSH administration**, never Ambra application traffic. Do not put passwords in files, logs, or commits.
- Starting HEAD on both machines: `7a3fd751d1674f03da91ce40d0e4c2016c13dd0c` (`fix(net): speed up authenticated P2P reconnects`), initially clean. Current changes belong to this investigation. Kubuntu retains the starting HEAD with synchronized, uncommitted source changes; Mac will receive the requested handoff commit.
- Preserve unrelated work. Do not reset or force-pull. Do not push again without a new request; the operator authorized this checkpoint push only.
- Mac disk floor: never below 1 GiB; prefer at least 2 GiB. Latest check: approximately **26 GiB free**. Check again before builds.
- User currently has **no cellular connection available**. Do not repeatedly request a hotspot switch.
- User authorized temporary WARP connection tests **then restoration to disconnected**, and command-line control of the real debug Desktop.
- Ask before changing important routes/firewalls/network configuration. Ask for macOS password entry privately in Terminal when necessary; never request disclosure in chat.

## Physical topology and school limitation

Mac school Wi-Fi: `en0`, address `10.29.33.27`, gateway `10.29.33.1`, public IPv4 `208.58.177.214`. Kubuntu home Wi-Fi: `wlo1`, `192.168.86.220`, gateway `192.168.86.1`, public IPv4 `74.104.161.161`. These are separate physical networks. Earlier cellular control used `172.20.10.12`, public `174.224.165.230`.

Without WARP, school received **0/60 replies** from public DHT candidates; home received **60/60** from the same candidates. Independent Python generated valid DHT wire requests, so the missing responses are not explained by Ambra discovery code. Bounded capture showed bootstrap UDP leaving physical Wi-Fi and no replies. Explicit direct peer UDP probing also received nothing. School did allow DNS, Google STUN on UDP/19302, and Nextcloud STUN on UDP/443; Cloudflare STUN on UDP/3478 timed out. This is selective restriction, not proof that all UDP is blocked. The exact firewall/drop location is unknown.

WARP restored DHT replies and real Desktop connectivity. WARP was already installed and configured for MASQUE traffic mode. Tests first used HTTP/2, later HTTP/3. Final peer route used `utun9`; Tailscale administration used `utun8`. This is **VPN-assisted HyperDHT/UDX**, not native traversal directly through the school firewall, and not proof of the original VPN-free requirement. Application protocol still uses pinned Noise and direct peer UDX; no Ambra application-data relay was added. DNS-only Cloudflare mode cannot fix filtered peer UDP.

SSH often stopped working while WARP was active. `warp-cli disconnect` followed by `tailscale up` restored administration. WARP is now off. Reconnecting it requires renewed user permission because the authorized temporary test has ended.

Do not claim every direct alternative is impossible. Native school access needs network permission for required DHT/peer UDP, or another demonstrated compatible direct path. A VPN can carry the traffic, but changes the transport topology and may be subject to school policy.

References consulted: https://developers.cloudflare.com/warp-client/warp-modes/ and https://developers.cloudflare.com/cloudflare-one/team-and-resources/devices/cloudflare-one-client/deployment/firewall/ .

## pwnat investigation

Production pwnat remains disabled. An isolated Kubuntu profile `/tmp/ambra-cross-20261028-pwnat` used ports 48447/48449 and a separate identity. The pre-existing `/usr/local/libexec/ambra-icmp-launch` had `cap_net_raw=ep`; server ran as UID/EUID 1000. The operator manually ran the macOS one-shot ICMP helper with sudo, following `docs/networking/pwnat.md`. Explicit public endpoint bypassed blocked DHT discovery.

The five-second probe failed with: `pwnat ICMP/QUIC/Noise setup timed out; client NAT must translate ICMP errors and both NATs must preserve ICMP identifiers/UDP ports`. No authenticated session resulted. The isolated server was stopped. The Mac capture started too late: its empty result is **not synchronized evidence** of the failed exchange. pwnat requires compatible ICMP translation and peer UDP and is not a proven school workaround.

## Root causes and changes

1. **False bootstrap success obscured the school failure.** `vendor/peeroxide-dht/src/rpc.rs` now tracks Pending/Ready/Failed bootstrap state. Configured bootstrap that discovers no reachable routing nodes returns `BootstrapFailed`, including later waiters, instead of eventually misleading the user with `peer not found`. Invalid bootstrap resolution fails before allocating sockets. Explicit standalone/no-bootstrap nodes remain supported. Three regressions cover this. `crates/ambra-net/src/hyperdht.rs` adds recovery proof: failed bootstrap discards its node and later uses fresh sockets when routing becomes reachable. The false-success defect predates the overnight optimization (`git blame`: `d8ce161`, October 26).
2. **Native HTTP reading waited for a complete large range.** After the first MiB, Desktop collected an entire 4 MiB range before returning audio bytes. On the slow path, the existing 20-second request deadline expired, triggering repeated work and playback discontinuity. `desktop/src-tauri/src/native_audio/decoder.rs` now streams large ranges progressively, validates Content-Range bounds/total, resumes interrupted bodies at the first unread byte, and handles HTTP 200 fallback by skipping the prefix progressively. Existing timeout values remain. Three focused regressions cover early delivery, exact resume, and invalid range rejection. Early-delivery regression failed before the fix. This removed the operator's backward audio/progress jumps.
3. **Every encrypted frame waited for remote acknowledgement.** The split SecretStream writer flushed each 16 KiB pump frame. UDX flush waits for remote ACK, serializing WAN delivery and causing remaining audible cutouts. `vendor/peeroxide-dht/src/secret_stream.rs` now uses a bounded standard Tokio 64 KiB BufWriter for the split write half, with explicit buffered write and flush methods. `crates/ambra-net/src/transport.rs` batches ready frames and flushes when input is idle; EOF still shuts down gracefully. Existing immediate-flush write API, wire framing, cipher state, authentication, raw UDX implementation, congestion control, and ACK semantics remain intact. Regression proves idle messages flush and ready frames do not wait between ACKs; it failed before and passes after. Operator confirmed continuous audio after both endpoints had this change.
4. **Real Desktop automation.** New `desktop/src-tauri/src/network_test.rs`, startup hook in `lib.rs`, and debug-only reconnect helper in `server_link.rs` provide opt-in stdin commands. No network listener, release control surface, server bundling, or replacement player. Commands use the existing authenticated bridge and native player. Queue selection preserves history/upcoming and checks queue revision. Diagnostics redact source URLs, bridge capabilities, and bearer values. Unknown actions/fields are rejected. Two regression tests pass.

No libudx files remain modified. A speculative raw UDX pipeline change/test was removed in favor of standard buffering. Temporary frontend diagnostics were removed; `desktop/src/api/core.ts` and `remote_endpoint.rs` are clean. No unrelated refactors were performed.

## Regression reference and source compatibility

Read `docs/networking/cross-network-2026-10-27.md` and `docs/p2p/overnight-report.md`. October 27 demonstrated cellular-to-home native HyperDHT, pairing, and audible tone. The overnight measurements used the same router and do not prove separate-network reliability.

At the start of this session Kubuntu was executing an installed server binary, not the checkout debug binary. Physical tests now explicitly run checkout builds. Relevant changes were synchronized using content checks before overwriting, preserving other work. Do not assume PATH resolves to the correct binary. The installed server binary was not replaced. No evidence establishes that connection racing, socket-pool optimization, or server supersession caused the school filtering. Those mechanisms were not blindly reverted.

## Live process/profile details

- Kubuntu server PID at stop: **72548**, `/home/llewyn/ambra/server/target/debug/ambra-server serve`, started around `15:18:41 UTC`.
- Server log: `/tmp/ambra-cross-20261028-batched-server.log`.
- Pinned server public key: `154597d7ea1e2c45b89cd4d362424c0b845ed813301c8ea344e22e0292c54240`.
- Debug Desktop PID was **61777**, tool PTY session **30814**; it has now exited via its `quit` command. These handles are historical, not reusable after exit.
- Isolated Desktop profile: `/tmp/ambra-cross-20261028-desktop`. It contains private identity/pairing credentials: **preserve, never commit or dump it**. Normal Desktop profile untouched.
- Paired test client ID: `105d9d2c901c5742e325dd62accc4a61`. Approval code 491625 was consumed earlier; obtain a new code for fresh pairing.
- Desktop log: `/tmp/ambra-cross-20261028-final-desktop.log`.
- User logged Qobuz into the server during this session; provider credentials remain private in server configuration.
- Track: Qobuz `qobuz:121923141`, **Redecorate**, about 245.84 s, FLAC 24-bit/48 kHz/stereo, estimated 1676.94 kbps.
- Local eight-second tone ID: `local:4e85b5a02eb68e19da7968ec5f619999f7f0463ab89e84393e51962eeb09afd0`.

After the cleanup below, rebuild the debug Desktop before using this launch command from `desktop/src-tauri`:

```sh
AMBRA_DATA_DIR=/tmp/ambra-cross-20261028-desktop \
RUST_LOG='ambra_net=debug,peeroxide::swarm=debug,peeroxide::_events=info,peeroxide_dht::hyperdht=debug,libudx=debug' \
./scripts/run-signed.sh target/debug/AMBRA --network-test-stdin
```

Redirect stderr to a new timestamped log. Keep stdin attached to a PTY for commands, one JSON object per line:

```json
{"action":"status"}
{"action":"tracks"}
{"action":"playTrack","trackId":"qobuz:121923141"}
{"action":"play"}
{"action":"pause"}
{"action":"seek","positionSeconds":0}
{"action":"reconnect"}
{"action":"uiTogglePlayback"}
{"action":"quit"}
```

`playTrack` requires metadata already present in the server queue catalog. `reconnect` closes the established manager transport and lets its normal lifecycle recover. `uiTogglePlayback` clicks the actual rendered play button. Do not treat native progress alone as audible proof; ask the operator.

## Final synchronized connection observations

First final connection: bootstrap and DHT resolution succeeded, pinned Noise completed in **319 ms**, token-verified hole-punch replies arrived, punch succeeded to `74.104.161.161:47120`, encrypted transport completed in **5057 ms**, HTTP/2 initialization took **6 ms**, device authorization **278 ms**, complete manager round **5606 ms**.

One forced close at `15:32:16 UTC` reused the healthy DHT node and negotiated another hole punch. Pinned Noise took **136 ms**; new public peer endpoint was `74.104.161.161:60707`; encrypted transport **2307 ms**, authorization **313 ms**, complete round **2878 ms**. Authenticated local-track listing succeeded, and Qobuz playback resumed using the command driver. These are two observations, not a reliability distribution or proof of a fresh local socket allocation.

See `results/cross-network-2026-10-28-evidence.txt` for selected UTC log excerpts and regression outcomes, and `results/cross-network-2026-10-28-playback.json` for twelve native post-reconnect samples. `relayed=true` in a DHT handshake log refers to forwarded signaling; it does not establish relayed application data. Final transport reports authenticated direct public UDX. WARP still carries the underlying IP traffic.

## Automated proof completed

- Mac Ambra-net: **21 unit + 4 direct-only + 15 native integration passed**.
- DHT library: **415 passed**.
- Swarm library: **26 passed**.
- Progressive HTTP regressions: **3 passed**.
- Debug driver regressions: **2 passed**.
- Batching regression: demonstrated failing before, passing after.
- Kubuntu final Ambra-net: **21 unit + 4 direct-only + 15 native integration passed**. All eight changed source files had matching SHA-256 hashes on both machines at checkpoint; hashes are in the evidence appendix.
- Debug Desktop and standalone server built successfully with the final synchronized changes.
- Full Desktop Rust suite after progressive reads, before final batching: **50 passed, 1 failed, 1 ignored**. Existing failure: `native_audio::tests::releasing_a_paused_device_does_not_reopen_the_song`, `worker.decoder.is_none()` at native_audio.rs:2298. The overnight report already documents it. Do not hide or expand scope to fix it.
- Clippy completed with 13 nonfatal warnings, including one new collapsible-if advisory in the decoder. Do not claim every warning predates this patch.
- `git diff --check` passed at checkpoint.

Raw local logs: `/tmp/ambra-cross-20261028-{bootstrap-before,bootstrap-after,http-stream-before,http-stream-tests,batching-before,batching-after,batched-net-tests,batched-dht-tests,final-swarm-tests,desktop-final-tests,desktop-clippy,exact-final-desktop-build}.log`.

Remote: `/tmp/ambra-cross-20261028-linux-net-final-tests.log`, `/tmp/ambra-cross-20261028-batched-server-build.log`, plus live server log above.

Build with `CARGO_INCREMENTAL=0`, limited jobs, and explicit debug Cargo manifests. Existing shared networking target is `crates/ambra-net/target`. Do not run root `bun run build`: it starts release/Tauri packaging. An accidental invocation was stopped immediately; about 473 MiB incomplete generated release cache remains. For frontend only, run `bun run build` from **desktop**, not repository root. Disk never approached its floor during this session.

## Remaining work, in priority order

1. Obtain an available permitted native network or school UDP permission. Repeat with WARP off and verify route/interface, direct public peer endpoint, and actual audible playback. Cellular is currently unavailable. Do not count VPN-assisted results as VPN-free acceptance.
2. Repeat cold and warm physical connections enough times to measure reliability. One final warm reconnect passed; successive attempts and precise fresh-local-socket proof are unfinished.
3. Repeat fresh pairing with a new real approval code on the final builds. Earlier physical pairing succeeded, but final batching build reused an existing pairing.
4. Test final-build server restart/client recovery, disconnect during active hole punching, and cleanup of losing/cancelled attempts. Automated coverage exists, but final physical scenarios are unfinished.
5. Verify sustained audible playback across more tracks/bitrates and after reconnect; include actual Desktop UI controls and library browsing. Final continuous sound is operator-confirmed for this Qobuz track, not a broad audio matrix.
6. Measure discovery, Noise, punch, complete connection, authorization, throughput, socket/task usage, and success rate only after connectivity is reliable. Current timings are small observations. No controlled baseline comparison or peak-resource benchmark was completed for these final fixes.
7. Review the uncommitted synchronized Kubuntu changes before updating its checkout to the new Mac commit. Do not blindly pull over them. Match source hashes and explicitly select intended binaries again.

Stop reason is the operator's usage limit, not completion of the original task. Preserve this distinction in any final report.

## Subsequent cleanup requested by the operator

The operator requested removal of unnecessary session files and test builds after the checkpoint. Both Mac Cargo output directories, `desktop/src-tauri/target` and `crates/ambra-net/target`, were deleted; these were generated, untracked artifacts. This also removed the incomplete release cache mentioned above. The Desktop and networking examples therefore require rebuilding before reuse.

On Kubuntu, `crates/ambra-net/target` and the contents of `server/target` were removed **except** `server/target/debug/ambra-server`. That executable and the running server were preserved. No repository source, Git data, installed binary, music, provider configuration, or pairing profile was deleted.

Individual October 28 temporary diagnostics and helper files were removed after their useful raw logs, JSON, CSV, and Python diagnostics were compressed into private archives:

- Mac: `/private/tmp/ambra-cross-20261028-desktop/raw-evidence.tar.gz` (about 1.1 MiB). The isolated Desktop profile and credentials remain in the same directory.
- Kubuntu: `/tmp/ambra-cross-20261028-evidence.tar.gz`. The live server log `/tmp/ambra-cross-20261028-batched-server.log` and isolated pwnat profile remain.

The earlier individual `/tmp/ambra-cross-20261028-*` diagnostic paths in this handoff now refer to archive members. Use `tar -tzf` to list or `tar -xOf ARCHIVE MEMBER` to read without recreating all files. The committed sanitized evidence remains available under `docs/networking/results`. Older temporary files with uncertain ownership or unrelated scope were left alone.
