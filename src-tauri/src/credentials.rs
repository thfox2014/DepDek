//! Encrypted credential storage (contract sections 7 and 9).
//!
//! `CredentialStore` owns the loopback master key (`secrets/master.key`,
//! 32 random bytes, chmod 600 on Unix) and stores per-scope ciphertext blobs
//! in `secrets/<scope>.enc.json`:
//!
//! ```json
//! { "version": 1, "entries": { "<key>": "base64(nonce || ciphertext || tag)" } }
//! ```
//!
//! The cipher is AES-256-GCM with a 12-byte random nonce; the output format
//! is `base64(nonce || ciphertext || tag)` so both this Rust module and the
//! Node sidecar (`sidecar/src/credentials.ts`) can interoperate. Keys never
//! leave the local data folder, and the whole `secrets/` tree is hidden from
//! agent sessions by `vault.rs` (`is_protected_path`).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use aes_gcm::aead::{Aead, KeyInit, OsRng};
use aes_gcm::{Aes256Gcm, Nonce};
use rand::RngCore;
use serde::{Deserialize, Serialize};

/// Relative path of the master key inside the vault root.
pub const MASTER_KEY_REL: &str = "secrets/master.key";
pub const MASTER_KEY_BYTES: usize = 32;
pub const ENC_NONCE_BYTES: usize = 12;
pub const SECRET_REF_PREFIX: &str = "$secret:";

#[derive(Debug, thiserror::Error)]
pub enum CredentialError {
    #[error("secret store io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("master key has wrong length")]
    BadKeyLen,
    #[error("ciphertext blob is malformed")]
    MalformedBlob,
    #[error("decryption failed (wrong key or corrupted blob)")]
    Decrypt,
    #[error("invalid base64 in blob: {0}")]
    B64(#[from] base64::DecodeError),
    #[error("invalid scope: {0} (plain file name required)")]
    InvalidScope(String),
    #[error("invalid secret reference: {0}")]
    InvalidRef(String),
}

fn blob_file(secrets_dir: &Path, scope: &str) -> Result<PathBuf, CredentialError> {
    let scope = scope.trim();
    if scope.is_empty()
        || scope == "."
        || scope == ".."
        || scope.contains('.')
        || scope.contains('/')
        || scope.contains('\\')
        || scope.contains('\0')
    {
        return Err(CredentialError::InvalidScope(scope.to_string()));
    }
    Ok(secrets_dir.join(format!("{scope}.enc.json")))
}

/// `$secret:<scope>.<key>` inline reference used wherever a plaintext
/// credential used to live (settings/api_key, mail accounts, calendar).
pub fn secret_ref(scope: &str, key: &str) -> String {
    format!("{SECRET_REF_PREFIX}{scope}.{key}")
}

pub fn is_secret_ref(value: &str) -> bool {
    value.starts_with(SECRET_REF_PREFIX)
}

/// Split a `$secret:` reference into its `(scope, key)` parts.
pub fn parse_secret_ref(value: &str) -> Option<(String, String)> {
    let rest = value.strip_prefix(SECRET_REF_PREFIX)?;
    let dot = rest.find('.')?;
    let (scope, key) = rest.split_at(dot);
    if scope.is_empty() || key.is_empty() {
        return None;
    }
    Some((scope.to_string(), key[1..].to_string()))
}

/// Encrypted credential store rooted at `<vault>/secrets`.
pub struct CredentialStore {
    secrets_dir: PathBuf,
    key: [u8; MASTER_KEY_BYTES],
}

#[derive(Serialize, Deserialize)]
struct BlobFile {
    version: u32,
    #[serde(default)]
    entries: BTreeMap<String, String>,
}

impl CredentialStore {
    /// Load or lazily create the master key under `root`, then return a store
    /// that keeps the key in memory only.
    pub fn open(root: &Path) -> Result<Self, CredentialError> {
        let secrets_dir = root.join("secrets");
        std::fs::create_dir_all(&secrets_dir)?;
        let key_path = secrets_dir.join("master.key");
        let key = if key_path.is_file() {
            let bytes = std::fs::read(&key_path)?;
            let arr: [u8; MASTER_KEY_BYTES] = bytes
                .try_into()
                .map_err(|_| CredentialError::BadKeyLen)?;
            arr
        } else {
            let mut key = [0u8; MASTER_KEY_BYTES];
            OsRng.fill_bytes(&mut key);
            write_keyfile(&key_path, &key)?;
            key
        };
        Ok(Self { secrets_dir, key })
    }

