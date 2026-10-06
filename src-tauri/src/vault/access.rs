//! Authentication and delegated directory policy remain inside Vault.
//! No browser/admin role or caller-supplied actor can construct a read scope.
use super::*;
use crate::secrets::SecretText;
use argon2::{
    password_hash::{phc::PasswordHash, PasswordHasher, PasswordVerifier},
    Algorithm, Argon2, Params, Version,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};
use std::time::{Duration, Instant};

const ABSOLUTE_TTL: u64 = 3600;
const IDLE_TTL: u64 = 600;
const SESSION_LIMIT: usize = 64;
const HASH_PREFIX: &str = "$argon2id$v=19$m=65536,t=3,p=1$";
#[path = "access/workers.rs"]
mod workers;
pub use workers::{WorkerCall, WorkerIssue, WorkerRevoke};
#[path = "access/gateway.rs"]
mod gateway;
pub use gateway::{ModelCall, ModelIssue, ModelRevoke};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AccessUser {
    pub principal_id: String,
    pub password_hash: String,
    pub read_paths: Vec<String>,
}
impl std::fmt::Debug for AccessUser {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AccessUser")
            .field("principal_id", &self.principal_id)
            .field("password_hash", &"[REDACTED]")
            .finish()
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LoginInput {
    pub username: String,
    pub password: SecretText,
}

#[derive(Debug, thiserror::Error)]
pub enum AccessError {
    #[error("business authentication required")]
    Required,
    #[error("business session expired or revoked")]
    Expired,
    #[error("business request not authorized")]
    Forbidden,
    #[error("invalid business request")]
    Invalid,
    #[error("business login temporarily limited")]
    Limited,
    #[error("business access is unavailable")]
    Unavailable,
    #[error("business resource not visible")]
    NotFound,
    #[error("durable business audit unavailable")]
    Audit,
    #[error("worker query call already used")]
    Conflict,
    #[error("model outcome unavailable; authorization consumed")]
    ModelUnknown,
    #[error(transparent)]
    Credential(#[from] crate::secrets::SecretError),
}
impl AccessError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Required => "AUTH_REQUIRED",
            Self::Expired => "SESSION_EXPIRED",
            Self::Forbidden => "FORBIDDEN",
            Self::Invalid => "INVALID_INPUT",
            Self::Limited => "RATE_LIMITED",
            Self::Unavailable => "CAPABILITY_UNAVAILABLE",
            Self::NotFound => "NOT_FOUND",
            Self::Audit => "AUDIT_UNAVAILABLE",
            Self::Conflict => "CONFLICT",
            Self::ModelUnknown => "MODEL_OUTCOME_UNKNOWN",
            Self::Credential(error) => error.code(),
        }
    }
    pub fn message(&self) -> &'static str {
        match self {
            Self::Required => "business authentication required",
            Self::Expired => "business session expired or revoked",
            Self::Forbidden => "business request not authorized",
            Self::Invalid => "invalid business request",
            Self::Limited => "business login temporarily limited",
            Self::Unavailable => "business access unavailable",
            Self::NotFound => "business resource not visible",
            Self::Audit => "durable business audit unavailable",
            Self::Conflict => "worker query call already used",
            Self::ModelUnknown => "model outcome unavailable; do not retry this authorization",
            Self::Credential(error) => error.message(),
        }
    }
}
impl From<ManagedReadError> for AccessError {
    fn from(error: ManagedReadError) -> Self {
        match error {
            ManagedReadError::Forbidden | ManagedReadError::NotFound => Self::NotFound,
            ManagedReadError::AuditUnavailable => Self::Audit,
            ManagedReadError::InvalidInput
            | ManagedReadError::NotUtf8
            | ManagedReadError::TooLarge => Self::Invalid,
            _ => Self::Unavailable,
        }
    }
}

