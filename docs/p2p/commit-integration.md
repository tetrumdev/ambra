# Commit integration validation — October 28, 2026

The user requested committing and pushing all overnight changes. Fetching origin revealed five existing commits after the overnight starting point, ending at `b0ba37b`. The overnight commit was rebased onto those changes. No remote history was overwritten.

The combined implementation preserves upstream changes to serialized per-datagram TTL, multi-socket UDX registration and winner selection, NAT sampling, passive hole-punch lifetime, and bounded encrypted-header exchange. The connection manager retains the newer 75-second HyperDHT budget while racing LAN and sharing connection attempts.

The async UDX adapter takes ownership of the existing multi-socket cleanup guard. Its cancellation regression checks deregistration of both the primary and alternate socket. Socket fast sends share the upstream TTL lock, including deferred-send fallback.

Conflict review also exposed a fallback regression: a valid pinned Noise reply followed by unusable UDX parameters could cancel and skip all alternate forwarders. A deterministic two-responder test reproduced this failure. Failed stream establishment now retries remaining candidates with fresh Noise state and a new stream ID; bounded parallel handshake forwarding remains intact. The test verifies that the alternate pinned responder is attempted and that retries do not reuse the failed Noise message.

Validation of the combined source on Mac:

- Ambra-net: 19 unit, 4 direct-only integration, and 15 native integration tests passed.
- DHT: 412 tests passed, including the new fallback regression.
- Swarm: 26 tests passed.
- Native UDX selection: 121 tests passed across the library, async stream, firewall hook, lifecycle, MTU, loss/reordering, throughput, multiplexing, socket, and error suites. The 64-test library suite also passed after extending cancellation coverage to alternate registrations.
- Server access: 9 tests passed, including authorization-safe session supersession.
- Clippy for Ambra-net library/examples completed with the existing pwnat collapsible-if warning.
- `git diff --check` passed. Repository sensitive-file guards are enforced for commit and push.

The physical measurements in `overnight-report.md` and `results/` describe the original overnight tree before integration with these five origin commits. They were not rerun for the combined commit. The original report's unrelated server/desktop failures, missing external interop fixtures, and unverified physical topologies remain applicable unless separately retested.

Kubuntu's pre-integration worktree was checked against the saved overnight commit: all 45 changed files matched and there were no additional changes. Its duplicate uncommitted snapshot can therefore be preserved in a named Git stash while fast-forwarding to the published combined commit, without modifying application configuration or running services.
