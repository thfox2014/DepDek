//! R1 incremental service: local owner identity, versioned read manifests,
//! and existing Rust Vault; optional credential management and scoped business
//! sessions. Optional exact-input local-only model gateway; no public HTTP,
//! production engine integration, persistent Job, or business writer.

#[cfg(unix)]
pub mod service;
#[cfg(unix)]
pub mod transport;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");
pub const MAX_REQUEST_BYTES: usize = 64 * 1024;
pub const MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
