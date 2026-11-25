# Ambra networking

Desktop and mobile clients use the same Rust connection manager to join an independent Ambra Server. A remote session is ready after the client verifies the server's pinned Noise identity and the server authorizes the device. Pairing requires server-owner approval. A joined client reconnects to the selected server when the path changes.

For server installation, pairing, and output selection, see [shared playback](../cross-device-playback.md) and the [mobile guide](../../mobile/README.md).

## Connection selection

| Method | When it is used |
| --- | --- |
| LAN | Starts immediately for a server on the local network. |
| [Router-forwarded TCP](public-tcp.md) | Starts alongside LAN when the client has an eligible public endpoint. |
| HyperDHT | Starts after the LAN grace period and attempts a direct encrypted stream over UDP and UDX. |
| [Nostr-signaled TCP](nostr-tcp-p2p.md) | Races HyperDHT after the grace period when supported. Nostr exchanges signed connection information. Application traffic uses the authenticated TCP stream. |
| [pwnat](pwnat.md) | An opt-in fallback on supported hosts with the required ICMP capability. |
| [Tailcat](tailcat.md) | The final fallback. It can establish a direct UDP path or use DERP to carry the end-to-end authenticated Ambra session. |

The winning transport carries the same HTTP/2 API and audio stream. The connection manager owns cancellation, authentication, and retries. Device revocation is enforced by the server. An unavailable network or unsupported transport can leave the client offline until a permitted path becomes available.

## Implementation

- [`crates/ambra-net`](../../crates/ambra-net) contains discovery, pairing, session encryption, transport selection, and reconnect logic.
- [`crates/ambra-mobile-bridge`](../../crates/ambra-mobile-bridge) exposes the shared Rust implementation to the native mobile module.
- [`server/src/network.rs`](../../server/src/network.rs) manages server transport listeners. [`server/src/access.rs`](../../server/src/access.rs) handles authorization.
- [Hotspot traversal](hotspot-traversal.md) explains address selection, socket ownership, and retry changes for mobile hotspots.
- [Dependency inventory](dependencies.json) lists the recorded Rust dependencies and license metadata.

## Diagnose a connection

```sh
ambra-server network status
cargo run --locked --manifest-path crates/ambra-net/Cargo.toml --example network_diagnose
```

Check the selected method, server identity, and authorization state. For a physical remote test, confirm that application traffic used the expected path. Local fixtures, same-router tests, and separate-network tests exercise different conditions. See the [validation report](validation.md) for examples and test commands.

Keep raw diagnostic outputs private. Share aggregate results and the relevant platform, build profile, and test topology. Replace real account names, network identifiers, filesystem paths, and pairing material with examples.
