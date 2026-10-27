//! Development interoperability probe. No Node process is shipped by Ambra.
use ambra_net::{Identity, PublicKey, hyperdht::Client};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
#[tokio::main]
async fn main() -> ambra_net::Result<()> {
    let key = PublicKey::try_from(
        std::env::args()
            .nth(1)
            .ok_or("Pass reference peer public key")?,
    )?;
    let node = Client::new(Identity::generate()?);
    let result = tokio::time::timeout(Duration::from_secs(45), async {
        let (mut io, _pump) = node.connect(key).await?;
        io.write_all(b"ambra-native-interop-v1").await?;
        let mut bytes = [0; 23];
        io.read_exact(&mut bytes).await?;
        if &bytes != b"ambra-native-interop-v1" {
            return Err("Reference peer returned unexpected bytes".into());
        }
        println!(
            "Native HyperDHT known-key lookup, Noise authentication and direct UDX echo succeeded"
        );
        Ok::<_, ambra_net::Error>(())
    })
    .await;
    node.shutdown().await;
    result??;
    Ok(())
}
