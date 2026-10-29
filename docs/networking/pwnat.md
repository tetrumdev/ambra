# Optional pwnat fallback

Ambra tries LAN, native HyperDHT, then pwnat, then offline. pwnat is an IPv4-only, conditional direct transport. It does not relay application data, guarantee arbitrary NAT traversal, or bypass pairing. The server must explicitly enable it with `ambra-server network pwnat on`. It remains off by default, including when upgrading an existing configuration. Remote networking (`network p2p on`) must also be enabled.

## Discovery and protocol limits

A running pwnat listener advertises a small signed mutable record through the existing public HyperDHT network. No new Ambra infrastructure or paid service is used. The record contains only a protocol version, public IPv4 UDP candidate, and expiry. The selected server's Ed25519 key verifies its signature. Records expire after 180 seconds, tolerate at most 30 seconds of future clock skew, reject unknown fields, and are bounded to 512 bytes. Private, overlay, reserved, multicast, IPv6, and zero-port candidates are rejected before use. Clocks must be reasonably synchronized.

The default candidate combines the DHT's observed **IP address** with the pwnat listener's **UDP port**. The DHT socket's observed port is never substituted for the separate QUIC socket. This is explicitly a candidate for a port-preserving NAT, not a measured QUIC mapping. If the actual mapped server port is known, `ambra-server network endpoint IP:port` overrides the candidate. `ambra-server network endpoint auto` clears that override. The same validated candidate can be included in a pairing link. Older invalid saved hints are discarded without resetting server identity or paired devices.

The client can retrieve the signed record even when a HyperDHT application connection fails, provided DHT control queries still work. Without a cached hint or reachable DHT record, automatic discovery is unavailable. NAT traversal itself cannot discover an unknown server IP.

The server emits an eight-byte ICMP Echo Request to documentation address `192.0.2.1`. This address is not an Internet service. The client sends a fabricated Time Exceeded quotation to the server's public address. The server validates the quotation and sends bounded UDP punches from its QUIC socket. Application traffic uses QUIC plus the same pinned Noise identity, HTTP handlers, device approval, and bearer authorization as other transports.

This bounded protocol requires all of the following:

- The server NAT retains the ICMP mapping and accepts the related quotation from a different source.
- The client network translates and forwards the fabricated ICMP error. Ordinary Linux conntrack SNAT does **not** do this: it classifies this error as INVALID and leaves its private source untranslated.
- The expected ICMP identifier survives translation.
- The client UDP port is preserved. The client binds the advertised server port, which the server uses as the agreed client port. Random client port mappings are not predicted.
- The server UDP mapping preserves its listener port, or the operator supplies the actual mapped port. Some NAT behavior, including competing confirmed tuples from unsolicited UDP, can force a different mapping.
- Firewalls permit the required ICMP and peer UDP traffic. Filtering the documentation destination can prevent server ICMP state creation.

Missing any condition can prevent traversal. These conditions are protocol limits, not errors that a privilege change can fix. No port scanning, randomized-port guessing, UPnP, STUN service, VPN path, or application-data relay is introduced.

## Privileges and isolation

Linux and macOS support an optional standalone launcher, `scripts/pwnat/icmp-launch.c`. It opens exactly one IPv4 raw ICMP socket, drops root identity if invoked through sudo, clears Linux process capabilities, prevents Linux privilege reacquisition, and then executes the requested command as the original user. Ambra receives only the socket descriptor in `AMBRA_PWNAT_ICMP_FD`. Ambra validates and duplicates the descriptor and marks it close-on-exec so later subprocesses do not inherit it.

The descriptor still grants raw ICMP transmission and reception to that explicitly launched process. This is not a packet-level sandbox. It does not grant permission to create additional raw sockets, change firewall rules, or perform general administrator operations. The launcher never reads a password, calls sudo, installs itself, starts a daemon, or modifies sudoers. It refuses to execute the command as root. Do not apply capabilities to Ambra, a shell, Python, or another general-purpose interpreter.

Build the launcher without elevation:

