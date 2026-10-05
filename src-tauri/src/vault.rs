//! Vault service: sandboxed access to the user data folder.
//!
//! This is the single trust boundary of the app (contract sections 2.3, 5
//! and 6): path validation, size limits, UTF-8 enforcement and the audit
//! log all live here. Agents never touch the filesystem directly.

use std::ffi::OsString;
use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, RwLock};

use flate2::write::GzEncoder;
use flate2::Compression;
use serde::Serialize;
use sha2::{Digest, Sha256};
use tar::Builder as TarBuilder;
use thiserror::Error;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;

use crate::audit::{AuditEntry, AuditLog, Op, AUDIT_FILE_NAME};

/// Single-file read/write limit for text operations (contract section 6.3).
pub const MAX_FILE_SIZE: u64 = 10 * 1024 * 1024;
/// Single-file limit for binary read/write operations (contract section 6.3).
pub const MAX_BINARY_FILE_SIZE: u64 = 64 * 1024 * 1024;
/// Maximum matches returned by `search_files` (contract section 2.3).
pub const MAX_SEARCH_MATCHES: usize = 50;
/// Total uncompressed input cap for the built-in archive action.
pub const MAX_COMPRESS_BYTES: u64 = 512 * 1024 * 1024;
/// File count cap for the built-in archive action.
pub const MAX_COMPRESS_FILES: usize = 10_000;
/// Snippet length cap for search results.
const MAX_SNIPPET_CHARS: usize = 200;

#[derive(Debug, Error)]
pub enum VaultError {
    /// -32001: path escapes the vault root (also absolute/empty paths,
    /// escaping symlinks and any access to the audit log file).
    #[error("path escapes root: {0}")]
    Escape(String),
    /// -32002: path does not exist.
    #[error("path not found: {0}")]
    NotFound(String),
    /// -32003: over the single-file size limit.
    #[error("file exceeds the size limit")]
    TooLarge,
    /// -32004: vault root not set.
    #[error("vault root not set")]
    RootNotSet,
    /// -32005: not UTF-8 text.
    #[error("not a UTF-8 text file: {0}")]
    NotUtf8(String),
    /// -32602: invalid JSON-RPC params (standard JSON-RPC code).
    #[error("invalid params: {0}")]
    InvalidParams(String),
    /// -32601: unknown method.
    #[error("unknown method: {0}")]
    UnknownMethod(String),
    /// -32603: internal/IO error (standard JSON-RPC code).
    #[error("io error: {0}")]
    Io(#[from] io::Error),
}

impl VaultError {
    /// Error code defined in contract section 2.4.
    pub fn code(&self) -> i64 {
        match self {
            VaultError::Escape(_) => -32001,
            VaultError::NotFound(_) => -32002,
            VaultError::TooLarge => -32003,
            VaultError::RootNotSet => -32004,
            VaultError::NotUtf8(_) => -32005,
            VaultError::UnknownMethod(_) => -32601,
            VaultError::InvalidParams(_) => -32602,
            VaultError::Io(_) => -32603,
        }
    }

    /// Error string for Tauri commands, e.g. `E32001 path escapes root: ..`.
    pub fn to_command_string(&self) -> String {
        format!("E{:05} {}", self.code().abs(), self)
    }
}

#[derive(Debug, Serialize)]
pub struct ReadFileResult {
    pub content: String,
    pub size: u64,
    pub sha256: String,
}

#[derive(Debug, Serialize)]
pub struct ReadBinaryResult {
    pub data_base64: String,
    pub size: u64,
    pub sha256: String,
    pub mime: String,
}

/// Guess a MIME type from the file extension; unknown extensions map to
/// `application/octet-stream` (contract section 2.3).
pub fn mime_for_path(rel: &str) -> String {
    let ext = Path::new(rel)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "mp4" => "video/mp4",
        "mov" => "video/quicktime",
        "mkv" => "video/x-matroska",
        "webm" => "video/webm",
        "avi" => "video/x-msvideo",
        "m4v" => "video/x-m4v",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" => "audio/ogg",
        "flac" => "audio/flac",
        "pdf" => "application/pdf",
        "json" => "application/json",
        "txt" => "text/plain",
        _ => "application/octet-stream",
    }
    .to_string()
}

#[derive(Debug, Serialize)]
pub struct WriteFileResult {
    pub size: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum EntryKind {
    File,
    Dir,
}

#[derive(Debug, Serialize)]
pub struct DirEntryInfo {
    pub name: String,
    pub kind: EntryKind,
    pub size: u64,
}

#[derive(Debug, Serialize)]
pub struct ListDirResult {
    pub entries: Vec<DirEntryInfo>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SearchMatch {
    pub path: String,
    pub line: usize,
    pub snippet: String,
}

#[derive(Debug, Serialize)]
pub struct SearchResult {
    pub matches: Vec<SearchMatch>,
}

#[derive(Debug, Serialize)]
pub struct StatResult {
    pub kind: EntryKind,
    pub size: u64,
    pub modified_ms: u64,
}

#[derive(Debug, Serialize)]
pub struct CompressResult {
    pub source: String,
    pub archive: String,
    pub files: usize,
    pub bytes: u64,
    pub archive_size: u64,
}

/// Hex-encoded SHA-256 of `bytes`.
pub fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

/// Normalize a POSIX-style relative path per contract section 6:
/// reject absolute/empty paths, resolve `.`/`..` lexically, never let
/// `..` climb above the root, and reject the audit log file name outright.
/// Returns the normalized relative path (`""` means the root itself).
fn normalize(rel: &str) -> Result<String, VaultError> {
    if rel.is_empty() {
        return Err(VaultError::Escape("empty path".to_string()));
    }
    let path = Path::new(rel);
    if path.is_absolute() {
        return Err(VaultError::Escape(format!(
            "absolute path not allowed: {rel}"
        )));
    }
    let mut parts: Vec<&str> = Vec::new();
    for comp in path.components() {
        match comp {
            Component::CurDir => {}
            Component::ParentDir => {
                if parts.pop().is_none() {
                    return Err(VaultError::Escape(format!("`..` climbs above root: {rel}")));
                }
            }
            Component::Normal(seg) => {
                let seg = seg
                    .to_str()
                    .ok_or_else(|| VaultError::NotUtf8(rel.to_string()))?;
                if seg == AUDIT_FILE_NAME {
                    return Err(VaultError::Escape(
                        "access to the audit log is denied".to_string(),
                    ));
                }
                parts.push(seg);
            }
            // RootDir/Prefix cannot occur after the is_absolute check.
            _ => return Err(VaultError::Escape(format!("invalid path: {rel}"))),
        }
    }
    Ok(parts.join("/"))
}

/// Credential / private account files that must stay out of agent reach.
///
/// Only trusted first-party sessions (`user` UI, `mail`/`calendar`/`settings`
/// connectors) may touch these; any agent session is denied so credentials
/// never enter model context (contract sections 2.3, 7 and 9).
///
/// Deliberately excluded: `myinfo/profile.json` (user self-description that
/// the agent context builder reads on purpose, see sidecar/context.ts) and
/// `todo/queue.json` (written by the sidecar under its own TODO_SESSION_ID).
const PROTECTED_PATHS: &[&str] = &[
    "tasks/history.json",
    "mail/accounts.json",
    "calendar/accounts.json",
    "settings/settings.json",
];

fn is_trusted_session(session_id: &str) -> bool {
    matches!(session_id, "user" | "mail" | "calendar" | "settings")
}

/// True when `relnorm` is a credential/private file — either an exact match
/// in PROTECTED_PATHS or anything under the encrypted `secrets/` tree (the
/// master key and encrypted credential blobs from `credentials.rs`).
fn is_protected_path(relnorm: &str) -> bool {
    PROTECTED_PATHS.contains(&relnorm)
        || relnorm == "secrets"
        || relnorm.starts_with("secrets/")
}

/// Exact-match list used by `compress` to skip protected files by absolute
/// path. Directory-based secrets/ skipping is handled via `skip_secrets`.
pub(crate) fn protected_paths() -> &'static [&'static str] {
    PROTECTED_PATHS
}

/// Hidden from agent listings/searches; trusted sessions see everything.
fn hidden_from(session_id: &str, relnorm: &str) -> bool {
    !is_trusted_session(session_id) && is_protected_path(relnorm)
}

/// Reject agent access to protected paths; trusted sessions pass through.
fn protected_guard(session_id: &str, relnorm: &str) -> Result<(), VaultError> {
    if is_trusted_session(session_id) || !is_protected_path(relnorm) {
        return Ok(());
    }
    Err(VaultError::Escape(
        "access to credential/private files is denied".to_string(),
    ))
}

#[derive(Clone)]
struct RootPair {
    /// Canonicalized root; all candidates are built from this path.
    root: PathBuf,
    canonical: PathBuf,
}

/// Sandboxed vault service. Cheap to clone (shares state via `Arc`).
#[derive(Clone, Default)]
pub struct Vault {
    inner: Arc<VaultInner>,
}

#[derive(Default)]
struct VaultInner {
    root: RwLock<Option<RootPair>>,
    audit: AuditLog,
}

impl Vault {
    pub fn new() -> Self {
        Self::default()
    }

    /// Set the vault root. The path must exist and be a directory; it is
    /// canonicalized so later prefix checks are exact. Also (re)opens the
    /// audit log inside the new root.
    pub fn set_root(&self, path: &Path) -> Result<PathBuf, VaultError> {
        let canonical = fs::canonicalize(path).map_err(|e| {
            if e.kind() == io::ErrorKind::NotFound {
                VaultError::NotFound(path.display().to_string())
            } else {
                VaultError::Io(e)
            }
        })?;
        if !canonical.is_dir() {
            return Err(VaultError::InvalidParams(format!(
                "not a directory: {}",
                canonical.display()
            )));
        }
        self.inner.audit.set_root(&canonical)?;
        *self.inner.root.write().unwrap() = Some(RootPair {
            root: canonical.clone(),
            canonical,
        });
        let pair = self.inner.root.read().unwrap();
        Ok(pair.as_ref().unwrap().root.clone())
    }

    pub fn root(&self) -> Option<PathBuf> {
        self.inner
            .root
            .read()
            .unwrap()
            .as_ref()
            .map(|p| p.root.clone())
    }

    pub fn audit(&self) -> AuditLog {
        self.inner.audit.clone()
    }

    fn root_pair(&self) -> Result<RootPair, VaultError> {
        self.inner
            .root
            .read()
            .unwrap()
            .clone()
            .ok_or(VaultError::RootNotSet)
    }

    /// Resolve a relative path that must already exist. Canonicalizes the
    /// full candidate (resolving every symlink on the way) and requires the
    /// result to stay under the canonical root.
    fn resolve_existing(&self, rel: &str) -> Result<(PathBuf, String), VaultError> {
        let pair = self.root_pair()?;
        let relnorm = normalize(rel)?;
        let candidate = if relnorm.is_empty() {
            pair.root.clone()
        } else {
            pair.root.join(&relnorm)
        };
        match fs::symlink_metadata(&candidate) {
            Ok(_) => {}
            Err(e) if e.kind() == io::ErrorKind::NotFound => {
                return Err(VaultError::NotFound(relnorm));
            }
            Err(e) => return Err(e.into()),
        }
        let canonical = fs::canonicalize(&candidate)?;
        if !canonical.starts_with(&pair.canonical) {
            return Err(VaultError::Escape(relnorm));
        }
        Ok((candidate, relnorm))
    }

    /// Resolve a relative path for writing; the target may not exist yet.
    /// The deepest existing ancestor (or the candidate itself, if present)
    /// is canonicalized and must stay under the canonical root, which
    /// rejects symlink escapes on the existing prefix.
    fn resolve_for_write(&self, rel: &str) -> Result<(PathBuf, String), VaultError> {
        let pair = self.root_pair()?;
        let relnorm = normalize(rel)?;
        if relnorm.is_empty() {
            return Err(VaultError::InvalidParams(
                "cannot write to the vault root itself".to_string(),
            ));
        }
        let candidate = pair.root.join(&relnorm);
        let mut ancestor = candidate.clone();
        let mut missing: Vec<OsString> = Vec::new();
        loop {
            match fs::symlink_metadata(&ancestor) {
                Ok(_) => break,
                Err(e) if e.kind() == io::ErrorKind::NotFound => {
                    missing.push(
                        ancestor
                            .file_name()
                            .expect("candidate is below root")
                            .to_os_string(),
                    );
                    ancestor = ancestor.parent().expect("root always exists").to_path_buf();
                }
                Err(e) => return Err(e.into()),
            }
        }
        let canonical = fs::canonicalize(&ancestor)?;
        if !canonical.starts_with(&pair.canonical) {
            return Err(VaultError::Escape(relnorm));
        }
        let mut target = canonical;
        for seg in missing.iter().rev() {
            target.push(seg);
        }
        Ok((target, relnorm))
    }

