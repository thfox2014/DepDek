//! Native single-owner appliance welcome. All identity, credit and IO checks
//! stay inside Vault. This does not impersonate an R1 business session.
use super::*;
#[path = "welcome/bitbay.rs"]
mod bitbay;
use crate::secrets::SecretText;
use argon2::{
    password_hash::{phc::PasswordHash, PasswordVerifier},
    Argon2,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    io::{Read, Write},
    os::fd::AsRawFd,
    sync::Mutex,
    time::{Duration, Instant},
};

const GRANT: u32 = 1_000;
const COST: u32 = 10;
const LIMIT: usize = 512 * 1024;
const MODEL: &str = "jiaho-setup";
const MODEL_ORIGIN: &str = "http://127.0.0.1:11435";

#[derive(Debug, thiserror::Error)]
pub enum WelcomeError {
    #[error("LOGIN_REQUIRED")]
    Required,
    #[error("INVALID_INPUT")]
    Invalid,
    #[error("LOGIN_FAILED")]
    Login,
    #[error("LOGIN_RATE_LIMITED")]
    Limited,
    #[error("CONFLICT")]
    Conflict,
    #[error("CREDITS_EXHAUSTED")]
    Credits,
    #[error("LOCAL_MODEL_UNAVAILABLE")]
    Model,
    #[error("MODEL_OUTCOME_UNKNOWN")]
    Unknown,
    #[error("WELCOME_STORE_UNAVAILABLE")]
    Store,
    #[error("AUDIT_UNAVAILABLE")]
    Audit,
    #[error("LOCAL_MODE_PROVIDER_DENIED")]
    LocalProvider,
    #[error("CONNECTION_MODE_LOCKED")]
    ModeLocked,
    #[error("NETWORK_SETTINGS_UNAVAILABLE")]
    NetworkSettings,
    #[error(transparent)]
    BitBay(#[from] bitbay::Error),
    #[error("BITBAY_LOCAL_SAVE_FAILED")]
    BitBayLocalSave,
    #[error("LOCAL_UNLOCK_PASSWORD_REQUIRED")]
    LocalUnlockPassword,
}
fn unavailable<T>(_: T) -> WelcomeError {
    WelcomeError::Store
}

#[derive(Clone, Copy, Default, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ConnectionMode { #[default] Online, Local }

/// Configuration routing boundary, not transport-level egress isolation.
fn local_provider(provider: &crate::settings::ProviderConfig) -> bool {
    use crate::settings::ProviderConfig;
    let endpoint = match provider {
        ProviderConfig::OpenAi { base_url: Some(url), .. } => url,
        ProviderConfig::OpenAiCompatible { base_url, .. } => base_url,
        _ => return false,
    };
    let Ok(url) = url::Url::parse(endpoint) else { return false };
    matches!(url.scheme(), "http" | "https") && url.username().is_empty() && url.password().is_none()
        && url.query().is_none() && url.fragment().is_none() && match url.host() {
            Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
            Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
            _ => false,
        }
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WelcomePreferences {
    pub display_name: String,
    pub language: String,
    pub purpose: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Receipt {
    fingerprint: String,
    status: String,
    reply: String,
}
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Snapshot {
    format: u32,
    username: String,
    password_hash: String,
    granted: bool,
    balance: u32,
    configured: bool,
    preferences: WelcomePreferences,
    #[serde(default)]
    connection_mode: ConnectionMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    bitbay: Option<bitbay::Account>,
    operations: BTreeMap<String, Receipt>,
}
struct LoginSession {
    created: Instant,
    touched: Instant,
}
struct Inner {
    snapshot: Snapshot,
    session: Option<LoginSession>,
    failures: u32,
    blocked: Option<Instant>,
    workspace_started: bool,
    code_sent_at: Option<Instant>,
}
pub struct WelcomeVault {
    directory: fs::File,
    _lock: fs::File,
    audit: AuditLog,
    inner: Mutex<Inner>,
}
fn username_valid(v: &str) -> bool {
    (3..=32).contains(&v.len())
        && v.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
}
fn active(inner: &mut Inner) -> bool {
    let valid = inner.session.as_ref().is_some_and(|s| {
        s.created.elapsed() < Duration::from_secs(43_200)
            && s.touched.elapsed() < Duration::from_secs(1_800)
    });
    if valid {
        inner.session.as_mut().unwrap().touched = Instant::now();
    } else {
        inner.session = None;
    }
    valid
}
impl WelcomeVault {
    pub fn open(path: &Path) -> Result<Self, WelcomeError> {
        if !path.is_absolute()
            || path.file_name().and_then(|s| s.to_str()) != Some(".jiaho-onboarding")
        {
            return Err(WelcomeError::Invalid);
        }
        // Create/open each component through held fds; never follow a path symlink.
        let mut directory = fs::File::open("/").map_err(unavailable)?;
        for part in path.components() {
            let Component::Normal(part) = part else {
                if matches!(part, Component::RootDir) {
                    continue;
                }
                return Err(WelcomeError::Invalid);
            };
            let name = part.to_str().ok_or(WelcomeError::Invalid)?;
            directory =
                match managed_open_at(&directory, name, libc::O_RDONLY | libc::O_DIRECTORY, 0) {
                    Ok(f) => f,
                    Err(ManagedReadError::NotFound) => {
                        let component = std::ffi::CString::new(name).map_err(unavailable)?;
                        if unsafe {
                            libc::mkdirat(directory.as_raw_fd(), component.as_ptr(), 0o700)
                        } != 0
                        {
                            return Err(WelcomeError::Store);
                        }
                        managed_open_at(&directory, name, libc::O_RDONLY | libc::O_DIRECTORY, 0)
                            .map_err(unavailable)?
                    }
                    Err(_) => return Err(WelcomeError::Store),
                };
        }
        private_directory_meta(&directory.metadata().map_err(unavailable)?).map_err(unavailable)?;
        let lock = private_open(&directory, "writer.lock", libc::O_RDWR | libc::O_CREAT)
            .map_err(unavailable)?;
        if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            return Err(WelcomeError::Conflict);
        }
        let snapshot = match managed_open_at(&directory, "state.json", libc::O_RDONLY, 0) {
            Err(ManagedReadError::NotFound) => Snapshot {
                format: 1,
                ..Snapshot::default()
            },
            Err(_) => return Err(WelcomeError::Store),
            Ok(file) => {
                private_file_meta(&file.metadata().map_err(unavailable)?).map_err(unavailable)?;
                let mut bytes = Vec::new();
                file.take((LIMIT + 1) as u64)
                    .read_to_end(&mut bytes)
                    .map_err(unavailable)?;
                if bytes.len() > LIMIT {
                    return Err(WelcomeError::Store);
                }
                let value: Snapshot = serde_json::from_slice(&bytes).map_err(unavailable)?;
                let charged = value
                    .operations
                    .values()
                    .filter(|r| r.status != "failed")
                    .count() as u32
                    * COST;
                if value.format != 1
                    || !(username_valid(&value.username) || value.bitbay.as_ref().is_some_and(|account| value.username == account.email))
                    || value.bitbay.as_ref().is_some_and(|account| account.user_id == 0 || bitbay::normalize_email(&account.email).ok().as_deref() != Some(account.email.as_str()))
                    || !value
                        .password_hash
                        .starts_with("$argon2id$v=19$m=65536,t=3,p=1$")
                    || PasswordHash::new(&value.password_hash).is_err()
                    || value.operations.len() > 128
                    || value.balance > GRANT
                    || (value.granted && value.balance.checked_add(charged) != Some(GRANT))
                    || (!value.granted && (value.balance != 0 || !value.operations.is_empty()))
                    || value.operations.values().any(|r| {
                        !matches!(r.status.as_str(), "pending" | "success" | "failed")
                            || r.reply.len() > 16384
                    })
                {
                    return Err(WelcomeError::Store);
                }
                value
            }
        };
        let audit = AuditLog::new();
        let file = private_open(
            &directory,
            AUDIT_FILE_NAME,
            libc::O_APPEND | libc::O_WRONLY | libc::O_CREAT,
        )
        .map_err(unavailable)?;
        audit.set_file(path.join(AUDIT_FILE_NAME), file);
        let store = Self {
            directory,
            _lock: lock,
            audit,
            inner: Mutex::new(Inner {
                snapshot,
                session: None,
                failures: 0,
                blocked: None,
                workspace_started: false,
                code_sent_at: None,
            }),
        };
        store.record("open", true)?;
        Ok(store)
    }
    fn record(&self, action: &str, ok: bool) -> Result<(), WelcomeError> {
        let mut entry = AuditEntry::new("jiaho-welcome", Op::Write, &format!("welcome/{action}"));
        entry.ok = ok;
        self.audit
            .record_durable(entry)
            .map_err(|_| WelcomeError::Audit)
    }
    fn save(&self, next: &Snapshot) -> Result<(), WelcomeError> {
        private_directory_meta(&self.directory.metadata().map_err(unavailable)?)
            .map_err(unavailable)?;
        match managed_open_at(&self.directory, "state.json", libc::O_RDONLY, 0) {
            Ok(f) => private_file_meta(&f.metadata().map_err(unavailable)?).map_err(unavailable)?,
            Err(ManagedReadError::NotFound) => (),
            Err(_) => return Err(WelcomeError::Store),
        }
        let bytes = serde_json::to_vec(next).map_err(unavailable)?;
        if bytes.len() > LIMIT {
            return Err(WelcomeError::Store);
        }
        let mut nonce = [0u8; 16];
        getrandom::fill(&mut nonce).map_err(unavailable)?;
        let stage = format!(".stage-{}", sha256_hex(&nonce));
        let mut file = private_open(
            &self.directory,
            &stage,
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL,
        )
        .map_err(unavailable)?;
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(unavailable)?;
        let source = std::ffi::CString::new(stage).unwrap();
        let target = c"state.json";
        if unsafe {
            libc::renameat(
                self.directory.as_raw_fd(),
                source.as_ptr(),
                self.directory.as_raw_fd(),
                target.as_ptr(),
            )
        } != 0
        {
            return Err(WelcomeError::Store);
        }
        self.directory.sync_all().map_err(unavailable)
    }
    pub fn authenticated(&self) -> bool {
        self.inner
            .lock()
            .map(|mut s| active(&mut s))
            .unwrap_or(false)
    }
    fn public(inner: &mut Inner) -> Value {
        let authenticated = active(inner);
        let s = &inner.snapshot;
        json!({"enabled":true,"initialized":!s.username.is_empty(),"authenticated":authenticated,"username":if authenticated{Some(&s.username)}else{None},"configured":authenticated && s.configured,"balance":if authenticated{s.balance}else{0},"grant_points":GRANT,"chat_cost":COST,"model":"jiaho-setup","preferences":if authenticated{Some(&s.preferences)}else{None},"connection_mode":s.connection_mode,"mode_locked":inner.workspace_started,"bitbay":if authenticated{s.bitbay.as_ref()}else{None}})
    }
    pub fn status(&self) -> Result<Value, WelcomeError> {
        let mut s = self.inner.lock().map_err(unavailable)?;
        let v = Self::public(&mut s);
        self.record("status", true)?;
        Ok(v)
    }
    pub fn set_connection_mode(&self, mode: ConnectionMode) -> Result<Value, WelcomeError> {
        let mut s = self.inner.lock().map_err(unavailable)?;
        let subject = if mode == ConnectionMode::Local { "connection_mode.local" } else { "connection_mode.online" };
        let result = (|| {
            if !active(&mut s) { return Err(WelcomeError::Required); }
            if s.workspace_started && mode != s.snapshot.connection_mode { return Err(WelcomeError::ModeLocked); }
            let mut next = s.snapshot.clone(); next.connection_mode = mode;
            self.record(&format!("{subject}.intent"), true)?; self.save(&next)?; s.snapshot = next;
            Ok(Self::public(&mut s))
        })();
        self.record(subject, result.is_ok())?; result
    }
    pub fn authorize_provider(&self, provider: &crate::settings::ProviderConfig, pin_mode: bool) -> Result<(), WelcomeError> {
        let mut s = self.inner.lock().map_err(unavailable)?;
        let result = (|| {
            if !active(&mut s) { return Err(WelcomeError::Required); }
            if s.snapshot.connection_mode == ConnectionMode::Local && !local_provider(provider) { return Err(WelcomeError::LocalProvider); }
            if pin_mode { s.workspace_started = true; }
            Ok(())
        })();
        self.record("model.authorize", result.is_ok())?; result
    }
    pub fn network_status(&self) -> Result<crate::network::NetworkStatus, WelcomeError> {
        self.network_status_with(crate::network::snapshot)
    }
    fn network_status_with(&self, snapshot: impl FnOnce() -> crate::network::NetworkStatus) -> Result<crate::network::NetworkStatus, WelcomeError> {
        // Narrow pre-login onboarding capability; does not activate any Vault session.
        self.record("network.status.intent", true)?;
        let status = snapshot(); self.record("network.status", true)?; Ok(status)
    }
    pub fn open_network_settings(&self) -> Result<(), WelcomeError> {
        self.open_network_settings_with(crate::network::open_settings)
    }
    fn open_network_settings_with(&self, open: impl FnOnce() -> Result<(), &'static str>) -> Result<(), WelcomeError> {
        self.record("network.settings.intent", true)?;
        let result = open().map_err(|_| WelcomeError::NetworkSettings);
        self.record("network.settings", result.is_ok())?; result
    }
    pub fn bitbay_send_code(&self, email: String) -> Result<Value, WelcomeError> {
        self.bitbay_send_code_with(email, bitbay::send_code)
    }
    fn bitbay_send_code_with(&self, email: String, send: impl FnOnce(&str) -> Result<(), bitbay::Error>) -> Result<Value, WelcomeError> {
        let mut s = self.inner.lock().map_err(unavailable)?;
        let result = (|| {
            if !s.snapshot.username.is_empty() && !active(&mut s) { return Err(WelcomeError::Required); }
            if s.snapshot.bitbay.is_some() { return Err(WelcomeError::Conflict); }
            let email = bitbay::normalize_email(&email)?;
            if s.code_sent_at.is_some_and(|at| at.elapsed() < Duration::from_secs(60)) { return Err(bitbay::Error::RateLimited.into()); }
            self.record("bitbay.send_code.intent", true)?;
            send(&email)?;
            s.code_sent_at = Some(Instant::now());
            Ok(json!({"sent":true,"retry_after_seconds":60}))
        })();
        self.record("bitbay.send_code", result.is_ok())?; result
    }
    pub fn bitbay_register(&self, email: String, code: SecretText, password: SecretText) -> Result<Value, WelcomeError> {
        self.bitbay_account_with(email, password, Some(code), None, bitbay::register)
    }
    pub fn bitbay_login(&self, email: String, password: SecretText, local_password: Option<SecretText>) -> Result<Value, WelcomeError> {
        self.bitbay_account_with(email, password, None, local_password, bitbay::login)
    }
    fn bitbay_account_with(
        &self, email: String, password: SecretText, code: Option<SecretText>, local_password: Option<SecretText>,
        request: impl FnOnce(&str, &SecretText, Option<&SecretText>) -> Result<bitbay::Account, bitbay::Error>,
    ) -> Result<Value, WelcomeError> {
        // Serialize the external write with local creation/binding. The HTTP call is bounded.
        let mut s = self.inner.lock().map_err(unavailable)?;
        let action = if code.is_some() { "bitbay.register" } else { "bitbay.login" };
        let result = (|| {
            let fresh = s.snapshot.username.is_empty();
            if !fresh && !active(&mut s) { return Err(WelcomeError::Required); }
            if s.snapshot.bitbay.is_some() { return Err(WelcomeError::Conflict); }
            let email = bitbay::normalize_email(&email)?;
            bitbay::validate_password(&password, code.is_some())?;
            if let Some(code) = &code {
                if code.bytes().len() != 6 || !code.bytes().iter().all(u8::is_ascii_digit) { return Err(bitbay::Error::Code.into()); }
            }
            // Prepare the local hash before sending a registration that cannot be rolled back.
            let hash = if fresh {
                let local = local_password.unwrap_or_else(|| password.clone());
                Some(hash_business_password(local).map_err(|_| WelcomeError::LocalUnlockPassword)?)
            } else { None };
            self.record(&format!("{action}.intent"), true)?;
            let account = request(&email, &password, code.as_ref())?;
            if account.email != email || account.user_id == 0 { return Err(bitbay::Error::Unknown.into()); }
            let mut next = s.snapshot.clone();
            if let Some(hash) = hash { next.username = email; next.password_hash = hash; }
            next.bitbay = Some(account);
            self.save(&next).map_err(|_| WelcomeError::BitBayLocalSave)?;
            s.snapshot = next;
            // No session is issued unless the final platform outcome is durably recorded.
            self.record(action, true)?;
            self.activate(&mut s)
        })();
        if result.is_err() { self.record(action, false)?; }
        result
    }
    pub fn register(&self, username: String, password: SecretText) -> Result<Value, WelcomeError> {
        let mut s = self.inner.lock().map_err(unavailable)?;
        let result = (|| {
            if !s.snapshot.username.is_empty() {
                return Err(WelcomeError::Conflict);
            }
            if !username_valid(&username) {
                return Err(WelcomeError::Invalid);
            }
            let hash = hash_business_password(password).map_err(|_| WelcomeError::Invalid)?;
            self.record("register.intent", true)?;
            let next = Snapshot {
                format: 1,
                username,
                password_hash: hash,
                ..Snapshot::default()
            };
            self.save(&next)?;
            s.snapshot = next;
            self.activate(&mut s)
        })();
        self.record("register", result.is_ok())?;
        result
    }
    pub fn login(&self, username: String, password: SecretText) -> Result<Value, WelcomeError> {
        let mut s = self.inner.lock().map_err(unavailable)?;
        let result = (|| {
            if s.blocked.is_some_and(|t| Instant::now() < t) {
                return Err(WelcomeError::Limited);
            }
            if s.snapshot.username.is_empty() || password.bytes().len() > 1024 {
                return Err(WelcomeError::Login);
            }
            let hash = PasswordHash::new(&s.snapshot.password_hash).map_err(unavailable)?;
            let valid = Argon2::default()
                .verify_password(password.bytes(), &hash)
                .is_ok();
            let matches_username = if s.snapshot.bitbay.as_ref().is_some_and(|account| account.email == s.snapshot.username) {
                bitbay::normalize_email(&username).ok().as_deref() == Some(s.snapshot.username.as_str())
            } else { username == s.snapshot.username };
            if !valid || !matches_username {
                s.failures += 1;
                if s.failures >= 5 {
                    s.blocked = Some(Instant::now() + Duration::from_secs(30));
                }
                return Err(WelcomeError::Login);
            }
            self.activate(&mut s)
        })();
        self.record("login", result.is_ok())?;
        result
    }
    fn activate(&self, s: &mut Inner) -> Result<Value, WelcomeError> {
        if !s.snapshot.granted {
            let mut next = s.snapshot.clone();
            next.granted = true;
            next.balance = GRANT;
            self.record("grant.intent", true)?;
            self.save(&next)?;
            s.snapshot = next;
            self.record("grant", true)?;
        }
        self.record("session.issue", true)?;
        s.failures = 0;
        s.blocked = None;
        s.session = Some(LoginSession {
            created: Instant::now(),
            touched: Instant::now(),
        });
        Ok(Self::public(s))
    }
    pub fn logout(&self) -> Result<(), WelcomeError> {
        let mut s = self.inner.lock().map_err(unavailable)?;
        s.session = None;
        self.record("logout", true)
    }
    pub fn complete(&self, preferences: WelcomePreferences) -> Result<Value, WelcomeError> {
        let mut s = self.inner.lock().map_err(unavailable)?;
        let result = (|| {
            if !active(&mut s) {
                return Err(WelcomeError::Required);
            }
            if preferences.display_name.trim().is_empty()
                || preferences.display_name.chars().count() > 40
                || preferences.display_name.chars().any(char::is_control)
                || !matches!(preferences.language.as_str(), "zh-CN" | "en")
                || !matches!(
                    preferences.purpose.as_str(),
                    "family" | "documents" | "photos"
                )
            {
                return Err(WelcomeError::Invalid);
            }
            let mut next = s.snapshot.clone();
            next.preferences = preferences;
            next.configured = true;
            self.record("complete.intent", true)?;
            self.save(&next)?;
            s.snapshot = next;
            Ok(Self::public(&mut s))
        })();
        self.record("complete", result.is_ok())?;
        result
    }
    pub fn model_ready() -> bool {
        client(Duration::from_secs(2))
            .and_then(|c| {
                c.get(format!("{MODEL_ORIGIN}/health"))
                    .send()
                    .map_err(|_| WelcomeError::Model)
            })
            .is_ok_and(|r| r.status().is_success())
    }
    pub fn chat(&self, operation: String, prompt: String) -> Result<Value, WelcomeError> {
        self.chat_using(operation, prompt, exchange)
    }
    fn chat_using(
        &self,
        operation: String,
        prompt: String,
        call: impl FnOnce(&str) -> Result<String, WelcomeError>,
    ) -> Result<Value, WelcomeError> {
        let mut s = self.inner.lock().map_err(unavailable)?;
        let result = (|| {
            if !active(&mut s) {
                return Err(WelcomeError::Required);
            }
            if !(8..=80).contains(&operation.len())
                || !operation
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"-_".contains(&b))
                || prompt.trim().is_empty()
                || prompt.len() > 4096
            {
                return Err(WelcomeError::Invalid);
            }
            let fingerprint = sha256_hex(prompt.as_bytes());
            if let Some(r) = s.snapshot.operations.get(&operation) {
                if r.fingerprint != fingerprint {
                    return Err(WelcomeError::Conflict);
                }
                return match r.status.as_str() {
                    "success" => Ok(
                        json!({"reply":r.reply,"balance":s.snapshot.balance,"operation_id":operation,"model":MODEL,"local":true}),
                    ),
                    "failed" => Err(WelcomeError::Model),
                    _ => Err(WelcomeError::Unknown),
                };
            }
            if s.snapshot.balance < COST {
                return Err(WelcomeError::Credits);
            }
            if s.snapshot.operations.len() >= 128 {
                return Err(WelcomeError::Credits);
            }
            self.record("chat.reserve.intent", true)?;
            let mut next = s.snapshot.clone();
            next.balance -= COST;
            next.operations.insert(
                operation.clone(),
                Receipt {
                    fingerprint,
                    status: "pending".into(),
                    reply: String::new(),
                },
            );
            self.save(&next)?;
            s.snapshot = next;
            // Exact once: persist the reservation BEFORE any model request.
            let answer = call(&prompt).and_then(|text| {
                if text.trim().is_empty() || text.len() > 16384 {
                    Err(WelcomeError::Model)
                } else {
                    Ok(text)
                }
            });
            let mut next = s.snapshot.clone();
            let receipt = next.operations.get_mut(&operation).unwrap();
            match &answer {
                Ok(text) => {
                    receipt.status = "success".into();
                    receipt.reply = text.clone();
                }
                Err(WelcomeError::Unknown) => (),
                Err(_) => {
                    receipt.status = "failed".into();
                    next.balance += COST;
                }
            }
            self.save(&next)?;
            s.snapshot = next;
            self.record("chat.settle", answer.is_ok())?;
            if !active(&mut s) {
                return Err(WelcomeError::Required);
            }
            answer.map(|reply|json!({"reply":reply,"balance":s.snapshot.balance,"operation_id":operation,"model":MODEL,"local":true}))
        })();
        self.record("chat", result.is_ok())?;
        result
    }
}
fn client(timeout: Duration) -> Result<reqwest::blocking::Client, WelcomeError> {
    reqwest::blocking::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(2))
        .timeout(timeout)
        .build()
        .map_err(|_| WelcomeError::Model)
}
fn exchange(prompt: &str) -> Result<String, WelcomeError> {
    let response=client(Duration::from_secs(90))?.post(format!("{MODEL_ORIGIN}/v1/chat/completions")).json(&json!({"model":MODEL,"stream":false,"max_tokens":256,"temperature":0.35,"messages":[{"role":"system","content":"你是家合 Jiaho 的本机配置助手。用简洁亲切的中文协助用户完成初始配置。你只能给出建议，没有文件、终端或管理权限，不能声称已经执行操作。可配置显示名称、中文或英文、家庭资料/文档/照片方向；用户在右侧表单确认保存。联网、磁盘和云端 Provider 可进入工作台后配置。不要索要密码或 API Key。每次最多给出三个简短步骤，最后问一个有助配置的问题。"},{"role":"user","content":prompt}]})).send().map_err(|e|if e.is_connect(){WelcomeError::Model}else{WelcomeError::Unknown})?;
    if !response.status().is_success() {
        return Err(WelcomeError::Model);
    }
    let mut bytes = Vec::new();
    response
        .take(65537)
        .read_to_end(&mut bytes)
        .map_err(|_| WelcomeError::Unknown)?;
    if bytes.len() > 65536 {
        return Err(WelcomeError::Model);
    }
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| WelcomeError::Model)?;
    value["choices"][0]["message"]["content"]
        .as_str()
        .map(str::to_owned)
        .ok_or(WelcomeError::Model)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::{symlink, PermissionsExt};
    fn setup() -> (tempfile::TempDir, PathBuf, WelcomeVault) {
        let t = tempfile::tempdir().unwrap();
        let p = fs::canonicalize(t.path())
            .unwrap()
            .join(".jiaho-onboarding");
        let v = WelcomeVault::open(&p).unwrap();
        (t, p, v)
    }
    fn register(v: &WelcomeVault) -> Value {
        v.register(
            "family".into(),
            SecretText::new("SyntheticWelcome2026!".into()),
        )
        .unwrap()
    }
    #[test]
    fn grant_only_once_across_login_and_restart_and_native_vault_gate() {
        let (t, p, v) = setup();
        assert!(matches!(
            v.chat_using("test-call-1".into(), "hello".into(), |_| panic!()),
            Err(WelcomeError::Required)
        ));
        assert_eq!(register(&v)["balance"], GRANT);
        let r = v
            .chat_using("test-call-1".into(), "hello".into(), |_| Ok("reply".into()))
            .unwrap();
        assert_eq!(r["balance"], 990);
        assert_eq!(
            v.chat_using("test-call-1".into(), "hello".into(), |_| panic!())
                .unwrap()["balance"],
            990
        );
        assert!(matches!(
            v.chat_using("test-call-1".into(), "changed".into(), |_| panic!()),
            Err(WelcomeError::Conflict)
        ));
        v.logout().unwrap();
        assert!(v
            .login("family".into(), SecretText::new("wrong".into()))
            .is_err());
        assert_eq!(
            v.login(
                "family".into(),
                SecretText::new("SyntheticWelcome2026!".into())
            )
            .unwrap()["balance"],
            990
        );
        drop(v);
        let gate = Vault::new();
        gate.enable_ai_os_login(&p).unwrap();
        let home = t.path().join("home");
        fs::create_dir(&home).unwrap();
        assert!(matches!(
            gate.set_root(&home),
            Err(VaultError::AuthRequired)
        ));
        let v = gate.ai_os_welcome().unwrap();
        assert_eq!(v.status().unwrap()["authenticated"], false);
        assert_eq!(
            v.login(
                "family".into(),
                SecretText::new("SyntheticWelcome2026!".into())
            )
            .unwrap()["balance"],
            990
        );
        gate.set_root(&home).unwrap();
        v.logout().unwrap();
        assert!(matches!(
            gate.read_file("user", "a.txt"),
            Err(VaultError::AuthRequired)
        ));
    }
    #[test]
    fn failed_calls_refund_unknown_calls_do_not_retry_and_preferences_persist() {
        let (_t, p, v) = setup();
        register(&v);
        assert!(v
            .chat_using("known-fail".into(), "hello".into(), |_| Err(
                WelcomeError::Model
            ))
            .is_err());
        assert_eq!(v.status().unwrap()["balance"], 1000);
        assert!(v
            .chat_using("known-fail".into(), "hello".into(), |_| panic!())
            .is_err());
        assert!(v
            .chat_using("unknown-call".into(), "hello".into(), |_| Err(
                WelcomeError::Unknown
            ))
            .is_err());
        assert_eq!(v.status().unwrap()["balance"], 990);
        assert!(v
            .chat_using("unknown-call".into(), "hello".into(), |_| panic!())
            .is_err());
        v.complete(WelcomePreferences {
            display_name: "我的家".into(),
            language: "zh-CN".into(),
            purpose: "family".into(),
        })
        .unwrap();
        drop(v);
        let v = WelcomeVault::open(&p).unwrap();
        assert_eq!(
            v.login(
                "family".into(),
                SecretText::new("SyntheticWelcome2026!".into())
            )
            .unwrap()["configured"],
            true
        );
        let audit = fs::read_to_string(p.join(AUDIT_FILE_NAME)).unwrap();
        for secret in ["SyntheticWelcome2026!", "hello", "我的家", "argon2"] {
            assert!(!audit.contains(secret));
        }
    }
    #[test]
    fn private_store_rejects_symlink_hardlink_public_modes_and_second_writer() {
        let (t, p, v) = setup();
        register(&v);
        assert!(WelcomeVault::open(&p).is_err());
        drop(v);
        let state = p.join("state.json");
        let outside = t.path().join("outside.json");
        fs::rename(&state, &outside).unwrap();
        symlink(&outside, &state).unwrap();
        assert!(WelcomeVault::open(&p).is_err());
        fs::remove_file(&state).unwrap();
        fs::hard_link(&outside, &state).unwrap();
        assert!(WelcomeVault::open(&p).is_err());
        fs::remove_file(&state).unwrap();
        fs::rename(&outside, &state).unwrap();
        fs::set_permissions(&state, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(WelcomeVault::open(&p).is_err());
        let link = t.path().join("alias");
        symlink(&p, &link).unwrap();
        assert!(WelcomeVault::open(&link.join(".jiaho-onboarding")).is_err());
    }
    #[test]
    fn parent_vault_cannot_expose_private_account_or_symlink_alias() {
        let (t, p, v) = setup();
        register(&v);
        let gate = Vault::new();
        gate.set_root(t.path()).unwrap();
        symlink(&p, t.path().join("alias")).unwrap();
        for session in ["user", "agent-test"] {
            for rel in [".jiaho-onboarding/state.json", "alias/state.json"] {
                assert!(gate.read_file(session, rel).is_err());
                assert!(gate.read_binary(session, rel).is_err());
                assert!(gate.write_file(session, rel, "overwrite").is_err());
                assert!(gate.stat(session, rel).is_err());
            }
            assert!(!gate
                .list_dir(session, ".")
                .unwrap()
                .entries
                .iter()
                .any(|e| e.name == ".jiaho-onboarding"));
            assert!(gate
                .search_files(session, "password_hash")
                .unwrap()
                .matches
                .is_empty());
        }
        let pack = t.path().join("pack");
        fs::create_dir_all(pack.join(".jiaho-onboarding")).unwrap();
        fs::write(pack.join(".jiaho-onboarding/state.json"), "private").unwrap();
        fs::write(pack.join("public.txt"), "public").unwrap();
        gate.compress("user", "pack", Some("archive.tar.gz"))
            .unwrap();
        let input = fs::File::open(t.path().join("archive.tar.gz")).unwrap();
        let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(input));
        assert!(archive.entries().unwrap().all(|entry| !entry
            .unwrap()
            .path()
            .unwrap()
            .to_string_lossy()
            .contains(".jiaho-onboarding")));
    }
    #[test]
    fn pre_login_network_check_and_settings_are_audited_without_unlocking_other_capabilities() {
        let (t, p, initial) = setup(); drop(initial);
        let gate = Vault::new(); gate.enable_ai_os_login(&p).unwrap();
        let v = gate.ai_os_welcome().unwrap();
        let status = v.network_status_with(|| crate::network::NetworkStatus {
            platform: "synthetic", interfaces: vec![crate::network::NetworkInterface {
                name: "synthetic".into(), addresses: vec!["192.0.2.20".into()],
            }], settings_available: true, connectivity: crate::network::Connectivity::Online,
        }).unwrap();
        assert_eq!(status.connectivity, crate::network::Connectivity::Online);
        v.open_network_settings_with(|| Ok(())).unwrap();
        assert!(matches!(v.open_network_settings_with(|| Err("test failure")), Err(WelcomeError::NetworkSettings)));
        assert!(!v.authenticated());
        assert!(matches!(gate.set_root(t.path()), Err(VaultError::AuthRequired)));
        assert!(matches!(gate.read_file("user", "private.txt"), Err(VaultError::AuthRequired)));
        assert!(matches!(v.set_connection_mode(ConnectionMode::Local), Err(WelcomeError::Required)));
        assert!(matches!(v.complete(WelcomePreferences::default()), Err(WelcomeError::Required)));
        let audit = fs::read_to_string(p.join(AUDIT_FILE_NAME)).unwrap();
        for action in ["network.status.intent", "network.status", "network.settings.intent", "network.settings"] { assert!(audit.contains(action), "{action}"); }
        assert!(!audit.contains("192.0.2.20"));
    }
    #[test]
    fn unavailable_audit_prevents_pre_login_network_io_and_settings_launch() {
        let (_t, p, v) = setup();
        let path = p.join(AUDIT_FILE_NAME);
        v.audit.set_file(path.clone(), fs::File::open(path).unwrap());
        assert!(matches!(v.network_status_with(|| panic!("must not probe without audit")), Err(WelcomeError::Audit)));
        assert!(matches!(v.open_network_settings_with(|| panic!("must not launch without audit")), Err(WelcomeError::Audit)));
        assert!(!v.authenticated());
    }
    #[test]
    fn bitbay_verified_registration_persists_identity_and_local_unlock_without_secrets() {
        let (_t, p, v) = setup();
        let password = "SyntheticBitBay2026!";
        let status = v.bitbay_account_with(" PERSON@Example.com ".into(), SecretText::new(password.into()), Some(SecretText::new("123456".into())), None,
            |email, secret, code| {
                assert_eq!(email, "person@example.com"); assert_eq!(secret.bytes(), password.as_bytes());
                assert_eq!(code.unwrap().bytes(), b"123456");
                Ok(bitbay::Account { email: email.into(), user_id: 42 })
            }).unwrap();
        assert_eq!(status["authenticated"], true);
        assert_eq!(status["bitbay"]["user_id"], 42);
        assert_eq!(status["username"], "person@example.com");
        v.logout().unwrap();
        assert!(v.status().unwrap()["bitbay"].is_null());
        drop(v);
        let saved = fs::read_to_string(p.join("state.json")).unwrap();
        let audit = fs::read_to_string(p.join(AUDIT_FILE_NAME)).unwrap();
        for value in [&saved, &audit] { assert!(!value.contains(password) && !value.contains("123456") && !value.contains("token")); }
        assert!(!audit.contains("person@example.com"));
        let v = WelcomeVault::open(&p).unwrap();
        assert!(!v.authenticated());
        let unlocked = v.login(" PERSON@Example.com ".into(), SecretText::new(password.into())).unwrap();
        assert_eq!(unlocked["bitbay"]["email"], "person@example.com");
        assert_eq!(unlocked["balance"], GRANT);
    }
    #[test]
    fn bitbay_cannot_replace_locked_or_already_linked_home_and_preserves_unlocked_legacy_identity() {
        let (_t, _p, v) = setup(); register(&v); v.logout().unwrap();
        assert!(matches!(v.bitbay_account_with("a@example.com".into(), SecretText::new("SyntheticBitBay2026!".into()), None, None, |_,_,_| panic!("locked Home must not invoke platform")), Err(WelcomeError::Required)));
        assert!(matches!(v.bitbay_send_code_with("a@example.com".into(), |_| panic!("locked Home must not send email")), Err(WelcomeError::Required)));
        v.login("family".into(), SecretText::new("SyntheticWelcome2026!".into())).unwrap();
        let linked = v.bitbay_account_with("a@example.com".into(), SecretText::new("abcdef".into()), None, None, |email,_,_| Ok(bitbay::Account { email:email.into(), user_id:9 })).unwrap();
        assert_eq!(linked["username"], "family");
        assert!(matches!(v.bitbay_account_with("other@example.com".into(), SecretText::new("SyntheticBitBay2026!".into()), None, None, |_,_,_| panic!("cannot replace association")), Err(WelcomeError::Conflict)));
        v.logout().unwrap();
        v.login("family".into(), SecretText::new("SyntheticWelcome2026!".into())).unwrap();
    }
    #[test]
    fn bitbay_failure_or_invalid_identity_never_creates_or_authenticates_a_local_account() {
        let (_t, p, v) = setup();
        for outcome in [Err(bitbay::Error::Unknown), Ok(bitbay::Account { email:"wrong@example.com".into(), user_id:5 }), Ok(bitbay::Account { email:"a@example.com".into(), user_id:0 })] {
            assert!(v.bitbay_account_with("a@example.com".into(), SecretText::new("SyntheticBitBay2026!".into()), None, None, |_,_,_| outcome).is_err());
            assert!(!v.authenticated()); assert!(!p.join("state.json").exists());
        }
        for (password, code) in [("short", "123456"), ("SyntheticBitBay2026!", "not-six-digits")] {
            assert!(v.bitbay_account_with("a@example.com".into(), SecretText::new(password.into()), Some(SecretText::new(code.into())), None, |_,_,_| panic!("invalid input must not invoke")).is_err());
        }
    }
    #[test]
    fn bitbay_short_existing_password_requires_separate_strong_local_password() {
        let (_t, _p, v) = setup();
        assert!(matches!(v.bitbay_account_with("a@example.com".into(), SecretText::new("abcdef".into()), None, None, |_,_,_| panic!("weak local password must not invoke")), Err(WelcomeError::LocalUnlockPassword)));
        let result = v.bitbay_account_with("a@example.com".into(), SecretText::new("abcdef".into()), None, Some(SecretText::new("StrongLocal2026!".into())), |email,secret,_| {
            assert_eq!(secret.bytes(), b"abcdef"); Ok(bitbay::Account { email:email.into(), user_id:7 })
        }).unwrap();
        assert_eq!(result["authenticated"], true);
        v.logout().unwrap();
        assert!(v.login("a@example.com".into(), SecretText::new("abcdef".into())).is_err());
        v.login("a@example.com".into(), SecretText::new("StrongLocal2026!".into())).unwrap();
    }
    #[test]
    fn bitbay_send_code_is_cooled_down_and_audit_failure_blocks_all_platform_io() {
        let (_t, p, v) = setup();
        let result = v.bitbay_send_code_with(" A@Example.com ".into(), |email| { assert_eq!(email,"a@example.com"); Ok(()) }).unwrap();
        assert_eq!(result["retry_after_seconds"], 60); assert!(!v.authenticated());
        assert!(matches!(v.bitbay_send_code_with("b@example.com".into(), |_| panic!("must honor cooldown")), Err(WelcomeError::BitBay(bitbay::Error::RateLimited))));
        assert!(v.bitbay_send_code_with("bad-input".into(), |_| panic!("invalid mailbox must not invoke")).is_err());
        let path = p.join(AUDIT_FILE_NAME); v.audit.set_file(path.clone(), fs::File::open(path).unwrap());
        assert!(matches!(v.bitbay_account_with("a@example.com".into(), SecretText::new("SyntheticBitBay2026!".into()), None, None, |_,_,_| panic!("audit failure must prevent platform invocation")), Err(WelcomeError::Audit)));
        assert!(!v.authenticated()); assert!(!p.join("state.json").exists());
    }
    #[test]
    fn local_model_routing_is_authenticated_persistent_and_rejects_remote_or_ambiguous_endpoints() {
        use crate::settings::ProviderConfig;
        let (_t, p, v) = setup();
        assert!(matches!(v.set_connection_mode(ConnectionMode::Local), Err(WelcomeError::Required)));
        register(&v); v.set_connection_mode(ConnectionMode::Local).unwrap();
        for base_url in ["http://127.0.0.1:11434/v1", "http://127.0.0.2:9000/v1", "http://[::1]:1234/v1"] {
            let p = ProviderConfig::OpenAiCompatible { base_url: base_url.into(), model: "local".into(), api_key: None };
            v.authorize_provider(&p, false).unwrap();
        }
        for base_url in ["https://api.example.test/v1", "http://localhost:11434/v1", "http://192.168.1.2/v1", "http://127.0.0.1.example.test/v1", "http://[::ffff:127.0.0.1]/v1", "file:///tmp/model", "http://secret@127.0.0.1/v1", "http://127.0.0.1/v1?key=secret", "http://127.0.0.1/v1#secret"] {
            let p = ProviderConfig::OpenAiCompatible { base_url: base_url.into(), model: "synthetic".into(), api_key: Some("SyntheticKeyNotForLogs".into()) };
            assert!(matches!(v.authorize_provider(&p, false), Err(WelcomeError::LocalProvider)), "{base_url}");
        }
        assert!(matches!(v.authorize_provider(&ProviderConfig::Anthropic { api_key: "synthetic".into(), model: "test".into() }, false), Err(WelcomeError::LocalProvider)));
        drop(v);
        let v = WelcomeVault::open(&p).unwrap();
        assert_eq!(v.status().unwrap()["connection_mode"], "local");
        assert!(matches!(v.set_connection_mode(ConnectionMode::Online), Err(WelcomeError::Required)));
        let audit = fs::read_to_string(p.join(AUDIT_FILE_NAME)).unwrap();
        assert!(!audit.contains("SyntheticKeyNotForLogs")); assert!(!audit.contains("api.example.test"));
    }
    #[test]
    fn creating_persistent_sessions_locks_mode_until_restart_but_analysis_checks_do_not() {
        let (_t, p, v) = setup(); register(&v);
        let provider = crate::settings::ProviderConfig::OpenAiCompatible { base_url:"http://127.0.0.1:11434/v1".into(), model:"test".into(), api_key:None };
        v.authorize_provider(&provider, false).unwrap();
        v.set_connection_mode(ConnectionMode::Local).unwrap();
        v.set_connection_mode(ConnectionMode::Online).unwrap();
        v.authorize_provider(&provider, true).unwrap();
        assert!(matches!(v.set_connection_mode(ConnectionMode::Local), Err(WelcomeError::ModeLocked)));
        assert_eq!(v.status().unwrap()["connection_mode"], "online");
        v.logout().unwrap();
        v.login("family".into(), SecretText::new("SyntheticWelcome2026!".into())).unwrap();
        assert!(matches!(v.set_connection_mode(ConnectionMode::Local), Err(WelcomeError::ModeLocked)));
        drop(v);
        let v = WelcomeVault::open(&p).unwrap();
        v.login("family".into(), SecretText::new("SyntheticWelcome2026!".into())).unwrap();
        v.set_connection_mode(ConnectionMode::Local).unwrap();
    }
    #[test]
    fn older_snapshots_default_online_and_standard_desktop_does_not_enable_the_gate() {
        let (_t, p, v) = setup(); register(&v); drop(v);
        let path = p.join("state.json");
        let mut data: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        data.as_object_mut().unwrap().remove("connection_mode");
        fs::write(&path, serde_json::to_vec(&data).unwrap()).unwrap();
        let v = WelcomeVault::open(&p).unwrap();
        assert_eq!(v.status().unwrap()["connection_mode"], "online");
        let desktop = Vault::new();
        desktop.require_ai_os_provider(&crate::settings::ProviderConfig::Anthropic { api_key:"synthetic".into(), model:"test".into() }, true).unwrap();
    }
    #[test]
    fn credits_exhaustion_and_login_rate_limit() {
        let (_t, _p, v) = setup();
        register(&v);
        for i in 0..100 {
            v.chat_using(format!("op-{i:08}"), "hi".into(), |_| Ok("ok".into()))
                .unwrap();
        }
        assert!(matches!(
            v.chat_using("exhausted-call".into(), "hi".into(), |_| panic!()),
            Err(WelcomeError::Credits)
        ));
        v.logout().unwrap();
        for _ in 0..5 {
            assert!(v
                .login("family".into(), SecretText::new("wrong".into()))
                .is_err());
        }
        assert!(matches!(
            v.login(
                "family".into(),
                SecretText::new("SyntheticWelcome2026!".into())
            ),
            Err(WelcomeError::Limited)
        ));
    }
}
