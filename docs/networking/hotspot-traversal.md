# Hotspot traversal fixes

## Diagnosis

A Mac connecting through one cellular hotspot while another Mac cannot is not
sufficient to identify the carrier's NAT type. There were, however, concrete
implementation defects on paths exercised by endpoint-dependent (symmetric) NAT:

- The initiator received a successful probe on a birthday candidate socket but
  handed the primary socket to UDX. The primary socket has a different NAT
  mapping, so successful punching did not imply successful data transport.
- The passive side registered its UDX listener only on the primary socket.
  Secondary candidates could reflect probes but could not accept UDX traffic.
- Low-TTL probes changed the socket-wide TTL before a deferred send and never
  restored it. Reflections and stream packets could inherit TTL 5. Simply
  resetting TTL immediately after scheduling a send would also race.
- NAT sampling launched only the initial sample count, without using spare
  candidates after packet loss. An ambiguous classifier can need a fifth
  observation, but only four probes were launched.
- The manager cancelled HyperDHT after 15 seconds even though hole punching
  alone has a 30-second window. The server expired passive attempts after 10
  seconds, including time spent signaling before punching began.

These explain why success on one hotspot did not validate the other NAT paths.
They do not establish which defect occurred on the reported Mac without its logs.

## Changes

- Carry the winning local socket through initiator connection establishment.
- Register passive candidate sockets before sending probes. The first accepted
  UDX packet commits both the receiving socket and remote endpoint. Remove
  losing registrations and cancel pending punch tasks on completion or abort.
- Serialize actual UDP sends and scope probe TTL to the individual datagram;
  restore the socket default before releasing the shared send lock. UDX stream
  traffic uses the same send abstraction.
- Replenish NAT samples with bounded concurrency, a bounded candidate budget,
  two-second probe timeouts and a six-second overall sampling deadline.
- Allow 60 seconds for the manager's HyperDHT attempt and passive lifetime.
  Keep cancellation and the existing LAN / HyperDHT / pwnat order. Timeout
  errors now include the transport's elapsed budget.

Both client and server should be rebuilt for all fixes to apply. The shared
networking crate is used by native clients; no pairing migration is required.
A failed connection can now take longer to reach the final pwnat fallback.
Identity pinning, Noise encryption, authorization and direct-only policy are
unchanged. No relay fallback or privilege request was added.

## Validation in this checkout

Executed on Windows, not on either reported Mac/hotspot:

| Focused test command | Result |
| --- | --- |
| `cargo test --manifest-path crates/ambra-net/Cargo.toml --lib manager::tests` | 5 passed |
| `cargo test --manifest-path vendor/libudx/Cargo.toml --test firewall_hook` | 4 passed |
| `cargo test --manifest-path vendor/libudx/Cargo.toml --lib` | 63 passed |
| `cargo test --manifest-path vendor/peeroxide-dht/Cargo.toml --lib holepunch` | 39 passed |
| `cargo test --manifest-path vendor/peeroxide-dht/Cargo.toml --lib nat::tests -- --skip auto_sample_collects_target_samples` | 26 passed |
| `cargo test --manifest-path vendor/peeroxide/Cargo.toml --lib swarm::tests` | 10 passed |

The NAT loopback integration test `auto_sample_collects_target_samples` failed
with zero samples; the same failure was reproduced with the original sampler.
The broader `ambra-net --tests` run did not pass: two QUIC loopback tests failed,
then LAN discovery remained pending until the command's 180-second limit. A
focused QUIC test also exceeded a separate 25-second command limit without
printing a failure detail. These results do not validate pwnat or LAN in this
environment. The broader UDX 10 MB stream test also timed out with both the
pre-change and modified implementations. Those separate test issues were not
changed as part of the traversal fix.

## Remaining live verification

Rebuild and restart the independent server and Mac client. Re-test the failing
hotspot with focused logs enabled:

```sh
RUST_LOG='ambra_net=debug,peeroxide::swarm=debug,peeroxide::_events=info,peeroxide_dht::hyperdht=debug' path/to/client
```

Compare NAT sample classification, probe success, stream establishment, and the
final manager error. Do not publish pairing secrets or device tokens. Actual
Mac/carrier validation has not been performed for these changes.

LAN broadcast discovery is not expected to cross cellular NAT. pwnat requires
server opt-in, a public candidate and supported ICMP behavior; it is not a
universal escape hatch. UDP-blocking networks and some random/random NAT pairs
remain unsupported by this direct-only implementation. A shared public IP under
carrier CGNAT is not evidence of shared LAN reachability; the native integration
already disables HyperDHT's local-connection shortcut.