    /// Record one audit entry for a finished operation.
    fn record_audit(
        &self,
        session_id: &str,
        op: Op,
        path: &str,
        outcome: Result<(Option<String>, Option<u64>), &VaultError>,
    ) {
        let mut entry = AuditEntry::new(session_id, op, path);
        match outcome {
            Ok((sha256, size)) => {
                entry.ok = true;
                entry.sha256 = sha256;
                entry.size = size;
            }
            Err(e) => {
                entry.ok = false;
                entry.error = Some(e.to_string());
            }
        }
        self.inner.audit.record(entry);
    }

    // ------------------------------------------------------------------
    // Public operations (contract section 2.3). Each records exactly one
    // audit entry, for success and failure alike.
    // ------------------------------------------------------------------

    pub fn read_file(&self, session_id: &str, rel: &str) -> Result<ReadFileResult, VaultError> {
        let audit_path = normalize(rel).unwrap_or_else(|_| rel.to_string());
        if let Err(error) = protected_guard(session_id, &audit_path) {
            self.record_audit(session_id, Op::Read, &audit_path, Err(&error));
            return Err(error);
        }
        let result = self.read_file_inner(rel);
        self.record_audit(
            session_id,
            Op::Read,
            &audit_path,
            result
                .as_ref()
                .map(|r| (Some(r.sha256.clone()), Some(r.size))),
        );
        result
    }

    /// Binary read for frontend media preview (contract section 2.3):
    /// same sandbox checks as `read_file`, no UTF-8 requirement, 64 MiB
    /// limit, base64 payload, MIME guessed from the extension. Audited as
    /// `op: "read"` like a text read.
    pub fn read_binary(&self, session_id: &str, rel: &str) -> Result<ReadBinaryResult, VaultError> {
        let audit_path = normalize(rel).unwrap_or_else(|_| rel.to_string());
        if let Err(error) = protected_guard(session_id, &audit_path) {
            self.record_audit(session_id, Op::Read, &audit_path, Err(&error));
            return Err(error);
        }
        let result = self.read_binary_inner(rel);
        self.record_audit(
            session_id,
            Op::Read,
            &audit_path,
            result
                .as_ref()
                .map(|r| (Some(r.sha256.clone()), Some(r.size))),
        );
        result
    }

    pub fn write_file(
        &self,
        session_id: &str,
        rel: &str,
        content: &str,
    ) -> Result<WriteFileResult, VaultError> {
        let audit_path = normalize(rel).unwrap_or_else(|_| rel.to_string());
        if let Err(error) = protected_guard(session_id, &audit_path) {
            self.record_audit(session_id, Op::Write, &audit_path, Err(&error));
            return Err(error);
        }
        let result = self.write_file_inner(rel, content);
        self.record_audit(
            session_id,
            Op::Write,
            &audit_path,
            result
                .as_ref()
                .map(|r| (Some(r.sha256.clone()), Some(r.size))),
        );
        result
    }

    /// Binary write used by trusted importers such as the mail sidecar. It is
    /// deliberately not registered as an agent tool. The payload uses base64
    /// because the sidecar transport is line-delimited JSON.
    pub fn write_binary(
        &self,
        session_id: &str,
        rel: &str,
        data_base64: &str,
    ) -> Result<WriteFileResult, VaultError> {
        let audit_path = normalize(rel).unwrap_or_else(|_| rel.to_string());
        if let Err(error) = protected_guard(session_id, &audit_path) {
            self.record_audit(session_id, Op::Write, &audit_path, Err(&error));
            return Err(error);
        }
        let result = self.write_binary_inner(rel, data_base64);
        self.record_audit(
            session_id,
            Op::Write,
            &audit_path,
            result
                .as_ref()
                .map(|r| (Some(r.sha256.clone()), Some(r.size))),
        );
        result
    }

    pub fn list_dir(&self, session_id: &str, rel: &str) -> Result<ListDirResult, VaultError> {
        let audit_path = normalize(rel).unwrap_or_else(|_| rel.to_string());
        if let Err(error) = protected_guard(session_id, &audit_path) {
            self.record_audit(session_id, Op::List, &audit_path, Err(&error));
            return Err(error);
        }
        let result = self.list_dir_inner(rel, session_id);
        self.record_audit(
            session_id,
            Op::List,
            &audit_path,
            result.as_ref().map(|_| (None, None)),
        );
        result
    }

    pub fn search_files(&self, session_id: &str, query: &str) -> Result<SearchResult, VaultError> {
        let result = self.search_files_inner(query, session_id);
        self.record_audit(
            session_id,
            Op::Search,
            ".",
            result.as_ref().map(|_| (None, None)),
        );
        result
    }

    pub fn delete_file(&self, session_id: &str, rel: &str) -> Result<(), VaultError> {
        let audit_path = normalize(rel).unwrap_or_else(|_| rel.to_string());
        if let Err(error) = protected_guard(session_id, &audit_path) {
            self.record_audit(session_id, Op::Delete, &audit_path, Err(&error));
            return Err(error);
        }
        let result = self.delete_file_inner(rel);
        self.record_audit(
            session_id,
            Op::Delete,
            &audit_path,
            result.as_ref().map(|_| (None, None)),
        );
        result
    }

    pub fn stat(&self, session_id: &str, rel: &str) -> Result<StatResult, VaultError> {
        let audit_path = normalize(rel).unwrap_or_else(|_| rel.to_string());
        if let Err(error) = protected_guard(session_id, &audit_path) {
            self.record_audit(session_id, Op::Stat, &audit_path, Err(&error));
            return Err(error);
        }
        let result = self.stat_inner(rel);
        self.record_audit(
            session_id,
            Op::Stat,
            &audit_path,
            result.as_ref().map(|r| (None, Some(r.size))),
        );
        result
    }

    /// Create a gzip-compressed tar archive inside the vault. This is a
    /// deliberate built-in action rather than shell execution: source paths
    /// are sandboxed, symlinks are skipped, and the resulting archive is
    /// recorded as a normal vault write.
    pub fn compress(
        &self,
        session_id: &str,
        source_rel: &str,
        archive_rel: Option<&str>,
    ) -> Result<CompressResult, VaultError> {
        let fallback_path = archive_rel
            .and_then(|path| normalize(path).ok())
            .or_else(|| normalize(source_rel).ok())
            .unwrap_or_else(|| source_rel.to_string());
        if let Err(error) = protected_guard(session_id, &fallback_path) {
            self.record_audit(session_id, Op::Write, &fallback_path, Err(&error));
            return Err(error);
        }
        if let Some(archive) = archive_rel {
            if let Ok(rel) = normalize(archive) {
                if let Err(error) = protected_guard(session_id, &rel) {
                    self.record_audit(session_id, Op::Write, &rel, Err(&error));
                    return Err(error);
                }
            }
        }
        let skip_secrets = !is_trusted_session(session_id);
        let excluded: Vec<PathBuf> = if skip_secrets {
            self.root_pair()
                .map(|pair| {
                    protected_paths()
                        .iter()
                        .map(|p| pair.root.join(p))
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default()
        } else {
            Vec::new()
        };
        let result = self.compress_inner(source_rel, archive_rel, &excluded, skip_secrets);
        let audit_path = result
            .as_ref()
            .map(|value| value.archive.clone())
            .unwrap_or(fallback_path);
        self.record_audit(
            session_id,
            Op::Write,
            &audit_path,
            result.as_ref().map(|r| (None, Some(r.archive_size))),
        );
        result
    }

    // ------------------------------------------------------------------
    // Inner implementations (no auditing).
    // ------------------------------------------------------------------

    fn read_file_inner(&self, rel: &str) -> Result<ReadFileResult, VaultError> {
        let (path, relnorm) = self.resolve_existing(rel)?;
        let meta = fs::metadata(&path)?;
        if !meta.is_file() {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "not a regular file").into());
        }
        if meta.len() > MAX_FILE_SIZE {
            return Err(VaultError::TooLarge);
        }
        let bytes = fs::read(&path)?;
        let content = String::from_utf8(bytes).map_err(|_| VaultError::NotUtf8(relnorm))?;
        Ok(ReadFileResult {
            size: content.len() as u64,
            sha256: sha256_hex(content.as_bytes()),
            content,
        })
    }

    fn read_binary_inner(&self, rel: &str) -> Result<ReadBinaryResult, VaultError> {
        let (path, relnorm) = self.resolve_existing(rel)?;
        let meta = fs::metadata(&path)?;
        if !meta.is_file() {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "not a regular file").into());
        }
        if meta.len() > MAX_BINARY_FILE_SIZE {
            return Err(VaultError::TooLarge);
        }
        let bytes = fs::read(&path)?;
        Ok(ReadBinaryResult {
            size: bytes.len() as u64,
            sha256: sha256_hex(&bytes),
            data_base64: BASE64.encode(&bytes),
            mime: mime_for_path(&relnorm),
        })
    }

    fn write_file_inner(&self, rel: &str, content: &str) -> Result<WriteFileResult, VaultError> {
        if content.len() as u64 > MAX_FILE_SIZE {
            return Err(VaultError::TooLarge);
        }
        let (path, _) = self.resolve_for_write(rel)?;
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(&path, content)?;
        Ok(WriteFileResult {
            size: content.len() as u64,
            sha256: sha256_hex(content.as_bytes()),
        })
    }

    fn write_binary_inner(
        &self,
        rel: &str,
        data_base64: &str,
    ) -> Result<WriteFileResult, VaultError> {
        // Reject obviously oversized encoded payloads before allocating the
        // decoded buffer. The exact decoded length is checked again below.
        let max_encoded_len = (MAX_BINARY_FILE_SIZE as usize).div_ceil(3) * 4;
        if data_base64.len() > max_encoded_len + 4 {
            return Err(VaultError::TooLarge);
        }
        let bytes = BASE64.decode(data_base64).map_err(|_| {
            VaultError::InvalidParams("data_base64 is not valid base64".to_string())
        })?;
        if bytes.len() as u64 > MAX_BINARY_FILE_SIZE {
            return Err(VaultError::TooLarge);
        }
        let (path, _) = self.resolve_for_write(rel)?;
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(&path, &bytes)?;
        Ok(WriteFileResult {
            size: bytes.len() as u64,
            sha256: sha256_hex(&bytes),
        })
    }

    fn list_dir_inner(&self, rel: &str, session_id: &str) -> Result<ListDirResult, VaultError> {
        let (path, relnorm) = self.resolve_existing(rel)?;
        if !fs::metadata(&path)?.is_dir() {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "not a directory").into());
        }
        let mut entries = Vec::new();
        for entry in fs::read_dir(&path)? {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().into_owned();
            // The audit log is invisible to all vault operations; protected
            // files (credential files plus the whole secrets/ tree) are also
            // hidden from agent sessions.
            let entry_rel = if relnorm.is_empty() {
                name.clone()
            } else {
                format!("{relnorm}/{name}")
            };
            if name == AUDIT_FILE_NAME || hidden_from(session_id, &entry_rel) {
                continue;
            }
            // Follow symlinks to classify; skip anything that cannot be
            // resolved (e.g. dangling links) or is neither file nor dir.
            let Ok(meta) = fs::metadata(entry.path()) else {
                continue;
            };
            let kind = if meta.is_dir() {
                EntryKind::Dir
            } else if meta.is_file() {
                EntryKind::File
            } else {
                continue;
            };
            let size = if kind == EntryKind::Dir {
                0
            } else {
                meta.len()
            };
            entries.push(DirEntryInfo { name, kind, size });
        }
        entries.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(ListDirResult { entries })
    }

    fn search_files_inner(&self, query: &str, session_id: &str) -> Result<SearchResult, VaultError> {
        let pair = self.root_pair()?;
        let mut matches = Vec::new();
        search_dir(&pair.root, &pair.root, query, &mut matches, session_id);
        Ok(SearchResult { matches })
    }

    fn delete_file_inner(&self, rel: &str) -> Result<(), VaultError> {
        let (path, _) = self.resolve_existing(rel)?;
        // symlink_metadata: a symlink is removed itself, never its target.
        if fs::symlink_metadata(&path)?.is_dir() {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "is a directory").into());
        }
        fs::remove_file(&path)?;
        Ok(())
    }

    fn stat_inner(&self, rel: &str) -> Result<StatResult, VaultError> {
        let (path, _) = self.resolve_existing(rel)?;
        let meta = fs::metadata(&path)?;
        let kind = if meta.is_dir() {
            EntryKind::Dir
        } else {
            EntryKind::File
        };
        let size = if kind == EntryKind::Dir {
            0
        } else {
            meta.len()
        };
        let modified_ms = meta
            .modified()?
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        Ok(StatResult {
            kind,
            size,
            modified_ms,
        })
    }

    fn compress_inner(
        &self,
        source_rel: &str,
        archive_rel: Option<&str>,
        excluded: &[PathBuf],
        skip_secrets: bool,
    ) -> Result<CompressResult, VaultError> {
        let (source_path, source_norm) = self.resolve_existing(source_rel)?;
        let source_meta = fs::symlink_metadata(&source_path)?;
        if !source_meta.is_file() && !source_meta.is_dir() {
            return Err(
                io::Error::new(io::ErrorKind::InvalidInput, "not a file or directory").into(),
            );
        }

        let (archive_path, archive_norm) = if let Some(path) = archive_rel {
            self.resolve_for_write(path)?
        } else {
            let parent = if source_norm.is_empty() {
                source_path.as_path()
            } else {
                source_path.parent().ok_or_else(|| {
                    VaultError::InvalidParams("source has no parent directory".to_string())
                })?
            };
            let base = if source_norm.is_empty() {
                "depdek-home".to_string()
            } else {
                source_path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or("archive")
                    .to_string()
            };
            let archive_name = format!("{base}.tar.gz");
            let archive_candidate = parent.join(&archive_name);
            let relative = archive_candidate
                .strip_prefix(self.root_pair()?.root)
                .map_err(|_| VaultError::Escape(archive_name.clone()))?
                .to_string_lossy()
                .into_owned();
            let (resolved, normalized) = self.resolve_for_write(&relative)?;
            (resolved, normalized)
        };

        if archive_path == source_path {
            return Err(VaultError::InvalidParams(
                "archive path must differ from the source".to_string(),
            ));
        }
        if source_meta.is_dir() && archive_path.starts_with(&source_path) {
            // An archive inside its source is safe only when explicitly
            // skipped during traversal; keep the restriction clear to users.
            if archive_rel.is_some() {
                return Err(VaultError::InvalidParams(
                    "archive path cannot be inside the source directory".to_string(),
                ));
            }
        }
        if let Some(parent) = archive_path.parent() {
            fs::create_dir_all(parent)?;
        }

        let temp_path = archive_path.with_extension("tar.gz.part");
        let mut files = 0usize;
        let mut bytes = 0u64;
        let build_result = (|| -> Result<(), VaultError> {
            let output = fs::File::create(&temp_path)?;
            let encoder = GzEncoder::new(output, Compression::default());
            let mut builder = TarBuilder::new(encoder);
            let archive_base = if source_meta.is_dir() && !source_norm.is_empty() {
                source_path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .map(PathBuf::from)
            } else if source_meta.is_file() {
                source_path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .map(PathBuf::from)
            } else {
                None
            };
            append_archive_entries(
                &mut builder,
                &source_path,
                archive_base.as_deref(),
                &archive_path,
                &temp_path,
                &mut files,
                &mut bytes,
                excluded,
                skip_secrets,
            )?;
            let encoder = builder.into_inner()?;
            encoder.finish()?;
            Ok(())
        })();
        if let Err(error) = build_result {
            let _ = fs::remove_file(&temp_path);
            return Err(error);
        }
        if archive_path.exists() {
            fs::remove_file(&archive_path)?;
        }
        fs::rename(&temp_path, &archive_path)?;
        let archive_size = fs::metadata(&archive_path)?.len();
        Ok(CompressResult {
            source: if source_norm.is_empty() {
                ".".to_string()
            } else {
                source_norm
            },
            archive: archive_norm,
            files,
            bytes,
            archive_size,
        })
    }
}