struct Session {
    principal: String,
    csrf_digest: String,
    created: Instant,
    last_seen: Instant,
}
impl Session {
    fn expired(&self) -> bool {
        self.created.elapsed() >= Duration::from_secs(ABSOLUTE_TTL)
            || self.last_seen.elapsed() >= Duration::from_secs(IDLE_TTL)
    }
}
#[derive(Default)]
struct Attempt {
    failures: u32,
    until: Option<Instant>,
}
#[derive(Default)]
pub(super) struct AccessState {
    configured: bool,
    users: BTreeMap<String, AccessUser>,
    sessions: HashMap<String, Session>,
    attempts: HashMap<String, Attempt>,
    workers: HashMap<String, workers::WorkerLease>,
    models: HashMap<String, gateway::ModelLease>,
}
fn argon() -> Result<Argon2<'static>, AccessError> {
    let params = Params::new(65536, 3, 1, Some(32)).map_err(|_| AccessError::Unavailable)?;
    Ok(Argon2::new(Algorithm::Argon2id, Version::V0x13, params))
}
pub fn hash_business_password(password: SecretText) -> Result<String, AccessError> {
    if password.bytes().len() > 1024
        || password.bytes().len() < 12
        || password.bytes().iter().any(|b| b.is_ascii_control())
    {
        return Err(AccessError::Invalid);
    }
    let mut salt = [0u8; 16];
    getrandom::fill(&mut salt).map_err(|_| AccessError::Unavailable)?;
    argon()?
        .hash_password_with_salt(password.bytes(), &salt)
        .map(|h| h.to_string())
        .map_err(|_| AccessError::Unavailable)
}
fn valid_hash(hash: &str) -> bool {
    let parts: Vec<_> = hash.split('$').collect();
    hash.starts_with(HASH_PREFIX)
        && parts.len() == 6
        && parts[4].len() == 22
        && parts[5].len() == 43
        && PasswordHash::new(hash).is_ok()
}
fn token(prefix: &str) -> Result<String, AccessError> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|_| AccessError::Unavailable)?;
    Ok(format!(
        "{prefix}_{}",
        bytes.iter().map(|b| format!("{b:02x}")).collect::<String>()
    ))
}
fn digest(bytes: &[u8]) -> String {
    sha256_hex(bytes)
}
fn token_id(value: &SecretText) -> Result<String, AccessError> {
    let bytes = value.bytes();
    if bytes.len() != 67
        || !bytes.starts_with(b"bs_")
        || !bytes[3..].iter().all(|b| b.is_ascii_hexdigit())
    {
        return Err(AccessError::Expired);
    }
    Ok(digest(bytes))
}
fn checked_session<'a>(
    state: &'a AccessState,
    id: &str,
    csrf: Option<&SecretText>,
) -> Result<&'a Session, AccessError> {
    let session = state.sessions.get(id).ok_or(AccessError::Expired)?;
    if session.expired() {
        return Err(AccessError::Expired);
    }
    if csrf.is_some_and(|c| digest(c.bytes()) != session.csrf_digest) {
        return Err(AccessError::Forbidden);
    }
    if !state.users.contains_key(&session.principal) {
        return Err(AccessError::Expired);
    }
    Ok(session)
}

