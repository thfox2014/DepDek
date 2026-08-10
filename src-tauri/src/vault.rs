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

use serde::Serialize;
use sha2::{Digest, Sha256};
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
                    return Err(VaultError::Escape(format!(
                        "`..` climbs above root: {rel}"
                    )));
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
                    ancestor = ancestor
                        .parent()
                        .expect("root always exists")
                        .to_path_buf();
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
        let result = self.list_dir_inner(rel);
        self.record_audit(
            session_id,
            Op::List,
            &audit_path,
            result.as_ref().map(|_| (None, None)),
        );
        result
    }

    pub fn search_files(&self, session_id: &str, query: &str) -> Result<SearchResult, VaultError> {
        let result = self.search_files_inner(query);
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
        let result = self.stat_inner(rel);
        self.record_audit(
            session_id,
            Op::Stat,
            &audit_path,
            result.as_ref().map(|r| (None, Some(r.size))),
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

    fn list_dir_inner(&self, rel: &str) -> Result<ListDirResult, VaultError> {
        let (path, _) = self.resolve_existing(rel)?;
        if !fs::metadata(&path)?.is_dir() {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "not a directory").into());
        }
        let mut entries = Vec::new();
        for entry in fs::read_dir(&path)? {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().into_owned();
            // The audit log is invisible to all vault operations.
            if name == AUDIT_FILE_NAME {
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
            let size = if kind == EntryKind::Dir { 0 } else { meta.len() };
            entries.push(DirEntryInfo { name, kind, size });
        }
        entries.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(ListDirResult { entries })
    }

    fn search_files_inner(&self, query: &str) -> Result<SearchResult, VaultError> {
        let pair = self.root_pair()?;
        let mut matches = Vec::new();
        search_dir(&pair.root, &pair.root, query, &mut matches);
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
}

/// Recursive content search. Never follows symlinks (a symlinked directory
/// could point outside the root), skips the audit log, oversized files and
/// non-UTF-8 files, and stops at `MAX_SEARCH_MATCHES`.
fn search_dir(dir: &Path, root: &Path, query: &str, matches: &mut Vec<SearchMatch>) {
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
        if ft.is_dir() {
            search_dir(&path, root, query, matches);
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
            let rel = path
                .strip_prefix(root)
                .unwrap_or(&path)
                .components()
                .filter_map(|c| match c {
                    Component::Normal(s) => Some(s.to_string_lossy().into_owned()),
                    _ => None,
                })
                .collect::<Vec<_>>()
                .join("/");
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
        v.write_file("user", "a.txt", "foo\nbar\nfoo again").unwrap();
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
        assert_eq!(v.read_binary("user", "doc.pdf").unwrap().mime, "application/pdf");

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