    /// Whether a master key file already exists (used by migration guards).
    pub fn has_key(root: &Path) -> bool {
        root.join(MASTER_KEY_REL).is_file()
    }

    fn cipher(&self) -> Aes256Gcm {
        Aes256Gcm::new_from_slice(&self.key).expect("32-byte key is valid")
    }

    /// Encrypt `plain` to `base64(nonce || ciphertext || tag)`.
    pub fn encrypt(&self, plain: &str) -> Result<String, CredentialError> {
        let cipher = self.cipher();
        let mut nonce_bytes = [0u8; ENC_NONCE_BYTES];
        OsRng.fill_bytes(&mut nonce_bytes);
        let nonce = Nonce::from_slice(&nonce_bytes);
        let ciphertext = cipher
            .encrypt(nonce, plain.as_bytes())
            .map_err(|_| CredentialError::Decrypt)?;
        let mut out = Vec::with_capacity(nonce_bytes.len() + ciphertext.len());
        out.extend_from_slice(&nonce_bytes);
        out.extend_from_slice(&ciphertext);
        Ok(base64_encode(&out))
    }

    /// Decrypt a blob produced by `encrypt` (or the Node sidecar).
    pub fn decrypt(&self, blob: &str) -> Result<String, CredentialError> {
        let raw = base64_decode(blob)?;
        if raw.len() <= ENC_NONCE_BYTES {
            return Err(CredentialError::MalformedBlob);
        }
        let (nonce_bytes, ciphertext) = raw.split_at(ENC_NONCE_BYTES);
        let cipher = self.cipher();
        let plain = cipher
            .decrypt(Nonce::from_slice(nonce_bytes), ciphertext)
            .map_err(|_| CredentialError::Decrypt)?;
        String::from_utf8(plain)
            .map_err(|_| CredentialError::MalformedBlob)
    }

    /// Encrypt and store `value` under `scope.key`, creating/updating
    /// `secrets/<scope>.enc.json` atomically (temp file + rename).
    pub fn set_entry(
        &self,
        scope: &str,
        key: &str,
        value: &str,
    ) -> Result<(), CredentialError> {
        let mut blob = self.load_blob(scope)?;
        blob.entries.insert(key.to_string(), self.encrypt(value)?);
        self.store_blob(scope, &blob)
    }

    /// Read and decrypt `scope.key`, or `None` when absent.
    pub fn get_entry(&self, scope: &str, key: &str) -> Result<Option<String>, CredentialError> {
        let blob = self.load_blob(scope)?;
        blob.entries
            .get(key)
            .map(|enc| self.decrypt(enc))
            .transpose()
    }

    /// Remove `scope.key` (persisting the file even when it becomes empty).
    pub fn delete_entry(&self, scope: &str, key: &str) -> Result<(), CredentialError> {
        let mut blob = self.load_blob(scope)?;
        if blob.entries.remove(key).is_some() {
            self.store_blob(scope, &blob)?;
        }
        Ok(())
    }

    pub fn has_entry(&self, scope: &str, key: &str) -> Result<bool, CredentialError> {
        Ok(self.load_blob(scope)?.entries.contains_key(key))
    }

    fn load_blob(&self, scope: &str) -> Result<BlobFile, CredentialError> {
        let path = blob_file(&self.secrets_dir, scope)?;
        if !path.is_file() {
            return Ok(BlobFile { version: 1, entries: BTreeMap::new() });
        }
        let text = std::fs::read_to_string(&path)?;
        let parsed: BlobFile =
            serde_json::from_str(&text).map_err(|_| CredentialError::MalformedBlob)?;
        Ok(parsed)
    }

