//! Asks the home router to forward a public TCP port to the server's encrypted listener.
//!
//! UPnP IGD is tried first, then NAT-PMP. Both are best effort: a router without either
//! simply leaves the server reachable through LAN and HyperDHT only. Nothing here carries
//! application data; the mapped port leads to the same identity-pinned Noise listener.
use crate::Result;
use std::{
    net::{IpAddr, Ipv4Addr, SocketAddr, SocketAddrV4},
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpStream, UdpSocket},
};

const SSDP: SocketAddrV4 = SocketAddrV4::new(Ipv4Addr::new(239, 255, 255, 250), 1900);
const DESCRIPTION: &str = "AMBRA";
const HTTP_LIMIT: usize = 256 * 1024;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Gateway {
    kind: Kind,
    /// This machine's address on the router's LAN.
    local: Ipv4Addr,
    pub external_ip: Ipv4Addr,
}
#[derive(Clone, Debug, PartialEq, Eq)]
enum Kind {
    Upnp { control: String, service: String },
    NatPmp { router: Ipv4Addr },
}

#[derive(Clone, Debug, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub method: Option<&'static str>,
    pub endpoints: Vec<SocketAddr>,
    pub error: Option<String>,
}

/// A public IPv4 a client elsewhere on the Internet could dial. Double NAT
/// (a private "external" address) cannot be reached and is rejected.
pub fn is_public(ip: Ipv4Addr) -> bool {
    let [a, b, ..] = ip.octets();
    !(ip.is_private()
        || ip.is_loopback()
        || ip.is_link_local()
        || ip.is_unspecified()
        || ip.is_documentation()
        || ip.is_broadcast()
        || a >= 224
        || (a == 100 && (64..=127).contains(&b)))
}

fn private_ipv4_interfaces() -> Vec<Ipv4Addr> {
    let mut out: Vec<Ipv4Addr> = if_addrs::get_if_addrs()
        .unwrap_or_default()
        .into_iter()
        .filter(|i| !i.is_loopback() && crate::lan::is_local(i.ip()))
        .filter(|i| peeroxide_dht::address_policy::is_native_interface(&i.name, i.ip()))
        .filter_map(|i| match i.ip() {
            IpAddr::V4(ip) if ip.is_private() => Some(ip),
            _ => None,
        })
        .collect();
    out.sort_unstable();
    out.dedup();
    out
}

/// Finds every router that can forward a port to a public address.
pub async fn discover() -> Vec<Gateway> {
    let (mut upnp, natpmp) = tokio::join!(discover_upnp(), discover_natpmp());
    for gateway in natpmp {
        // Prefer UPnP when the same LAN address already has one.
        if !upnp.iter().any(|g| g.local == gateway.local) {
            upnp.push(gateway);
        }
    }
    upnp
}

async fn discover_upnp() -> Vec<Gateway> {
    let mut searches = tokio::task::JoinSet::new();
    for local in private_ipv4_interfaces() {
        searches.spawn(async move { ssdp_search(local).await.unwrap_or_default() });
    }
    let mut locations = Vec::new();
    while let Some(Ok(found)) = searches.join_next().await {
        for item in found {
            if !locations.contains(&item) {
                locations.push(item);
            }
        }
    }
    let mut gateways = Vec::new();
    for (local, location) in locations {
        match tokio::time::timeout(Duration::from_secs(4), upnp_gateway(local, &location)).await {
            Ok(Ok(gateway)) if !gateways.contains(&gateway) => gateways.push(gateway),
            Ok(Ok(_)) => {}
            Ok(Err(error)) => tracing::debug!(%location, %error, "UPnP gateway unusable"),
            Err(_) => tracing::debug!(%location, "UPnP gateway timed out"),
        }
    }
    gateways
}

async fn ssdp_search(local: Ipv4Addr) -> Result<Vec<(Ipv4Addr, String)>> {
    let socket = socket2::Socket::new(socket2::Domain::IPV4, socket2::Type::DGRAM, Some(socket2::Protocol::UDP))?;
    socket.set_nonblocking(true)?;
    socket.bind(&SocketAddr::from((local, 0)).into())?;
    // Multi-homed hosts must ask on this interface, not wherever the default route points.
    socket.set_multicast_if_v4(&local)?;
    socket.set_multicast_ttl_v4(2)?;
    let socket = UdpSocket::from_std(socket.into())?;
    for target in [
        "urn:schemas-upnp-org:device:InternetGatewayDevice:1",
        "urn:schemas-upnp-org:device:InternetGatewayDevice:2",
        "urn:schemas-upnp-org:service:WANIPConnection:1",
    ] {
        let search = format!(
            "M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nST: {target}\r\nMAN: \"ssdp:discover\"\r\nMX: 1\r\n\r\n"
        );
        socket.send_to(search.as_bytes(), SSDP).await?;
    }
    let mut found = Vec::new();
    let mut buffer = [0u8; 2048];
    let deadline = tokio::time::Instant::now() + Duration::from_millis(1500);
    while let Ok(Ok((length, from))) =
        tokio::time::timeout_at(deadline, socket.recv_from(&mut buffer)).await
    {
        let text = String::from_utf8_lossy(&buffer[..length]);
        let Some(location) = header(&text, "location") else { continue };
        // A LAN device answering for another host's description is ignored.
        if !location.contains(&from.ip().to_string()) {
            continue;
        }
        if !found.iter().any(|(_, l)| l == &location) {
            found.push((local, location));
        }
    }
    Ok(found)
}

