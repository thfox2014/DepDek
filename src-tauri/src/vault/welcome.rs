//! Native single-owner appliance welcome. All identity, credit and IO checks
//! stay inside Vault. This does not impersonate an R1 business session.
use super::*;
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
}
fn unavailable<T>(_: T) -> WelcomeError {
    WelcomeError::Store
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
                    || !username_valid(&value.username)
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
        json!({"enabled":true,"initialized":!s.username.is_empty(),"authenticated":authenticated,"username":if authenticated{Some(&s.username)}else{None},"configured":authenticated && s.configured,"balance":if authenticated{s.balance}else{0},"grant_points":GRANT,"chat_cost":COST,"model":"jiaho-setup","preferences":if authenticated{Some(&s.preferences)}else{None}})
    }
    pub fn status(&self) -> Result<Value, WelcomeError> {
        let mut s = self.inner.lock().map_err(unavailable)?;
        let v = Self::public(&mut s);
        self.record("status", true)?;
        Ok(v)
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
            if !valid || username != s.snapshot.username {
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
