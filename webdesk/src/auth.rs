//! Password hashing, sessions and login throttling.
//!
//! Security posture (see docs/webdesk-design.md):
//! * passwords are stored as Argon2id PHC strings, never in plaintext;
//! * the session cookie is HttpOnly + SameSite=Strict and expires on both an
//!   absolute TTL and an idle timeout;
//! * every state-changing request must echo the per-session CSRF token;
//! * failed logins from one address are throttled with exponential backoff;
//! * every login/logout attempt is written to the append-only audit log.

use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::Mutex;
use std::time::Duration;

use anyhow::{anyhow, Result};
use argon2::{Argon2, PasswordHasher, PasswordVerifier};
use password_hash::phc::PasswordHash;

use crate::util::now_ms;

pub const SESSION_COOKIE: &str = "depdek_webdesk_session";
pub const CSRF_HEADER: &str = "x-depdek-csrf";
const USER_NAME: &str = "admin";

/// Hash a password into an Argon2id PHC string (`$argon2id$v=19$...`).
pub fn hash_password(password: &str) -> Result<String> {
    if password.len() < 8 {
        return Err(anyhow!("密码至少 8 位"));
    }
    let salt = password_hash::generate_salt();
    let hash = Argon2::default()
        .hash_password_with_salt(password.as_bytes(), &salt)
        .map_err(|error| anyhow!("哈希失败：{error}"))?;
    Ok(hash.to_string())
}

/// Constant-time-ish verification against a stored PHC string.
pub fn verify_password(password: &str, stored_phc: &str) -> bool {
    match PasswordHash::new(stored_phc) {
        Ok(parsed) => Argon2::default()
            .verify_password(password.as_bytes(), &parsed)
            .is_ok(),
        Err(_) => false,
    }
}

/// Cryptographically random hex token (session id / CSRF token).
pub fn random_token() -> String {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).expect("OS RNG unavailable");
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[derive(Debug, Clone)]
pub struct Session {
    pub id: String,
    pub csrf: String,
    pub user: &'static str,
    pub created_ms: u64,
    pub last_seen_ms: u64,
    pub ip: String,
}

#[derive(Debug)]
pub struct SessionStore {
    ttl: Duration,
    idle: Duration,
    sessions: Mutex<HashMap<String, Session>>,
}

impl SessionStore {
    pub fn new(ttl_secs: u64, idle_secs: u64) -> Self {
        Self {
            ttl: Duration::from_secs(ttl_secs),
            idle: Duration::from_secs(idle_secs),
            sessions: Mutex::new(HashMap::new()),
        }
    }

    pub fn create(&self, ip: &str) -> Session {
        self.sweep();
        let session = Session {
            id: random_token(),
            csrf: random_token(),
            user: USER_NAME,
            created_ms: now_ms(),
            last_seen_ms: now_ms(),
            ip: ip.to_string(),
        };
        self.sessions
            .lock()
            .expect("session mutex")
            .insert(session.id.clone(), session.clone());
        session
    }

    /// Look up a session and refresh its idle timer. Expired sessions are removed.
    pub fn touch(&self, session_id: &str) -> Option<Session> {
        let now = now_ms();
        let mut guard = self.sessions.lock().expect("session mutex");
        let session = guard.get_mut(session_id)?;
        if self.expired(session, now) {
            guard.remove(session_id);
            return None;
        }
        session.last_seen_ms = now;
        Some(session.clone())
    }

    pub fn remove(&self, session_id: &str) -> bool {
        self.sessions
            .lock()
            .expect("session mutex")
            .remove(session_id)
            .is_some()
    }

    pub fn active_count(&self) -> usize {
        self.sessions.lock().expect("session mutex").len()
    }

    fn expired(&self, session: &Session, now: u64) -> bool {
        now.saturating_sub(session.created_ms) > self.ttl.as_millis() as u64
            || now.saturating_sub(session.last_seen_ms) > self.idle.as_millis() as u64
    }

    fn sweep(&self) {
        let now = now_ms();
        self.sessions
            .lock()
            .expect("session mutex")
            .retain(|_, session| !self.expired(session, now));
    }
}

#[derive(Debug, Default)]
struct Attempts {
    failures: u32,
    blocked_until_ms: u64,
}

/// Per-address login throttle with exponential backoff (capped at 15 minutes).
#[derive(Debug)]
pub struct LoginThrottle {
    max_failures: u32,
    attempts: Mutex<HashMap<String, Attempts>>,
}