fn append_archive_entries(
    builder: &mut TarBuilder<GzEncoder<fs::File>>,
    path: &Path,
    name: Option<&Path>,
    archive_path: &Path,
    temp_path: &Path,
    files: &mut usize,
    bytes: &mut u64,
    excluded: &[PathBuf],
    skip_secrets: bool,
) -> Result<(), VaultError> {
    let file_type = fs::symlink_metadata(path)?.file_type();
    if file_type.is_symlink() {
        return Ok(());
    }
    if file_type.is_file() {
        if path == archive_path
            || path == temp_path
            || path.file_name().is_some_and(|n| n == AUDIT_FILE_NAME)
            || excluded.iter().any(|candidate| candidate == path)
        {
            return Ok(());
        }
        let size = fs::metadata(path)?.len();
        if *files >= MAX_COMPRESS_FILES || bytes.saturating_add(size) > MAX_COMPRESS_BYTES {
            return Err(VaultError::TooLarge);
        }
        let archive_name = name.unwrap_or_else(|| Path::new("file"));
        builder.append_path_with_name(path, archive_name)?;
        *files += 1;
        *bytes += size;
        return Ok(());
    }
    if !file_type.is_dir() {
        return Ok(());
    }
    if let Some(dir_name) = name {
        if dir_name.file_name().is_some_and(|n| n == AUDIT_FILE_NAME) {
            return Ok(());
        }
        builder.append_dir(dir_name, path)?;
    }
    let mut entries = fs::read_dir(path)?.flatten().collect::<Vec<_>>();
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        if entry.file_name() == AUDIT_FILE_NAME {
            continue;
        }
        // Encrypted credential blobs and the master key never enter archives
        // produced on behalf of an agent session.
        if skip_secrets && entry.file_name() == "secrets" {
            continue;
        }
        let child_name = match name {
            Some(parent) => parent.join(entry.file_name()),
            None => PathBuf::from(entry.file_name()),
        };
        append_archive_entries(
            builder,
            &entry.path(),
            Some(&child_name),
            archive_path,
            temp_path,
            files,
            bytes,
            excluded,
            skip_secrets,
        )?;
    }
    Ok(())
}