```sh
cc -O2 -Wall -Wextra -Werror scripts/pwnat/icmp-launch.c -o /tmp/ambra-icmp-launch
```

For an explicitly opted-in Linux installation, an administrator can install a protected copy for one user. These commands use the disposable Kubuntu test account:

```sh
sudo install -d -o root -g root -m 0755 /usr/local/libexec
sudo install -o root -g llewyn -m 0750 /tmp/ambra-icmp-launch /usr/local/libexec/ambra-icmp-launch
sudo setcap cap_net_raw=ep /usr/local/libexec/ambra-icmp-launch
getcap /usr/local/libexec/ambra-icmp-launch
/usr/local/libexec/ambra-icmp-launch /home/llewyn/ambra/server/target/debug/ambra-server serve
```

The filesystem must support capability xattrs and honor executable capabilities; a `nosuid` mount or a restricted capability bounding set can prevent this. Replacing the helper can remove its capability and requires an administrator to grant it again. Roll back by removing the installed helper or running `sudo setcap -r /usr/local/libexec/ambra-icmp-launch`. No capability is applied to Ambra itself.

On macOS, launch the installed helper explicitly through sudo. Only socket creation runs privileged; the test probe runs as the invoking user. The helper does not request, store, or process a password. macOS datagram ping sockets are insufficient: the tested OS permits Echo but rejects the required Time Exceeded transmission with `Invalid argument`.

The installer accepts a prebuilt launcher and makes a root-owned copy. Linux grants only `CAP_NET_RAW` to a copy executable by the invoking user's group. macOS installs an ordinary executable without a setuid bit, daemon, or sudoers change. A one-shot sudo invocation remains necessary on macOS:

```sh
cc -O2 -Wall -Wextra -Werror scripts/pwnat/icmp-launch.c -o /tmp/ambra-icmp-launch
sudo sh scripts/pwnat/install-helper.sh /tmp/ambra-icmp-launch
# Linux:
/usr/local/libexec/ambra-icmp-launch --health
# macOS:
sudo /usr/local/libexec/ambra-icmp-launch --health
# Remove the installed helper on either platform:
sudo sh scripts/pwnat/install-helper.sh --uninstall
```

`--health` opens and closes one raw socket, drops privileges, and emits structured health with UID/EUID. Socket permission failures also emit a structured stage and OS error number. The command mode executes an absolute path only after dropping privileges. The unprivileged child still receives a raw ICMP descriptor; this is not a packet-filtering sandbox. Do not grant untrusted users access through a broad sudoers rule.

| Platform | Current behavior | Privilege requirement and verification |
| --- | --- | --- |
| Linux | Optional, verified with the dedicated launcher | Helper needs `CAP_NET_RAW`; Ambra runs without root or process capabilities. Real Echo transmission/reception and compatible simulated traversal pass. |
| macOS | Optional; raw socket denied in ordinary application | Explicit sudo for the one-shot helper is required. Privilege drop and raw signaling were physically tested on October 28. Hotspot-to-home pwnat still fails before QUIC establishment: no ICMP quotations arrive at the server. |
| Windows | Explicitly disabled | Windows raw sockets require Administrator access. No supported socket broker is implemented or tested; ordinary Ambra does not request elevation. Shared library cross-compiles for Windows. |
| iOS | Explicitly disabled | Normal application sandbox does not provide these raw socket privileges. No device validation or sandbox-compatible implementation is claimed. |
| Android | Explicitly disabled | Normal application sandbox does not provide `CAP_NET_RAW`. No rooted-device exception is enabled. |

The server remains an independent executable. Clients contain only shared client networking code, not Ambra Server. Unsupported platforms skip pwnat without opening raw sockets.

## Failure behavior and diagnostics

LAN has a three-second deadline, HyperDHT seventy-five seconds, and pwnat eight seconds including at most three seconds for record retrieval and five seconds for ICMP/QUIC/Noise setup. The HyperDHT deadline allows discovery and setup plus a retry after a thirty-second hole-punch attempt expires, as can happen on hotspot networks with destination-dependent UDP mappings. Failed rounds wait five seconds before retrying. ICMP signaling is limited to one packet per 300 ms during setup. The listener sends at most three small punches per new public source, with at most sixteen sources per ten-second window and sixty-four active setup/session tasks.

