//! Native networking shared by Ambra's server and clients, with Tailcat as the final fallback.
pub mod bridge;
pub mod gate;
pub mod hyperdht;
pub mod identity;
pub mod lan;
pub mod manager;
pub mod media_cache;
pub mod pairing;
pub mod portmap;
pub mod pwnat;
pub mod signaling;
pub mod tailcat;
pub mod tcp_punch;
pub mod transport;
pub use identity::{Identity, PublicKey};
pub use manager::{ConnectionManager, ConnectionState, SelectedServer};
pub type Error = Box<dyn std::error::Error + Send + Sync>;
pub type Result<T> = std::result::Result<T, Error>;
