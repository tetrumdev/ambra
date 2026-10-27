use crate::Result;
use peeroxide_dht::hyperdht::KeyPair;
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::Path,
};
use zeroize::Zeroizing;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Hash, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct PublicKey(pub [u8; 32]);
impl TryFrom<String> for PublicKey {
    type Error = String;
    fn try_from(value: String) -> std::result::Result<Self, String> {
        let mut bytes = [0; 32];
        hex::decode_to_slice(&value, &mut bytes)
            .map_err(|_| "Expected a 64-character server public key")?;
        if bytes == [0; 32] {
            return Err("Invalid zero public key".into());
        }
        Ok(Self(bytes))
    }
}
impl From<PublicKey> for String {
    fn from(key: PublicKey) -> Self {
        hex::encode(key.0)
    }
}
impl std::fmt::Display for PublicKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", hex::encode(self.0))
    }
}

/// A seed is never serialized with public server information or printed in Debug.
#[derive(Clone)]
pub struct Identity {
    seed: Zeroizing<[u8; 32]>,
}
impl Identity {
    pub fn generate() -> Result<Self> {
        let mut seed = Zeroizing::new([0; 32]);
        getrandom::fill(seed.as_mut()).map_err(|e| std::io::Error::other(e.to_string()))?;
        Ok(Self { seed })
    }
    pub fn key_pair(&self) -> KeyPair {
        KeyPair::from_seed(*self.seed)
    }
    pub fn public_key(&self) -> PublicKey {
        PublicKey(self.key_pair().public_key)
    }
    /// Create once, exclusively. Corrupt or unreadable identities never rotate silently.
    /// The enclosing application data directory must be private to the user (Windows ACLs).
    pub fn load_or_create(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let identity = Self::generate()?;
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        match options.open(path) {
            Ok(mut file) => {
                file.write_all(identity.seed.as_ref())?;
                file.sync_all()?;
                Ok(identity)
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                let metadata = fs::symlink_metadata(path)?;
                if !metadata.is_file() {
                    return Err("Identity must be a regular file".into());
                }
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    if metadata.permissions().mode() & 0o077 != 0 {
                        return Err("Identity permissions must be 0600".into());
                    }
                }
                let mut seed = Zeroizing::new([0; 32]);
                let mut file = fs::File::open(path)?;
                file.read_exact(seed.as_mut())?;
                if file.read(&mut [0])? != 0 {
                    return Err(
                        "Corrupt identity; restore its backup instead of rotating it".into(),
                    );
                }
                Ok(Self { seed })
            }
            Err(error) => Err(error.into()),
        }
    }
}
