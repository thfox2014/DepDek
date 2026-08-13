//! Read-only Obsidian vault connector.
//!
//! Obsidian notes live outside the selected DepDek Home, so they use a
//! separate canonical root and never share the writable Vault resolver. This
//! module deliberately exposes only Markdown listing/reading; it excludes
//! Obsidian's internal `.obsidian` and trash directories and never writes to
//! the selected folder.

use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, RwLock};

use serde::Serialize;

use crate::audit::{AuditEntry, AuditLog, Op};
use crate::vault::{sha256_hex, MAX_FILE_SIZE};

const MAX_NOTES: usize = 5000;
const MAX_DEPTH: usize = 32;

#[derive(Debug, Serialize)]
pub struct ObsidianNote {
    pub path: String,
    pub title: String,
    pub folder: String,
    pub size: u64,
    pub modified_ms: u64,
}

#[derive(Debug, Serialize)]
pub struct ObsidianListResult {
    pub notes: Vec<ObsidianNote>,
}

#[derive(Debug, Serialize)]
pub struct ObsidianReadResult {
    pub path: String,
    pub content: String,
    pub size: u64,
    pub sha256: String,
}

#[derive(Clone, Default)]
pub struct ObsidianStore {
    root: Arc<RwLock<Option<PathBuf>>>,
    audit: AuditLog,
}

impl ObsidianStore {
    pub fn new(audit: AuditLog) -> Self {
        Self {
            root: Arc::new(RwLock::new(None)),
            audit,
        }
    }

    pub fn set_root(&self, path: &Path) -> Result<PathBuf, String> {
        let canonical =
            fs::canonicalize(path).map_err(|error| format!("无法连接 Obsidian Vault：{error}"))?;
        if !canonical.is_dir() {
            return Err("选择的路径不是文件夹".to_string());
        }
        if canonical
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| matches!(name, ".obsidian" | ".trash" | ".git"))
        {
            return Err("不能把 Obsidian 内部目录作为 Vault".to_string());
        }
        *self.root.write().unwrap() = Some(canonical.clone());
        self.record(Op::Stat, "obsidian", true, None, None, None);
        Ok(canonical)
    }

    pub fn clear_root(&self) {
        *self.root.write().unwrap() = None;
        self.record(Op::Stat, "obsidian", true, None, None, None);
    }

    pub fn root(&self) -> Option<PathBuf> {
        self.root.read().unwrap().clone()
    }

    pub fn list_notes(&self, query: Option<&str>) -> Result<ObsidianListResult, String> {
        let root = self
            .root()
            .ok_or_else(|| "尚未连接 Obsidian Vault".to_string())?;
        let mut notes = Vec::new();
        let result = walk_notes(&root, &root, 0, query.unwrap_or(""), &mut notes);
        if let Err(error) = result {
            self.record(Op::List, "obsidian", false, None, None, Some(error.clone()));
            return Err(error);
        }
        notes.sort_by(|a, b| a.path.to_lowercase().cmp(&b.path.to_lowercase()));
        self.record(Op::List, "obsidian", true, None, None, None);
        Ok(ObsidianListResult { notes })
    }

    pub fn read_note(&self, rel: &str) -> Result<ObsidianReadResult, String> {
        let root = self
            .root()
            .ok_or_else(|| "尚未连接 Obsidian Vault".to_string())?;
        let normalized = normalize_rel(rel)?;
        if !is_markdown(&normalized) || is_hidden_area(&normalized) {
            self.record(
                Op::Read,
                &format!("obsidian/{normalized}"),
                false,
                None,
                None,
                Some("只允许读取 Markdown 笔记".to_string()),
            );
            return Err("只允许读取 Markdown 笔记".to_string());
        }
        let candidate = root.join(&normalized);
        let link_metadata = fs::symlink_metadata(&candidate).map_err(|error| {
            let message = format!("读取 Obsidian 笔记失败：{error}");
            self.record(
                Op::Read,
                &format!("obsidian/{normalized}"),
                false,
                None,
                None,
                Some(message.clone()),
            );
            message
        })?;
        if link_metadata.file_type().is_symlink() {
            self.record(
                Op::Read,
                &format!("obsidian/{normalized}"),
                false,
                None,
                None,
                Some("不读取 Obsidian 符号链接笔记".to_string()),
            );
            return Err("不读取 Obsidian 符号链接笔记".to_string());
        }
        let canonical = fs::canonicalize(&candidate).map_err(|error| {
            let message = format!("读取 Obsidian 笔记失败：{error}");
            self.record(
                Op::Read,
                &format!("obsidian/{normalized}"),
                false,
                None,
                None,
                Some(message.clone()),
            );
            message
        })?;
        if !canonical.starts_with(&root) {
            self.record(
                Op::Read,
                &format!("obsidian/{normalized}"),
                false,
                None,
                None,
                Some("路径越出 Obsidian Vault".to_string()),
            );
            return Err("路径越出 Obsidian Vault".to_string());
        }
        let metadata =
            fs::metadata(&canonical).map_err(|error| format!("读取 Obsidian 笔记失败：{error}"))?;
        if !metadata.is_file() {
            return Err("选择的 Obsidian 路径不是文件".to_string());
        }
        if metadata.len() > MAX_FILE_SIZE {
            return Err("Obsidian 笔记超过 10 MiB 限制".to_string());
        }
        let bytes =
            fs::read(&canonical).map_err(|error| format!("读取 Obsidian 笔记失败：{error}"))?;
        let content =
            String::from_utf8(bytes).map_err(|_| "Obsidian 笔记不是 UTF-8 文本".to_string())?;
        let size = content.len() as u64;
        let sha256 = sha256_hex(content.as_bytes());
        self.record(
            Op::Read,
            &format!("obsidian/{normalized}"),
            true,
            Some(sha256.clone()),
            Some(size),
            None,
        );
        Ok(ObsidianReadResult {
            path: normalized,
            content,
            size,
            sha256,
        })
    }

    fn record(
        &self,
        op: Op,
        path: &str,
        ok: bool,
        sha256: Option<String>,
        size: Option<u64>,
        error: Option<String>,
    ) {
        let mut entry = AuditEntry::new("user", op, path);
        entry.ok = ok;
        entry.sha256 = sha256;
        entry.size = size;
        entry.error = error;
        self.audit.record(entry);
    }
}