/// Relative vault path of `path` under `root`, using `/` separators.
fn relative_path(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .components()
        .filter_map(|c| match c {
            Component::Normal(s) => Some(s.to_string_lossy().into_owned()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/")
}

/// Recursive content search. Never follows symlinks (a symlinked directory
/// could point outside the root), skips the audit log, oversized files and
/// non-UTF-8 files, and stops at `MAX_SEARCH_MATCHES`. Credential/private
/// files (including the encrypted secrets/ tree) are hidden from agent
/// sessions.
fn search_dir(
    dir: &Path,
    root: &Path,
    query: &str,
    matches: &mut Vec<SearchMatch>,
    session_id: &str,
) {
    if matches.len() >= MAX_SEARCH_MATCHES {
        return;
    }
    let Ok(read_dir) = fs::read_dir(dir) else {
        return;
    };
    for entry in read_dir.flatten() {
        if matches.len() >= MAX_SEARCH_MATCHES {
            return;
        }
        if entry.file_name() == AUDIT_FILE_NAME {
            continue;
        }
        let Ok(ft) = entry.file_type() else {
            continue;
        };
        if ft.is_symlink() {
            continue;
        }
        let path = entry.path();
        let rel = relative_path(root, &path);
        if ft.is_dir() {
            if hidden_from(session_id, &rel) {
                continue;
            }
            search_dir(&path, root, query, matches, session_id);
        } else if ft.is_file() {
            let Ok(meta) = entry.metadata() else {
                continue;
            };
            if meta.len() > MAX_FILE_SIZE {
                continue;
            }
            let Ok(text) = fs::read_to_string(&path) else {
                continue;
            };
            // Credential files are excluded from agent searches even though
            // the audit log itself is skipped above.
            if hidden_from(session_id, &rel) {
                continue;
            }
            for (idx, line) in text.lines().enumerate() {
                if line.contains(query) {
                    let snippet: String = line.trim().chars().take(MAX_SNIPPET_CHARS).collect();
                    matches.push(SearchMatch {
                        path: rel.clone(),
                        line: idx + 1,
                        snippet,
                    });
                    if matches.len() >= MAX_SEARCH_MATCHES {
                        break;
                    }
                }
            }
        }
    }
}

// ----------------------------------------------------------------------
// AgentOS R1: a deliberately narrow, descriptor-relative read capability.
// It is separate from the v1 API so stronger rules do not break legacy Home
// operations. All managed data checks remain in this Vault module.
// ----------------------------------------------------------------------

#[cfg(unix)]
pub const MANAGED_MAX_TEXT_BYTES: usize = 128 * 1024;
#[cfg(unix)]
pub const MANAGED_MAX_LIST_ENTRIES: usize = 100;
#[cfg(unix)]
const MANAGED_MAX_DIRECTORY_SCAN: usize = 5_000;

#[cfg(unix)]
#[derive(Debug, Error)]
pub enum ManagedReadError {
    #[error("resource is not visible in this read capability")]
    Forbidden,
    #[error("resource not found")]
    NotFound,
    #[error("policy revision changed")]
    PolicyChanged,
    #[error("managed read limit exceeded")]
    TooLarge,
    #[error("resource is not UTF-8 text")]
    NotUtf8,
    #[error("invalid read parameters")]
    InvalidInput,
    #[error("durable audit unavailable; no data released")]
    AuditUnavailable,
    #[error("resource I/O unavailable")]
    Io,
}

/// Constructed by the trusted transport from its peer identity, not decoded
/// from client JSON. The authority is checked again at the Vault boundary.
#[cfg(unix)]
pub struct ReadAuthority {
    principal_id: String,
    workspace_id: String,
    policy_revision: u64,
    request_id: String,
}

#[cfg(unix)]
impl ReadAuthority {
    pub fn new(principal: &str, workspace: &str, policy_revision: u64, request_id: &str) -> Self {
        Self {
            principal_id: principal.into(),
            workspace_id: workspace.into(),
            policy_revision,
            request_id: request_id.into(),
        }
    }
}

#[cfg(unix)]
pub enum ManagedReadOperation {
    Read { path: String },
    List { path: String, limit: usize },
    Stat { path: String },
}

/// Only the service-owned registered directories are visible; this type has
/// no write, root mutation, binary read, search-all, or raw filesystem method.
#[cfg(unix)]
pub struct ManagedReadVault {
    root: fs::File,
    root_path: PathBuf,
    workspace_id: String,
    principal_id: String,
    read_paths: Vec<String>,
    audit: AuditLog,
    access: std::sync::Mutex<access::AccessState>,
}

#[cfg(unix)]
#[path = "vault/access.rs"]
mod access;
#[cfg(unix)]
pub use access::{hash_business_password, AccessError, AccessUser, LoginInput};

#[cfg(unix)]
impl ManagedReadVault {
    pub fn open(
        root: &Path,
        workspace_id: &str,
        principal_id: &str,
        read_paths: &[String],
    ) -> Result<Self, ManagedReadError> {
        use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
        if !managed_id(workspace_id)
            || !managed_id(principal_id)
            || read_paths.is_empty()
            || read_paths.len() > 32
        {
            return Err(ManagedReadError::InvalidInput);
        }
        let canonical = fs::canonicalize(root).map_err(managed_io_error)?;
        let root_file = fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(&canonical)
            .map_err(managed_io_error)?;
        let mut paths = Vec::new();
        for path in read_paths {
            let norm = managed_normalize(path)?;
            if norm.is_empty() || managed_protected(&norm) {
                return Err(ManagedReadError::Forbidden);
            }
            let directory = managed_open_beneath(&root_file, &norm)?;
            if !directory.metadata().map_err(managed_io_error)?.is_dir() {
                return Err(ManagedReadError::InvalidInput);
            }
            paths.push(norm);
        }
        paths.sort();
        paths.dedup();
        // Opening via the held directory fd also protects the audit path
        // from symlink substitutions between checking and opening it.
        let audit_file = managed_open_at(
            &root_file,
            AUDIT_FILE_NAME,
            libc::O_RDWR | libc::O_APPEND | libc::O_CREAT,
            0o600,
        )?;
        let meta = audit_file.metadata().map_err(managed_io_error)?;
        if !meta.is_file()
            || meta.nlink() != 1
            || meta.uid() != unsafe { libc::geteuid() }
            || meta.mode() & 0o077 != 0
        {
            return Err(ManagedReadError::Forbidden);
        }
        managed_check_audit_tail(&audit_file, meta.len())?;
        // Persist a newly-created audit directory entry before the first read
        // can be released. Each record subsequently synchronizes its file.
        root_file
            .sync_all()
            .map_err(|_| ManagedReadError::AuditUnavailable)?;
        let audit = AuditLog::new();
        audit.set_file(canonical.join(AUDIT_FILE_NAME), audit_file);
        Ok(Self {
            root: root_file,
            root_path: canonical,
            workspace_id: workspace_id.into(),
            principal_id: principal_id.into(),
            read_paths: paths,
            audit,
            access: std::sync::Mutex::new(access::AccessState::default()),
        })
    }

    pub fn open_secret_files(&self, directory: &Path) -> Result<SecretFiles, SecretFileError> {
        SecretFiles::open(
            directory,
            &self.root_path,
            &self.workspace_id,
            &self.principal_id,
        )
    }

    pub fn execute(
        &self,
        authority: &ReadAuthority,
        operation: ManagedReadOperation,
    ) -> Result<serde_json::Value, ManagedReadError> {
        self.execute_scoped(authority, operation, &self.read_paths, false)
    }

    fn execute_scoped(
        &self,
        authority: &ReadAuthority,
        operation: ManagedReadOperation,
        scopes: &[String],
        delegated: bool,
    ) -> Result<serde_json::Value, ManagedReadError> {
        let (op, path) = match &operation {
            ManagedReadOperation::Read { path } => (Op::Read, path.as_str()),
            ManagedReadOperation::List { path, .. } => (Op::List, path.as_str()),
            ManagedReadOperation::Stat { path } => (Op::Stat, path.as_str()),
        };
        let result = (|| {
            if (!delegated && authority.principal_id != self.principal_id)
                || authority.workspace_id != self.workspace_id
                || !managed_id(&authority.request_id)
            {
                return Err(ManagedReadError::Forbidden);
            }
            if authority.policy_revision != 1 {
                return Err(ManagedReadError::PolicyChanged);
            }
            let norm = self.visible_scoped(path, scopes)?;
            let file = managed_open_beneath(&self.root, &norm)?;
            match &operation {
                ManagedReadOperation::Read { .. } => self.read_text(file),
                ManagedReadOperation::List { limit, .. } => self.list(file, &norm, *limit, scopes),
                ManagedReadOperation::Stat { .. } => {
                    let meta = managed_regular_metadata(&file)?;
                    let modified_ms = meta
                        .modified()
                        .map_err(managed_io_error)?
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.as_millis() as u64)
                        .unwrap_or(0);
                    Ok((
                        serde_json::json!({"kind": if meta.is_dir() {"dir"} else {"file"},
                        "size": if meta.is_dir() {0} else {meta.len()}, "modified_ms": modified_ms}),
                        None,
                        None,
                    ))
                }
            }
        })();
        let mut entry = AuditEntry::new(
            &format!("v2:{}:{}", authority.principal_id, authority.request_id),
            op,
            &path.chars().take(1024).collect::<String>(),
        );
        match &result {
            Ok((_, sha, size)) => {
                entry.ok = true;
                entry.sha256 = sha.clone();
                entry.size = *size;
            }
            Err(error) => entry.error = Some(error.to_string()),
        }
        self.audit
            .record_durable(entry)
            .map_err(|_| ManagedReadError::AuditUnavailable)?;
        result.map(|(value, _, _)| value)
    }

    fn visible_path(&self, path: &str) -> Result<String, ManagedReadError> {
        let norm = managed_normalize(path)?;
        if managed_protected(&norm)
            || !self
                .read_paths
                .iter()
                .any(|prefix| norm == *prefix || norm.starts_with(&format!("{prefix}/")))
        {
            return Err(ManagedReadError::Forbidden);
        }
        Ok(norm)
    }

    fn visible_scoped(&self, path: &str, scopes: &[String]) -> Result<String, ManagedReadError> {
        let norm = self.visible_path(path)?;
        if !scopes
            .iter()
            .any(|scope| norm == *scope || norm.starts_with(&format!("{scope}/")))
        {
            return Err(ManagedReadError::Forbidden);
        }
        Ok(norm)
    }

    fn read_text(
        &self,
        file: fs::File,
    ) -> Result<(serde_json::Value, Option<String>, Option<u64>), ManagedReadError> {
        use std::io::Read;
        let meta = managed_regular_metadata(&file)?;
        if !meta.is_file() {
            return Err(ManagedReadError::InvalidInput);
        }
        if meta.len() > MANAGED_MAX_TEXT_BYTES as u64 {
            return Err(ManagedReadError::TooLarge);
        }
        let mut bytes = Vec::new();
        file.take((MANAGED_MAX_TEXT_BYTES + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(managed_io_error)?;
        if bytes.len() > MANAGED_MAX_TEXT_BYTES {
            return Err(ManagedReadError::TooLarge);
        }
        let size = bytes.len() as u64;
        let sha = sha256_hex(&bytes);
        let content = String::from_utf8(bytes).map_err(|_| ManagedReadError::NotUtf8)?;
        Ok((
            serde_json::json!({"content":content,"size":size,"sha256":sha}),
            Some(sha),
            Some(size),
        ))
    }

    fn list(
        &self,
        file: fs::File,
        norm: &str,
        limit: usize,
        scopes: &[String],
    ) -> Result<(serde_json::Value, Option<String>, Option<u64>), ManagedReadError> {
        use std::ffi::CStr;
        use std::os::fd::{FromRawFd, IntoRawFd};
        if limit == 0 || limit > MANAGED_MAX_LIST_ENTRIES {
            return Err(ManagedReadError::InvalidInput);
        }
        if !file.metadata().map_err(managed_io_error)?.is_dir() {
            return Err(ManagedReadError::InvalidInput);
        }
        let fd = file.try_clone().map_err(managed_io_error)?.into_raw_fd();
        let ptr = unsafe { libc::fdopendir(fd) };
        if ptr.is_null() {
            unsafe {
                drop(fs::File::from_raw_fd(fd));
            }
            return Err(ManagedReadError::Io);
        }
        struct Directory(*mut libc::DIR);
        impl Drop for Directory {
            fn drop(&mut self) {
                unsafe {
                    libc::closedir(self.0);
                }
            }
        }
        let directory = Directory(ptr);
        let mut entries = Vec::new();
        let mut scanned = 0usize;
        let mut truncated = false;
        loop {
            errno::set_errno(errno::Errno(0));
            let next = unsafe { libc::readdir(directory.0) };
            if next.is_null() {
                if errno::errno().0 != 0 {
                    return Err(ManagedReadError::Io);
                }
                break;
            }
            scanned += 1;
            if scanned > MANAGED_MAX_DIRECTORY_SCAN {
                truncated = true;
                break;
            }
            let name = unsafe { CStr::from_ptr((*next).d_name.as_ptr()) };
            let Ok(name) = name.to_str() else {
                continue;
            };
            if self
                .visible_scoped(&format!("{norm}/{name}"), scopes)
                .is_err()
                || name == "."
                || name == ".."
            {
                continue;
            }
            let Ok(child) = managed_open_at(&file, name, libc::O_RDONLY | libc::O_NONBLOCK, 0)
            else {
                continue;
            };
            let Ok(meta) = managed_regular_metadata(&child) else {
                continue;
            };
            entries.push(DirEntryInfo {
                name: name.into(),
                kind: if meta.is_dir() {
                    EntryKind::Dir
                } else {
                    EntryKind::File
                },
                size: if meta.is_dir() { 0 } else { meta.len() },
            });
        }
        entries.sort_by(|a, b| a.name.cmp(&b.name));
        truncated |= entries.len() > limit;
        entries.truncate(limit);
        Ok((
            serde_json::json!({"entries":entries,"truncated":truncated,"coverage":"bounded_live_directory"}),
            None,
            None,
        ))
    }
}

#[cfg(unix)]
fn managed_check_audit_tail(file: &fs::File, length: u64) -> Result<(), ManagedReadError> {
    use std::os::unix::fs::FileExt;
    if length == 0 {
        return Ok(());
    }
    // A previous partial append must not be silently continued after restart.
    // Inspect only the last bounded record; this is not historical validation.
    let size = length.min(64 * 1024) as usize;
    let offset = length - size as u64;
    let mut tail = vec![0u8; size];
    file.read_exact_at(&mut tail, offset)
        .map_err(|_| ManagedReadError::AuditUnavailable)?;
    if tail.last() != Some(&b'\n') {
        return Err(ManagedReadError::AuditUnavailable);
    }
    let start = match tail[..size - 1].iter().rposition(|b| *b == b'\n') {
        Some(index) => index + 1,
        None if offset == 0 => 0,
        None => return Err(ManagedReadError::AuditUnavailable),
    };
    serde_json::from_slice::<AuditEntry>(&tail[start..size - 1])
        .map_err(|_| ManagedReadError::AuditUnavailable)?;
    Ok(())
}

#[cfg(unix)]
fn managed_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_.:".contains(&b))
}

#[cfg(unix)]
fn managed_normalize(path: &str) -> Result<String, ManagedReadError> {
    if path.len() > 1024 || path.contains('\0') || path.contains('\\') {
        return Err(ManagedReadError::InvalidInput);
    }
    normalize(path).map_err(|_| ManagedReadError::Forbidden)
}

#[cfg(unix)]
fn managed_protected(norm: &str) -> bool {
    if norm.is_empty() {
        return true;
    }
    norm.split('/').any(|part| {
        let part = part.to_ascii_lowercase();
        part.starts_with('.')
            || matches!(
                part.as_str(),
                "mydata"
                    | "myinfo"
                    | "agents"
                    | "mail"
                    | "calendar"
                    | "todo"
                    | "tasks"
                    | "memory"
                    | "audit"
                    | "indexes"
                    | "staging"
                    | "originals"
                    | "accounts.json"
                    | "settings.json"
                    | "credentials.json"
                    | "agent.env"
                    | "credentials.enc"
                    | "secret-store"
                    | "secrets"
            )
            || [
                ".sqlite",
                ".sqlite3",
                ".db",
                ".sqlite-wal",
                ".sqlite-shm",
                ".sqlite-journal",
                ".db-wal",
                ".db-shm",
                ".env",
                ".pem",
                ".key",
            ]
            .iter()
            .any(|suffix| part.ends_with(suffix))
    })
}

#[cfg(unix)]
fn managed_io_error(error: io::Error) -> ManagedReadError {
    match error.raw_os_error() {
        Some(libc::ENOENT) => ManagedReadError::NotFound,
        Some(libc::ELOOP) | Some(libc::EMLINK) | Some(libc::EACCES) | Some(libc::EPERM) => {
            ManagedReadError::Forbidden
        }
        _ => ManagedReadError::Io,
    }
}

#[cfg(unix)]
fn managed_open_at(
    directory: &fs::File,
    name: &str,
    flags: i32,
    mode: u32,
) -> Result<fs::File, ManagedReadError> {
    use std::ffi::CString;
    use std::os::fd::{AsRawFd, FromRawFd};
    let name = CString::new(name).map_err(|_| ManagedReadError::InvalidInput)?;
    // Every component is opened relative to a held descriptor. No full path
    // is reopened after validation, including the last read/stat/list step.
    let fd = unsafe {
        libc::openat(
            directory.as_raw_fd(),
            name.as_ptr(),
            flags | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK,
            mode as libc::c_uint,
        )
    };
    if fd < 0 {
        return Err(managed_io_error(io::Error::last_os_error()));
    }
    Ok(unsafe { fs::File::from_raw_fd(fd) })
}

#[cfg(unix)]
fn managed_open_beneath(root: &fs::File, norm: &str) -> Result<fs::File, ManagedReadError> {
    let mut directory = root.try_clone().map_err(managed_io_error)?;
    let parts: Vec<_> = norm.split('/').collect();
    for (i, name) in parts.iter().enumerate() {
        if name.is_empty() || *name == "." || *name == ".." {
            return Err(ManagedReadError::Forbidden);
        }
        let flags = libc::O_RDONLY
            | if i + 1 < parts.len() {
                libc::O_DIRECTORY
            } else {
                0
            };
        directory = managed_open_at(&directory, name, flags, 0)?;
    }
    Ok(directory)
}

#[cfg(unix)]
fn managed_regular_metadata(file: &fs::File) -> Result<fs::Metadata, ManagedReadError> {
    use std::os::unix::fs::MetadataExt;
    let meta = file.metadata().map_err(managed_io_error)?;
    if !meta.is_file() && !meta.is_dir() {
        return Err(ManagedReadError::Forbidden);
    }
    if meta.is_file() && meta.nlink() != 1 {
        return Err(ManagedReadError::Forbidden);
    }
    Ok(meta)
}

// Secret Store has its own, disjoint private directory. All filesystem and
// authority checks stay here; secrets.rs receives only opaque bounded bytes.
#[cfg(unix)]
pub const MAX_SECRET_FILE_BYTES: usize = 2 * 1024 * 1024;

#[cfg(unix)]
#[derive(Debug, Error)]
pub enum SecretFileError {
    #[error("private credential storage is not authorized")]
    Forbidden,
    #[error("private credential storage is already in use")]
    Busy,
    #[error("private credential storage unavailable")]
    Unavailable,
    #[error("credential commit outcome requires verification")]
    CommitUnknown,
    #[error("credential audit unavailable")]
    AuditUnavailable,
}

#[cfg(unix)]
pub struct SecretFiles {
    directory: fs::File,
    _lock: fs::File,
    workspace_id: String,
    principal_id: String,
    audit: AuditLog,
    #[cfg(test)]
    save_fault: std::sync::atomic::AtomicU8,
    #[cfg(test)]
    audit_fail_after: std::sync::atomic::AtomicU8,
}

#[cfg(unix)]
impl SecretFiles {
    fn open(
        path: &Path,
        data_root: &Path,
        workspace: &str,
        principal: &str,
    ) -> Result<Self, SecretFileError> {
        use std::os::fd::AsRawFd;
        use std::os::unix::fs::OpenOptionsExt;
        if !path.is_absolute() || !managed_id(workspace) || !managed_id(principal) {
            return Err(SecretFileError::Forbidden);
        }
        let leaf = fs::symlink_metadata(path).map_err(|_| SecretFileError::Unavailable)?;
        private_directory_meta(&leaf)?;
        let canonical = fs::canonicalize(path).map_err(|_| SecretFileError::Unavailable)?;
        if canonical.starts_with(data_root) || data_root.starts_with(&canonical) {
            return Err(SecretFileError::Forbidden);
        }
        let directory = fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(&canonical)
            .map_err(|_| SecretFileError::Unavailable)?;
        private_directory_meta(
            &directory
                .metadata()
                .map_err(|_| SecretFileError::Unavailable)?,
        )?;
        let lock = private_open(
            &directory,
            ".secret-store.lock",
            libc::O_RDWR | libc::O_CREAT,
        )?;
        if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            return Err(SecretFileError::Busy);
        }
        let audit_file = private_open(
            &directory,
            ".secret-audit.jsonl",
            libc::O_RDWR | libc::O_APPEND | libc::O_CREAT,
        )?;
        managed_check_audit_tail(
            &audit_file,
            audit_file
                .metadata()
                .map_err(|_| SecretFileError::Unavailable)?
                .len(),
        )
        .map_err(|_| SecretFileError::AuditUnavailable)?;
        directory
            .sync_all()
            .map_err(|_| SecretFileError::Unavailable)?;
        let audit = AuditLog::new();
        audit.set_file(canonical.join(".secret-audit.jsonl"), audit_file);
        Ok(Self {
            directory,
            _lock: lock,
            workspace_id: workspace.into(),
            principal_id: principal.into(),
            audit,
            #[cfg(test)]
            save_fault: std::sync::atomic::AtomicU8::new(0),
            #[cfg(test)]
            audit_fail_after: std::sync::atomic::AtomicU8::new(0),
        })
    }

    pub(crate) fn authorize(&self, authority: &ReadAuthority) -> Result<(), SecretFileError> {
        if authority.workspace_id != self.workspace_id
            || authority.principal_id != self.principal_id
            || authority.policy_revision != 1
            || !managed_id(&authority.request_id)
        {
            return Err(SecretFileError::Forbidden);
        }
        self.check_directory()
    }

    fn check_directory(&self) -> Result<(), SecretFileError> {
        private_directory_meta(
            &self
                .directory
                .metadata()
                .map_err(|_| SecretFileError::Unavailable)?,
        )
    }

    pub(crate) fn read_encrypted(&self) -> Result<Option<Vec<u8>>, SecretFileError> {
        use std::io::Read;
        self.check_directory()?;
        let file = match private_open(&self.directory, "credentials.enc", libc::O_RDONLY) {
            Ok(file) => file,
            Err(SecretFileError::Unavailable) => {
                // Check ENOENT independently, not by treating all failures as
                // an empty store. Never overwrite corrupt/unauthorized data.
                match managed_open_at(&self.directory, "credentials.enc", libc::O_RDONLY, 0) {
                    Err(ManagedReadError::NotFound) => return Ok(None),
                    _ => return Err(SecretFileError::Unavailable),
                }
            }
            Err(error) => return Err(error),
        };
        if file
            .metadata()
            .map_err(|_| SecretFileError::Unavailable)?
            .len()
            > MAX_SECRET_FILE_BYTES as u64
        {
            return Err(SecretFileError::Unavailable);
        }
        let mut bytes = Vec::new();
        file.take((MAX_SECRET_FILE_BYTES + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(|_| SecretFileError::Unavailable)?;
        if bytes.len() > MAX_SECRET_FILE_BYTES {
            return Err(SecretFileError::Unavailable);
        }
        Ok(Some(bytes))
    }

    pub(crate) fn save_encrypted(&self, bytes: &[u8]) -> Result<(), SecretFileError> {
        use std::ffi::CString;
        use std::io::Write;
        use std::os::fd::AsRawFd;
        self.check_directory()?;
        if bytes.is_empty() || bytes.len() > MAX_SECRET_FILE_BYTES {
            return Err(SecretFileError::Unavailable);
        }
        match managed_open_at(&self.directory, "credentials.enc", libc::O_RDONLY, 0) {
            Ok(file) => {
                private_file_meta(&file.metadata().map_err(|_| SecretFileError::Unavailable)?)?
            }
            Err(ManagedReadError::NotFound) => {}
            Err(_) => return Err(SecretFileError::Forbidden),
        }
        let mut random = [0u8; 16];
        getrandom::fill(&mut random).map_err(|_| SecretFileError::Unavailable)?;
        let suffix: String = random.iter().map(|b| format!("{b:02x}")).collect();
        let name = format!(".encrypted-stage-{suffix}");
        let mut file = private_open(
            &self.directory,
            &name,
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL,
        )?;
        file.write_all(bytes)
            .and_then(|_| file.sync_all())
            .map_err(|_| SecretFileError::Unavailable)?;
        // Failed staging files contain ciphertext only and are preserved for
        // explicit recovery; no broad cleanup or silent evidence deletion.
        #[cfg(test)]
        if self.save_fault.load(std::sync::atomic::Ordering::SeqCst) == 1 {
            return Err(SecretFileError::Unavailable);
        }
        let src = CString::new(name).map_err(|_| SecretFileError::Unavailable)?;
        let dst = CString::new("credentials.enc").unwrap();
        if unsafe {
            libc::renameat(
                self.directory.as_raw_fd(),
                src.as_ptr(),
                self.directory.as_raw_fd(),
                dst.as_ptr(),
            )
        } != 0
        {
            return Err(SecretFileError::Unavailable);
        }
        #[cfg(test)]
        if self.save_fault.load(std::sync::atomic::Ordering::SeqCst) == 2 {
            return Err(SecretFileError::CommitUnknown);
        }
        self.directory
            .sync_all()
            .map_err(|_| SecretFileError::CommitUnknown)
    }

    pub(crate) fn audit(
        &self,
        authority: &ReadAuthority,
        action: &'static str,
        ok: bool,
        code: Option<&'static str>,
    ) -> Result<(), SecretFileError> {
        self.check_directory()?;
        #[cfg(test)]
        if self.audit_fail_after.fetch_update(
            std::sync::atomic::Ordering::SeqCst,
            std::sync::atomic::Ordering::SeqCst,
            |n| if n > 0 { Some(n - 1) } else { None },
        ) == Ok(1)
        {
            let read_only = private_open(&self.directory, ".secret-audit.jsonl", libc::O_RDONLY)?;
            self.audit.set_file(PathBuf::new(), read_only);
        }
        let mut entry = AuditEntry::new(
            &format!("v2:{}:{}", self.principal_id, authority.request_id),
            Op::Write,
            action,
        );
        entry.ok = ok;
        entry.error = code.map(str::to_owned);
        self.audit
            .record_durable(entry)
            .map_err(|_| SecretFileError::AuditUnavailable)
    }

    #[cfg(test)]
    pub(crate) fn inject_save_fault(&self, point: u8) {
        self.save_fault
            .store(point, std::sync::atomic::Ordering::SeqCst);
    }

    #[cfg(test)]
    pub(crate) fn inject_audit_failure(&self, after: u8) {
        self.audit_fail_after
            .store(after, std::sync::atomic::Ordering::SeqCst);
    }
}

#[cfg(unix)]
fn private_directory_meta(meta: &fs::Metadata) -> Result<(), SecretFileError> {
    use std::os::unix::fs::MetadataExt;
    if !meta.is_dir()
        || meta.file_type().is_symlink()
        || meta.uid() != unsafe { libc::geteuid() }
        || meta.mode() & 0o077 != 0
    {
        return Err(SecretFileError::Forbidden);
    }
    Ok(())
}

#[cfg(unix)]
pub fn validate_private_service_directory(path: &Path) -> Result<(), SecretFileError> {
    if !path.is_absolute() {
        return Err(SecretFileError::Forbidden);
    }
    private_directory_meta(&fs::symlink_metadata(path).map_err(|_| SecretFileError::Unavailable)?)
}

/// Remove only the private Unix socket created by this service instance.
#[cfg(unix)]
pub struct PrivateServiceSocketGuard {
    path: PathBuf,
    identity: (u64, u64),
}
#[cfg(unix)]
impl PrivateServiceSocketGuard {
    pub fn attach(path: &Path) -> Result<Self, SecretFileError> {
        use std::os::unix::fs::{FileTypeExt, MetadataExt, PermissionsExt};
        validate_private_service_directory(path.parent().ok_or(SecretFileError::Forbidden)?)?;
        let meta = fs::symlink_metadata(path).map_err(|_| SecretFileError::Unavailable)?;
        if !meta.file_type().is_socket() || meta.uid() != unsafe { libc::geteuid() } {
            return Err(SecretFileError::Forbidden);
        }
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))
            .map_err(|_| SecretFileError::Unavailable)?;
        Ok(Self {
            path: path.to_owned(),
            identity: (meta.dev(), meta.ino()),
        })
    }
}
#[cfg(unix)]
impl Drop for PrivateServiceSocketGuard {
    fn drop(&mut self) {
        use std::os::unix::fs::{FileTypeExt, MetadataExt};
        if let Ok(meta) = fs::symlink_metadata(&self.path) {
            if meta.file_type().is_socket() && (meta.dev(), meta.ino()) == self.identity {
                let _ = fs::remove_file(&self.path);
            }
        }
    }
}

#[cfg(unix)]
fn private_file_meta(meta: &fs::Metadata) -> Result<(), SecretFileError> {
    use std::os::unix::fs::MetadataExt;
    if !meta.is_file()
        || meta.nlink() != 1
        || meta.uid() != unsafe { libc::geteuid() }
        || meta.mode() & 0o077 != 0
    {
        return Err(SecretFileError::Forbidden);
    }
    Ok(())
}

#[cfg(unix)]
fn private_open(directory: &fs::File, name: &str, flags: i32) -> Result<fs::File, SecretFileError> {
    let file = managed_open_at(directory, name, flags, 0o600).map_err(|error| match error {
        ManagedReadError::Forbidden => SecretFileError::Forbidden,
        _ => SecretFileError::Unavailable,
    })?;
    private_file_meta(&file.metadata().map_err(|_| SecretFileError::Unavailable)?)?;
    Ok(file)
}

/// Fixed legacy env file for the independent non-root development broker.
/// Never registered as a general file/Agent tool or a SecretStore getter.
#[cfg(unix)]
pub struct LocalAgentEnvFile {
    directory: fs::File,
    audit: AuditLog,
    writer: bool,
    _lock: Option<fs::File>,
}
#[cfg(unix)]
impl LocalAgentEnvFile {
    pub fn open(path: &Path, writer: bool) -> Result<Self, SecretFileError> {
        use std::os::fd::AsRawFd;
        use std::os::unix::fs::OpenOptionsExt;
        if unsafe { libc::geteuid() } == 0
            || !path.is_absolute()
            || path.file_name().and_then(|s| s.to_str()) != Some("agent.env")
        {
            return Err(SecretFileError::Forbidden);
        }
        let parent = path.parent().ok_or(SecretFileError::Forbidden)?;
        private_directory_meta(
            &fs::symlink_metadata(parent).map_err(|_| SecretFileError::Unavailable)?,
        )?;
        let directory = fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(parent)
            .map_err(|_| SecretFileError::Unavailable)?;
        private_directory_meta(
            &directory
                .metadata()
                .map_err(|_| SecretFileError::Unavailable)?,
        )?;
        let lock = if writer {
            let file = private_open(&directory, ".agent-env.lock", libc::O_RDWR | libc::O_CREAT)?;
            if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
                return Err(SecretFileError::Busy);
            }
            Some(file)
        } else {
            None
        };
        let audit_name = if writer {
            ".agent-env-write-audit.jsonl"
        } else {
            ".agent-env-read-audit.jsonl"
        };
        let audit_file = private_open(
            &directory,
            audit_name,
            libc::O_RDWR | libc::O_APPEND | libc::O_CREAT,
        )?;
        managed_check_audit_tail(
            &audit_file,
            audit_file
                .metadata()
                .map_err(|_| SecretFileError::Unavailable)?
                .len(),
        )
        .map_err(|_| SecretFileError::AuditUnavailable)?;
        directory
            .sync_all()
            .map_err(|_| SecretFileError::Unavailable)?;
        let audit = AuditLog::new();
        audit.set_file(parent.join(audit_name), audit_file);
        Ok(Self {
            directory,
            audit,
            writer,
            _lock: lock,
        })
    }
    fn check(&self) -> Result<(), SecretFileError> {
        private_directory_meta(
            &self
                .directory
                .metadata()
                .map_err(|_| SecretFileError::Unavailable)?,
        )
    }
    fn record<T>(
        &self,
        action: &str,
        result: &Result<T, SecretFileError>,
    ) -> Result<(), SecretFileError> {
        let mut entry = AuditEntry::new("agent-local-config", Op::Write, action);
        entry.ok = result.is_ok();
        if result.is_err() {
            entry.error = Some("private configuration unavailable".into());
        }
        self.audit
            .record_durable(entry)
            .map_err(|_| SecretFileError::AuditUnavailable)
    }
    pub fn read(&self) -> Result<zeroize::Zeroizing<Vec<u8>>, SecretFileError> {
        use std::io::Read;
        let result = (|| {
            self.check()?;
            let file = match private_open(&self.directory, "agent.env", libc::O_RDONLY) {
                Ok(file) => file,
                Err(SecretFileError::Unavailable) => {
                    match managed_open_at(&self.directory, "agent.env", libc::O_RDONLY, 0) {
                        Err(ManagedReadError::NotFound) => {
                            return Ok(zeroize::Zeroizing::new(vec![]))
                        }
                        _ => return Err(SecretFileError::Unavailable),
                    }
                }
                Err(error) => return Err(error),
            };
            let mut bytes = zeroize::Zeroizing::new(Vec::new());
            file.take(128 * 1024 + 1)
                .read_to_end(&mut bytes)
                .map_err(|_| SecretFileError::Unavailable)?;
            if bytes.len() > 128 * 1024 {
                return Err(SecretFileError::Unavailable);
            }
            Ok(bytes)
        })();
        self.record("agent.env.read", &result)?;
        result
    }
    pub fn write(&self, bytes: &[u8]) -> Result<(), SecretFileError> {
        use std::ffi::CString;
        use std::io::Write;
        use std::os::fd::AsRawFd;
        let result = (|| {
            self.check()?;
            if !self.writer || bytes.len() > 128 * 1024 {
                return Err(SecretFileError::Forbidden);
            }
            // Validate an existing target before replacement; never follow aliases.
            match private_open(&self.directory, "agent.env", libc::O_RDONLY) {
                Ok(_) => {}
                Err(SecretFileError::Unavailable) => {
                    match managed_open_at(&self.directory, "agent.env", libc::O_RDONLY, 0) {
                        Err(ManagedReadError::NotFound) => {}
                        _ => return Err(SecretFileError::Unavailable),
                    }
                }
                Err(error) => return Err(error),
            }
            self.record("agent.env.write.intent", &Ok::<_, SecretFileError>(()))?;
            let mut random = [0u8; 16];
            getrandom::fill(&mut random).map_err(|_| SecretFileError::Unavailable)?;
            let name = format!(
                ".agent-env-stage-{}",
                random
                    .iter()
                    .map(|b| format!("{b:02x}"))
                    .collect::<String>()
            );
            let mut file = private_open(
                &self.directory,
                &name,
                libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL,
            )?;
            file.write_all(bytes)
                .and_then(|_| file.sync_all())
                .map_err(|_| SecretFileError::Unavailable)?;
            let src = CString::new(name).map_err(|_| SecretFileError::Unavailable)?;
            let dst = CString::new("agent.env").unwrap();
            if unsafe {
                libc::renameat(
                    self.directory.as_raw_fd(),
                    src.as_ptr(),
                    self.directory.as_raw_fd(),
                    dst.as_ptr(),
                )
            } != 0
            {
                return Err(SecretFileError::Unavailable);
            }
            self.directory
                .sync_all()
                .map_err(|_| SecretFileError::CommitUnknown)
        })();
        self.record("agent.env.write", &result)?;
        result
    }
}

#[cfg(all(test, unix))]
mod local_agent_env_tests {
    use super::*;
    use std::os::unix::fs::{symlink, PermissionsExt};

    fn fixture() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        fs::set_permissions(dir.path(), fs::Permissions::from_mode(0o700)).unwrap();
        dir
    }

    #[test]
    fn local_env_private_atomic_reload_and_exclusive_writer() {
        let dir = fixture();
        let path = dir.path().join("agent.env");
        let writer = LocalAgentEnvFile::open(&path, true).unwrap();
        assert!(matches!(
            LocalAgentEnvFile::open(&path, true),
            Err(SecretFileError::Busy)
        ));
        let reader = LocalAgentEnvFile::open(&path, false).unwrap();
        assert!(reader.read().unwrap().is_empty());
        writer.write(b"synthetic-key-first").unwrap();
        assert_eq!(&*reader.read().unwrap(), b"synthetic-key-first");
        writer.write(b"synthetic-key-second").unwrap();
        assert_eq!(&*reader.read().unwrap(), b"synthetic-key-second");
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert!(reader.write(b"forbidden").is_err());
        assert!(writer.write(&vec![0; 128 * 1024 + 1]).is_err());
        for name in [
            ".agent-env-write-audit.jsonl",
            ".agent-env-read-audit.jsonl",
        ] {
            assert!(!fs::read_to_string(dir.path().join(name))
                .unwrap()
                .contains("synthetic-key"));
        }
    }

    #[test]
    fn local_env_alias_escape_and_permission_changes_fail_closed() {
        let dir = fixture();
        let outside = fixture();
        let original = outside.path().join("private-original");
        fs::write(&original, b"must-not-change").unwrap();
        fs::set_permissions(&original, fs::Permissions::from_mode(0o600)).unwrap();
        let path = dir.path().join("agent.env");
        let writer = LocalAgentEnvFile::open(&path, true).unwrap();
        symlink(&original, &path).unwrap();
        assert!(writer.read().is_err());
        assert!(writer.write(b"escape").is_err());
        fs::remove_file(&path).unwrap();
        fs::hard_link(&original, &path).unwrap();
        assert!(writer.read().is_err());
        assert!(writer.write(b"alias").is_err());
        assert_eq!(fs::read(&original).unwrap(), b"must-not-change");
        fs::remove_file(&path).unwrap();
        writer.write(b"private").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(writer.read().is_err());
        assert!(writer.write(b"public").is_err());
        fs::set_permissions(dir.path(), fs::Permissions::from_mode(0o755)).unwrap();
        assert!(writer.read().is_err());
        assert!(LocalAgentEnvFile::open(&path, false).is_err());
        assert!(LocalAgentEnvFile::open(&outside.path().join("other.env"), false).is_err());
    }

    #[test]
    fn local_env_failed_audit_never_releases_contents_or_commits_write() {
        let dir = fixture();
        let path = dir.path().join("agent.env");
        let writer = LocalAgentEnvFile::open(&path, true).unwrap();
        writer.write(b"original").unwrap();
        // A read-only audit FD injects a durable append failure without touching user files.
        let audit = dir.path().join(".agent-env-write-audit.jsonl");
        writer
            .audit
            .set_file(audit.clone(), fs::File::open(audit).unwrap());
        assert!(matches!(
            writer.read(),
            Err(SecretFileError::AuditUnavailable)
        ));
        assert!(writer.write(b"must-not-commit").is_err());
        assert_eq!(fs::read(path).unwrap(), b"original");
    }

    #[test]
    fn private_socket_cleanup_does_not_remove_a_replacement() {
        let dir = fixture();
        let path = dir.path().join("test.sock");
        let listener = std::os::unix::net::UnixListener::bind(&path).unwrap();
        let guard = PrivateServiceSocketGuard::attach(&path).unwrap();
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        fs::remove_file(&path).unwrap();
        fs::write(&path, b"replacement").unwrap();
        drop(listener);
        drop(guard);
        assert_eq!(fs::read(path).unwrap(), b"replacement");
    }
}