impl ManagedReadVault {
    fn access_audit<T>(
        &self,
        request: &str,
        principal: &str,
        action: &str,
        result: &Result<T, AccessError>,
    ) -> Result<(), AccessError> {
        let mut entry = AuditEntry::new(&format!("v2:{principal}:{request}"), Op::Write, action);
        entry.ok = result.is_ok();
        entry.error = result.as_ref().err().map(|e| e.code().into());
        self.audit
            .record_durable(entry)
            .map_err(|_| AccessError::Audit)
    }
    pub fn configure_access(&self, users: Vec<AccessUser>) -> Result<(), AccessError> {
        let enabled = !users.is_empty();
        let result = self.configure_access_inner(users);
        if enabled && result.is_err() {
            self.access_audit(
                "startup-access-denied",
                &self.principal_id,
                "auth.configure",
                &result,
            )?;
        }
        result
    }
    fn configure_access_inner(&self, users: Vec<AccessUser>) -> Result<(), AccessError> {
        let mut state = self.access.lock().map_err(|_| AccessError::Unavailable)?;
        if state.configured || users.len() > 32 {
            return Err(AccessError::Invalid);
        }
        let mut registered = BTreeMap::new();
        for mut user in users {
            if !managed_id(&user.principal_id)
                || user.principal_id.starts_with("local:")
                || !valid_hash(&user.password_hash)
                || user.read_paths.is_empty()
                || user.read_paths.len() > 32
            {
                return Err(AccessError::Invalid);
            }
            let mut scopes = Vec::new();
            for path in &user.read_paths {
                let norm = self.visible_path(path)?;
                if !managed_open_beneath(&self.root, &norm)?
                    .metadata()
                    .map_err(|_| AccessError::Unavailable)?
                    .is_dir()
                {
                    return Err(AccessError::Invalid);
                }
                scopes.push(norm);
            }
            scopes.sort();
            scopes.dedup();
            user.read_paths = scopes;
            if registered.insert(user.principal_id.clone(), user).is_some() {
                return Err(AccessError::Invalid);
            }
        }
        if !registered.is_empty() {
            self.access_audit(
                "startup-access",
                &self.principal_id,
                "auth.configure",
                &Ok(json!({})),
            )?;
        }
        state.users = registered;
        state.configured = true;
        Ok(())
    }
    pub fn login_business(&self, request: &str, input: LoginInput) -> Result<Value, AccessError> {
        let mut state = self.access.lock().map_err(|_| AccessError::Unavailable)?;
        let result = (|| {
            if state.users.is_empty() {
                return Err(AccessError::Unavailable);
            }
            if !managed_id(&input.username)
                || input.password.bytes().is_empty()
                || input.password.bytes().len() > 1024
            {
                return Err(AccessError::Required);
            }
            let bucket = if state.users.contains_key(&input.username) {
                input.username.clone()
            } else {
                "<unknown>".into()
            };
            if state
                .attempts
                .get(&bucket)
                .is_some_and(|a| a.until.is_some_and(|t| Instant::now() < t))
            {
                return Err(AccessError::Limited);
            }
            // Same bounded KDF for unknown usernames; no role/account enumeration.
            let hash = &state
                .users
                .get(&input.username)
                .unwrap_or_else(|| state.users.values().next().unwrap())
                .password_hash;
            let valid = argon()?
                .verify_password(
                    input.password.bytes(),
                    &PasswordHash::new(hash).map_err(|_| AccessError::Unavailable)?,
                )
                .is_ok();
            if !valid || !state.users.contains_key(&input.username) {
                let attempt = state.attempts.entry(bucket).or_default();
                attempt.failures = attempt.failures.saturating_add(1);
                if attempt.failures >= 5 {
                    attempt.until = Some(Instant::now() + Duration::from_secs(30));
                }
                return Err(AccessError::Required);
            }
            state.attempts.remove(&bucket);
            state.sessions.retain(|_, s| !s.expired());
            if state.sessions.len() >= SESSION_LIMIT {
                return Err(AccessError::Limited);
            }
            let raw = token("bs")?;
            let csrf = token("csrf")?;
            let id = digest(raw.as_bytes());
            // Persist issuance audit before installing or releasing a token.
            self.access_audit(request, &input.username, "auth.login", &Ok(json!({})))?;
            state.sessions.insert(
                id,
                Session {
                    principal: input.username.clone(),
                    csrf_digest: digest(csrf.as_bytes()),
                    created: Instant::now(),
                    last_seen: Instant::now(),
                },
            );
            Ok(
                json!({"session_token":raw,"csrf_token":csrf,"principal_id":input.username,"workspace_id":self.workspace_id,"expires_in":ABSOLUTE_TTL,"idle_timeout":IDLE_TTL,"audience":"depdek-business-read"}),
            )
        })();
        if result.is_err() {
            self.access_audit(request, &self.principal_id, "auth.login", &result)?;
        }
        result
    }
    pub fn business_session(
        &self,
        request: &str,
        token: &SecretText,
        csrf: Option<&SecretText>,
        logout: bool,
    ) -> Result<Value, AccessError> {
        let mut state = self.access.lock().map_err(|_| AccessError::Unavailable)?;
        let result = (|| {
            let id = token_id(token)?;
            let session = checked_session(&state, &id, csrf)?;
            let principal = session.principal.clone();
            if logout {
                if csrf.is_none() {
                    return Err(AccessError::Forbidden);
                }
                state.sessions.remove(&id);
                state.workers.retain(|_, lease| lease.session_id != id);
                state.models.retain(|_, lease| lease.session_id != id);
                Ok(json!({"logged_out":true}))
            } else {
                state.sessions.get_mut(&id).unwrap().last_seen = Instant::now();
                Ok(
                    json!({"principal_id":principal,"workspace_id":self.workspace_id,"policy_revision":1,"audience":"depdek-business-read"}),
                )
            }
        })();
        self.access_audit(
            request,
            &self.principal_id,
            if logout {
                "auth.logout"
            } else {
                "auth.session"
            },
            &result,
        )?;
        result
    }
    pub fn delegated_info(
        &self,
        request: &str,
        token: &SecretText,
        workspace: Option<&str>,
    ) -> Result<Value, AccessError> {
        let mut state = self.access.lock().map_err(|_| AccessError::Unavailable)?;
        let result = (|| {
            let id = token_id(token)?;
            let session = checked_session(&state, &id, None)?;
            if workspace.is_some_and(|w| w != self.workspace_id) {
                return Err(AccessError::NotFound);
            }
            let principal = session.principal.clone();
            state.sessions.get_mut(&id).unwrap().last_seen = Instant::now();
            Ok(
                json!({"principal_id":principal,"workspace_id":self.workspace_id,"policy_revision":1}),
            )
        })();
        self.access_audit(request, &self.principal_id, "auth.authorize_query", &result)?;
        result
    }
    pub fn delegated_read(
        &self,
        request: &str,
        token: &SecretText,
        csrf: &SecretText,
        workspace: &str,
        operation: ManagedReadOperation,
    ) -> Result<Value, AccessError> {
        // Serialize authenticated reads and logout. Once logout returns, no
        // in-flight read can acquire a scope from the revoked session.
        let mut state = self.access.lock().map_err(|_| AccessError::Unavailable)?;
        let result = (|| {
            let id = token_id(token)?;
            let session = checked_session(&state, &id, Some(csrf))?;
            if workspace != self.workspace_id {
                return Err(AccessError::NotFound);
            }
            let principal = session.principal.clone();
            let scopes = &state
                .users
                .get(&principal)
                .ok_or(AccessError::Expired)?
                .read_paths;
            let authority = ReadAuthority::new(&principal, &self.workspace_id, 1, request);
            let value = self.execute_scoped(&authority, operation, scopes, true)?;
            // TTL is rechecked after I/O and durable file audit, before release.
            checked_session(&state, &id, Some(csrf))?;
            state.sessions.get_mut(&id).unwrap().last_seen = Instant::now();
            Ok(value)
        })();
        if result.is_err() {
            self.access_audit(
                request,
                &self.principal_id,
                "auth.delegated_read_denied",
                &result,
            )?;
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::OnceLock;
    const PASSWORD: &str = "SYNTHETIC_BUSINESS_PASSWORD";
    fn hash() -> String {
        static HASH: OnceLock<String> = OnceLock::new();
        HASH.get_or_init(|| hash_business_password(SecretText::new(PASSWORD.into())).unwrap())
            .clone()
    }
    fn setup() -> (tempfile::TempDir, ManagedReadVault) {
        let root = tempfile::tempdir().unwrap();
        for directory in ["documents/alice", "documents/bob"] {
            fs::create_dir_all(root.path().join(directory)).unwrap();
        }
        fs::write(
            root.path().join("documents/alice/receipt.md"),
            "alice-private-evidence",
        )
        .unwrap();
        fs::write(
            root.path().join("documents/bob/receipt.md"),
            "bob-private-evidence",
        )
        .unwrap();
        let vault =
            ManagedReadVault::open(root.path(), "w1", "local:test", &["documents".into()]).unwrap();
        vault
            .configure_access(vec![
                AccessUser {
                    principal_id: "alice".into(),
                    password_hash: hash(),
                    read_paths: vec!["documents/alice".into()],
                },
                AccessUser {
                    principal_id: "bob".into(),
                    password_hash: hash(),
                    read_paths: vec!["documents/bob".into()],
                },
            ])
            .unwrap();
        (root, vault)
    }
    fn login(vault: &ManagedReadVault) -> Value {
        vault
            .login_business(
                "login-1",
                LoginInput {
                    username: "alice".into(),
                    password: SecretText::new(PASSWORD.into()),
                },
            )
            .unwrap()
    }
    fn tokens(value: &Value) -> (SecretText, SecretText) {
        (
            SecretText::new(value["session_token"].as_str().unwrap().into()),
            SecretText::new(value["csrf_token"].as_str().unwrap().into()),
        )
    }
    fn read(path: &str) -> ManagedReadOperation {
        ManagedReadOperation::Read { path: path.into() }
    }
    #[test]
    fn business_identity_scopes_and_no_internal_or_parent_leak() {
        let (root, vault) = setup();
        let value = login(&vault);
        let (token, csrf) = tokens(&value);
        assert_eq!(value["principal_id"], "alice");
        assert_eq!(
            vault
                .delegated_read(
                    "read-1",
                    &token,
                    &csrf,
                    "w1",
                    read("documents/alice/receipt.md")
                )
                .unwrap()["content"],
            "alice-private-evidence"
        );
        for path in [
            "documents/bob/receipt.md",
            "documents",
            "../documents/bob/receipt.md",
            "/etc/passwd",
            "documents/alice/accounts.json",
        ] {
            assert!(matches!(
                vault.delegated_read("deny-1", &token, &csrf, "w1", read(path)),
                Err(AccessError::NotFound)
            ));
        }
        let listing = vault
            .delegated_read(
                "list-1",
                &token,
                &csrf,
                "w1",
                ManagedReadOperation::List {
                    path: "documents/alice".into(),
                    limit: 100,
                },
            )
            .unwrap();
        assert_eq!(listing["entries"].as_array().unwrap().len(), 1);
        let audit = fs::read_to_string(root.path().join(AUDIT_FILE_NAME)).unwrap();
        for secret in [
            PASSWORD,
            value["session_token"].as_str().unwrap(),
            value["csrf_token"].as_str().unwrap(),
            "alice-private-evidence",
            "bob-private-evidence",
        ] {
            assert!(!audit.contains(secret));
        }
        assert!(!audit.contains(&hash()));
    }
    #[test]
    fn csrf_logout_expiry_restart_and_wrong_workspace_are_enforced() {
        let (root, vault) = setup();
        let value = login(&vault);
        let (token, csrf) = tokens(&value);
        assert!(matches!(
            vault.delegated_read(
                "bad-csrf",
                &token,
                &SecretText::new("fake".into()),
                "w1",
                read("documents/alice/receipt.md")
            ),
            Err(AccessError::Forbidden)
        ));
        assert!(matches!(
            vault.delegated_read(
                "bad-ws",
                &token,
                &csrf,
                "w2",
                read("documents/alice/receipt.md")
            ),
            Err(AccessError::NotFound)
        ));
        vault
            .business_session("logout-1", &token, Some(&csrf), true)
            .unwrap();
        assert!(matches!(
            vault.delegated_read(
                "revoked-1",
                &token,
                &csrf,
                "w1",
                read("documents/alice/receipt.md")
            ),
            Err(AccessError::Expired)
        ));
        let value = login(&vault);
        let (token, csrf) = tokens(&value);
        let id = token_id(&token).unwrap();
        vault
            .access
            .lock()
            .unwrap()
            .sessions
            .get_mut(&id)
            .unwrap()
            .last_seen = Instant::now() - Duration::from_secs(IDLE_TTL + 1);
        assert!(matches!(
            vault.business_session("idle-1", &token, None, false),
            Err(AccessError::Expired)
        ));
        vault
            .access
            .lock()
            .unwrap()
            .sessions
            .get_mut(&id)
            .unwrap()
            .last_seen = Instant::now();
        vault
            .access
            .lock()
            .unwrap()
            .sessions
            .get_mut(&id)
            .unwrap()
            .created = Instant::now() - Duration::from_secs(ABSOLUTE_TTL + 1);
        assert!(matches!(
            vault.delegated_read(
                "ttl-1",
                &token,
                &csrf,
                "w1",
                read("documents/alice/receipt.md")
            ),
            Err(AccessError::Expired)
        ));
        drop(vault);
        let restarted =
            ManagedReadVault::open(root.path(), "w1", "local:test", &["documents".into()]).unwrap();
        assert!(matches!(
            restarted.business_session("restart-1", &token, None, false),
            Err(AccessError::Expired)
        ));
    }
    #[test]
    fn delegated_symlink_and_hardlink_cannot_import_another_users_data() {
        use std::os::unix::fs::symlink;
        let (root, vault) = setup();
        let value = login(&vault);
        let (token, csrf) = tokens(&value);
        let bob = root.path().join("documents/bob/receipt.md");
        symlink(&bob, root.path().join("documents/alice/alias.md")).unwrap();
        fs::hard_link(&bob, root.path().join("documents/alice/hard.md")).unwrap();
        for alias in ["documents/alice/alias.md", "documents/alice/hard.md"] {
            assert!(matches!(
                vault.delegated_read("alias-denied", &token, &csrf, "w1", read(alias)),
                Err(AccessError::NotFound)
            ));
        }
        let result = vault
            .delegated_read(
                "filtered-list",
                &token,
                &csrf,
                "w1",
                ManagedReadOperation::List {
                    path: "documents/alice".into(),
                    limit: 100,
                },
            )
            .unwrap();
        assert_eq!(result["entries"].as_array().unwrap().len(), 1);
    }
    #[test]
    fn identity_config_must_be_private_disjoint_and_not_aliased() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let root = tempfile::tempdir().unwrap();
        fs::set_permissions(root.path(), fs::Permissions::from_mode(0o700)).unwrap();
        let home = root.path().join("home");
        fs::create_dir(&home).unwrap();
        let path = root.path().join("config.json");
        fs::write(&path, "synthetic-config").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(
            read_private_runtime_config(&path, &home).unwrap(),
            b"synthetic-config"
        );
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(read_private_runtime_config(&path, &home).is_err());
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        let link = root.path().join("link.json");
        symlink(&path, &link).unwrap();
        assert!(read_private_runtime_config(&link, &home).is_err());
        fs::hard_link(&path, root.path().join("alias.json")).unwrap();
        assert!(read_private_runtime_config(&path, &home).is_err());
        let inside = home.join("config.json");
        fs::write(&inside, "synthetic").unwrap();
        fs::set_permissions(&inside, fs::Permissions::from_mode(0o600)).unwrap();
        assert!(read_private_runtime_config(&inside, &home).is_err());
    }
    #[test]
    fn malformed_registration_cannot_expand_or_overlap_internal_assets() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join("documents")).unwrap();
        let vault =
            ManagedReadVault::open(root.path(), "w1", "local:test", &["documents".into()]).unwrap();
        for scope in [".", "../escape", "documents-other", "mail"] {
            assert!(vault
                .configure_access(vec![AccessUser {
                    principal_id: "alice".into(),
                    password_hash: hash(),
                    read_paths: vec![scope.into()]
                }])
                .is_err());
        }
        let bad_hash = hash().replace("m=65536", "m=999999999");
        assert!(vault
            .configure_access(vec![AccessUser {
                principal_id: "alice".into(),
                password_hash: bad_hash,
                read_paths: vec!["documents".into()]
            }])
            .is_err());
        assert!(vault
            .configure_access(vec![AccessUser {
                principal_id: "local:test".into(),
                password_hash: hash(),
                read_paths: vec!["documents".into()]
            }])
            .is_err());
        let user = || AccessUser {
            principal_id: "alice".into(),
            password_hash: hash(),
            read_paths: vec!["documents".into()],
        };
        assert!(vault.configure_access(vec![user(), user()]).is_err());
    }
    #[test]
    fn failed_logins_are_bounded_and_missing_accounts_do_not_authenticate() {
        let (_root, vault) = setup();
        for _ in 0..5 {
            assert!(matches!(
                vault.login_business(
                    "wrong-login",
                    LoginInput {
                        username: "unknown".into(),
                        password: SecretText::new(PASSWORD.into())
                    }
                ),
                Err(AccessError::Required)
            ));
        }
        assert!(matches!(
            vault.login_business(
                "limited-login",
                LoginInput {
                    username: "unknown".into(),
                    password: SecretText::new(PASSWORD.into())
                }
            ),
            Err(AccessError::Limited)
        ));
        assert!(matches!(
            vault.login_business(
                "bad-password",
                LoginInput {
                    username: "alice".into(),
                    password: SecretText::new("WRONG_SYNTHETIC_PASSWORD".into())
                }
            ),
            Err(AccessError::Required)
        ));
    }
    #[test]
    fn audit_failure_never_issues_session_or_releases_content() {
        let (root, vault) = setup();
        let value = login(&vault);
        let (token, csrf) = tokens(&value);
        vault.audit.set_file(
            root.path().join(AUDIT_FILE_NAME),
            fs::File::open(root.path().join(AUDIT_FILE_NAME)).unwrap(),
        );
        assert!(matches!(
            vault.delegated_read(
                "failed-audit",
                &token,
                &csrf,
                "w1",
                read("documents/alice/receipt.md")
            ),
            Err(AccessError::Audit)
        ));
        assert!(matches!(
            vault.login_business(
                "failed-login-audit",
                LoginInput {
                    username: "bob".into(),
                    password: SecretText::new(PASSWORD.into())
                }
            ),
            Err(AccessError::Audit)
        ));
        assert_eq!(vault.access.lock().unwrap().sessions.len(), 1);
    }
}
