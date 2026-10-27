# Networking audit before implementation

Audited commit: `8e5df17` (latest checked-out main, including ewph/eggwithpants's server and mobile work). No application code had been changed when this audit was written.

## Existing behavior and reuse

1. `server/src/main.rs`, `cli.rs`, and `server_process.rs` implement a standalone Tokio executable, explicit foreground/background startup, a process lock, runtime address record, stop notification, and local HTTP management. Keep this lifecycle and CLI authority.
2. `server_config.rs` persists a random legacy server ID, name, bind, discovery flag, and paired devices in `server.json`. Only SHA-256 hashes of device bearer tokens are stored. Unix writes request mode 0600. This random ID is not a cryptographic identity.
3. `network.rs` owns six-digit approval codes, 128-bit request handles, ten-minute expiry, a sixteen-request limit, approval/denial, token issuance, listing and revocation. Reuse this store and handlers rather than introduce a second pairing authority. Request handles are enrollment secrets; codes identify requests to the owner, not remote passwords.
4. `access.rs` checks browser origins, bearer/query tokens, and local management access. Loopback peer plus loopback Host currently grants local privileges. A transport adapter must insert trusted remote-origin metadata before dispatching the same Router. Headers supplied by peers must never grant local privileges.
5. `api.rs` builds one Axum application. Music handlers already stream bodies incrementally, preserve ranges, and serve binary artwork. `session.rs` owns shared queue/playback state and long polling. `endpoints.rs` owns output presence, command polling, reports and results. Keep all these application protocols and provider integrations.
6. Server discovery currently answers `AMBRA-DISCOVER/1` over IPv4 UDP 38148. Desktop duplicates broadcast/interface logic. Discovery data is unauthenticated. Consolidate discovery into Rust, add cryptographic identity and secure-listener hints, and verify every connection independently. Manual hints must remain available when broadcasts fail. Evaluate mDNS against the existing working broadcast protocol; do not operate redundant discovery daemons without need.

## Desktop communication

`server_link.rs` persists host/join choice, client ID, address, and token in `server-link.json`. Host mode connects to the independently running local server. Join mode never automatically starts a replacement server, including old fallback settings. `serverConnection.ts` wraps fetch authentication and rebases saved media URLs; query tokens are removed before shared persistence. `remote_endpoint.rs` uses the same selected URL for reports, long polling and native playback. Replace joined connection plumbing with a private loopback Rust bridge while retaining the logical selected server and existing APIs. Legacy links have no pinned key and require explicit re-pairing before secure remote use; never silently learn a key from the old random ID.

## Mobile communication

Expo/React Native `client.ts` uses fetch, SecureStore for token/ID/address, address probes and a Tailscale hostname heuristic. `Pairing.tsx` requests approval and polls using a request handle. Native Expo Audio consumes authenticated server media URLs; `phoneEndpoint.ts` and `phonePlayback.ts` implement the existing output protocol. Keep React Native, playback and synchronization. Replace P2P address selection with the shared Rust manager through a packaged native module; Expo Go cannot load that module. Keep development tooling until native builds can be verified. No operating-system background socket guarantee can be inferred from foreground tests.

## CLI and request semantics

CLI requests the running server's loopback API; when stopped it can edit configuration directly. Network commands must query that same state, without creating a DHT node. The server's HTTP pipeline supports concurrent calls, provider startup waits, streaming, seeking, endpoint polling and session polling (25 seconds). The transport must preserve methods, headers, status, trailers/body flow control, cancellation and range semantics, and must not retry a possibly delivered mutation.

## Shared ownership and migration

The new `ambra-net` crate will own key persistence, versioned public pairing payloads, discovery, encrypted streams, connection priority/deadlines/cancellation, diagnostics and the fixed-destination local bridge. The server retains device authorization and all music/session ownership. Desktop and the mobile native bridge share this crate. Existing independent Cargo projects have different vendored patches and release scripts; path dependencies initially avoid an unrelated workspace/lockfile migration.

Every peer connection must verify the selected public key before sending a bearer token. Enrollment remains an owner-approved six-digit workflow over encryption; QR information contains public identity and hints only. Existing device records remain valid on the server, but legacy clients must explicitly approve migration to a cryptographic key. Revocation must be checked on every HTTP request, irrespective of transport.

## Candidate review at audit time

`peeroxide-dht` 1.7.3 declares Rust 1.85, MIT OR Apache-2.0, forbids unsafe code, and offers public bootstrap, known-key connection, announcements, Noise, UDX and hole punching. Its `connect_through_node` automatically follows a remote `relay_through` request. Stock configuration therefore does NOT meet Ambra's no-data-relay requirement. A reproducible direct-only patch must reject that request before opening a relay stream. Its low-level `run_server` does not deliver accepted application streams; the higher-level peeroxide acceptor supplies passive hole-punch lifecycle management. Dependency choice and any use of that acceptor must be documented, not described as lower-level-only.

`hyperdht` 0.1.1 (cowlicks) declares MIT, depends on native libsodium and UDX, and its upstream explicitly labels itself unstable/work in progress. Prefer the newer pure Rust stack if direct-only behavior and interoperability can be tested.

The independent pwnat implementation will use only the published method and RFC packet formats, not GPL implementation source. Raw ICMP availability must be probed without elevation. Linux and mobile sandboxes often deny necessary sockets. Packet tests are not NAT verification. Network/device results must be reported separately from simulated tests.