/// Opt-in identity configuration is a private control asset, not business data.
/// Bootstrap callers compare these bounded bytes with their parsed config.
#[cfg(unix)]
pub fn read_private_runtime_config(
    path: &Path,
    data_root: &Path,
) -> Result<Vec<u8>, SecretFileError> {
    use std::io::Read;
    use std::os::unix::fs::OpenOptionsExt;
    if !path.is_absolute() {
        return Err(SecretFileError::Forbidden);
    }
    let canonical = fs::canonicalize(path).map_err(|_| SecretFileError::Unavailable)?;
    let root = fs::canonicalize(data_root).map_err(|_| SecretFileError::Unavailable)?;
    if canonical.starts_with(root) {
        return Err(SecretFileError::Forbidden);
    }
    let parent = path.parent().ok_or(SecretFileError::Forbidden)?;
    let name = path
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or(SecretFileError::Forbidden)?;
    private_directory_meta(
        &fs::symlink_metadata(parent).map_err(|_| SecretFileError::Unavailable)?,
    )?;
    let directory = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(parent)
        .map_err(|_| SecretFileError::Unavailable)?;
    private_directory_meta(
        &directory
            .metadata()
            .map_err(|_| SecretFileError::Unavailable)?,
    )?;
    let file = private_open(&directory, name, libc::O_RDONLY)?;
    let mut bytes = Vec::new();
    file.take(64 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| SecretFileError::Unavailable)?;
    if bytes.len() > 64 * 1024 {
        return Err(SecretFileError::Unavailable);
    }
    Ok(bytes)
}

