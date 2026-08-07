//! Append-only JSONL audit log (contract section 5).
//!
//! Every vault operation, successful or not, produces exactly one
//! `AuditEntry` line in `<vault root>/.vault-audit.jsonl`. Listeners are
//! notified after each write so the Tauri layer can emit `vault://audit`.

use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};

/// Audit log file name; hidden from and unreachable through all vault ops.
pub const AUDIT_FILE_NAME: &str = ".vault-audit.jsonl";

/// Vault operation kinds (contract section 3, `AuditEntry.op`).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Op {
    Read,
    Write,
    List,
    Search,
    Delete,
    Stat,
}

/// One audit record; shape fixed by contract section 3.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AuditEntry {
    pub ts_ms: i64,
    pub session_id: String,
    pub op: Op,
    pub path: String,
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
}

impl AuditEntry {
    pub fn new(session_id: &str, op: Op, path: &str) -> Self {
        let ts_ms = time::OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000;
        Self {
            ts_ms: ts_ms as i64,
            session_id: session_id.to_string(),
            op,
            path: path.to_string(),
            ok: false,
            error: None,
            sha256: None,
            size: None,
        }
    }
}

pub type AuditListener = Arc<dyn Fn(&AuditEntry) + Send + Sync>;

#[derive(Clone, Default)]
pub struct AuditLog {
    inner: Arc<Mutex<AuditLogInner>>,
}

#[derive(Default)]
struct AuditLogInner {
    path: Option<std::path::PathBuf>,
    file: Option<File>,
    listeners: Vec<AuditListener>,
}

impl AuditLog {
    pub fn new() -> Self {
        Self::default()
    }

    /// Point the log at `<root>/.vault-audit.jsonl`, creating it if needed.
    pub fn set_root(&self, root: &Path) -> std::io::Result<()> {
        let path = root.join(AUDIT_FILE_NAME);
        let file = OpenOptions::new().create(true).append(true).open(&path)?;
        let mut inner = self.inner.lock().unwrap();
        inner.path = Some(path);
        inner.file = Some(file);
        Ok(())
    }

    pub fn add_listener(&self, listener: AuditListener) {
        self.inner.lock().unwrap().listeners.push(listener);
    }

    /// Append one entry and notify listeners. A file write failure does not
    /// prevent listener notification (the log must never break vault ops).
    pub fn record(&self, entry: AuditEntry) {
        let mut inner = self.inner.lock().unwrap();
        if let Some(file) = &mut inner.file {
            if let Ok(mut line) = serde_json::to_string(&entry) {
                line.push('\n');
                let _ = file.write_all(line.as_bytes());
                let _ = file.flush();
            }
        }
        for listener in &inner.listeners {
            listener(&entry);
        }
    }

    /// Read entries newest-first with pagination. Returns `(entries, total)`.
    pub fn read(&self, offset: usize, limit: usize) -> (Vec<AuditEntry>, usize) {
        let inner = self.inner.lock().unwrap();
        let Some(path) = &inner.path else {
            return (Vec::new(), 0);
        };
        let Ok(file) = File::open(path) else {
            return (Vec::new(), 0);
        };
        let mut entries: Vec<AuditEntry> = BufReader::new(file)
            .lines()
            .map_while(Result::ok)
            .filter_map(|line| serde_json::from_str(&line).ok())
            .collect();
        let total = entries.len();
        entries.reverse();
        let page = entries.into_iter().skip(offset).take(limit).collect();
        (page, total)
    }
}