fn header(response: &str, name: &str) -> Option<String> {
    response.lines().find_map(|line| {
        let (key, value) = line.split_once(':')?;
        key.trim().eq_ignore_ascii_case(name).then(|| value.trim().to_owned())
    })
}

struct Url {
    host: String,
    port: u16,
    path: String,
}
fn parse_url(url: &str) -> Result<Url> {
    let rest = url.strip_prefix("http://").ok_or("Only http UPnP URLs are supported")?;
    let (authority, path) = rest.split_once('/').map_or((rest, "/".to_owned()), |(a, p)| (a, format!("/{p}")));
    let (host, port) = match authority.rsplit_once(':') {
        Some((host, port)) => (host.to_owned(), port.parse()?),
        None => (authority.to_owned(), 80),
    };
    Ok(Url { host, port, path })
}

async fn http(url: &Url, request: String) -> Result<(u16, String)> {
    let ip: Ipv4Addr = url.host.parse()?;
    if !ip.is_private() {
        return Err("UPnP gateway must be on the local network".into());
    }
    let mut stream = tokio::time::timeout(
        Duration::from_secs(3),
        TcpStream::connect((ip, url.port)),
    )
    .await??;
    stream.write_all(request.as_bytes()).await?;
    let mut body = Vec::new();
    let mut chunk = [0u8; 8192];
    loop {
        let read = tokio::time::timeout(Duration::from_secs(4), stream.read(&mut chunk)).await??;
        if read == 0 {
            break;
        }
        body.extend_from_slice(&chunk[..read]);
        if body.len() > HTTP_LIMIT {
            return Err("UPnP response too large".into());
        }
    }
    let text = String::from_utf8_lossy(&body).into_owned();
    let status = text
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .ok_or("Malformed UPnP HTTP response")?;
    let body = text.split_once("\r\n\r\n").map_or(String::new(), |(_, b)| b.to_owned());
    Ok((status, body))
}

/// The text of the first `<name>` element after `from`, ignoring namespaces.
fn element(xml: &str, name: &str) -> Option<String> {
    let mut search = xml;
    loop {
        let start = search.find('<')?;
        search = &search[start + 1..];
        let end = search.find('>')?;
        let tag = &search[..end];
        let local = tag.split_whitespace().next()?.rsplit(':').next()?;
        if local == name && !tag.starts_with('/') && !tag.ends_with('/') {
            let content = &search[end + 1..];
            let close = content.find("</")?;
            return Some(content[..close].trim().to_owned());
        }
        search = &search[end..];
    }
}

async fn upnp_gateway(local: Ipv4Addr, location: &str) -> Result<Gateway> {
    let url = parse_url(location)?;
    let (status, description) = http(
        &url,
        format!(
            "GET {} HTTP/1.0\r\nHost: {}:{}\r\nConnection: close\r\n\r\n",
            url.path, url.host, url.port
        ),
    )
    .await?;
    if status != 200 {
        return Err(format!("UPnP description answered {status}").into());
    }
    // Prefer IP over PPP, newest version first.
    let mut chosen = None;
    for service in [
        "urn:schemas-upnp-org:service:WANIPConnection:2",
        "urn:schemas-upnp-org:service:WANIPConnection:1",
        "urn:schemas-upnp-org:service:WANPPPConnection:1",
    ] {
        if let Some(at) = description.find(&format!(">{service}<")) {
            if let Some(control) = element(&description[at..], "controlURL") {
                chosen = Some((service.to_owned(), control));
                break;
            }
        }
    }
    let (service, control) = chosen.ok_or("No WAN connection service")?;
    let control = if control.starts_with("http://") {
        control
    } else {
        format!(
            "http://{}:{}/{}",
            url.host,
            url.port,
            control.trim_start_matches('/')
        )
    };
    let kind = Kind::Upnp { control, service };
    let response = soap(&kind, "GetExternalIPAddress", &[]).await?;
    let external_ip: Ipv4Addr = element(&response, "NewExternalIPAddress")
        .ok_or("Router did not report its external address")?
        .parse()?;
    if !is_public(external_ip) {
        return Err(format!("Router's external address {external_ip} is not public (double NAT)").into());
    }
    Ok(Gateway { kind, local, external_ip })
}

