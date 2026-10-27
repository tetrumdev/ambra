# Physical cross-network validation — October 27, 2026

Ambra Desktop on a Mac connected to a cellular hotspot paired with the independent Ambra Server on Kubuntu home Wi-Fi, connected over native HyperDHT/UDX, and played server audio. The operator confirmed that Desktop displayed HyperDHT and that the test tone played. This report supersedes the earlier reports' lack of physical cross-network evidence for this particular pair of networks.

## Revision and environment

Both repositories started clean at `6c7cbe66fccf9cce8ec6cfbe022c41a36df8a0f1`. The changes from this investigation were synchronized with content checks before overwriting remote files. No reset, force checkout, commit, firewall change, router change, Tailscale change, privilege grant, or server launch from a client was performed. A newer origin commit changed only the README; the matched source baseline was retained.

- Mac: Apple Silicon, native Desktop, hotspot gateway `172.20.10.1`, physical interface `en0`, IP MTU 1500.
- Kubuntu 24.04.5: x86_64, home address `192.168.86.220`, gateway `192.168.86.1`, physical interface `wlo1`.
- SSH management: `ssh ambra-kubuntu`, user `llewyn`, Tailscale address `100.106.252.60`.
- Independent server: `~/ambra/server/target/debug/ambra-server serve`. The installed server was stopped through its CLI and the checked-out build was explicitly started over SSH.
- Server public identity: `154597d7ea1e2c45b89cd4d362424c0b845ed813301c8ea344e22e0292c54240`.
- Desktop used an isolated test profile. Existing desktop data and the independent Mac server were preserved.

Tailscale carried SSH administration, source synchronization, and diagnostic collection. No Ambra service was accessed through a forwarded port, Tailscale candidate, or VPN service address.

## Proven defects and changes

1. **Overlay candidates escaped into native networking.** The original Kubuntu pairing link advertised `fd7a:115c:a1e0::f537:fc3d`, and DHT interface enumeration included tunnel addresses. A shared address policy now excludes Tailscale's `100.64.0.0/10`, its IPv6 ULA, mapped IPv4, and tunnel interfaces. Discovery, pairing validation, manual bootstrap, DHT datagrams, hole-punch candidates, and direct stream endpoints apply the policy. Manual bootstrap resolves and validates its numeric LAN destination before HTTP, disables proxies, and refuses redirects.
2. **Pairing opened a competing session.** Enrollment succeeded, but a second connection with the same device key was dropped by the server's one-live-session rule. `ConnectionManager::authorize` now validates the issued token over the established encrypted session. Desktop transfers that manager into its joined runtime without cancelling it when enrollment is dropped. Invalid authorization never produces a connected state.
3. **UDX confused UDP payload size with IP MTU.** Trace showed probes advancing to a 1500-byte UDP payload on a 1500-byte IP interface. IPv4 and UDP add 28 bytes, requiring fragmentation. Large transfers then retransmitted heavily and ended in `hyper::Error(Http2, KeepAliveTimedOut)`. The pinned libudx 1.7.3 is vendored with its IPv4 UDP maximum corrected to 1472 bytes. The deterministic delayed/lossy UDP regression times out with the original cap and passes with the correction. Live traces now stop at `new_mtu=1472 state=SearchComplete`.
4. **Framing added unnecessary WAN acknowledgement waits.** The encrypted frame header and ciphertext are now written together. The existing 16 KiB pump chunks and bounded buffers are retained. A larger-chunk experiment was rejected during integration testing.
5. **Diagnostics hid the actual path.** Server and Desktop honor `RUST_LOG`; manager state, selected method, verified direct endpoint, pump errors, and HTTP/2 error sources are logged. Accepted DHT sessions retain their actual UDX endpoint instead of the old documentation-address placeholder. No device tokens, private identity seeds, or bridge capabilities are intentionally logged.

The existing encryption, pinned server key, device-key binding, token authorization, local administration boundary, approval flow, and direct-only policy remain in force. No client bundles or launches the server.

