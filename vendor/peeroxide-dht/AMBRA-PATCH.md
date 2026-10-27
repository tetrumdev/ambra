# Direct-only patch

Source: Rightbracket/peeroxide, release 1.7.3, commit
6ec917806480d769c16dfbf44a8d80413fcc0418. MIT OR Apache-2.0;
upstream license files are preserved. No pwnat source was accessed or copied.

`hyperdht.rs::connect_through_node` rejects `NoisePayload.relay_through`
before opening any relay connection. DHT handshake forwarding and hole-punch
signaling remain allowed. Ambra never configures `relay_through`, starts a
relay service, or calls the blind-relay APIs. The stock upstream automatic
relay path is incompatible with Ambra's policy. This pinned source copy makes
the policy reviewable and independent of local Cargo patches/configuration.

The peeroxide acceptor is used only because the low-level DHT run_server API
does not yield accepted data streams. Ambra uses no topic discovery on clients.

Additional integration fixes, validated separately from the upstream release:

- Acceptor spawn no longer awaits public bootstrap before returning. Ambra owns
  bounded announcement/refresh and cancellation, independently of local startup.
- Preserve each lookup responder's observed address in QueryReply; retain
  acknowledged signaling-node/server-endpoint pairs for passive hole punching.
- Only successful ANNOUNCE acknowledgements contribute to announced status.
- Advertise observed firewall state, not a fixed UNKNOWN value.
- Cache identical Noise handshake replies for ten seconds (bounded cache), so
  concurrent forwarding through different DHT nodes cannot replace the hole-punch
  session ID already selected by a client.
- Expose connection-slot release after application stream closure.
- Reject acceptor data-relay configuration before opening sockets.
- Limit secretstream frames to 1 MiB before allocation; treat truncated length
  prefixes as errors rather than clean EOF.

The copied golden fixtures come from the same upstream commit and retain that
project's MIT/Apache-2.0 licensing. Live public-network tests and their limitations
are recorded in docs/networking/README.md. No independent security audit is implied.
