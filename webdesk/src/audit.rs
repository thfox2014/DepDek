//! Append-only audit log for the web console.
//!
//! Mirrors the desktop vault convention (`.vault-audit.jsonl`): one JSON object
//! per line, never rewritten, and an audit failure never blocks a request —
//! it is logged to stderr instead.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde_json::{json, Value};

use crate::util::iso_now;

#[derive(Debug)]
pub struct AuditLog {
    path: PathBuf,
    lock: Mutex<()>,
}

impl AuditLog {
    pub fn new(path: &Path) -> Self {
        if let Some(parent) = path.parent() {
            if let Err(error) = fs::create_dir_all(parent) {
                eprintln!("[webdesk] 无法创建审计目录 {}：{error}", parent.display());
            }
        }
        Self {
            path: path.to_path_buf(),
            lock: Mutex::new(()),
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Record one action. `action` uses the `domain.verb` convention
    /// (`login.success`, `login.failure`, `session.logout`, ...).
    pub fn record(&self, action: &str, actor: &str, ip: &str, ok: bool, detail: Value) {
        let entry = json!({
            "ts": iso_now(),
            "ts_ms": crate::util::now_ms(),
            "action": action,
            "actor": actor,
            "ip": ip,
            "ok": ok,
            "detail": detail,
        });
        let _guard = self.lock.lock().expect("audit mutex");
        let line = format!("{entry}\n");
        match OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)
        {
            Ok(mut file) => {
                if let Err(error) = file.write_all(line.as_bytes()) {
                    eprintln!("[webdesk] 审计写入失败 {}：{error}", self.path.display());
                }
            }
            Err(error) => {
                eprintln!(
                    "[webdesk] 无法打开审计文件 {}：{error}",
                    self.path.display()
                );
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn appends_one_json_object_per_line() {
        let dir = tempfile::tempdir().unwrap();
        let log = AuditLog::new(&dir.path().join("nested/webdesk-audit.jsonl"));
        log.record(
            "login.failure",
            "anon",
            "10.0.0.1",
            false,
            json!({"reason": "bad-password"}),
        );
        log.record("login.success", "admin", "10.0.0.1", true, Value::Null);

        let raw = std::fs::read_to_string(log.path()).unwrap();
        let lines: Vec<&str> = raw.lines().collect();
        assert_eq!(lines.len(), 2);
        let first: Value = serde_json::from_str(lines[0]).unwrap();
        assert_eq!(first["action"], "login.failure");
        assert_eq!(first["ok"], false);
        assert_eq!(first["detail"]["reason"], "bad-password");
        let second: Value = serde_json::from_str(lines[1]).unwrap();
        assert_eq!(second["actor"], "admin");
    }
}
