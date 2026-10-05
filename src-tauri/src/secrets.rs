//! R1 local-owner encrypted credential storage. No public plaintext getter,
//! model/Worker lease, automatic legacy rewrite, or platform unlock shortcut.
use std::collections::BTreeMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use argon2::{Algorithm, Argon2, Params, Version};
use base64::{engine::general_purpose::STANDARD, Engine};
use chacha20poly1305::{
    aead::{Aead, Payload},
    KeyInit, XChaCha20Poly1305, XNonce,
};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use thiserror::Error;
use zeroize::{Zeroize, Zeroizing};

use crate::vault::{ReadAuthority, SecretFileError, SecretFiles};
mod migration;

pub const IDLE_LOCK_SECONDS: u64 = 300;
const MAX_CREDENTIALS: usize = 128;
const MAX_OPERATIONS: usize = 512;
const MAX_SECRET_BYTES: usize = 8192;
const MAX_PAYLOAD_BYTES: usize = 1024 * 1024;
const DOMAIN: &str = "depdek-secret-store-v1/argon2id-v19-m65536-t3-p1/xchacha20poly1305";

/// Sensitive request fields are never part of a public response or Debug.
#[derive(Clone)]
pub struct SecretText(Zeroizing<String>);
impl SecretText {
    pub fn new(value: String) -> Self {
        Self(Zeroizing::new(value))
    }
    pub(crate) fn bytes(&self) -> &[u8] {
        self.0.as_bytes()
    }
}
impl std::fmt::Debug for SecretText {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("[REDACTED]")
    }
}
impl<'de> Deserialize<'de> for SecretText {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        String::deserialize(d).map(Self::new)
    }
}
impl Serialize for SecretText {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.0)
    }
}

