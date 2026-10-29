# Retained overnight evidence

See [the engineering report](../../autonomous-p2p-overnight-2026-10-29.md) for interpretation, limitations and commands. All Rust binaries use the debug profile. JSON numbers retain measured precision; this does not imply equivalent measurement accuracy.

- `controlled-baseline.json`: original `bd9841e`, 90-second physical workload. A log parser initially mishandled ANSI codes; recorded public endpoint evidence and fresh OS route checks corrected verification. The correction note remains in the JSON.
- `controlled-final.json`: first deadline/window fixes, before earned pacing credit.
- `pacing-credit-physical.json`: matched 90-second physical comparison after preserving earned pacing credit.
- `native-reference-matched.json`: same client and HTTP/2 workload with the test-only optimized native UDX/Node server.
- `local-reference.json`: 15-second encrypted TCP/Noise/HTTP2 loopback; not physical LAN.
- `final-stress.json`: final close-notice code, 12 fresh connections across four clients, followed by a 120-second single streaming/control workload. Includes executable hashes and workload parameters.
- `physical-transfer-baseline.json`: six successful byte-exact WAV transfers and five reconnects. Overall failure is the obsolete desktop/frontend setup, not those transfers. Do not count this as a passing complete playback test.
- `physical-playback-baseline.json`: fresh archived original desktop; valid 45-second native playback with one-second sampling.
- `physical-controls-baseline.json`: original production code with debug-only queue/next test commands. Five controls of each type after 15 seconds playback.
- `physical-before-close-notice.json`: earned-credit code, five reconnects, six transfers, 45 seconds native playback and 20 controls. Restart encountered the keepalive delay.
- `physical-final.json`: final code including close notice, repeated-Play behavior and isolated WebView; five reconnects, six transfers, 423 native samples, 20 controls and restart. `server_source_commit` is the Linux HEAD during testing; six working source blobs were separately verified before final fast-forward. It is not an assertion of a clean build from that older HEAD.
- `build-manifest.json`: committed production source blobs, build flags, baseline/final executable hashes. Input and signed desktop executable hashes are distinguished.
- `regression-evidence.json`: selected before/after failure and gate result lines. Intentionally retains the known desktop and Linux fixture failures. It is not a claim that all suites passed.
- `comparison.html`: self-contained comparison, including the API p95 regression.

Playback JSON is sanitized by an explicit field allowlist. It excludes pairing transcripts, identities, bearer tokens, bridge capabilities, tokenized source URLs, profiles and normal user configuration. Native samples retain numeric/output state, not audio samples. Public route evidence is reduced to verified interfaces. Original private fixtures, profiles and raw logs are removed during cleanup after preserving this evidence.

A `first_ready_ms` includes automated pairing approval/SSH orchestration and is not steady-state API or playback startup latency. A reconnect round deliberately creates a new authenticated connection. API poll latency includes an intentional 100 ms handler delay. Percentiles are from individual recorded polls; five control or connection observations are described using medians/ranges only. Probe resource samples are OS snapshots, not whole-application profiles.