fn is_markdown(path: &str) -> bool {
    matches!(
        Path::new(path)
            .extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| ext.to_ascii_lowercase())
            .as_deref(),
        Some("md") | Some("markdown")
    )
}

fn is_hidden_area(path: &str) -> bool {
    path.split('/')
        .any(|part| part == ".obsidian" || part == ".trash" || part == ".git")
}

fn normalize_rel(rel: &str) -> Result<String, String> {
    if rel.is_empty() || Path::new(rel).is_absolute() {
        return Err("Obsidian 笔记路径无效".to_string());
    }
    let mut parts = Vec::new();
    for component in Path::new(rel).components() {
        match component {
            Component::CurDir => {}
            Component::Normal(part) => {
                let value = part
                    .to_str()
                    .ok_or_else(|| "Obsidian 路径不是 UTF-8".to_string())?;
                parts.push(value.to_string());
            }
            Component::ParentDir => {
                if parts.pop().is_none() {
                    return Err("Obsidian 路径越出 Vault".to_string());
                }
            }
            _ => return Err("Obsidian 路径无效".to_string()),
        }
    }
    let normalized = parts.join("/");
    if normalized.is_empty() {
        return Err("Obsidian 路径无效".to_string());
    }
    Ok(normalized)
}

fn walk_notes(
    root: &Path,
    directory: &Path,
    depth: usize,
    query: &str,
    notes: &mut Vec<ObsidianNote>,
) -> Result<(), String> {
    if depth > MAX_DEPTH || notes.len() >= MAX_NOTES {
        return Ok(());
    }
    let entries =
        fs::read_dir(directory).map_err(|error| format!("扫描 Obsidian Vault 失败：{error}"))?;
    for entry in entries {
        if notes.len() >= MAX_NOTES {
            break;
        }
        let entry = entry.map_err(|error| format!("扫描 Obsidian Vault 失败：{error}"))?;
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        let path = entry.path();
        let link_metadata = fs::symlink_metadata(&path)
            .map_err(|error| format!("读取 Obsidian 元数据失败：{error}"))?;
        if link_metadata.file_type().is_symlink() {
            continue;
        }
        let metadata = entry
            .metadata()
            .map_err(|error| format!("读取 Obsidian 元数据失败：{error}"))?;
        // Do not traverse symlinks outside the selected Obsidian Vault.
        let canonical = fs::canonicalize(&path)
            .map_err(|error| format!("读取 Obsidian 元数据失败：{error}"))?;
        if !canonical.starts_with(root) {
            continue;
        }
        if metadata.is_dir() {
            walk_notes(root, &path, depth + 1, query, notes)?;
            continue;
        }
        let rel = path
            .strip_prefix(root)
            .map_err(|_| "Obsidian 路径解析失败".to_string())?
            .to_string_lossy()
            .replace('\\', "/");
        if !is_markdown(&rel) || is_hidden_area(&rel) {
            continue;
        }
        let title = Path::new(&name)
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or(&name)
            .to_string();
        if !query.is_empty()
            && !rel.to_lowercase().contains(&query.to_lowercase())
            && !title.to_lowercase().contains(&query.to_lowercase())
        {
            continue;
        }
        let modified_ms = metadata
            .modified()
            .ok()
            .and_then(|value| value.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|value| value.as_millis() as u64)
            .unwrap_or(0);
        let folder = Path::new(&rel)
            .parent()
            .map(|value| value.to_string_lossy().replace('\\', "/"))
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "根目录".to_string());
        notes.push(ObsidianNote {
            path: rel,
            title,
            folder,
            size: metadata.len(),
            modified_ms,
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn lists_markdown_and_reads_note_without_touching_hidden_area() {
        let directory = tempdir().unwrap();
        fs::create_dir_all(directory.path().join("项目")).unwrap();
        fs::create_dir_all(directory.path().join(".obsidian")).unwrap();
        fs::write(directory.path().join("项目/计划.md"), "# 计划\n").unwrap();
        fs::write(directory.path().join(".obsidian/app.json"), "{}").unwrap();
        let audit = AuditLog::new();
        audit.set_root(directory.path()).unwrap();
        let store = ObsidianStore::new(audit);
        store.set_root(directory.path()).unwrap();
        let notes = store.list_notes(None).unwrap().notes;
        assert_eq!(notes.len(), 1);
        assert_eq!(notes[0].path, "项目/计划.md");
        assert_eq!(store.read_note("项目/计划.md").unwrap().content, "# 计划\n");
        assert!(store.read_note(".obsidian/app.json").is_err());
    }

    #[test]
    fn rejects_traversal_and_non_markdown_reads() {
        let directory = tempdir().unwrap();
        fs::write(directory.path().join("note.md"), "note").unwrap();
        fs::write(directory.path().join("secret.txt"), "secret").unwrap();
        let audit = AuditLog::new();
        audit.set_root(directory.path()).unwrap();
        let store = ObsidianStore::new(audit);
        store.set_root(directory.path()).unwrap();
        assert!(store.read_note("../secret.txt").is_err());
        assert!(store.read_note("secret.txt").is_err());
    }
}
