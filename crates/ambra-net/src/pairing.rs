use crate::{PublicKey, Result};
use base64::Engine;
use serde::{Deserialize, Serialize};

/// Public bootstrap information, never an administrative or device credential.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PairingPayload {
    pub version: u8,
    pub public_key: PublicKey,
    pub name: String,
    #[serde(default)]
    pub local_addresses: Vec<std::net::SocketAddr>,
    #[serde(default)]
    pub public_endpoint: Option<std::net::SocketAddr>,
    /// Router-forwarded TCP endpoints. Omitted when empty so older apps still read the link.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub public_tcp: Vec<std::net::SocketAddr>,
}
impl PairingPayload {
    pub fn encode(&self) -> Result<String> {
        // Only hints that every device reads the same way, so no device rejects the link.
        let mut portable = self.clone();
        portable.local_addresses.retain(|a| crate::lan::is_portable_direct(a.ip()) && a.port() != 0);
        portable.public_tcp.retain(|a| valid_public_tcp(*a));
        if portable.public_endpoint.is_some_and(|e| crate::pwnat::validate_endpoint(e).is_err()) {
            portable.public_endpoint = None;
        }
        portable.validate()?;
        Ok(format!(
            "ambra://pair/{}",
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(serde_json::to_vec(&portable)?)
        ))
    }
    pub fn decode(value: &str) -> Result<Self> {
        if value.len() > 8192 {
            return Err("Pairing payload is too large".into());
        }
        let mut payload: Self = serde_json::from_slice(
            &base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(
                value
                    .strip_prefix("ambra://pair/")
                    .ok_or("Expected an Ambra pairing link")?,
            )?,
        )?;
        if payload.local_addresses.len() > 16 || payload.public_tcp.len() > 8 {
            return Err("Invalid or unsupported pairing payload".into());
        }
        // Hints only speed up finding the server; its pinned key authenticates every path. One
        // this device can't use (another network's IPv6 prefix, say) is dropped, not fatal.
        payload.local_addresses.retain(|a| crate::lan::is_direct(a.ip()) && a.port() != 0);
        payload.public_tcp.retain(|a| valid_public_tcp(*a));
        if payload.public_endpoint.is_some_and(|e| crate::pwnat::validate_endpoint(e).is_err()) {
            payload.public_endpoint = None;
        }
        payload.validate()?;
        Ok(payload)
    }
    fn validate(&self) -> Result<()> {
        if self.version != 1
            || self.name.chars().count() > 64
            || self.name.chars().any(char::is_control)
            || self.local_addresses.len() > 16
        {
            return Err("Invalid or unsupported pairing payload".into());
        }
        if self
            .local_addresses
            .iter()
            .any(|a| !crate::lan::is_direct(a.ip()) || a.port() == 0)
        {
            return Err("Invalid local endpoint hint".into());
        }
        if self.public_tcp.len() > 8 || self.public_tcp.iter().any(|a| !valid_public_tcp(*a)) {
            return Err("Invalid public endpoint hint".into());
        }
        if let Some(endpoint) = self.public_endpoint { crate::pwnat::validate_endpoint(endpoint)?; }
        Ok(())
    }
}

fn valid_public_tcp(address: std::net::SocketAddr) -> bool {
    match address.ip() {
        std::net::IpAddr::V4(ip) => crate::portmap::is_public(ip) && address.port() != 0,
        std::net::IpAddr::V6(_) => false,
    }
}