A failed pwnat listener does not stop LAN or HyperDHT. Its DHT publication has a separate deadline and cannot change HyperDHT announcement success. Enabling or disabling only pwnat does not restart a working HyperDHT stream. A live client connection remains selected until loss. Reconnect reuses the client's fixed-port QUIC endpoint while old sessions drain; it does not immediately bind another socket to the same port.

`network status` reports capability, opt-in state, running listener, public candidate, and separate listener/publication errors. Client logs identify each transport attempt, deadline, verified public peer endpoint, and pinned Noise authentication. A connected state still requires `/api/network/session` authorization. Failed enrollment never becomes a successful connection. Application mutations are not replayed on ambiguous disconnects.

A log saying `Pwnat` proves selection of the pwnat QUIC transport, not by itself that ICMP crossed a physical NAT. Combine it with the validated ICMP quotation, public UDP tuples, route/interface evidence, and deliberate exclusion of other data transports.

Connection errors now identify `icmp_socket`, `udp_bind`, `quic_connect`, `quic_stream`, or `noise_identity`, plus the bounded ICMP request count. Listener status includes `icmpEchoSent`, `icmpErrors`, `icmpQuotationsAccepted`, and `udpPunchesSent`. The standalone server retries an exited HyperDHT or pwnat listener with capped exponential backoff; changing transport configuration or shutting down cancels retries.

## Reproducible tests

Build the native probes and server without elevation:

```sh
CARGO_INCREMENTAL=0 cargo build --manifest-path crates/ambra-net/Cargo.toml --examples
CARGO_INCREMENTAL=0 cargo build --manifest-path server/Cargo.toml
cargo test --manifest-path crates/ambra-net/Cargo.toml --tests
```

On disposable Kubuntu, after installing the helper, the opt-in lab runs actual Ambra Server and the native pairing probe through isolated network namespaces:

```sh
cd /home/llewyn/ambra
CARGO_TARGET_DIR=server/target cargo build --manifest-path crates/ambra-net/Cargo.toml --examples
sudo python3 scripts/pwnat/test-nat.py
```

The lab tests ordinary Linux client SNAT failure, independently blocks Time Exceeded traffic and checks the firewall counter, then models a compatible client NAT with an **explicit stateless ICMP translation rule inside its namespace**. The positive result is conditional simulation, not proof that default Linux NAT or a physical router supports this protocol. Its transit namespace has no Internet route and no Tailscale interface. All namespaces and processes are removed in `finally`; logs remain in its printed artifact directory. Host firewall and forwarding settings are not changed.

`scripts/pwnat/test-macos.py` is the prepared physical-device test. Run it only through the launcher, with a separately running isolated Kubuntu server. It obtains a signed endpoint record automatically, disables LAN and HyperDHT data attempts, performs server-approved pairing over the pwnat stream, checks exact WAV/range bytes, and reconnects. SSH is used only for management and approval. The script refuses to run as root and never requests or processes a password. See the dated investigation report for the prepared command and results.

The newer `cross-network.py` manages its own isolated server and automates approval and cleanup. Its default mode checks real HyperDHT pairing, authorization, exact WAV/range bytes, repeated reconnects, and both peers' physical routes. pwnat-only mode needs the inherited ICMP descriptor and the installed Linux helper. Neither mode touches the normal server profile:

```sh
python3 scripts/pwnat/cross-network.py llewyn@100.106.252.60 --rounds 8
sudo /usr/local/libexec/ambra-icmp-launch /usr/bin/python3 \
  "$PWD/scripts/pwnat/cross-network.py" llewyn@100.106.252.60 \
  --transport pwnat --rounds 2
```

Artifacts use a private temporary directory. Preserve that directory for debugging; it can contain test pairing credentials. Only sanitized aggregates should be committed. `udp-peer.py` separately tests authenticated, bounded direct UDP with an explicitly selected physical source address; its coordination token travels over stdin and is never logged.