    fn store_blob(&self, scope: &str, blob: &BlobFile) -> Result<(), CredentialError> {
        let path = blob_file(&self.secrets_dir, scope)?;
        let text = serde_json::to_string_pretty(blob)
            .map_err(|_| CredentialError::MalformedBlob)?;
        let tmp = path.with_extension("enc.json.tmp");
        std::fs::write(&tmp, format!("{text}\n"))?;
        // The blob may hold the only copy of ciphertext for a newly revealed
        // key; only publish it once the temp write has fully landed.
        std::fs::rename(&tmp, &path)?;
        set_private_mode(&path);
        Ok(())
    }
}

fn write_keyfile(path: &Path, key: &[u8]) -> Result<(), CredentialError> {
    std::fs::write(path, key)?;
    set_private_mode(path);
    Ok(())
}

#[cfg(unix)]
fn set_private_mode(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
}

#[cfg(not(unix))]
fn set_private_mode(_path: &Path) {}

fn base64_encode(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

fn base64_decode(text: &str) -> Result<Vec<u8>, base64::DecodeError> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.decode(text)
}

/// Decide what `api_key` should be stored for a provider update:
/// - empty / redacted placeholder keeps the legacy (or same) value, so the
///   settings UI round-trip can never wipe a key the user did not replace;
/// - an existing `$secret:` reference is kept as-is;
/// - a fresh plaintext key is encrypted and replaced by its reference.
pub fn migrate_provider_key(
    store: &CredentialStore,
    name: &str,
    api_key: &str,
    legacy: Option<&str>,
) -> Result<String, CredentialError> {
    if api_key.is_empty() || api_key == "********" {
        return Ok(legacy.unwrap_or(api_key).to_string());
    }
    if is_secret_ref(api_key) {
        return Ok(api_key.to_string());
    }
    let ref_key = format!("{name}.api_key");
    store.set_entry("providers", &ref_key, api_key)?;
    Ok(secret_ref("providers", &ref_key))
}

/// Resolve a stored provider key: decrypt `$secret:` references, keep any
/// plaintext value untouched. Used just before forwarding to the sidecar.
pub fn resolve_provider_key(
    store: &CredentialStore,
    api_key: &str,
) -> Result<String, CredentialError> {
    if is_secret_ref(api_key) {
        let (scope, key) = parse_secret_ref(api_key)
            .ok_or_else(|| CredentialError::InvalidRef(api_key.to_string()))?;
        store.get_entry(&scope, &key)?.ok_or_else(|| {
            CredentialError::InvalidRef(format!("missing secret for {api_key}"))
        })
    } else {
        Ok(api_key.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn store(dir: &tempfile::TempDir) -> CredentialStore {
        CredentialStore::open(dir.path()).unwrap()
    }

    #[test]
    fn encrypt_decrypt_roundtrip() {
        let dir = tempdir().unwrap();
        let s = store(&dir);
        let secret = "smtp-password-中文-🔐";
        let blob = s.encrypt(secret).unwrap();
        assert_ne!(blob, secret);
        assert_eq!(s.decrypt(&blob).unwrap(), secret);
    }

    #[test]
    fn unique_blobs_per_encryption() {
        let dir = tempdir().unwrap();
        let s = store(&dir);
        let a = s.encrypt("same").unwrap();
        let b = s.encrypt("same").unwrap();
        assert_ne!(a, b, "random nonce must produce unique ciphertext");
    }

    #[test]
    fn tampered_blob_is_rejected() {
        let dir = tempdir().unwrap();
        let s = store(&dir);
        let blob = s.encrypt("secret").unwrap();
        let bytes = base64_decode(&blob).unwrap();
        let mut tampered = bytes.clone();
        let last = tampered.len() - 1;
        tampered[last] ^= 0x01;
        assert!(tampered != bytes);
        match s.decrypt(&base64_encode(&tampered)) {
            Err(CredentialError::Decrypt) => {}
            other => panic!("expected Decrypt error, got {other:?}"),
        }
    }

    #[test]
    fn master_key_is_created_private_and_reused() {
        let dir = tempdir().unwrap();
        {
            let s = CredentialStore::open(dir.path()).unwrap();
            let blob = s.encrypt("persist-me").unwrap();
            let key_path = dir.path().join(MASTER_KEY_REL);
            assert!(key_path.is_file());
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let mode = std::fs::metadata(&key_path).unwrap().permissions().mode();
                assert_eq!(mode & 0o777, 0o600, "master key must be 0600");
            }
            // Key size is exactly 32 bytes.
            assert_eq!(std::fs::metadata(&key_path).unwrap().len(), 32);
            // A second store must reuse the same key file.
            let s2 = CredentialStore::open(dir.path()).unwrap();
            assert_eq!(s2.decrypt(&blob).unwrap(), "persist-me");
        }
    }

    #[test]
    fn entries_persist_across_reopen_and_delete() {
        let dir = tempdir().unwrap();
        {
            let s = store(&dir);
            s.set_entry("mail", "work.password", "hunter2").unwrap();
            s.set_entry("providers", "deepseek.api_key", "sk-123").unwrap();
            assert_eq!(s.get_entry("mail", "work.password").unwrap().as_deref(), Some("hunter2"));
        }
        {
            let s = store(&dir);
            assert_eq!(s.get_entry("mail", "work.password").unwrap().as_deref(), Some("hunter2"));
            assert_eq!(s.get_entry("providers", "deepseek.api_key").unwrap().as_deref(), Some("sk-123"));
            assert_eq!(s.get_entry("mail", "missing").unwrap(), None);
            s.delete_entry("mail", "work.password").unwrap();
            assert_eq!(s.get_entry("mail", "work.password").unwrap(), None);
        }
    }

    #[test]
    fn ciphertext_file_never_contains_plaintext() {
        let dir = tempdir().unwrap();
        let s = store(&dir);
        s.set_entry("mail", "a.password", "very-secret-password").unwrap();
        let text = std::fs::read_to_string(dir.path().join("secrets/mail.enc.json")).unwrap();
        assert!(!text.contains("very-secret-password"));
        assert!(text.contains("$secret") == false);
        assert!(text.contains("entries"));
    }

    #[test]
    fn invalid_scope_rejected() {
        let dir = tempdir().unwrap();
        let s = store(&dir);
        for scope in ["a/b", "../x", ".", "..", "", "a\\b", "a.b", "mail.work"] {
            assert!(s.set_entry(scope, "k", "v").is_err(), "scope {scope:?}");
        }
    }

    #[test]
    fn secret_ref_helpers() {
        assert_eq!(secret_ref("mail", "work.password"), "$secret:mail.work.password");
        assert!(is_secret_ref("$secret:mail.work.password"));
        assert!(!is_secret_ref("hunter2"));
        assert_eq!(
            parse_secret_ref("$secret:providers.deepseek.api_key"),
            Some(("providers".to_string(), "deepseek.api_key".to_string()))
        );
        assert_eq!(parse_secret_ref("plain"), None);
        assert_eq!(parse_secret_ref("$secret:"), None);
        assert_eq!(parse_secret_ref("$secret:.x"), None);
    }

    #[test]
    fn migrate_provider_key_encrypts_fresh_and_keeps_placeholders() {
        let dir = tempdir().unwrap();
        let s = store(&dir);

        // Empty/redacted placeholders keep the legacy value.
        assert_eq!(migrate_provider_key(&s, "p", "", Some("sk-legacy")).unwrap(), "sk-legacy");
        assert_eq!(migrate_provider_key(&s, "p", "********", Some("sk-legacy")).unwrap(), "sk-legacy");
        assert_eq!(migrate_provider_key(&s, "p", "", None).unwrap(), "");

        // An existing reference passes through untouched.
        let ref_val = "$secret:providers.p.api_key";
        assert_eq!(migrate_provider_key(&s, "p", ref_val, None).unwrap(), ref_val);

        // A fresh plaintext key is encrypted and replaced by its reference.
        let ref_out = migrate_provider_key(&s, "p", "sk-fresh", None).unwrap();
        assert_eq!(ref_out, "$secret:providers.p.api_key");
        assert_eq!(resolve_provider_key(&s, &ref_out).unwrap(), "sk-fresh");

        // Plaintext resolve is a no-op; missing secret fails.
        assert_eq!(resolve_provider_key(&s, "sk-visible").unwrap(), "sk-visible");
        assert!(resolve_provider_key(&s, "$secret:providers.missing.api_key").is_err());
    }
}