## Connection trace and transport proof

1. The operator pasted the public pairing link into the real Desktop Server settings. Cross-network resolution used the selected public key; LAN broadcast discovery is not expected to cross NATs.
2. LAN had no matching server on the hotspot. pwnat was skipped without a public endpoint. HyperDHT bootstrapped and resolved the public key through public DHT nodes.
3. Noise authenticated the selected server. DHT nodes forwarded handshake and hole-punch control messages. NAT samples classified the peers, token-verified punch messages identified the endpoint, and UDP probes established a direct UDX stream.
4. The real Desktop displayed code `741461`. SSH management approved that request for `Eythans-MacBook-Air`. Desktop validated `/api/network/session` and reused the enrollment connection.
5. Authenticated HTTP/2 carried session/library requests and streamed content through the capability-protected loopback bridge. The probe also checked HTTP 206 ranges, exact bytes, denial of `/api/local/config`, and rejection of a consumed enrollment handle.
6. Desktop's native decoder and output played the server WAV. The operator heard the tone on cellular; an independent opt-in Desktop hardware test advanced to 3.101 seconds at 44,100 Hz, stereo.

The real Desktop's final cellular connection was `74.104.161.161:33955`. Kubuntu observed the Desktop at `174.224.164.234:64174`. These are peer public endpoints, not Tailscale endpoints or DHT data relays. Mac route inspection selected gateway `172.20.10.1` and `en0`; Kubuntu selected `192.168.86.1` and `wlo1` for the cellular public IP. macOS `nettop`, filtered to the actual Desktop PID, recorded approximately 1.46 MB on its active UDP socket on `en0`; no active Desktop UDP socket used a tunnel interface.

This evidence is combined with the connector's authenticated-relay rejection regression and the acceptor's rejection of relay configuration. A field named `dataRelay: false` alone is not the basis for the transport claim. Privileged packet capture was unavailable; route inspection, per-process interface counters, authenticated peer endpoints, code enforcement, and regression tests provide the recorded proof.

## Live results

- Original large transfer: 1,411,244 bytes in 15,056 ms on one attempt; later transfers and native playback stalled before the MTU fix.
- Patched cellular transfer: **1,411,244 bytes, 88 delivered chunks, 7,582 ms**, with exact incremental byte verification. Fixture: eight-second, 44.1 kHz stereo PCM WAV, SHA-256 `4e85b5a02eb68e19da7968ec5f619999f7f0463ab89e84393e51962eeb09afd0`.
- GUI pairing, authorization, library access, and audible playback: passed on cellular and home Wi-Fi as described above.
- Physical hotspot-to-home-Wi-Fi change: the same Desktop process recovered from HyperDHT to encrypted LAN with the same server key.
- Physical home-Wi-Fi-to-hotspot change: Desktop recovered from LAN to HyperDHT and the operator confirmed playback. Logs show authorization completing at `22:25:52 UTC` after entering HyperDHT at `22:25:44 UTC`.
- Server shutdown: Desktop remained alive, reported transport loss, and retried. Restart restored connectivity. No client started a replacement server.
- Forced transport close with fresh UDP sockets: reconnect completed in approximately **30.45 seconds**, including one failed bounded attempt while the previous server session expired. The selected identity and bridge remained stable. A subsequent authorized session request passed and the full 1,411,244-byte stream passed exact byte verification again in 14,465 ms.
- Native hardware playback test on cellular: passed in 11.73 seconds overall; native output advanced past three seconds. The test pauses and releases its output on completion.

The WAV is published as **Native P2P test tone**, by **Ambra network test**, for operator playback verification.

## Rust checks

All commands were run with `CARGO_INCREMENTAL=0` after generated incremental caches exhausted Mac disk space. Only generated build caches were removed. Linux tests use a process-local `umask 022`: the SSH shell's original `0002` made compiled test fixtures group-writable, which the existing executable-security checks correctly refused.

