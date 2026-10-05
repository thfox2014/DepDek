//! R1 incremental service: local owner identity, versioned read manifests,
//! and existing Rust Vault; optional credential management and scoped business
//! sessions. No HTTP listener, model, Job, or business writer.

#[cfg(unix)]
pub mod service;
#[cfg(unix)]
pub mod transport;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");
pub const MAX_REQUEST_BYTES: usize = 64 * 1024;
pub const MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
