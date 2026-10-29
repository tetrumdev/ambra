//! Opt-in, bounded diagnostics. Never loads application identities or bearer tokens.
//! Usage: network_diagnose [--peer PUBLIC_KEY] [--connect] [--include-addresses]
use ambra_net::{Identity, PublicKey, pwnat};
use libudx::UdxRuntime;
use peeroxide_dht::{
    address_policy,
    hyperdht::{self, HyperDhtConfig},
};
use serde_json::{Value, json};
use std::{
    net::{Ipv4Addr, SocketAddr},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::net::UdpSocket;

fn event(stage: &str, started: Instant, data: Value) {
    println!(
        "{}",
        json!({"schema":1,"unix_ms":SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis(),
        "stage":stage,"elapsed_ms":started.elapsed().as_secs_f64()*1000.,"data":data})
    );
}

// RFC 5389: accept only a matching Binding Success transaction from the chosen server.
fn mapped_address(packet: &[u8], transaction: &[u8; 12]) -> Option<SocketAddr> {
    if packet.len() < 20
        || packet[..2] != [1, 1]
        || packet[4..8] != [0x21, 0x12, 0xa4, 0x42]
        || &packet[8..20] != transaction
    {
        return None;
    }
    let end = 20 + u16::from_be_bytes(packet[2..4].try_into().ok()?) as usize;
    if end > packet.len() || !end.is_multiple_of(4) {
        return None;
    }
    let mut offset = 20;
    while offset + 4 <= end {
        let kind = u16::from_be_bytes(packet[offset..offset + 2].try_into().ok()?);
        let len = u16::from_be_bytes(packet[offset + 2..offset + 4].try_into().ok()?) as usize;
        offset += 4;
        let value = packet.get(offset..offset.checked_add(len)?)?;
        if offset + len > end {
            return None;
        }
        if (kind == 0x20 || kind == 1) && len == 8 && value[1] == 1 {
            let xor = if kind == 0x20 { 0x2112a442u32 } else { 0 };
            let port = u16::from_be_bytes(value[2..4].try_into().ok()?) ^ (xor >> 16) as u16;
            let ip = Ipv4Addr::from(u32::from_be_bytes(value[4..8].try_into().ok()?) ^ xor);
            return Some((ip, port).into());
        }
        offset += (len + 3) & !3;
    }
    None
}

#[tokio::main]
async fn main() -> ambra_net::Result<()> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    let reveal = args.iter().any(|s| s == "--include-addresses");
    let connect = args.iter().any(|s| s == "--connect");
    let mut peer = None;
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--include-addresses" => {}
            "--connect" => {}
            "--peer" => {
                index += 1;
                peer = Some(PublicKey::try_from(
                    args.get(index).ok_or("Missing peer key")?.clone(),
                )?);
            }
            _ => {
                return Err(
                    "Usage: network_diagnose [--peer PUBLIC_KEY] [--connect] [--include-addresses]"
                        .into(),
                );
            }
        }
        index += 1;
    }
    if connect && peer.is_none() {
        return Err("--connect requires --peer".into());
    }
    let start = Instant::now();
    let interfaces: Vec<_> = if_addrs::get_if_addrs()?.into_iter().map(|i| {
        let ip = i.ip();
        let kind = if ip.is_loopback() { "loopback" } else if address_policy::is_native_interface(&i.name, ip) { "native" } else { "overlay_or_tunnel" };
        json!({"name":i.name,"kind":kind,"family":if ip.is_ipv4(){4}else{6},"address":if reveal{Some(ip.to_string())}else{None}})
    }).collect();
    event(
        "interfaces",
        start,
        json!({"interfaces":interfaces,"addresses_redacted":!reveal}),
    );
    let capability = pwnat::capability();
    event("pwnat_capability", start, json!(capability));
    // Same UDP socket across destinations. Mapping differences are evidence of
    // destination dependence, not a complete RFC 5780 NAT classification.
    let socket = UdpSocket::bind("0.0.0.0:0").await?;
    let mut mappings = Vec::new();
    for target in [
        "stun.l.google.com:19302",
        "stun1.l.google.com:19302",
        "stun.nextcloud.com:443",
    ] {
        let mut rtts = Vec::new();
        let mut last_mapping = None;
        for _ in 0..3 {
            let probe_start = Instant::now();
            let result = tokio::time::timeout(Duration::from_secs(2), async {
                let destination = tokio::net::lookup_host(target)
                    .await?
                    .find(SocketAddr::is_ipv4)
                    .ok_or("No IPv4 STUN address")?;
                let mut transaction = [0; 12];
                getrandom::fill(&mut transaction)?;
                let mut request = vec![0, 1, 0, 0, 0x21, 0x12, 0xa4, 0x42];
                request.extend_from_slice(&transaction);
                socket.send_to(&request, destination).await?;
                let mut buffer = [0; 2048];
                loop {
                    let (n, source) = socket.recv_from(&mut buffer).await?;
                    if source == destination
                        && let Some(address) = mapped_address(&buffer[..n], &transaction)
                    {
                        return Ok::<_, ambra_net::Error>(address);
                    }
                }
            })
            .await;
            if let Ok(Ok(mapping)) = result {
                rtts.push(probe_start.elapsed().as_secs_f64() * 1000.);
                mappings.push(mapping);
                last_mapping = Some(mapping);
            }
        }
        let jitter = if rtts.len() > 1 {
            Some(
                rtts.windows(2).map(|v| (v[1] - v[0]).abs()).sum::<f64>() / (rtts.len() - 1) as f64,
            )
        } else {
            None
        };
        event(
            "stun",
            start,
            json!({"target":target,"sent":3,"received":rtts.len(),"rtt_ms":rtts,"successive_rtt_jitter_ms":jitter,
            "mapping":if reveal{last_mapping.map(|m|m.to_string())}else{None},"mapping_redacted":!reveal}),
        );
    }
    event(
        "nat_observation",
        start,
        json!({"destination_dependent_mapping_observed":mappings.windows(2).any(|m|m[0]!=m[1]),"samples":mappings.len(),
        "limitation":"STUN success does not establish peer UDP or ICMP reachability; timeouts do not prove packet loss"}),
    );
    let runtime = UdxRuntime::new()?;
    let config = HyperDhtConfig::with_public_bootstrap();
    let bootstrap = config.dht.bootstrap.clone();
    let (task, handle, _events) = hyperdht::spawn(&runtime, config).await?;
    let task = tokio_util::task::AbortOnDropHandle::new(task);
    let stage = Instant::now();
    let result = tokio::time::timeout(Duration::from_secs(12), handle.bootstrapped()).await;
    let bootstrap_ok = matches!(result, Ok(Ok(())));
    event(
        "dht_bootstrap",
        stage,
        json!({"ok":bootstrap_ok,"result":format!("{result:?}"),"wire_bytes":handle.wire_stats()}),
    );
    for target in bootstrap {
        // Public bootstrap entries use IP@hostname:port, with the IP as a
        // fallback. Probe that configured IP without treating @ as DNS syntax.
        let (host, port) = target.rsplit_once(':').ok_or("Invalid bootstrap address")?;
        let host = host.split_once('@').map_or(host, |(ip, _)| ip);
        let stage = Instant::now();
        let result = tokio::time::timeout(
            Duration::from_secs(3),
            handle.dht().ping(host, port.parse()?),
        )
        .await;
        let rtt = result
            .as_ref()
            .ok()
            .and_then(|r| r.as_ref().ok())
            .map(|r| r.rtt.as_secs_f64() * 1000.);
        event(
            "dht_ping",
            stage,
            json!({"target":target,"ok":rtt.is_some(),"rtt_ms":rtt}),
        );
    }
    if let Some(peer) = peer {
        let stage = Instant::now();
        let result = tokio::time::timeout(Duration::from_secs(15), handle.find_peer(peer.0)).await;
        event(
            "dht_find_peer",
            stage,
            json!({"ok":matches!(result,Ok(Ok(Some(_)))),"result":match result {Ok(Ok(Some(_)))=>"found",Ok(Ok(None))=>"not_found",Ok(Err(_))=>"query_failed",Err(_)=>"timeout"}}),
        );
        if connect {
            let stage = Instant::now();
            let identity = Identity::generate()?;
            let mut options = hyperdht::ConnectOpts::default();
            options.local_connection = false;
            let result = tokio::time::timeout(
                Duration::from_secs(75),
                handle.connect_with_options(&identity.key_pair(), peer.0, &[], &runtime, options),
            )
            .await;
            // Error variants identify discovery, signaling, punching and Noise
            // failures. Peer addresses remain absent unless explicitly opted in.
            let data = match result {
                Ok(Ok(connection)) => {
                    json!({"ok":true,"transport":"HyperDHT","noise_identity_verified":connection.remote_public_key==peer.0,
                    "authorization":"not_attempted","endpoint":if reveal{connection.remote_addr.map(|a|a.to_string())}else{None}})
                }
                Ok(Err(error)) => {
                    json!({"ok":false,"error_code":format!("{error:?}").split(['(','{']).next(),"detail":if reveal{Some(error.to_string())}else{None}})
                }
                Err(_) => json!({"ok":false,"error_code":"Timeout","budget_seconds":75}),
            };
            event("dht_direct_connect", stage, data);
        }
    }
    let _ = tokio::time::timeout(Duration::from_secs(2), handle.destroy()).await;
    task.abort();
    event(
        "complete",
        start,
        json!({"diagnostic_completed":true,"bootstrap_ok":bootstrap_ok}),
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn stun_rejects_wrong_transaction_and_truncation() {
        let id = [7; 12];
        let mut p = vec![1, 1, 0, 12, 0x21, 0x12, 0xa4, 0x42];
        p.extend_from_slice(&id);
        p.extend_from_slice(&[0, 0x20, 0, 8, 0, 1, 0x21, 0x13, 0x29, 0x1a, 0xac, 0x4a]);
        assert_eq!(mapped_address(&p, &id), Some("8.8.8.8:1".parse().unwrap()));
        assert_eq!(mapped_address(&p, &[8; 12]), None);
        for n in 0..p.len() {
            assert_eq!(mapped_address(&p[..n], &id), None);
        }
    }
}