| Check | macOS | Kubuntu |
|---|---|---|
| `cargo build --locked --manifest-path server/Cargo.toml` | Pass | Pass |
| `cargo build --locked --manifest-path desktop/src-tauri/Cargo.toml` | Pass | Not a Linux Desktop test |
| `cargo test --locked --manifest-path crates/ambra-net/Cargo.toml --tests` | 20 passed | 20 passed |
| `cargo test --locked --manifest-path desktop/src-tauri/Cargo.toml` | 39 passed, 1 opt-in hardware test ignored by default | Not run |
| Opt-in `paired_desktop_streams_audio_through_native_output` | Passed on cellular with real output | Not applicable |
| libudx unit tests | 61 passed | Covered through shared networking tests |
| DHT encryption/framing tests | 12 passed | Covered through shared networking tests |
| Address-policy boundary test | Passed | Covered through candidate-rejection integration test |
| Full server suite | 189 passed, 1 ignored | 186 passed, 1 failed, 2 ignored |
| Linux server suite with only `write_behind_benchmark` skipped | Not needed | 186 passed, 2 ignored, 1 filtered |

The Linux full-suite failure is the unchanged cache-write benchmark's fixed 400 ms wait: the output file does not exist by its deadline on this machine. It was reported separately and not weakened or changed. The six earlier fixture-permission failures disappeared with the process-local umask correction.

Regression coverage includes invalid/mapped Tailscale candidates, pairing promotion on the same encrypted connection, desktop ownership transfer without cancellation, wrong keys/tokens, local administration denial, explicit data-relay rejection, packet loss/reordering/oversized UDP data, concurrent streaming and polling, ranges, shutdown, and stable-identity reconnection.

## Reproduction

Build the server and `crates/ambra-net/examples/pairing_probe.rs`. Obtain the public pairing link through `ambra-server pair qr`. Pass a content-addressed fixture filename and `--audio-file <WAV>` to the probe; approve its printed code with the independent server CLI. `--control` accepts `status`, `ping`, `stream`, `rebind`, and `quit` on stdin. `--client-id` isolates test device records. `--publish-fixture` publishes the validation WAV metadata. `--desktop-data` writes a new private isolated desktop pairing profile and refuses to overwrite existing settings.

The opt-in Desktop test needs `AMBRA_P2P_TEST_DESKTOP_DATA` pointing to that paired profile and `AMBRA_P2P_TEST_AUDIO_ID` containing the WAV content ID:

```sh
cargo test --locked --manifest-path desktop/src-tauri/Cargo.toml \
  native_audio::cross_network_tests::paired_desktop_streams_audio_through_native_output \
  -- --ignored --nocapture
```

Enable focused tracing with:

```sh
RUST_LOG='ambra_net=debug,peeroxide::swarm=debug,peeroxide::_events=info,peeroxide_dht::hyperdht=debug'
```

`libudx=debug` additionally reports MTU progression. Avoid broad transport trace logging during routine listening.

## Limits

- This validates these two physical networks, not every carrier, router, firewall, or NAT combination. No hidden relay or fourth fallback was added.
- pwnat on Kubuntu reports `Raw ICMP unavailable without elevation: Operation not permitted (os error 1)`. No raw-socket privileges or public pwnat endpoint were configured; no pwnat traversal claim is made.
- The 1472-byte cap corrects IPv4 overhead for the observed 1500-byte paths. Lower-MTU paths and comprehensive unfragmented path-MTU discovery need separate work.
- Throughput varies: the 8-second PCM WAV downloaded in 7.58 seconds initially and 14.47 seconds after a forced reconnect. Sustained high-bitrate playback and long-running uninterrupted playback are not established by this test.
- Reconnection can take tens of seconds while an old authenticated server session expires. Interrupted media is not transparently replayed by the connection manager; existing player recovery and seeking remain responsible for media resumption.
- No production installation, commit, push, PR, mobile-device validation, high-resolution audio endurance run, or independent cryptographic audit was performed.
