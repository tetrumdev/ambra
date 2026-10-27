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
}
impl PairingPayload {
    pub fn encode(&self) -> Result<String> {
        self.validate()?;
        Ok(format!(
            "ambra://pair/{}",
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(serde_json::to_vec(self)?)
        ))
    }
    pub fn decode(value: &str) -> Result<Self> {
        if value.len() > 8192 {
            return Err("Pairing payload is too large".into());
        }
        let payload: Self = serde_json::from_slice(
            &base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(
                value
                    .strip_prefix("ambra://pair/")
                    .ok_or("Expected an Ambra pairing link")?,
            )?,
        )?;
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
            .any(|a| !crate::lan::is_local(a.ip()) || a.port() == 0)
        {
            return Err("Invalid local endpoint hint".into());
        }
        if self
            .public_endpoint
            .is_some_and(|a| crate::lan::is_local(a.ip()) || peeroxide_dht::address_policy::is_overlay(a.ip()) || a.ip().is_unspecified() || a.ip().is_multicast() || a.port() == 0)
        {
            return Err("Invalid public endpoint hint".into());
        }
        Ok(())
    }
}
