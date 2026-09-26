//! Shared application state handed to every handler.

use std::sync::Arc;

use crate::audit::AuditLog;
use crate::auth::{LoginThrottle, SessionStore};
use crate::config::Config;
use crate::metrics::Metrics;
use crate::util::now_ms;

pub struct AppState {
    pub config: Config,
    pub audit: AuditLog,
    pub sessions: SessionStore,
    pub throttle: LoginThrottle,
    pub metrics: Arc<std::sync::RwLock<Metrics>>,
    pub version: String,
    pub started_ms: u64,
    /// True when the operator explicitly disabled authentication
    /// (`--insecure-no-auth`). Surfaced in the UI and the audit log.
    pub insecure_no_auth: bool,
}

impl AppState {
    pub fn uptime_secs(&self) -> u64 {
        now_ms().saturating_sub(self.started_ms) / 1000
    }

    pub fn secure_cookies(&self) -> bool {
        self.config.tls_enabled()
    }
}
