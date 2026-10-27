# Validation ledger

Validation date: October 26, 2026. Host: Apple Silicon macOS 27.0.1 (26A434), native Rust target `aarch64-apple-darwin`, Rust 1.97.1. No iOS/Android hardware or separate router was available. See the implementation report for limitations rather than interpreting compilation as device support.

## Final automated results

- `cargo test --manifest-path crates/ambra-net/Cargo.toml`: 16 tests pass (5 unit, 1 authenticated relay-rejection test over UDP/Noise, 10 native integration tests). QUIC/Noise loopback compatibility is explicitly separate from pwnat NAT proof.
- `cargo test --manifest-path server/Cargo.toml -- --test-threads=1`: 151 tests pass.
- `cargo test --manifest-path desktop/src-tauri/Cargo.toml`: 29 tests pass. A subsequent `cargo check` also passes after final shared-library changes.
- `cargo test --manifest-path crates/ambra-mobile-bridge/Cargo.toml`: 1 host C ABI test passes; native library compilation succeeds on macOS. This does not validate JNI/Swift device linkage.
- `cargo test --manifest-path vendor/peeroxide-dht/Cargo.toml --lib`: 389 upstream/patched tests pass, including golden byte fixtures and malformed frame limits.
- `cd desktop && bun test`: 70 tests pass, including mobile protocol/playback/lyrics and bridge URL persistence regressions.
- `cd desktop && bun run build`: passes TypeScript and Vite production build. Existing large-chunk advisory remains.
- `cd mobile && bunx tsc --noEmit` and `bun run lint`: pass.
- Expo autolinking recognizes `AmbraNetworkModule` for Apple and Android. `expo prebuild --platform ios --no-install` succeeds.
- `python3 scripts/test-native-network.py`: passes against the built real server and native client with isolated temporary config/data/cache. Covers encrypted approval, real session access, audio upload/range, enrollment replay rejection, bridge administration denial, CLI identity/QR/list/revoke, live P2P toggles and clean process shutdown.
- `git diff --check`: passes.

The initial parallel server run failed lease-release and write-behind timing tests while several builds ran concurrently. The final serialized suite passes. This does not establish stability of those tests under heavy parallel load. A transient disk-full build failure was resolved by removing task-created build artifacts; the mobile host ABI test subsequently passes.

## Public network checks

Temporary development infrastructure used Node 24.18.1 with reference `hyperdht@6.34.1`; it is not a production dependency.

1. Public bootstrap/announcement and Rust-to-Node known-key Noise/UDX exact echo: passed.
2. Public announcement from native Rust acceptor and native Rust HTTP/2 client: passed, including a 2,097,152-byte synthetic response.
3. Node client to native acceptor: direct Noise/UDX handshake passed after endpoint-hint and duplicate-handshake patches. The Node HTTP/2 harness received a 46-byte initial frame and stalled; full streaming in this direction remains unverified.

All peers ran on the same host/network. Public DHT traffic was real. These results do not verify separate NAT traversal, carrier-grade NAT, roaming, or cellular connectivity. No relay was configured. The authenticated relay-instruction test verifies rejection before a relay connection can be opened.

Reproduce the public reference echo with:

```sh
npm ci --prefix scripts/network-interop
python3 scripts/network-interop/check.py
```

Other probes are in `crates/ambra-net/examples/`. Production builds do not start Node reference processes.

## Performance sample

Optimized synthetic loopback test:

```sh
cargo test --release --manifest-path crates/ambra-net/Cargo.toml \
  encrypted_streaming_ranges_uploads_and_concurrent_polling_use_same_http_handlers -- --nocapture
```

Observed authentication: 3.991375 ms. An 8 MiB transfer concurrent with a 100 ms poll completed in 120.658416 ms. The test also checked a 1 MiB upload and byte-range response.

Optimized public-DHT acceptor snapshot, five seconds after announcement: `ps` reported 0.0% CPU and 1,456 KiB RSS. Unstripped example executable: 7,053,488 bytes. Clean shutdown: 0.544 seconds. This is one short networking-only sample, not full-server overhead or a sustained benchmark. OS paging/compression and concurrent compilation affect these numbers.

## Blocked or unperformed checks

- `bash mobile/scripts/build-network.sh ios`: stops with `Full Xcode is required.` The host has Command Line Tools, not full Xcode/iOS SDKs.
- `bash mobile/scripts/build-network.sh android`: stops with `Install cargo-ndk and Android NDK first.`
- pwnat capability: `Raw ICMP unavailable without elevation: Operation not permitted (os error 1)`. No privilege change was attempted. Packet validation and QUIC/Noise compatibility tests are not router traversal tests.
- Windows/Linux compilation, Android/iOS device builds, camera scanning, real music providers/audio, separate NATs, long-duration sessions, background playback, network transitions and battery measurements: not performed.
