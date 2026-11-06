//! Discover routers and optionally map a TCP port: `portmap_probe [external internal]`.
#[tokio::main]
async fn main() {
    let args: Vec<u16> = std::env::args().skip(1).filter_map(|a| a.parse().ok()).collect();
    for gateway in ambra_net::portmap::discover().await {
        println!("{} gateway, external {}", gateway.method(), gateway.external_ip);
        if let [external, internal] = args[..] {
            let result = gateway.map_tcp(external, internal, std::time::Duration::from_secs(600)).await;
            println!("  map {external}->{internal}: {result:?}");
        }
    }
}
