# Router-forwarded public TCP (November 6, 2026)

## Why P2P stopped working

1. **The server host's firewall dropped everything.** ufw on the CachyOS server (default `DROP`, enabled around Nov 1) allowed only SSH and KDE Connect inbound. LAN discovery replies, the secure TCP listener, and unsolicited HyperDHT hole-punch packets were all silently dropped. Tailscale kept working only because it inserts its own accept rule for `tailscale0` ahead of ufw.
   Fix: `sudo ufw allow 38147:38150/tcp` and `sudo ufw allow 38148:38150/udp`.
2. **School Wi-Fi blocks almost all UDP.** HyperDHT and Tailscale's direct path both need UDP, so neither can go direct from school (Tailscale falls back to its DERP relay). Outbound TCP is open: a portquiz.net check from the school Mac reached ports 80, 993, 3000, 5223, 8080, 8443 and 38150.

## What changed

* `crates/ambra-net/src/portmap.rs`: dependency-free UPnP IGD (SSDP + SOAP) and NAT-PMP client. Rejects double-NAT gateways whose "external" address is private.
* `server/src/p2p.rs`: while remote networking is on, the server asks the router to forward public TCP 443, then 8443, then its secure port, to the Noise listener. It renews every 20 minutes (one-hour lease) and removes the forwards on shutdown. NAT-PMP allows one forward per internal port, so the first port granted is kept. The Fios G3100 reserves 80 and 443, so this network gets 8443.
* `lan::serve` now accepts Internet peers, but only paired devices (see "Paired-only admission" below). They get the same identity-pinned Noise handshake and bearer authorization as HyperDHT peers, never local management, and at most 8 connections per address.
* `ConnectionManager` adds `Method::Public`. The public TCP dial starts at the same moment as the LAN dial; HyperDHT starts after the 250 ms LAN grace. Public candidates (plus port 443 on each known address) are dialed happy-eyeballs style, 200 ms apart, and the first finished Noise handshake wins. A HyperDHT session is upgraded to public TCP when that becomes reachable.
* Clients learn endpoints from `GET /api/network/session` (`publicEndpoints`), the pairing link (`publicTcp`), and a per-device cache (`server-endpoints.json` on desktop, `ambra-server-endpoints.json` on mobile). A device that has once connected at home, or over Tailscale, can connect from anywhere else.
* `network status` shows `portMapping`.

## Measurements

From outside, through a ProtonVPN interface (New York exit) to the home server:

| Check | Result |
|---|---|
| TCP connect + Noise handshake | 102–106 ms |
| Request round trip | p50 20–30 ms, p95 29–40 ms |
| 8 MB download, first byte | 52 ms |
| 8 MB download throughput | 64.5 Mbit/s |

HyperDHT (home to home, after the firewall fix) connected 5/5 times in 2.6–7.7 s.

## Limits

* Needs UPnP or NAT-PMP on the server's router, or a manual forward to the secure port. A manual forward of external 443 is picked up automatically, because clients always try 443.
* With ufw active, SSDP replies are dropped, so UPnP discovery fails and NAT-PMP is used. That's fine on routers that support both.
* The router does not loop back to its own public IP, so the public path can't be tested from inside the home LAN. LAN is used there anyway.
* Carrier-grade NAT (no public IPv4 at the server) leaves only HyperDHT.

## Paired-only admission

Goal: nothing on the internet can talk to the server unless it is a paired device. Scanners, someone who learned the server's IP, port or public key, and an unpaired device holding an old pairing link all get no answer.

**Public TCP (the forwarded port).** Before Noise, the client sends a 124-byte knock (`crates/ambra-net/src/gate.rs`):

| Bytes | Field |
|---|---|
| 4 | marker `ff ff ff 01` (cannot be the start of a SecretStream frame) |
| 32 | device public key |
| 8 | Unix time, milliseconds |
| 16 | random nonce |
| 64 | Ed25519 signature over `"ambra/knock/v1" ‖ server key ‖ device key ‖ time ‖ nonce` |

The server reads exactly 124 bytes, waiting at most 3 s. It then checks these in order:

1. The marker is present.
2. The key belongs to a paired device. An unknown key fails here, without a signature check.
3. The timestamp is within ±30 minutes of the server's clock.
4. The signature is valid.
5. The nonce has not been used before (replay cache).

If any check fails, the server closes the connection without sending a byte. After Noise, the peer's static key must equal the key that knocked. The knock is written immediately before the first Noise message, so it adds no round trip, and verification costs about 50 µs. The forwarded port never pairs devices. A LAN peer may also knock: a device at home dialing the public address through a router that loops it back arrives from a LAN address.

**HyperDHT.** The client's static key arrives in the first IK handshake message. The vendored `peeroxide` gained `SwarmConfig::admit`, which drops the handshake before any reply when the key is not admitted. HyperDHT admits paired devices. It also admits new devices for 10 minutes after the owner shows the pairing link (`/api/local/pairing/qr`), so a phone can pair remotely. A six-digit approval on the server is still required.

**pwnat (opt-in).** QUIC handshakes before Noise names the peer, so unpaired peers are disconnected right after Noise, before any HTTP.

**LAN.** Unchanged: LAN and Tailscale peers can pair. Remote paths require a device key recorded at pairing; devices paired before keys existed work on the LAN only.

Measured from outside (ProtonVPN), against the real server:

| Check | Result |
|---|---|
| Paired device: TCP connect + knock + Noise | 119 ms (single run; was 102–106 ms) |
| Request round trip | p50 29.5 ms |
| No bytes sent | 0 bytes received, closed after the 3 s timeout |
| Knock from an unpaired key | 0 bytes received, closed immediately |
| Garbage bytes | 0 bytes received, closed immediately |
| HyperDHT, paired key | connected in 6.6 s |
| HyperDHT, unpaired key | no answer (25 s timeout) |

What an outsider can still learn:

* A TCP port is open: the kernel completes the SYN handshake before the application sees anything.
* DHT nodes near the server's announcement see its public key and IP address. This is inherent to HyperDHT; with the gate it gives them nothing to connect to.
