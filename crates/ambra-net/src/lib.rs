//! Native direct-only networking shared by Ambra's server and native clients.
pub mod bridge;
pub mod hyperdht;
pub mod identity;
pub mod lan;
pub mod manager;
pub mod media_cache;
pub mod pairing;
pub mod gate;
pub mod portmap;
pub mod pwnat;
pub mod transport;
pub mod signaling;
pub mod tcp_punch;
pub use identity::{Identity, PublicKey};
pub use manager::{ConnectionManager, ConnectionState, SelectedServer};
pub type Error = Box<dyn std::error::Error + Send + Sync>;
pub type Result<T> = std::result::Result<T, Error>;