#[derive(Debug, Error)]
pub enum SecretError {
    #[error("credential access is forbidden")]
    Forbidden,
    #[error("credential store is locked")]
    Locked,
    #[error("credential store requires explicit initialization")]
    NotInitialized,
    #[error("credential store already exists")]
    AlreadyInitialized,
    #[error("invalid credential request")]
    InvalidInput,
    #[error("credential operation or revision conflicts")]
    Conflict,
    #[error("credential or operation capacity exceeded")]
    Capacity,
    #[error("credential store unavailable; verify operation before retry")]
    Unavailable,
    #[error("credential commit outcome requires receipt verification")]
    CommitUnknown,
    #[error("credential audit unavailable; verify operation before retry")]
    AuditUnavailable,
    #[error("unlock failed; check passphrase or store integrity")]
    UnlockFailed,
    #[error("wait before another unlock attempt")]
    Cooldown,
    #[error("credential store format unavailable")]
    InvalidFormat,
    #[error("credential store is already in use")]
    Busy,
}
impl SecretError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Forbidden => "FORBIDDEN",
            Self::Locked => "SECRET_STORE_LOCKED",
            Self::NotInitialized => "SECRET_STORE_NOT_INITIALIZED",
            Self::AlreadyInitialized => "SECRET_STORE_EXISTS",
            Self::InvalidInput => "INVALID_INPUT",
            Self::Conflict => "CONFLICT",
            Self::Capacity => "LIMIT_EXCEEDED",
            Self::Unavailable => "SECRET_STORE_UNAVAILABLE",
            Self::CommitUnknown => "COMMIT_UNKNOWN",
            Self::AuditUnavailable => "AUDIT_UNAVAILABLE",
            Self::UnlockFailed => "UNLOCK_FAILED",
            Self::Cooldown => "UNLOCK_COOLDOWN",
            Self::InvalidFormat => "SECRET_STORE_FORMAT_INVALID",
            Self::Busy => "SECRET_STORE_BUSY",
        }
    }
    pub fn message(&self) -> &'static str {
        match self {
            Self::Forbidden => "credential access is forbidden",
            Self::Locked => "credential store is locked",
            Self::NotInitialized => "explicit initialization required",
            Self::AlreadyInitialized => "credential store already exists",
            Self::InvalidInput => "invalid credential request",
            Self::Conflict => "operation or revision conflicts",
            Self::Capacity => "credential capacity exceeded",
            Self::Unavailable => "credential storage unavailable; verify before retry",
            Self::CommitUnknown => "commit outcome unknown; query operation receipt after recovery",
            Self::AuditUnavailable => "audit unavailable; verify operation after recovery",
            Self::UnlockFailed => "unlock failed",
            Self::Cooldown => "wait before retrying unlock",
            Self::InvalidFormat => "credential format unavailable",
            Self::Busy => "credential store busy",
        }
    }
}
impl From<SecretFileError> for SecretError {
    fn from(e: SecretFileError) -> Self {
        match e {
            SecretFileError::Forbidden => Self::Forbidden,
            SecretFileError::Busy => Self::Busy,
            SecretFileError::Unavailable => Self::Unavailable,
            SecretFileError::CommitUnknown => Self::CommitUnknown,
            SecretFileError::AuditUnavailable => Self::AuditUnavailable,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum CredentialKind {
    Provider,
    Mail,
    Calendar,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum CredentialField {
    ApiKey,
    Password,
    AccessToken,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(deny_unknown_fields)]
pub struct CredentialBinding {
    pub kind: CredentialKind,
    pub account_id: String,
    pub field: CredentialField,
}
impl CredentialBinding {
    fn validate(&self) -> Result<(), SecretError> {
        if self.account_id.trim().is_empty()
            || self.account_id.len() > 128
            || self.account_id.chars().any(char::is_control)
            || !matches!(
                (&self.kind, &self.field),
                (CredentialKind::Provider, CredentialField::ApiKey)
                    | (CredentialKind::Mail, CredentialField::Password)
                    | (CredentialKind::Calendar, CredentialField::Password)
                    | (CredentialKind::Calendar, CredentialField::AccessToken)
            )
        {
            return Err(SecretError::InvalidInput);
        }
        Ok(())
    }
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(deny_unknown_fields)]
pub struct PutCredential {
    pub operation_id: String,
    pub binding: CredentialBinding,
    pub expected_revision: u64,
    pub secret: SecretText,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RevokeCredential {
    pub operation_id: String,
    pub credential_ref: String,
    pub expected_revision: u64,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InitializeStore {
    pub operation_id: String,
    pub passphrase: SecretText,
}
pub use migration::{ImportCredentials, LegacySources};

pub enum SecretOperation {
    Status,
    Initialize(InitializeStore),
    Unlock(SecretText),
    Lock,
    List,
    Put(PutCredential),
    Revoke(RevokeCredential),
    Receipt(String),
    ImportPreview(LegacySources),
    ImportApply(ImportCredentials),
}
impl SecretOperation {
    fn audit_action(&self) -> &'static str {
        match self {
            Self::Status => "credentials/status",
            Self::Initialize(_) => "credentials/init",
            Self::Unlock(_) => "credentials/unlock",
            Self::Lock => "credentials/lock",
            Self::List => "credentials/list",
            Self::Put(_) => "credentials/put",
            Self::Revoke(_) => "credentials/revoke",
            Self::Receipt(_) => "credentials/receipt",
            Self::ImportPreview(_) => "credentials/import.preview",
            Self::ImportApply(_) => "credentials/import.apply",
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct StoredCredential {
    credential_ref: String,
    revision: u64,
    binding: CredentialBinding,
    revoked: bool,
    secret: SecretText,
}
impl StoredCredential {
    fn public(&self) -> Value {
        json!({"credential_ref":self.credential_ref,"revision":self.revision,
        "binding":self.binding,"state":if self.revoked {"revoked"} else {"stored"},"runtime_enabled":false})
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct OperationRecord {
    digest: String,
    receipt: Value,
}
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Snapshot {
    credentials: Vec<StoredCredential>,
    operations: BTreeMap<String, OperationRecord>,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Envelope {
    format: String,
    workspace_id: String,
    salt: [u8; 16],
    nonce: [u8; 24],
    ciphertext: String,
}
struct Unlocked {
    key: Zeroizing<[u8; 32]>,
    salt: [u8; 16],
    snapshot: Snapshot,
    last_activity: Instant,
}
#[derive(Default)]
struct Inner {
    unlocked: Option<Unlocked>,
    retry_after: Option<Instant>,
}

pub struct SecretStore {
    files: SecretFiles,
    workspace: String,
    inner: Mutex<Inner>,
}
impl SecretStore {
    pub fn new(files: SecretFiles, workspace: String) -> Self {
        Self {
            files,
            workspace,
            inner: Mutex::new(Inner::default()),
        }
    }

    pub fn expire_idle(&self) {
        if let Ok(mut inner) = self.inner.try_lock() {
            expire(&mut inner);
        }
    }

    pub fn execute(
        &self,
        authority: &ReadAuthority,
        operation: SecretOperation,
    ) -> Result<Value, SecretError> {
        let action = operation.audit_action();
        let mut inner = self.inner.lock().map_err(|_| SecretError::Unavailable)?;
        expire(&mut inner);
        if let Err(error) = self.files.authorize(authority) {
            inner.unlocked = None;
            self.files
                .audit(authority, action, false, Some("FORBIDDEN"))?;
            return Err(error.into());
        }
        // A durable intent comes before any key-management effects. Secrets,
        // binding names, operation IDs and input digests never enter this log.
        if let Err(error) = self.files.audit(authority, action, false, Some("INTENT")) {
            inner.unlocked = None;
            return Err(error.into());
        }
        let result = self.apply(&mut inner, operation);
        if matches!(
            result,
            Err(SecretError::Unavailable
                | SecretError::CommitUnknown
                | SecretError::AuditUnavailable
                | SecretError::Forbidden)
        ) {
            inner.unlocked = None;
        }
        if let Err(error) = self.files.audit(
            authority,
            action,
            result.is_ok(),
            result.as_ref().err().map(SecretError::code),
        ) {
            inner.unlocked = None;
            return Err(error.into());
        }
        if let Some(unlocked) = &mut inner.unlocked {
            unlocked.last_activity = Instant::now();
        }
        result
    }

    fn apply(&self, inner: &mut Inner, operation: SecretOperation) -> Result<Value, SecretError> {
        match operation {
            SecretOperation::Status => {
                Ok(json!({"initialized":self.files.read_encrypted()?.is_some(),
                "locked":inner.unlocked.is_none(),"idle_lock_seconds":IDLE_LOCK_SECONDS,"runtime_enabled":false}))
            }
            SecretOperation::Initialize(input) => {
                validate_operation(&input.operation_id)?;
                validate_passphrase(&input.passphrase)?;
                if self.files.read_encrypted()?.is_some() {
                    return Err(SecretError::AlreadyInitialized);
                }
                let mut salt = [0u8; 16];
                random(&mut salt)?;
                let key = derive(&input.passphrase, &salt)?;
                let mut snapshot = Snapshot::default();
                let receipt = json!({"operation_id":input.operation_id,"status":"initialized","runtime_enabled":false});
                snapshot.operations.insert(
                    input.operation_id,
                    OperationRecord {
                        digest: "initialization".into(),
                        receipt: receipt.clone(),
                    },
                );
                self.files
                    .save_encrypted(&seal(&self.workspace, &salt, &key, &snapshot)?)?;
                inner.unlocked = Some(Unlocked {
                    key,
                    salt,
                    snapshot,
                    last_activity: Instant::now(),
                });
                Ok(receipt)
            }
            SecretOperation::Unlock(passphrase) => {
                if inner.unlocked.is_some() {
                    return Err(SecretError::Conflict);
                }
                if inner.retry_after.is_some_and(|at| Instant::now() < at) {
                    return Err(SecretError::Cooldown);
                }
                validate_passphrase(&passphrase)?;
                let bytes = self
                    .files
                    .read_encrypted()?
                    .ok_or(SecretError::NotInitialized)?;
                let envelope = parse_envelope(&bytes, &self.workspace)?;
                let key = derive(&passphrase, &envelope.salt)?;
                let snapshot = match unseal(&envelope, &key) {
                    Ok(snapshot) => snapshot,
                    Err(_) => {
                        inner.retry_after = Some(Instant::now() + Duration::from_secs(2));
                        return Err(SecretError::UnlockFailed);
                    }
                };
                validate_snapshot(&snapshot)?;
                inner.unlocked = Some(Unlocked {
                    key,
                    salt: envelope.salt,
                    snapshot,
                    last_activity: Instant::now(),
                });
                inner.retry_after = None;
                Ok(json!({"locked":false,"runtime_enabled":false}))
            }
            SecretOperation::Lock => {
                inner.unlocked = None;
                Ok(json!({"locked":true}))
            }
            other => {
                let unlocked = inner.unlocked.as_mut().ok_or(SecretError::Locked)?;
                match other {
                    SecretOperation::List => Ok(
                        json!({"credentials":unlocked.snapshot.credentials.iter().map(StoredCredential::public).collect::<Vec<_>>() }),
                    ),
                    SecretOperation::Receipt(id) => {
                        validate_operation(&id)?;
                        Ok(unlocked
                            .snapshot
                            .operations
                            .get(&id)
                            .ok_or(SecretError::Conflict)?
                            .receipt
                            .clone())
                    }
                    SecretOperation::Put(input) => self.put(unlocked, input),
                    SecretOperation::Revoke(input) => self.revoke(unlocked, input),
                    SecretOperation::ImportPreview(sources) => {
                        let candidates = sources.extract()?;
                        let (conflicts, bindings) =
                            migration::preview(&unlocked.snapshot, &candidates);
                        Ok(
                            json!({"bindings":bindings,"conflicts":conflicts,"skipped_empty_keys":candidates.skipped,
                            "source_unchanged":true,"runtime_enabled":false}),
                        )
                    }
                    SecretOperation::ImportApply(input) => self.import(unlocked, input),
                    _ => Err(SecretError::InvalidInput),
                }
            }
        }
    }

    fn commit(&self, unlocked: &mut Unlocked, next: Snapshot) -> Result<(), SecretError> {
        validate_snapshot(&next)?;
        let encrypted = seal(&self.workspace, &unlocked.salt, &unlocked.key, &next)?;
        self.files.save_encrypted(&encrypted)?;
        unlocked.snapshot = next;
        Ok(())
    }

    fn put(&self, unlocked: &mut Unlocked, input: PutCredential) -> Result<Value, SecretError> {
        validate_operation(&input.operation_id)?;
        input.binding.validate()?;
        validate_secret(&input.secret)?;
        let digest = digest(&input)?;
        if let Some(receipt) = replay(&unlocked.snapshot, &input.operation_id, &digest)? {
            return Ok(receipt);
        }
        let mut next = unlocked.snapshot.clone();
        let record = if let Some(record) = next
            .credentials
            .iter_mut()
            .find(|r| r.binding == input.binding)
        {
            if record.revision != input.expected_revision {
                return Err(SecretError::Conflict);
            }
            record.revision = record
                .revision
                .checked_add(1)
                .ok_or(SecretError::Capacity)?;
            record.secret = input.secret;
            record.revoked = false;
            record
        } else {
            if input.expected_revision != 0 {
                return Err(SecretError::Conflict);
            }
            next.credentials.push(StoredCredential {
                credential_ref: new_reference()?,
                revision: 1,
                binding: input.binding,
                revoked: false,
                secret: input.secret,
            });
            next.credentials.last().unwrap()
        };
        let receipt = json!({"operation_id":input.operation_id,"status":"stored","credential":record.public(),"runtime_enabled":false});
        next.operations.insert(
            input.operation_id,
            OperationRecord {
                digest,
                receipt: receipt.clone(),
            },
        );
        self.commit(unlocked, next)?;
        Ok(receipt)
    }

    fn revoke(
        &self,
        unlocked: &mut Unlocked,
        input: RevokeCredential,
    ) -> Result<Value, SecretError> {
        validate_operation(&input.operation_id)?;
        let digest = digest(&input)?;
        if let Some(receipt) = replay(&unlocked.snapshot, &input.operation_id, &digest)? {
            return Ok(receipt);
        }
        let mut next = unlocked.snapshot.clone();
        let record = next
            .credentials
            .iter_mut()
            .find(|r| r.credential_ref == input.credential_ref)
            .ok_or(SecretError::Conflict)?;
        if record.revision != input.expected_revision || record.revoked {
            return Err(SecretError::Conflict);
        }
        record.revision = record
            .revision
            .checked_add(1)
            .ok_or(SecretError::Capacity)?;
        record.revoked = true;
        record.secret = SecretText::new(String::new());
        let receipt = json!({"operation_id":input.operation_id,"status":"revoked","credential":record.public()});
        next.operations.insert(
            input.operation_id,
            OperationRecord {
                digest,
                receipt: receipt.clone(),
            },
        );
        self.commit(unlocked, next)?;
        Ok(receipt)
    }

    fn import(
        &self,
        unlocked: &mut Unlocked,
        input: ImportCredentials,
    ) -> Result<Value, SecretError> {
        validate_operation(&input.operation_id)?;
        let digest = digest(&input)?;
        if let Some(receipt) = replay(&unlocked.snapshot, &input.operation_id, &digest)? {
            return Ok(receipt);
        }
        let candidates = input.sources.extract()?;
        let (conflicts, _) = migration::preview(&unlocked.snapshot, &candidates);
        if !conflicts.is_empty() {
            return Err(SecretError::Conflict);
        }
        let mut next = unlocked.snapshot.clone();
        let skipped = candidates.skipped;
        let mut mappings = Vec::new();
        for (binding, secret) in candidates.items {
            let record = StoredCredential {
                credential_ref: new_reference()?,
                revision: 1,
                binding,
                revoked: false,
                secret,
            };
            mappings.push(record.public());
            next.credentials.push(record);
        }
        let receipt = json!({"operation_id":input.operation_id,"status":"staged","mappings":mappings,"skipped_empty_keys":skipped,
            "source_unchanged":true,"runtime_enabled":false,"connection_verified":false});
        next.operations.insert(
            input.operation_id,
            OperationRecord {
                digest,
                receipt: receipt.clone(),
            },
        );
        self.commit(unlocked, next)?;
        Ok(receipt)
    }
}

fn expire(inner: &mut Inner) {
    if inner
        .unlocked
        .as_ref()
        .is_some_and(|u| u.last_activity.elapsed() >= Duration::from_secs(IDLE_LOCK_SECONDS))
    {
        inner.unlocked = None;
    }
}
fn validate_operation(value: &str) -> Result<(), SecretError> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_.:".contains(&b))
    {
        return Err(SecretError::InvalidInput);
    }
    Ok(())
}
fn validate_passphrase(value: &SecretText) -> Result<(), SecretError> {
    if value.0.chars().count() < 12
        || value.bytes().len() > 1024
        || value.0.chars().any(char::is_control)
    {
        return Err(SecretError::InvalidInput);
    }
    Ok(())
}
fn validate_secret(value: &SecretText) -> Result<(), SecretError> {
    if value.bytes().is_empty()
        || value.bytes().len() > MAX_SECRET_BYTES
        || value.0.chars().any(char::is_control)
    {
        return Err(SecretError::InvalidInput);
    }
    Ok(())
}
fn validate_snapshot(snapshot: &Snapshot) -> Result<(), SecretError> {
    if snapshot.credentials.len() > MAX_CREDENTIALS || snapshot.operations.len() > MAX_OPERATIONS {
        return Err(SecretError::Capacity);
    }
    let mut seen = std::collections::BTreeSet::new();
    for r in &snapshot.credentials {
        r.binding.validate()?;
        if r.revision == 0 || !seen.insert(&r.binding) {
            return Err(SecretError::InvalidFormat);
        }
        if !r.revoked {
            validate_secret(&r.secret)?;
        }
    }
    Ok(())
}
fn random(bytes: &mut [u8]) -> Result<(), SecretError> {
    getrandom::fill(bytes).map_err(|_| SecretError::Unavailable)
}
fn new_reference() -> Result<String, SecretError> {
    let mut bytes = [0u8; 16];
    random(&mut bytes)?;
    Ok(format!(
        "cr_{}",
        bytes.iter().map(|b| format!("{b:02x}")).collect::<String>()
    ))
}
fn derive(passphrase: &SecretText, salt: &[u8; 16]) -> Result<Zeroizing<[u8; 32]>, SecretError> {
    let params = Params::new(65536, 3, 1, Some(32)).map_err(|_| SecretError::Unavailable)?;
    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut key = Zeroizing::new([0u8; 32]);
    argon
        .hash_password_into(passphrase.bytes(), salt, &mut *key)
        .map_err(|_| SecretError::Unavailable)?;
    Ok(key)
}
fn aad(workspace: &str, salt: &[u8; 16]) -> Result<Vec<u8>, SecretError> {
    serde_json::to_vec(&(DOMAIN, workspace, salt)).map_err(|_| SecretError::Unavailable)
}
fn seal(
    workspace: &str,
    salt: &[u8; 16],
    key: &[u8; 32],
    snapshot: &Snapshot,
) -> Result<Vec<u8>, SecretError> {
    let plaintext =
        Zeroizing::new(serde_json::to_vec(snapshot).map_err(|_| SecretError::Unavailable)?);
    if plaintext.len() > MAX_PAYLOAD_BYTES {
        return Err(SecretError::Capacity);
    }
    let mut nonce = [0u8; 24];
    random(&mut nonce)?;
    let cipher = XChaCha20Poly1305::new_from_slice(key).map_err(|_| SecretError::Unavailable)?;
    let ciphertext = cipher
        .encrypt(
            &XNonce::from(nonce),
            Payload {
                msg: &plaintext,
                aad: &aad(workspace, salt)?,
            },
        )
        .map_err(|_| SecretError::Unavailable)?;
    serde_json::to_vec(&Envelope {
        format: DOMAIN.into(),
        workspace_id: workspace.into(),
        salt: *salt,
        nonce,
        ciphertext: STANDARD.encode(ciphertext),
    })
    .map_err(|_| SecretError::Unavailable)
}
fn parse_envelope(bytes: &[u8], workspace: &str) -> Result<Envelope, SecretError> {
    let envelope: Envelope =
        serde_json::from_slice(bytes).map_err(|_| SecretError::InvalidFormat)?;
    if envelope.format != DOMAIN
        || envelope.workspace_id != workspace
        || envelope.ciphertext.len() > (MAX_PAYLOAD_BYTES + 16).div_ceil(3) * 4
    {
        return Err(SecretError::InvalidFormat);
    }
    Ok(envelope)
}
fn unseal(envelope: &Envelope, key: &[u8; 32]) -> Result<Snapshot, SecretError> {
    let cipher = XChaCha20Poly1305::new_from_slice(key).map_err(|_| SecretError::Unavailable)?;
    let bytes = STANDARD
        .decode(&envelope.ciphertext)
        .map_err(|_| SecretError::UnlockFailed)?;
    let plaintext = Zeroizing::new(
        cipher
            .decrypt(
                &XNonce::from(envelope.nonce),
                Payload {
                    msg: &bytes,
                    aad: &aad(&envelope.workspace_id, &envelope.salt)?,
                },
            )
            .map_err(|_| SecretError::UnlockFailed)?,
    );
    serde_json::from_slice(&plaintext).map_err(|_| SecretError::UnlockFailed)
}
fn digest(input: &impl Serialize) -> Result<String, SecretError> {
    let bytes = Zeroizing::new(serde_json::to_vec(input).map_err(|_| SecretError::InvalidInput)?);
    Ok(format!("{:x}", Sha256::digest(&*bytes)))
}
fn replay(snapshot: &Snapshot, id: &str, digest: &str) -> Result<Option<Value>, SecretError> {
    if let Some(record) = snapshot.operations.get(id) {
        if record.digest != digest {
            return Err(SecretError::Conflict);
        }
        return Ok(Some(record.receipt.clone()));
    }
    Ok(None)
}

/// Best-effort scrubbing of JSON request buffers; not protection from swap,
/// core dumps, browser memory, arbitrary parser copies or a compromised OS.
pub fn wipe_json(value: &mut Value) {
    match value {
        Value::String(s) => s.zeroize(),
        Value::Array(v) => v.iter_mut().for_each(wipe_json),
        Value::Object(v) => v.values_mut().for_each(wipe_json),
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::{ManagedReadOperation, ManagedReadVault};
    use std::os::unix::fs::{symlink, PermissionsExt};

    const PASSPHRASE: &str = "synthetic-strong-store-passphrase";
    const SECRET: &str = "SYNTHETIC_PROVIDER_SECRET_DO_NOT_USE";

    fn owner() -> ReadAuthority {
        ReadAuthority::new("local:test", "w1", 1, "secret-test")
    }
    fn prepare() -> (tempfile::TempDir, ManagedReadVault, std::path::PathBuf) {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        std::fs::create_dir_all(home.join("documents")).unwrap();
        let private = temp.path().join("private-store");
        std::fs::create_dir(&private).unwrap();
        std::fs::set_permissions(&private, std::fs::Permissions::from_mode(0o700)).unwrap();
        let vault =
            ManagedReadVault::open(&home, "w1", "local:test", &["documents".into()]).unwrap();
        (temp, vault, private)
    }
    fn init(store: &SecretStore) -> Value {
        store
            .execute(
                &owner(),
                SecretOperation::Initialize(InitializeStore {
                    operation_id: "init-1".into(),
                    passphrase: SecretText::new(PASSPHRASE.into()),
                }),
            )
            .unwrap()
    }
    fn put(id: &str, revision: u64, secret: &str) -> SecretOperation {
        SecretOperation::Put(PutCredential {
            operation_id: id.into(),
            binding: CredentialBinding {
                kind: CredentialKind::Provider,
                account_id: "demo".into(),
                field: CredentialField::ApiKey,
            },
            expected_revision: revision,
            secret: SecretText::new(secret.into()),
        })
    }
    fn sources() -> LegacySources {
        let value: Value = serde_json::from_str(include_str!(
            "../../docs/agentos-v2/fixtures/legacy-credentials.example.json"
        ))
        .unwrap();
        serde_json::from_value(
            json!({"settings":value["settings"],"mail":value["mail"],"calendar":value["calendar"]}),
        )
        .unwrap()
    }
    fn assert_scrubbed(value: &str) {
        assert!(!value.contains(PASSPHRASE));
        assert!(!value.contains(SECRET));
        for s in [
            "DEMO_ONLY_NOT_A_VALID_PROVIDER_KEY",
            "DEMO_ONLY_NOT_A_VALID_MAIL_PASSWORD",
            "DEMO_ONLY_NOT_A_VALID_CALENDAR_PASSWORD",
            "DEMO_ONLY_NOT_A_VALID_CALENDAR_TOKEN",
        ] {
            assert!(!value.contains(s));
        }
    }

    #[test]
    fn encrypted_at_rest_redacted_api_and_no_plaintext_or_key_file() {
        let (_temp, vault, private) = prepare();
        let store = SecretStore::new(vault.open_secret_files(&private).unwrap(), "w1".into());
        init(&store);
        let result = store.execute(&owner(), put("put-1", 0, SECRET)).unwrap();
        assert_scrubbed(&result.to_string());
        let listing = store.execute(&owner(), SecretOperation::List).unwrap();
        assert_eq!(listing["credentials"].as_array().unwrap().len(), 1);
        assert_eq!(listing["credentials"][0]["runtime_enabled"], false);
        assert_scrubbed(&listing.to_string());
        for entry in std::fs::read_dir(&private).unwrap() {
            let entry = entry.unwrap();
            let bytes = std::fs::read(entry.path()).unwrap();
            assert_scrubbed(&String::from_utf8_lossy(&bytes));
            assert!(!entry.file_name().to_string_lossy().contains("key"));
        }
        assert!(vault
            .execute(
                &owner(),
                ManagedReadOperation::Read {
                    path: "../private-store/credentials.enc".into()
                }
            )
            .is_err());
        assert_eq!(
            format!("{:?}", SecretText::new(SECRET.into())),
            "[REDACTED]"
        );
    }

    #[test]
    fn lock_restart_wrong_passphrase_and_authenticated_tamper() {
        let (_temp, vault, private) = prepare();
        let store = SecretStore::new(vault.open_secret_files(&private).unwrap(), "w1".into());
        init(&store);
        store.execute(&owner(), put("put-1", 0, SECRET)).unwrap();
        drop(store);
        let store = SecretStore::new(vault.open_secret_files(&private).unwrap(), "w1".into());
        assert!(matches!(
            store.execute(&owner(), SecretOperation::List),
            Err(SecretError::Locked)
        ));
        assert!(matches!(
            store.execute(
                &owner(),
                SecretOperation::Unlock(SecretText::new("incorrect-synthetic-password".into()))
            ),
            Err(SecretError::UnlockFailed)
        ));
        assert!(matches!(
            store.execute(
                &owner(),
                SecretOperation::Unlock(SecretText::new(PASSPHRASE.into()))
            ),
            Err(SecretError::Cooldown)
        ));
        store.inner.lock().unwrap().retry_after = None;
        store
            .execute(
                &owner(),
                SecretOperation::Unlock(SecretText::new(PASSPHRASE.into())),
            )
            .unwrap();
        assert_eq!(
            store.execute(&owner(), SecretOperation::List).unwrap()["credentials"][0]["revision"],
            1
        );
        store.execute(&owner(), SecretOperation::Lock).unwrap();
        let path = private.join("credentials.enc");
        let mut envelope: Envelope =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        let mut bytes = STANDARD.decode(&envelope.ciphertext).unwrap();
        bytes[0] ^= 1;
        envelope.ciphertext = STANDARD.encode(bytes);
        std::fs::write(&path, serde_json::to_vec(&envelope).unwrap()).unwrap();
        assert!(matches!(
            store.execute(
                &owner(),
                SecretOperation::Unlock(SecretText::new(PASSPHRASE.into()))
            ),
            Err(SecretError::UnlockFailed)
        ));
        assert!(matches!(
            store.execute(
                &owner(),
                SecretOperation::Initialize(InitializeStore {
                    operation_id: "init-2".into(),
                    passphrase: SecretText::new(PASSPHRASE.into())
                })
            ),
            Err(SecretError::AlreadyInitialized)
        ));
    }

    #[test]
    fn idempotency_revision_rotation_revoke_and_durable_receipt() {
        let (_temp, vault, private) = prepare();
        let store = SecretStore::new(vault.open_secret_files(&private).unwrap(), "w1".into());
        init(&store);
        let first = store.execute(&owner(), put("op-1", 0, SECRET)).unwrap();
        assert_eq!(
            store.execute(&owner(), put("op-1", 0, SECRET)).unwrap(),
            first
        );
        assert!(matches!(
            store.execute(&owner(), put("op-1", 0, "different-synthetic-secret")),
            Err(SecretError::Conflict)
        ));
        assert!(matches!(
            store.execute(&owner(), put("op-2", 0, SECRET)),
            Err(SecretError::Conflict)
        ));
        let rotated = store
            .execute(&owner(), put("op-2", 1, "ROTATED_SYNTHETIC_SECRET"))
            .unwrap();
        assert_eq!(rotated["credential"]["revision"], 2);
        assert_eq!(
            rotated["credential"]["credential_ref"],
            first["credential"]["credential_ref"]
        );
        let input:RevokeCredential = serde_json::from_value(json!({"operation_id":"revoke-1","credential_ref":first["credential"]["credential_ref"],"expected_revision":2})).unwrap();
        let revoked = store
            .execute(&owner(), SecretOperation::Revoke(input))
            .unwrap();
        assert_eq!(revoked["credential"]["state"], "revoked");
        drop(store);
        let store = SecretStore::new(vault.open_secret_files(&private).unwrap(), "w1".into());
        store
            .execute(
                &owner(),
                SecretOperation::Unlock(SecretText::new(PASSPHRASE.into())),
            )
            .unwrap();
        assert_eq!(
            store
                .execute(&owner(), SecretOperation::Receipt("revoke-1".into()))
                .unwrap(),
            revoked
        );
        assert!(store
            .inner
            .lock()
            .unwrap()
            .unlocked
            .as_ref()
            .unwrap()
            .snapshot
            .credentials[0]
            .secret
            .bytes()
            .is_empty());
    }

    #[test]
    fn import_fixture_is_atomic_idempotent_staged_only_and_redacted() {
        let (_temp, vault, private) = prepare();
        let store = SecretStore::new(vault.open_secret_files(&private).unwrap(), "w1".into());
        init(&store);
        let preview = store
            .execute(&owner(), SecretOperation::ImportPreview(sources()))
            .unwrap();
        assert_eq!(preview["bindings"].as_array().unwrap().len(), 4);
        assert_eq!(preview["skipped_empty_keys"], 1);
        assert_scrubbed(&preview.to_string());
        assert_eq!(
            store.execute(&owner(), SecretOperation::List).unwrap()["credentials"]
                .as_array()
                .unwrap()
                .len(),
            0
        );
        let result = store
            .execute(
                &owner(),
                SecretOperation::ImportApply(ImportCredentials {
                    operation_id: "import-1".into(),
                    sources: sources(),
                }),
            )
            .unwrap();
        assert_eq!(result["status"], "staged");
        assert_eq!(result["source_unchanged"], true);
        assert_eq!(result["connection_verified"], false);
        assert_scrubbed(&result.to_string());
        assert_eq!(
            store
                .execute(
                    &owner(),
                    SecretOperation::ImportApply(ImportCredentials {
                        operation_id: "import-1".into(),
                        sources: sources()
                    })
                )
                .unwrap(),
            result
        );
        assert!(matches!(
            store.execute(
                &owner(),
                SecretOperation::ImportApply(ImportCredentials {
                    operation_id: "import-2".into(),
                    sources: sources()
                })
            ),
            Err(SecretError::Conflict)
        ));
        assert_eq!(
            store.execute(&owner(), SecretOperation::List).unwrap()["credentials"]
                .as_array()
                .unwrap()
                .len(),
            4
        );
    }

    #[test]
    fn import_rejects_duplicate_or_invalid_source_before_any_commit() {
        let (_temp, vault, private) = prepare();
        let store = SecretStore::new(vault.open_secret_files(&private).unwrap(), "w1".into());
        init(&store);
        let bad:LegacySources = serde_json::from_value(json!({"settings":{"providers":{"bad":{"kind":"openai-compatible","model":"m","api_key":SECRET,"base_url":"https://username:password@example.invalid/v1"}}}})).unwrap();
        assert!(matches!(
            store.execute(
                &owner(),
                SecretOperation::ImportApply(ImportCredentials {
                    operation_id: "bad-import".into(),
                    sources: bad
                })
            ),
            Err(SecretError::InvalidInput)
        ));
        let account = json!({"name":"duplicate","host":"imap.example.invalid","user":"demo@example.invalid","password":SECRET});
        let bad: LegacySources =
            serde_json::from_value(json!({"mail":{"accounts":[account.clone(),account]}})).unwrap();
        assert!(matches!(
            store.execute(
                &owner(),
                SecretOperation::ImportApply(ImportCredentials {
                    operation_id: "bad-import-2".into(),
                    sources: bad
                })
            ),
            Err(SecretError::InvalidInput)
        ));
        assert_eq!(
            store.execute(&owner(), SecretOperation::List).unwrap()["credentials"]
                .as_array()
                .unwrap()
                .len(),
            0
        );
    }

    #[test]
    fn uncertain_commit_locks_then_reconciles_original_operation_after_restart() {
        let (_temp, vault, private) = prepare();
        let store = SecretStore::new(vault.open_secret_files(&private).unwrap(), "w1".into());
        init(&store);
        store.files.inject_save_fault(2);
        assert!(matches!(
            store.execute(&owner(), put("uncertain-1", 0, SECRET)),
            Err(SecretError::CommitUnknown)
        ));
        assert!(store.inner.lock().unwrap().unlocked.is_none());
        drop(store);
        let store = SecretStore::new(vault.open_secret_files(&private).unwrap(), "w1".into());
        store
            .execute(
                &owner(),
                SecretOperation::Unlock(SecretText::new(PASSPHRASE.into())),
            )
            .unwrap();
        let receipt = store
            .execute(&owner(), SecretOperation::Receipt("uncertain-1".into()))
            .unwrap();
        assert_eq!(receipt["status"], "stored");
        assert_eq!(
            store
                .execute(&owner(), put("uncertain-1", 0, SECRET))
                .unwrap(),
            receipt
        );
        assert_eq!(
            store.execute(&owner(), SecretOperation::List).unwrap()["credentials"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn failed_staging_keeps_old_snapshot_and_never_claims_success() {
        let (_temp, vault, private) = prepare();
        let store = SecretStore::new(vault.open_secret_files(&private).unwrap(), "w1".into());
        init(&store);
        let original = std::fs::read(private.join("credentials.enc")).unwrap();
        store.files.inject_save_fault(1);
        assert!(matches!(
            store.execute(&owner(), put("failed-1", 0, SECRET)),
            Err(SecretError::Unavailable)
        ));
        assert_eq!(
            std::fs::read(private.join("credentials.enc")).unwrap(),
            original
        );
        assert!(store.inner.lock().unwrap().unlocked.is_none());
        drop(store);
        let store = SecretStore::new(vault.open_secret_files(&private).unwrap(), "w1".into());
        store
            .execute(
                &owner(),
                SecretOperation::Unlock(SecretText::new(PASSPHRASE.into())),
            )
            .unwrap();
        assert!(matches!(
            store.execute(&owner(), SecretOperation::Receipt("failed-1".into())),
            Err(SecretError::Conflict)
        ));
        for entry in std::fs::read_dir(&private).unwrap() {
            assert_scrubbed(&String::from_utf8_lossy(
                &std::fs::read(entry.unwrap().path()).unwrap(),
            ));
        }
    }

    #[test]
    fn idle_lock_and_wrong_workspace_do_not_release_credentials() {
        let (_temp, vault, private) = prepare();
        let store = SecretStore::new(vault.open_secret_files(&private).unwrap(), "w1".into());
        init(&store);
        let forged = ReadAuthority::new("local:test", "other", 1, "forged");
        assert!(matches!(
            store.execute(&forged, SecretOperation::List),
            Err(SecretError::Forbidden)
        ));
        assert!(store.inner.lock().unwrap().unlocked.is_none());
        store
            .execute(
                &owner(),
                SecretOperation::Unlock(SecretText::new(PASSPHRASE.into())),
            )
            .unwrap();
        store
            .inner
            .lock()
            .unwrap()
            .unlocked
            .as_mut()
            .unwrap()
            .last_activity = Instant::now() - Duration::from_secs(IDLE_LOCK_SECONDS + 1);
        store.expire_idle();
        assert!(matches!(
            store.execute(&owner(), SecretOperation::List),
            Err(SecretError::Locked)
        ));
    }

    #[test]
    fn secret_directory_permissions_aliases_and_exclusive_owner_lock() {
        let (temp, vault, private) = prepare();
        std::fs::set_permissions(&private, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(vault.open_secret_files(&private).is_err());
        std::fs::set_permissions(&private, std::fs::Permissions::from_mode(0o700)).unwrap();
        let alias = temp.path().join("alias");
        symlink(&private, &alias).unwrap();
        assert!(vault.open_secret_files(&alias).is_err());
        let inside = temp.path().join("home/private-store");
        std::fs::create_dir(&inside).unwrap();
        std::fs::set_permissions(&inside, std::fs::Permissions::from_mode(0o700)).unwrap();
        assert!(vault.open_secret_files(&inside).is_err());
        let files = vault.open_secret_files(&private).unwrap();
        assert!(matches!(
            vault.open_secret_files(&private),
            Err(SecretFileError::Busy)
        ));
        drop(files);
        let victim = temp.path().join("victim");
        std::fs::write(&victim, "not modified").unwrap();
        symlink(&victim, private.join("credentials.enc")).unwrap();
        let store = SecretStore::new(vault.open_secret_files(&private).unwrap(), "w1".into());
        assert!(store.execute(&owner(), SecretOperation::Status).is_err());
        assert_eq!(std::fs::read_to_string(victim).unwrap(), "not modified");
    }

    #[test]
    fn audit_failure_before_or_after_commit_never_returns_success() {
        for after in [1, 2] {
            let (_temp, vault, private) = prepare();
            let store = SecretStore::new(vault.open_secret_files(&private).unwrap(), "w1".into());
            init(&store);
            store.files.inject_audit_failure(after);
            assert!(matches!(
                store.execute(&owner(), put("audit-failed-1", 0, SECRET)),
                Err(SecretError::AuditUnavailable)
            ));
            assert!(store.inner.lock().unwrap().unlocked.is_none());
            assert!(matches!(
                store.execute(
                    &owner(),
                    SecretOperation::Unlock(SecretText::new(PASSPHRASE.into()))
                ),
                Err(SecretError::AuditUnavailable)
            ));
            drop(store);
            let store = SecretStore::new(vault.open_secret_files(&private).unwrap(), "w1".into());
            store
                .execute(
                    &owner(),
                    SecretOperation::Unlock(SecretText::new(PASSPHRASE.into())),
                )
                .unwrap();
            let result = store.execute(&owner(), SecretOperation::Receipt("audit-failed-1".into()));
            if after == 1 {
                assert!(matches!(result, Err(SecretError::Conflict)));
            } else {
                assert_eq!(result.unwrap()["status"], "stored");
            }
        }
    }

    #[test]
    fn encrypted_file_hardlink_and_public_permissions_are_rejected() {
        let (temp, vault, private) = prepare();
        let store = SecretStore::new(vault.open_secret_files(&private).unwrap(), "w1".into());
        let target = private.join("credentials.enc");
        std::fs::write(&target, "opaque-not-plaintext").unwrap();
        std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(matches!(
            store.execute(&owner(), SecretOperation::Status),
            Err(SecretError::Forbidden)
        ));
        std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o600)).unwrap();
        std::fs::hard_link(&target, temp.path().join("alias.enc")).unwrap();
        assert!(matches!(
            store.execute(&owner(), SecretOperation::Status),
            Err(SecretError::Forbidden)
        ));
    }

    #[test]
    fn concurrent_replay_commits_one_revision_and_one_receipt() {
        let (_temp, vault, private) = prepare();
        let store = std::sync::Arc::new(SecretStore::new(
            vault.open_secret_files(&private).unwrap(),
            "w1".into(),
        ));
        init(&store);
        let threads: Vec<_> = (0..4)
            .map(|_| {
                let store = store.clone();
                std::thread::spawn(move || {
                    store
                        .execute(&owner(), put("parallel-1", 0, SECRET))
                        .unwrap()
                })
            })
            .collect();
        let receipts: Vec<_> = threads.into_iter().map(|t| t.join().unwrap()).collect();
        assert!(receipts.iter().all(|r| r == &receipts[0]));
        let credentials = store.execute(&owner(), SecretOperation::List).unwrap();
        assert_eq!(credentials["credentials"].as_array().unwrap().len(), 1);
        assert_eq!(credentials["credentials"][0]["revision"], 1);
    }

    #[test]
    fn mixed_import_conflict_never_partially_adds_new_bindings() {
        let (_temp, vault, private) = prepare();
        let store = SecretStore::new(vault.open_secret_files(&private).unwrap(), "w1".into());
        init(&store);
        let existing: PutCredential = serde_json::from_value(json!({
            "operation_id":"existing-1", "binding":{"kind":"provider","account_id":"DemoCloud","field":"api_key"},
            "expected_revision":0, "secret":SECRET,
        })).unwrap();
        store
            .execute(&owner(), SecretOperation::Put(existing))
            .unwrap();
        let before = std::fs::read(private.join("credentials.enc")).unwrap();
        let preview = store
            .execute(&owner(), SecretOperation::ImportPreview(sources()))
            .unwrap();
        assert_eq!(preview["conflicts"].as_array().unwrap().len(), 1);
        assert!(matches!(
            store.execute(
                &owner(),
                SecretOperation::ImportApply(ImportCredentials {
                    operation_id: "mixed-import-1".into(),
                    sources: sources(),
                })
            ),
            Err(SecretError::Conflict)
        ));
        assert_eq!(
            std::fs::read(private.join("credentials.enc")).unwrap(),
            before
        );
        assert_eq!(
            store.execute(&owner(), SecretOperation::List).unwrap()["credentials"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert!(matches!(
            store.execute(&owner(), SecretOperation::Receipt("mixed-import-1".into())),
            Err(SecretError::Conflict)
        ));
    }

    #[test]
    fn payload_is_bound_to_workspace_and_cipher_nonce_changes_on_write() {
        let (_temp, vault, private) = prepare();
        let store = SecretStore::new(vault.open_secret_files(&private).unwrap(), "w1".into());
        init(&store);
        let before: Envelope =
            serde_json::from_slice(&std::fs::read(private.join("credentials.enc")).unwrap())
                .unwrap();
        store.execute(&owner(), put("put-1", 0, SECRET)).unwrap();
        let after: Envelope =
            serde_json::from_slice(&std::fs::read(private.join("credentials.enc")).unwrap())
                .unwrap();
        assert_ne!(before.nonce, after.nonce);
        assert_eq!(before.salt, after.salt);
        assert!(parse_envelope(
            &std::fs::read(private.join("credentials.enc")).unwrap(),
            "other-space"
        )
        .is_err());
        let mut forged = after;
        forged.workspace_id = "other-space".into();
        let guard = store.inner.lock().unwrap();
        let key = &guard.unlocked.as_ref().unwrap().key;
        assert!(unseal(&forged, key).is_err());
    }
}