async fn soap(kind: &Kind, action: &str, arguments: &[(&str, String)]) -> Result<String> {
    let Kind::Upnp { control, service } = kind else {
        return Err("Not a UPnP gateway".into());
    };
    let url = parse_url(control)?;
    let arguments: String = arguments
        .iter()
        .map(|(name, value)| format!("<{name}>{value}</{name}>"))
        .collect();
    let body = format!(
        "<?xml version=\"1.0\"?>\r\n<s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\" s:encodingStyle=\"http://schemas.xmlsoap.org/soap/encoding/\"><s:Body><u:{action} xmlns:u=\"{service}\">{arguments}</u:{action}></s:Body></s:Envelope>\r\n"
    );
    let request = format!(
        "POST {} HTTP/1.0\r\nHost: {}:{}\r\nContent-Type: text/xml; charset=\"utf-8\"\r\nSOAPAction: \"{service}#{action}\"\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        url.path,
        url.host,
        url.port,
        body.len()
    );
    let (status, response) = http(&url, request).await?;
    if status != 200 {
        let code = element(&response, "errorCode").unwrap_or_default();
        let description = element(&response, "errorDescription").unwrap_or_default();
        return Err(format!("UPnP {action} failed: {status} {code} {description}").into());
    }
    Ok(response)
}

async fn discover_natpmp() -> Vec<Gateway> {
    let mut gateways = Vec::new();
    for local in private_ipv4_interfaces() {
        let Some(router) = default_gateway(local) else { continue };
        match natpmp(local, router, &[0, 0]).await {
            Ok(reply) if reply.len() >= 12 => {
                let external_ip = Ipv4Addr::new(reply[8], reply[9], reply[10], reply[11]);
                if is_public(external_ip) {
                    gateways.push(Gateway { kind: Kind::NatPmp { router }, local, external_ip });
                }
            }
            Ok(_) => {}
            Err(error) => tracing::debug!(%router, %error, "NAT-PMP unavailable"),
        }
    }
    gateways
}

/// The router for `local`: the kernel's default route when it is on that subnet, otherwise
/// the conventional `.1` address of a /24.
fn default_gateway(local: Ipv4Addr) -> Option<Ipv4Addr> {
    #[cfg(target_os = "linux")]
    if let Ok(table) = std::fs::read_to_string("/proc/net/route") {
        for line in table.lines().skip(1) {
            let fields: Vec<_> = line.split_whitespace().collect();
            if fields.len() > 3 && fields[1] == "00000000" {
                if let Ok(raw) = u32::from_str_radix(fields[2], 16) {
                    let gateway = Ipv4Addr::from(raw.to_le_bytes());
                    if gateway.octets()[..3] == local.octets()[..3] {
                        return Some(gateway);
                    }
                }
            }
        }
    }
    let [a, b, c, _] = local.octets();
    let guess = Ipv4Addr::new(a, b, c, 1);
    (guess != local).then_some(guess)
}

async fn natpmp(local: Ipv4Addr, router: Ipv4Addr, request: &[u8]) -> Result<Vec<u8>> {
    let socket = UdpSocket::bind((local, 0)).await?;
    socket.connect((router, 5351)).await?;
    let mut buffer = [0u8; 64];
    // RFC 6886 retry schedule, shortened: 250 ms doubling, three tries.
    let mut wait = Duration::from_millis(250);
    for _ in 0..3 {
        socket.send(request).await?;
        if let Ok(Ok(length)) = tokio::time::timeout(wait, socket.recv(&mut buffer)).await {
            let reply = &buffer[..length];
            if length < 4 || reply[0] != 0 || reply[1] != request[1] + 128 {
                return Err("Malformed NAT-PMP reply".into());
            }
            let result = u16::from_be_bytes([reply[2], reply[3]]);
            if result != 0 {
                return Err(format!("NAT-PMP result code {result}").into());
            }
            return Ok(reply.to_vec());
        }
        wait *= 2;
    }
    Err("NAT-PMP router did not answer".into())
}