#[cfg(all(test, unix))]
mod managed_tests {
    use super::*;
    use std::os::unix::fs::symlink;

    fn setup() -> (tempfile::TempDir, ManagedReadVault) {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join("documents")).unwrap();
        fs::create_dir(root.path().join("private")).unwrap();
        fs::write(
            root.path().join("documents/hello.md"),
            "你好\nforms@support.empf.org.hk",
        )
        .unwrap();
        fs::write(root.path().join("private/secret.txt"), "do not expose").unwrap();
        let vault =
            ManagedReadVault::open(root.path(), "w1", "local:test", &["documents".into()]).unwrap();
        (root, vault)
    }

    fn owner() -> ReadAuthority {
        ReadAuthority::new("local:test", "w1", 1, "req-test")
    }
    fn read(path: &str) -> ManagedReadOperation {
        ManagedReadOperation::Read { path: path.into() }
    }

    #[test]
    fn managed_reads_preserve_unicode_hash_and_durable_audit() {
        let (_root, vault) = setup();
        let value = vault.execute(&owner(), read("documents/hello.md")).unwrap();
        assert_eq!(value["content"], "你好\nforms@support.empf.org.hk");
        assert_eq!(
            value["sha256"],
            sha256_hex(value["content"].as_str().unwrap().as_bytes())
        );
        let (entries, total) = vault.audit.read(0, 10);
        assert_eq!(total, 1);
        assert!(entries[0].ok);
        assert_eq!(entries[0].session_id, "v2:local:test:req-test");
        assert_eq!(entries[0].sha256.as_deref(), value["sha256"].as_str());
    }

    #[test]
    fn scope_workspace_actor_and_policy_are_checked_and_denied_audited() {
        let (_root, vault) = setup();
        for authority in [
            ReadAuthority::new("another", "w1", 1, "r1"),
            ReadAuthority::new("local:test", "w2", 1, "r2"),
            ReadAuthority::new("local:test", "w1", 2, "r3"),
        ] {
            assert!(vault
                .execute(&authority, read("documents/hello.md"))
                .is_err());
        }
        assert!(matches!(
            vault.execute(&owner(), read("private/secret.txt")),
            Err(ManagedReadError::Forbidden)
        ));
        let (entries, total) = vault.audit.read(0, 10);
        assert_eq!(total, 4);
        assert!(entries.iter().all(|e| !e.ok));
    }

    #[test]
    fn traversal_absolute_empty_and_prefix_confusion_are_rejected() {
        let (_root, vault) = setup();
        for path in [
            "../outside",
            "/etc/passwd",
            "",
            ".",
            "documents/../../outside",
            "documents/../private/secret.txt",
            "documents-other/a",
            "documents\\hello.md",
        ] {
            assert!(vault.execute(&owner(), read(path)).is_err(), "path: {path}");
        }
    }

    #[test]
    fn symlink_and_hardlink_aliases_cannot_bypass_scope_or_reserved_paths() {
        let (root, vault) = setup();
        symlink(
            root.path().join("private/secret.txt"),
            root.path().join("documents/alias.txt"),
        )
        .unwrap();
        symlink(
            root.path().join("documents/hello.md"),
            root.path().join("documents/inside-link.txt"),
        )
        .unwrap();
        symlink(
            root.path().join("private"),
            root.path().join("documents/dir-link"),
        )
        .unwrap();
        fs::hard_link(
            root.path().join("private/secret.txt"),
            root.path().join("documents/hard.txt"),
        )
        .unwrap();
        for path in [
            "documents/alias.txt",
            "documents/inside-link.txt",
            "documents/dir-link/secret.txt",
            "documents/hard.txt",
        ] {
            assert!(vault.execute(&owner(), read(path)).is_err(), "path: {path}");
        }
        let value = vault
            .execute(
                &owner(),
                ManagedReadOperation::List {
                    path: "documents".into(),
                    limit: 100,
                },
            )
            .unwrap();
        assert_eq!(value["entries"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn listings_hide_internal_files_and_reserved_directories() {
        let (root, vault) = setup();
        for name in [
            ".hidden",
            "settings.json",
            "workspace.sqlite",
            "control.db",
            "agent.env",
        ] {
            fs::write(root.path().join("documents").join(name), "sensitive").unwrap();
            assert!(vault
                .execute(&owner(), read(&format!("documents/{name}")))
                .is_err());
        }
        fs::create_dir(root.path().join("documents/memory")).unwrap();
        let value = vault
            .execute(
                &owner(),
                ManagedReadOperation::List {
                    path: "documents".into(),
                    limit: 100,
                },
            )
            .unwrap();
        assert_eq!(value["entries"].as_array().unwrap().len(), 1);
        assert_eq!(value["entries"][0]["name"], "hello.md");
    }

    #[test]
    fn no_root_or_sensitive_registration_is_allowed() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join("mydata")).unwrap();
        for scope in [".", "mydata", "../escape"] {
            assert!(
                ManagedReadVault::open(root.path(), "w1", "local:test", &[scope.into()]).is_err()
            );
        }
    }

    #[test]
    fn text_and_list_budgets_are_enforced_and_truncation_explicit() {
        let (root, vault) = setup();
        let file = fs::File::create(root.path().join("documents/large.txt")).unwrap();
        file.set_len(MANAGED_MAX_TEXT_BYTES as u64 + 1).unwrap();
        assert!(matches!(
            vault.execute(&owner(), read("documents/large.txt")),
            Err(ManagedReadError::TooLarge)
        ));
        for n in 0..105 {
            fs::write(root.path().join(format!("documents/item-{n:03}.txt")), "x").unwrap();
        }
        let value = vault
            .execute(
                &owner(),
                ManagedReadOperation::List {
                    path: "documents".into(),
                    limit: 100,
                },
            )
            .unwrap();
        assert_eq!(value["entries"].as_array().unwrap().len(), 100);
        assert_eq!(value["truncated"], true);
        assert!(vault
            .execute(
                &owner(),
                ManagedReadOperation::List {
                    path: "documents".into(),
                    limit: 101
                }
            )
            .is_err());
    }

    #[test]
    fn non_regular_and_non_utf8_reads_are_rejected() {
        let (root, vault) = setup();
        fs::write(root.path().join("documents/binary.bin"), [0xff, 0xfe]).unwrap();
        assert!(matches!(
            vault.execute(&owner(), read("documents/binary.bin")),
            Err(ManagedReadError::NotUtf8)
        ));
        assert!(vault.execute(&owner(), read("documents")).is_err());
        use std::os::unix::net::UnixListener;
        let _listener = UnixListener::bind(root.path().join("documents/not-a-file.sock")).unwrap();
        assert!(vault
            .execute(&owner(), read("documents/not-a-file.sock"))
            .is_err());
    }

    #[test]
    fn failing_audit_never_releases_content_or_success_listener() {
        let (root, vault) = setup();
        let file = fs::File::open(root.path().join(AUDIT_FILE_NAME)).unwrap(); // read-only descriptor: write must fail
        vault
            .audit
            .set_file(root.path().join(AUDIT_FILE_NAME), file);
        let notifications = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let count = notifications.clone();
        vault.audit.add_listener(Arc::new(move |_| {
            count.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        }));
        assert!(matches!(
            vault.execute(&owner(), read("documents/hello.md")),
            Err(ManagedReadError::AuditUnavailable)
        ));
        assert!(matches!(
            vault.execute(&owner(), read("documents/hello.md")),
            Err(ManagedReadError::AuditUnavailable)
        ));
        assert_eq!(notifications.load(std::sync::atomic::Ordering::SeqCst), 0);
    }

    #[test]
    fn audit_symlink_is_not_followed_or_modified() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join("documents")).unwrap();
        fs::write(outside.path().join("victim"), "unchanged").unwrap();
        symlink(
            outside.path().join("victim"),
            root.path().join(AUDIT_FILE_NAME),
        )
        .unwrap();
        assert!(
            ManagedReadVault::open(root.path(), "w1", "local:test", &["documents".into()]).is_err()
        );
        assert_eq!(
            fs::read_to_string(outside.path().join("victim")).unwrap(),
            "unchanged"
        );
    }

    #[test]
    fn broad_or_hardlinked_audit_is_refused_without_permission_migration() {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let root = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join("documents")).unwrap();
        let audit_path = root.path().join(AUDIT_FILE_NAME);
        fs::write(&audit_path, "legacy audit\n").unwrap();
        fs::set_permissions(&audit_path, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(matches!(
            ManagedReadVault::open(root.path(), "w1", "local:test", &["documents".into()]),
            Err(ManagedReadError::Forbidden)
        ));
        assert_eq!(fs::metadata(&audit_path).unwrap().mode() & 0o777, 0o644);
        fs::set_permissions(&audit_path, fs::Permissions::from_mode(0o600)).unwrap();
        let alias = root.path().join("documents/audit-alias");
        fs::hard_link(&audit_path, &alias).unwrap();
        assert!(matches!(
            ManagedReadVault::open(root.path(), "w1", "local:test", &["documents".into()]),
            Err(ManagedReadError::Forbidden)
        ));
        assert_eq!(fs::read_to_string(&alias).unwrap(), "legacy audit\n");
    }

    #[test]
    fn incomplete_or_invalid_audit_tail_blocks_restart_without_repairing_data() {
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join("documents")).unwrap();
        let audit_path = root.path().join(AUDIT_FILE_NAME);
        for tail in ["{\"ts_ms\":1", "invalid-json\n"] {
            fs::write(&audit_path, tail).unwrap();
            fs::set_permissions(&audit_path, fs::Permissions::from_mode(0o600)).unwrap();
            assert!(matches!(
                ManagedReadVault::open(root.path(), "w1", "local:test", &["documents".into()]),
                Err(ManagedReadError::AuditUnavailable)
            ));
            assert_eq!(fs::read_to_string(&audit_path).unwrap(), tail);
        }
    }

    #[test]
    fn held_root_descriptor_does_not_reopen_a_replaced_root_path() {
        let parent = tempfile::tempdir().unwrap();
        let root = parent.path().join("root");
        fs::create_dir_all(root.join("documents")).unwrap();
        fs::write(root.join("documents/a.txt"), "original").unwrap();
        let vault =
            ManagedReadVault::open(&root, "w1", "local:test", &["documents".into()]).unwrap();
        fs::rename(&root, parent.path().join("old-root")).unwrap();
        fs::create_dir_all(root.join("documents")).unwrap();
        fs::write(root.join("documents/a.txt"), "replacement must not be read").unwrap();
        let value = vault.execute(&owner(), read("documents/a.txt")).unwrap();
        assert_eq!(value["content"], "original");
        assert!(
            fs::read_to_string(parent.path().join("old-root").join(AUDIT_FILE_NAME))
                .unwrap()
                .contains("req-test")
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn setup() -> (tempfile::TempDir, Vault) {
        let dir = tempfile::tempdir().unwrap();
        let vault = Vault::new();
        vault.set_root(dir.path()).unwrap();
        (dir, vault)
    }

    #[test]
    fn read_write_list_stat_delete_roundtrip() {
        let (_dir, v) = setup();
        let w = v.write_file("user", "notes/a.txt", "hello world").unwrap();
        assert_eq!(w.size, 11);
        assert_eq!(w.sha256.len(), 64);

        let r = v.read_file("user", "notes/a.txt").unwrap();
        assert_eq!(r.content, "hello world");
        assert_eq!(r.size, 11);
        assert_eq!(r.sha256, w.sha256);

        let list = v.list_dir("user", "notes").unwrap();
        assert_eq!(list.entries.len(), 1);
        assert_eq!(list.entries[0].name, "a.txt");
        assert_eq!(list.entries[0].kind, EntryKind::File);
        assert_eq!(list.entries[0].size, 11);

        let root_list = v.list_dir("user", ".").unwrap();
        assert!(root_list
            .entries
            .iter()
            .any(|e| e.name == "notes" && e.kind == EntryKind::Dir));

        let st = v.stat("user", "notes/a.txt").unwrap();
        assert_eq!(st.kind, EntryKind::File);
        assert_eq!(st.size, 11);
        assert!(st.modified_ms > 0);

        v.delete_file("user", "notes/a.txt").unwrap();
        let err = v.read_file("user", "notes/a.txt").unwrap_err();
        assert_eq!(err.code(), -32002);
    }

    #[test]
    fn compress_creates_archive_inside_vault_and_audits_write() {
        let (_dir, v) = setup();
        v.write_file("user", "docs/a.txt", "hello").unwrap();
        v.write_file("user", "docs/nested/b.txt", "world").unwrap();

        let result = v.compress("user", "docs", None).unwrap();
        assert_eq!(result.source, "docs");
        assert_eq!(result.archive, "docs.tar.gz");
        assert_eq!(result.files, 2);
        assert!(result.archive_size > 0);
        assert!(v.root().unwrap().join("docs.tar.gz").is_file());
        let entries = v.audit().read(0, 20).0;
        assert!(entries
            .iter()
            .any(|entry| entry.op == Op::Write && entry.path == "docs.tar.gz" && entry.ok));
    }

    #[test]
    fn compress_rejects_archive_inside_source() {
        let (_dir, v) = setup();
        v.write_file("user", "docs/a.txt", "hello").unwrap();
        let err = v
            .compress("user", "docs", Some("docs/archive.tar.gz"))
            .unwrap_err();
        assert!(matches!(err, VaultError::InvalidParams(_)));
    }

    #[test]
    fn dotdot_escape_rejected() {
        let (_dir, v) = setup();
        for p in ["../evil.txt", "a/../../evil.txt", ".."] {
            let e = v.write_file("user", p, "x").unwrap_err();
            assert_eq!(e.code(), -32001, "path: {p}");
        }
        let e = v.read_file("user", "../../../../etc/passwd").unwrap_err();
        assert_eq!(e.code(), -32001);
    }

    #[test]
    fn absolute_and_empty_paths_rejected() {
        let (_dir, v) = setup();
        let e = v.read_file("user", "/etc/passwd").unwrap_err();
        assert_eq!(e.code(), -32001);
        let e = v.write_file("user", "/tmp/evil.txt", "x").unwrap_err();
        assert_eq!(e.code(), -32001);
        let e = v.list_dir("user", "").unwrap_err();
        assert_eq!(e.code(), -32001);
    }

    #[cfg(unix)]
    #[test]
    fn symlink_escape_rejected() {
        let (_dir, v) = setup();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("secret.txt"), "top secret").unwrap();
        let root = v.root().unwrap();

        // Symlink to an outside file: read must be rejected.
        std::os::unix::fs::symlink(outside.path().join("secret.txt"), root.join("link.txt"))
            .unwrap();
        let e = v.read_file("user", "link.txt").unwrap_err();
        assert_eq!(e.code(), -32001);

        // Symlink to an outside dir: writing through it must be rejected.
        std::os::unix::fs::symlink(outside.path(), root.join("outdir")).unwrap();
        let e = v.write_file("user", "outdir/new.txt", "x").unwrap_err();
        assert_eq!(e.code(), -32001);
        assert!(!outside.path().join("new.txt").exists());
    }

    #[cfg(unix)]
    #[test]
    fn symlink_inside_root_allowed() {
        let (_dir, v) = setup();
        v.write_file("user", "real.txt", "inside").unwrap();
        let root = v.root().unwrap();
        std::os::unix::fs::symlink(root.join("real.txt"), root.join("alias.txt")).unwrap();
        let r = v.read_file("user", "alias.txt").unwrap();
        assert_eq!(r.content, "inside");
    }

    #[test]
    fn audit_file_hidden_and_unreachable() {
        let (_dir, v) = setup();
        v.write_file("user", "a.txt", "hi").unwrap();

        // The audit log exists on disk but is filtered from listings.
        assert!(v.root().unwrap().join(AUDIT_FILE_NAME).exists());
        let list = v.list_dir("user", ".").unwrap();
        assert!(!list.entries.iter().any(|e| e.name == AUDIT_FILE_NAME));

        // Direct read/write of the audit log is rejected with -32001.
        let e = v.read_file("user", ".vault-audit.jsonl").unwrap_err();
        assert_eq!(e.code(), -32001);
        let e = v.write_file("user", ".vault-audit.jsonl", "x").unwrap_err();
        assert_eq!(e.code(), -32001);
        let e = v.delete_file("user", "sub/.vault-audit.jsonl").unwrap_err();
        assert_eq!(e.code(), -32001);
    }

    #[test]
    fn credential_files_denied_to_agent_sessions() {
        let (_dir, v) = setup();
        for p in PROTECTED_PATHS {
            v.write_file("user", p, r#"{"secret": true}"#).unwrap();
        }

        // Agent sessions are denied every operation on credential files...
        for p in PROTECTED_PATHS {
            assert_eq!(
                v.read_file("agent-1", p).unwrap_err().code(),
                -32001,
                "read {p}"
            );
            assert_eq!(
                v.write_file("agent-1", p, "x").unwrap_err().code(),
                -32001,
                "write {p}"
            );
            assert_eq!(
                v.stat("agent-1", p).unwrap_err().code(),
                -32001,
                "stat {p}"
            );
            assert_eq!(
                v.delete_file("agent-1", p).unwrap_err().code(),
                -32001,
                "delete {p}"
            );
            // ...and the file is hidden from directory listings.
            let parent = p.rsplit_once('/').map(|(d, _)| d).unwrap();
            let name = p.rsplit('/').next().unwrap();
            let list = v.list_dir("agent-1", parent).unwrap();
            assert!(
                !list.entries.iter().any(|e| e.name == name),
                "listed {p}"
            );
        }

        // Agent searches never expose credential content.
        let results = v.search_files("agent-1", "secret").unwrap();
        assert!(
            results.matches.is_empty(),
            "agent search leaked credential matches"
        );

        // Trusted first-party sessions keep full access.
        for p in PROTECTED_PATHS {
            let r = v.read_file("user", p).unwrap();
            assert!(r.content.contains("secret"), "trusted read {p}");
        }
    }

    #[test]
    fn compress_excludes_credential_files_for_agent_sessions() {
        let (_dir, v) = setup();
        v.write_file("user", "mail/accounts.json", r#"{"imap": "secret"}"#)
            .unwrap();
        v.write_file("user", "docs/a.txt", "hello").unwrap();

        // Trusted sessions may package the credential file.
        let trusted = v.compress("user", "mail", None).unwrap();
        assert_eq!(
            trusted.files, 1,
            "trusted archive should include accounts.json"
        );
        std::fs::remove_file(v.root().unwrap().join(&trusted.archive)).unwrap();

        // Agent sessions get a filtered archive.
        let agent = v.compress("agent-1", "mail", None).unwrap();
        assert_eq!(
            agent.files, 0,
            "agent archive should exclude accounts.json"
        );
    }

    #[test]
    fn secrets_tree_denied_to_agent_sessions() {
        let (_dir, v) = setup();
        v.write_file("user", "secrets/master.key", "opaque-key-bytes")
            .unwrap();
        v.write_file("user", "secrets/mail.enc.json", r#"{"enc": "cipher"}"#)
            .unwrap();
        v.write_file("user", "docs/a.txt", "public").unwrap();

        // Agent sessions are denied every operation inside secrets/.
        for p in ["secrets/master.key", "secrets/mail.enc.json"] {
            assert_eq!(
                v.read_file("agent-1", p).unwrap_err().code(),
                -32001,
                "read {p}"
            );
            assert_eq!(
                v.read_file("user", p).unwrap().content.contains("enc") || p.contains("key"),
                true,
                "trusted read {p}"
            );
            assert_eq!(
                v.write_file("agent-1", p, "x").unwrap_err().code(),
                -32001,
                "write {p}"
            );
            assert_eq!(
                v.write_binary("agent-1", p, "eA==").unwrap_err().code(),
                -32001,
                "write_binary {p}"
            );
            assert_eq!(
                v.stat("agent-1", p).unwrap_err().code(),
                -32001,
                "stat {p}"
            );
            assert_eq!(
                v.delete_file("agent-1", p).unwrap_err().code(),
                -32001,
                "delete {p}"
            );
        }

        // The secrets/ directory itself is invisible in root listings and
        // cannot be listed by an agent session.
        let root_list = v.list_dir("agent-1", ".").unwrap();
        assert!(
            !root_list.entries.iter().any(|e| e.name == "secrets"),
            "agent listing exposed secrets/"
        );
        let root_list = v.list_dir("user", ".").unwrap();
        assert!(
            root_list.entries.iter().any(|e| e.name == "secrets"),
            "trusted listing should show secrets/"
        );
        assert_eq!(
            v.list_dir("agent-1", "secrets").unwrap_err().code(),
            -32001,
            "agent list_dir secrets"
        );

        // Agent searches never walk into the secrets/ tree.
        let results = v.search_files("agent-1", "cipher").unwrap();
        assert!(
            results.matches.is_empty(),
            "agent search leaked secrets content"
        );
        let results = v.search_files("user", "cipher").unwrap();
        assert!(
            results.matches.iter().any(|m| m.path == "secrets/mail.enc.json"),
            "trusted search should find secrets content"
        );
    }

    #[test]
    fn compress_excludes_secrets_tree_for_agent_sessions() {
        let (_dir, v) = setup();
        v.write_file("user", "secrets/master.key", "opaque-key-bytes")
            .unwrap();
        v.write_file("user", "docs/a.txt", "hello").unwrap();

        // Trusted sessions may package the secrets tree.
        let trusted = v.compress("user", ".", None).unwrap();
        assert_eq!(
            trusted.files, 2,
            "trusted archive should include secrets/ and docs/"
        );
        std::fs::remove_file(v.root().unwrap().join(&trusted.archive)).unwrap();

        // Agent archives never contain the secrets/ tree.
        let agent = v.compress("agent-1", ".", None).unwrap();
        assert_eq!(
            agent.files, 1,
            "agent archive should exclude secrets/ but keep docs/a.txt"
        );
    }

    #[test]
    fn size_limit_enforced() {
        let (_dir, v) = setup();
        let big = "x".repeat(MAX_FILE_SIZE as usize + 1);
        let e = v.write_file("user", "big.txt", &big).unwrap_err();
        assert_eq!(e.code(), -32003);

        std::fs::write(
            v.root().unwrap().join("big2.txt"),
            vec![b'x'; MAX_FILE_SIZE as usize + 1],
        )
        .unwrap();
        let e = v.read_file("user", "big2.txt").unwrap_err();
        assert_eq!(e.code(), -32003);
    }

    #[test]
    fn non_utf8_rejected() {
        let (_dir, v) = setup();
        std::fs::write(v.root().unwrap().join("bin.dat"), [0xff, 0xfe, 0x00, 0x01]).unwrap();
        let e = v.read_file("user", "bin.dat").unwrap_err();
        assert_eq!(e.code(), -32005);
    }

    #[test]
    fn root_not_set() {
        let v = Vault::new();
        let e = v.read_file("user", "a.txt").unwrap_err();
        assert_eq!(e.code(), -32004);
    }

    #[test]
    fn search_finds_matches_with_lines() {
        let (_dir, v) = setup();
        v.write_file("user", "a.txt", "foo\nbar\nfoo again")
            .unwrap();
        v.write_file("user", "sub/b.txt", "nothing\nfoo").unwrap();

        let res = v.search_files("user", "foo").unwrap();
        assert_eq!(res.matches.len(), 3);
        assert!(res.matches.iter().any(|m| m.path == "a.txt" && m.line == 1));
        assert!(res.matches.iter().any(|m| m.path == "a.txt" && m.line == 3));
        assert!(res
            .matches
            .iter()
            .any(|m| m.path == "sub/b.txt" && m.line == 2 && m.snippet == "foo"));

        // Search never surfaces the audit log itself.
        let res = v.search_files("user", "write").unwrap();
        assert!(res.matches.iter().all(|m| m.path != AUDIT_FILE_NAME));
    }

    #[test]
    fn search_capped_at_50() {
        let (_dir, v) = setup();
        let content = (0..60)
            .map(|i| format!("match line {i}"))
            .collect::<Vec<_>>()
            .join("\n");
        v.write_file("user", "many.txt", &content).unwrap();
        let res = v.search_files("user", "match").unwrap();
        assert_eq!(res.matches.len(), MAX_SEARCH_MATCHES);
    }

    #[test]
    fn audit_entries_recorded_for_success_and_failure() {
        let (_dir, v) = setup();
        v.write_file("agent-1", "doc.txt", "hello").unwrap();
        let _ = v.read_file("agent-1", "missing.txt").unwrap_err();

        let (entries, total) = v.audit().read(0, 100);
        assert_eq!(total, 2);

        // Newest first.
        let read_entry = &entries[0];
        assert_eq!(read_entry.op, Op::Read);
        assert!(!read_entry.ok);
        assert!(read_entry.error.is_some());
        assert_eq!(read_entry.session_id, "agent-1");
        assert_eq!(read_entry.path, "missing.txt");

        let write_entry = &entries[1];
        assert_eq!(write_entry.op, Op::Write);
        assert!(write_entry.ok);
        assert_eq!(write_entry.session_id, "agent-1");
        assert_eq!(write_entry.path, "doc.txt");
        assert_eq!(write_entry.sha256.as_deref().unwrap().len(), 64);
        assert_eq!(write_entry.size, Some(5));
        assert!(write_entry.ts_ms > 0);

        // Pagination: offset skips the newest entry.
        let (page, _) = v.audit().read(1, 1);
        assert_eq!(page.len(), 1);
        assert_eq!(page[0].op, Op::Write);
    }

    #[test]
    fn audit_listener_notified() {
        let (_dir, v) = setup();
        let count = Arc::new(AtomicUsize::new(0));
        let c = count.clone();
        v.audit().add_listener(Arc::new(move |_| {
            c.fetch_add(1, Ordering::SeqCst);
        }));
        v.write_file("user", "a.txt", "hi").unwrap();
        let _ = v.read_file("user", "missing.txt").unwrap_err();
        assert_eq!(count.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn error_codes_and_command_strings() {
        assert_eq!(VaultError::TooLarge.code(), -32003);
        assert_eq!(VaultError::RootNotSet.code(), -32004);
        assert_eq!(
            VaultError::UnknownMethod("vault/nope".into()).code(),
            -32601
        );
        let s = VaultError::Escape("../x".into()).to_command_string();
        assert!(s.starts_with("E32001 "), "got: {s}");
    }

    #[test]
    fn read_binary_roundtrip_and_mime() {
        let (_dir, v) = setup();
        // PNG magic bytes followed by non-UTF-8 payload.
        let bytes: Vec<u8> = vec![
            0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0xFF, 0xFE, 0x00, 0x80,
        ];
        std::fs::write(v.root().unwrap().join("img.png"), &bytes).unwrap();

        let r = v.read_binary("user", "img.png").unwrap();
        assert_eq!(r.mime, "image/png");
        assert_eq!(r.size, bytes.len() as u64);
        assert_eq!(r.sha256, sha256_hex(&bytes));
        let decoded = BASE64.decode(&r.data_base64).unwrap();
        assert_eq!(decoded, bytes, "base64 roundtrip mismatch");

        // A few more extension mappings.
        std::fs::write(v.root().unwrap().join("clip.MP4"), b"\x00").unwrap();
        assert_eq!(v.read_binary("user", "clip.MP4").unwrap().mime, "video/mp4");
        std::fs::write(v.root().unwrap().join("doc.pdf"), b"%PDF").unwrap();
        assert_eq!(
            v.read_binary("user", "doc.pdf").unwrap().mime,
            "application/pdf"
        );

        // Unknown extension falls back to octet-stream.
        std::fs::write(v.root().unwrap().join("data.xyz"), [0u8, 1, 2]).unwrap();
        let r = v.read_binary("user", "data.xyz").unwrap();
        assert_eq!(r.mime, "application/octet-stream");
    }

    #[test]
    fn read_binary_security_and_size_limit() {
        let (_dir, v) = setup();
        // Path escape and missing file behave exactly like read_file.
        let e = v.read_binary("user", "../secret.bin").unwrap_err();
        assert_eq!(e.code(), -32001);
        let e = v.read_binary("user", "missing.bin").unwrap_err();
        assert_eq!(e.code(), -32002);
        let e = v.read_binary("user", ".vault-audit.jsonl").unwrap_err();
        assert_eq!(e.code(), -32001);

        // Sparse file just over the 64 MiB limit (no real allocation).
        let path = v.root().unwrap().join("huge.bin");
        let f = std::fs::File::create(&path).unwrap();
        f.set_len(MAX_BINARY_FILE_SIZE + 1).unwrap();
        drop(f);
        let e = v.read_binary("user", "huge.bin").unwrap_err();
        assert_eq!(e.code(), -32003);

        // Root not set.
        let e = Vault::new().read_binary("user", "x.bin").unwrap_err();
        assert_eq!(e.code(), -32004);
    }

    #[test]
    fn read_binary_audited_as_read_op() {
        let (_dir, v) = setup();
        std::fs::write(v.root().unwrap().join("img.png"), [0x89, 0x50, 0xFF]).unwrap();
        let r = v.read_binary("agent-7", "img.png").unwrap();

        let (entries, _) = v.audit().read(0, 10);
        assert_eq!(entries.len(), 1);
        let entry = &entries[0];
        assert_eq!(entry.op, Op::Read, "read_binary must audit as op=read");
        assert!(entry.ok);
        assert_eq!(entry.session_id, "agent-7");
        assert_eq!(entry.path, "img.png");
        assert_eq!(entry.sha256.as_deref(), Some(r.sha256.as_str()));
        assert_eq!(entry.size, Some(3));
    }

    #[test]
    fn write_binary_roundtrip_security_and_audit() {
        let (_dir, v) = setup();
        let bytes = [0x00, 0xFF, 0x89, 0x50, 0x4E, 0x47];
        let encoded = BASE64.encode(bytes);
        let written = v
            .write_binary("mail", "mail/qq/attachments/42/01-image.png", &encoded)
            .unwrap();
        assert_eq!(written.size, bytes.len() as u64);
        assert_eq!(written.sha256, sha256_hex(&bytes));
        let read = v
            .read_binary("user", "mail/qq/attachments/42/01-image.png")
            .unwrap();
        assert_eq!(BASE64.decode(read.data_base64).unwrap(), bytes);

        let (entries, _) = v.audit().read(0, 10);
        let write_entry = entries.iter().find(|entry| entry.op == Op::Write).unwrap();
        assert_eq!(write_entry.session_id, "mail");
        assert_eq!(write_entry.path, "mail/qq/attachments/42/01-image.png");
        assert!(write_entry.ok);

        assert_eq!(
            v.write_binary("mail", "../escape.bin", &encoded)
                .unwrap_err()
                .code(),
            -32001
        );
        assert_eq!(
            v.write_binary("mail", "mail/bad.bin", "not base64!")
                .unwrap_err()
                .code(),
            -32602
        );
    }

    #[test]
    fn read_file_still_rejects_non_utf8_where_read_binary_allows() {
        let (_dir, v) = setup();
        let bytes = [0x89, 0x50, 0x4E, 0x47, 0xFF, 0xFE];
        std::fs::write(v.root().unwrap().join("img.png"), bytes).unwrap();
        // Regression: the text read keeps its UTF-8 requirement...
        let e = v.read_file("user", "img.png").unwrap_err();
        assert_eq!(e.code(), -32005);
        // ...while the binary read of the same file succeeds.
        assert!(v.read_binary("user", "img.png").is_ok());
    }
}
