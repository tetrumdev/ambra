//! Ambra's native-network policy, shared by discovery and NAT traversal.
use std::net::IpAddr;

/// Exclude Tailscale's IPv4 allocation and IPv6 ULA, including mapped IPv4.
/// The entire shared IPv4 range is unsuitable as a public traversal endpoint.
pub fn is_overlay(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => ip.octets()[0] == 100 && (64..=127).contains(&ip.octets()[1]),
        IpAddr::V6(ip) => ip.to_ipv4_mapped().map_or_else(
            || ip.segments()[..3] == [0xfd7a, 0x115c, 0xa1e0],
            |ip| is_overlay(IpAddr::V4(ip)),
        ),
    }
}

/// Tunnel interfaces must never supply native LAN advertisements or probes.
pub fn is_native_interface(name: &str, ip: IpAddr) -> bool {
    !is_overlay(ip)
        && !["tailscale", "utun", "tun", "tap", "wg", "ipsec", "ppp"]
            .iter()
            .any(|prefix| name.starts_with(prefix))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn overlay_ranges_and_tunnel_interfaces_are_excluded() {
        for address in ["100.64.0.1", "100.106.252.60", "100.127.255.254",
            "fd7a:115c:a1e0::f537:fc3d", "::ffff:100.117.211.104"] {
            assert!(is_overlay(address.parse().unwrap()), "{address}");
        }
        for address in ["100.63.255.255", "100.128.0.1", "192.168.86.220", "172.20.10.12",
            "127.0.0.1", "::1", "fd12::1", "2600:1000::1"] {
            assert!(!is_overlay(address.parse().unwrap()), "{address}");
        }
        for name in ["tailscale0", "utun8", "tun0", "wg0"] {
            assert!(!is_native_interface(name, "fe80::1".parse().unwrap()));
        }
        assert!(is_native_interface("wlo1", "192.168.86.220".parse().unwrap()));
    }
}