impl LoginThrottle {
    pub fn new(max_failures: u32) -> Self {
        Self {
            max_failures: max_failures.max(1),
            attempts: Mutex::new(HashMap::new()),
        }
    }

    /// Seconds the caller must wait, or `None` when the address may try again.
    pub fn blocked_for(&self, ip: &str) -> Option<u64> {
        let now = now_ms();
        let guard = self.attempts.lock().expect("throttle mutex");
        let entry = guard.get(ip)?;
        if entry.blocked_until_ms > now {
            return Some((entry.blocked_until_ms - now + 999) / 1000);
        }
        None
    }

    pub fn record_failure(&self, ip: &str) -> u32 {
        let mut guard = self.attempts.lock().expect("throttle mutex");
        let entry = guard.entry(ip.to_string()).or_default();
        entry.failures = entry.failures.saturating_add(1);
        if entry.failures >= self.max_failures {
            let over = entry.failures - self.max_failures;
            let backoff_secs = 60u64.saturating_mul(1 << over.min(4));
            entry.blocked_until_ms = now_ms() + backoff_secs * 1000;
        }
        entry.failures
    }

    pub fn record_success(&self, ip: &str) {
        self.attempts.lock().expect("throttle mutex").remove(ip);
    }
}

pub fn client_ip(headers: &axum::http::HeaderMap, peer: Option<std::net::SocketAddr>) -> String {
    if let Some(forwarded) = headers.get("x-forwarded-for").and_then(|v| v.to_str().ok()) {
        if let Some(first) = forwarded.split(',').next() {
            let candidate = first.trim();
            if let Ok(ip) = candidate.parse::<IpAddr>() {
                return ip.to_string();
            }
        }
    }
    peer.map(|addr| addr.ip().to_string())
        .unwrap_or_else(|| "unknown".into())
}

/// Extract a cookie value from the request headers.
pub fn cookie<'a>(headers: &'a axum::http::HeaderMap, name: &str) -> Option<&'a str> {
    let raw = headers.get(axum::http::header::COOKIE)?.to_str().ok()?;
    raw.split(';')
        .filter_map(|part| part.split_once('='))
        .find(|(key, _)| key.trim() == name)
        .map(|(_, value)| value.trim())
}

pub fn session_cookie(session_id: &str, max_age_secs: u64, secure: bool) -> String {
    let mut cookie = format!(
        "{SESSION_COOKIE}={session_id}; Path=/; HttpOnly; SameSite=Strict; Max-Age={max_age_secs}"
    );
    if secure {
        cookie.push_str("; Secure");
    }
    cookie
}

pub fn cleared_cookie(secure: bool) -> String {
    let mut cookie = format!("{SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0");
    if secure {
        cookie.push_str("; Secure");
    }
    cookie
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hashes_and_verifies_passwords() {
        let hash = hash_password("correct horse battery").unwrap();
        assert!(hash.starts_with("$argon2id$"), "PHC 前缀: {hash}");
        assert!(!hash.contains("correct horse battery"), "不得包含明文");
        assert!(verify_password("correct horse battery", &hash));
        assert!(!verify_password("wrong password", &hash));
        assert!(!verify_password(
            "correct horse battery",
            "not-a-phc-string"
        ));
    }

    #[test]
    fn rejects_short_passwords() {
        assert!(hash_password("short").is_err());
    }

    #[test]
    fn sessions_expire_and_can_be_revoked() {
        let store = SessionStore::new(3600, 3600);
        let session = store.create("127.0.0.1");
        assert!(store.touch(&session.id).is_some());
        assert_eq!(store.active_count(), 1);
        assert!(store.remove(&session.id));
        assert!(store.touch(&session.id).is_none());
        assert_eq!(store.active_count(), 0);
    }

    #[test]
    fn throttle_blocks_after_repeated_failures() {
        let throttle = LoginThrottle::new(3);
        assert!(throttle.blocked_for("10.0.0.9").is_none());
        throttle.record_failure("10.0.0.9");
        throttle.record_failure("10.0.0.9");
        assert!(throttle.blocked_for("10.0.0.9").is_none());
        throttle.record_failure("10.0.0.9");
        let wait = throttle.blocked_for("10.0.0.9").expect("blocked");
        assert!(wait > 0 && wait <= 60, "首次封禁 60s，实际 {wait}");
        throttle.record_success("10.0.0.9");
        assert!(throttle.blocked_for("10.0.0.9").is_none());
    }

    #[test]
    fn tokens_are_unique_and_hex() {
        let a = random_token();
        let b = random_token();
        assert_eq!(a.len(), 64);
        assert_ne!(a, b);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
    }
}
