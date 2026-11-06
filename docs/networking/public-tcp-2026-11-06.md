# Router-forwarded public TCP (November 6, 2026)

## Why P2P stopped working

1. **The server host's firewall dropped everything.** ufw on the CachyOS server (default `DROP`, enabled around Nov 1) allowed only SSH and KDE Connect inbound. LAN discovery replies, the secure TCP listener, and unsolicited HyperDHT hole-punch packets were all silently dropped. Tailscale kept working only because it inserts its own accept rule for `tailscale0` ahead of ufw.
   Fix: `sudo ufw allow 38147:38150/tcp` and `sudo ufw allow 38148:38150/udp`.
2. **School Wi-Fi blocks almost all UDP.** HyperDHT and Tailscale's direct path both need UDP, so neither can go direct from school (Tailscale falls back to its DERP relay). Outbound TCP is open: a portquiz.net check from the school Mac reached ports 80, 993, 3000, 5223, 8080, 8443 and 38150.

## What changed

* `crates/ambra-net/src/portmap.rs`: dependency-free UPnP IGD (SSDP + SOAP) and NAT-PMP client. Rejects double-NAT gateways whose "external" address is private.
* `server/src/p2p.rs`: while remote networking is on, the server asks the router to forward public TCP 443, then 8443, then its secure port, to the Noise listener. It renews every 20 minutes (one-hour lease) and removes the forwards on shutdown. NAT-PMP allows one forward per internal port, so the first port granted is kept. The Fios G3100 reserves 80 and 443, so this network gets 8443.
* `lan::serve` now accepts Internet peers. They get the same identity-pinned Noise handshake and bearer authorization as HyperDHT peers, never local management, and at most 8 connections per address.
* `ConnectionManager` adds `Method::Public`. After the 250 ms LAN head start, public TCP and HyperDHT race. Public candidates (plus port 443 on each known address) are dialed happy-eyeballs style, 200 ms apart, and the first finished Noise handshake wins. A HyperDHT session is upgraded to public TCP when that becomes reachable.
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