impl Gateway {
    pub fn method(&self) -> &'static str {
        match self.kind {
            Kind::Upnp { .. } => "UPnP",
            Kind::NatPmp { .. } => "NAT-PMP",
        }
    }

    /// Forwards public `external` TCP to `internal` on this machine. Returns the public
    /// port actually granted (NAT-PMP may choose a different one).
    pub async fn map_tcp(&self, external: u16, internal: u16, lease: Duration) -> Result<u16> {
        match &self.kind {
            Kind::Upnp { .. } => {
                let add = |lease: u64| async move {
                    let arguments = [
                        ("NewRemoteHost", String::new()),
                        ("NewExternalPort", external.to_string()),
                        ("NewProtocol", "TCP".into()),
                        ("NewInternalPort", internal.to_string()),
                        ("NewInternalClient", self.local.to_string()),
                        ("NewEnabled", "1".into()),
                        ("NewPortMappingDescription", DESCRIPTION.into()),
                        ("NewLeaseDuration", lease.to_string()),
                    ];
                    soap(&self.kind, "AddPortMapping", &arguments).await
                };
                match add(lease.as_secs()).await {
                    Ok(_) => Ok(external),
                    // 725: OnlyPermanentLeasesSupported.
                    Err(error) if error.to_string().contains(" 725 ") => add(0).await.map(|_| external),
                    Err(error) => {
                        // Already ours (for example after a restart): keep it.
                        if self.upnp_owns(external, internal).await {
                            Ok(external)
                        } else {
                            Err(error)
                        }
                    }
                }
            }
            Kind::NatPmp { router } => {
                let mut request = vec![0, 2, 0, 0];
                request.extend_from_slice(&internal.to_be_bytes());
                request.extend_from_slice(&external.to_be_bytes());
                request.extend_from_slice(&(lease.as_secs() as u32).to_be_bytes());
                let reply = natpmp(self.local, *router, &request).await?;
                if reply.len() < 16 {
                    return Err("Short NAT-PMP mapping reply".into());
                }
                Ok(u16::from_be_bytes([reply[10], reply[11]]))
            }
        }
    }

    async fn upnp_owns(&self, external: u16, internal: u16) -> bool {
        let Ok(entry) = soap(
            &self.kind,
            "GetSpecificPortMappingEntry",
            &[
                ("NewRemoteHost", String::new()),
                ("NewExternalPort", external.to_string()),
                ("NewProtocol", "TCP".into()),
            ],
        )
        .await
        else {
            return false;
        };
        element(&entry, "NewInternalClient").as_deref() == Some(&self.local.to_string())
            && element(&entry, "NewInternalPort").as_deref() == Some(&internal.to_string())
    }

    pub async fn unmap_tcp(&self, external: u16, internal: u16) {
        let result = match &self.kind {
            Kind::Upnp { .. } => soap(
                &self.kind,
                "DeletePortMapping",
                &[
                    ("NewRemoteHost", String::new()),
                    ("NewExternalPort", external.to_string()),
                    ("NewProtocol", "TCP".into()),
                ],
            )
            .await
            .map(drop),
            Kind::NatPmp { router } => {
                let mut request = vec![0, 2, 0, 0];
                request.extend_from_slice(&internal.to_be_bytes());
                request.extend_from_slice(&[0, 0, 0, 0, 0, 0]);
                natpmp(self.local, *router, &request).await.map(drop)
            }
        };
        if let Err(error) = result {
            tracing::debug!(%error, external, "Port mapping removal failed");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn element_ignores_namespaces_and_finds_nested_values() {
        let xml = "<s:Envelope><s:Body><u:GetExternalIPAddressResponse xmlns:u=\"x\"><NewExternalIPAddress>8.8.4.4</NewExternalIPAddress></u:GetExternalIPAddressResponse></s:Body></s:Envelope>";
        assert_eq!(element(xml, "NewExternalIPAddress").as_deref(), Some("8.8.4.4"));
        let description = "<service><serviceType>urn:schemas-upnp-org:service:WANIPConnection:2</serviceType><controlURL>/ctl/IPConn</controlURL></service>";
        assert_eq!(element(description, "controlURL").as_deref(), Some("/ctl/IPConn"));
        assert_eq!(element("<a><b/></a>", "b"), None);
    }

    #[test]
    fn urls_and_ssdp_headers_parse() {
        let url = parse_url("http://192.168.1.1:38255/rootDesc.xml").unwrap();
        assert_eq!((url.host.as_str(), url.port, url.path.as_str()), ("192.168.1.1", 38255, "/rootDesc.xml"));
        let url = parse_url("http://10.0.0.1").unwrap();
        assert_eq!((url.port, url.path.as_str()), (80, "/"));
        let reply = "HTTP/1.1 200 OK\r\nLOCATION: http://192.168.1.1:5000/desc.xml\r\nST: x\r\n\r\n";
        assert_eq!(header(reply, "location").as_deref(), Some("http://192.168.1.1:5000/desc.xml"));
    }

    #[test]
    fn double_nat_and_cgnat_addresses_are_not_public() {
        for ip in ["192.168.1.1", "10.0.0.1", "100.64.1.1", "172.16.0.1", "0.0.0.0"] {
            assert!(!is_public(ip.parse().unwrap()), "{ip}");
        }
        assert!(is_public("74.104.161.129".parse().unwrap()));
    }
}
