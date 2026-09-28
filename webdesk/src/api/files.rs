//! Authenticated, read-only file browsing rooted at an explicitly allowed directory.

use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::time::UNIX_EPOCH;

use axum::body::Body;
use axum::extract::{Query, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio_util::io::ReaderStream;

use super::session::{guard, ApiError};
use crate::state::AppState;

const MAX_ITEMS: usize = 500;
const MAX_SCANNED_ITEMS: usize = 10_000;
const MAX_PREVIEW_BYTES: u64 = 256 * 1024;
const MAX_DOWNLOAD_BYTES: u64 = 4 * 1024 * 1024 * 1024;

#[derive(Debug, Deserialize)]
pub struct FilesQuery {
    #[serde(default)]
    path: Option<String>,
}

#[derive(Debug, Serialize)]
struct FileItem {
    name: String,
    path: String,
    kind: &'static str,
    size_bytes: u64,
    modified_at_ms: Option<u64>,
}

/// `GET /api/files?path=relative/path`
pub async fn list(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<FilesQuery>,
) -> Result<Response, ApiError> {
    let session = protected_session(&state, &headers)?;
    let relative = query.path.unwrap_or_default();
    let result = list_directory(&state, &relative);
    state.audit.record(
        "files.list",
        session.user,
        &session.ip,
        result.is_ok(),
        json!({ "path": relative, "count": result.as_ref().map(|items| items.0.len()).unwrap_or(0) }),
    );
    let (root_name, items, truncated) = result?;
    Ok(Json(json!({
        "root_name": root_name,
        "path": relative,
        "parent_path": parent_path(&relative),
        "items": items,
        "truncated": truncated,
    }))
    .into_response())
}

/// `GET /api/files/preview?path=relative/file.txt` — text-only, capped preview.
pub async fn preview(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<FilesQuery>,
) -> Result<Response, ApiError> {
    let session = protected_session(&state, &headers)?;
    let relative = query.path.unwrap_or_default();
    let result = read_preview(&state, &relative).await;
    state.audit.record(
        "files.preview",
        session.user,
        &session.ip,
        result.is_ok(),
        json!({ "path": relative }),
    );
    Ok(Json(json!({ "content": result? })).into_response())
}

/// `GET /api/files/download?path=relative/file.bin`
pub async fn download(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<FilesQuery>,
) -> Result<Response, ApiError> {
    let session = protected_session(&state, &headers)?;
    let relative = query.path.unwrap_or_default();
    let file_result = open_download(&state, &relative).await;
    state.audit.record(
        "files.download",
        session.user,
        &session.ip,
        file_result.is_ok(),
        json!({ "path": relative }),
    );
    let (file, size, filename) = file_result?;
    let encoded_name = encode_filename(&filename);
    let mut response = Response::new(Body::from_stream(ReaderStream::new(file)));
    *response.status_mut() = StatusCode::OK;
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/octet-stream"),
    );
    response.headers_mut().insert(
        header::CONTENT_LENGTH,
        HeaderValue::from_str(&size.to_string()).expect("numeric content length"),
    );
    response.headers_mut().insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_str(&format!("attachment; filename*=UTF-8''{encoded_name}"))
            .expect("encoded filename is ASCII"),
    );
    response.headers_mut().insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    Ok(response)
}

fn protected_session(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<crate::auth::Session, ApiError> {
    if state.insecure_no_auth {
        return Err(ApiError::forbidden("文件管理在无认证调试模式下已禁用"));
    }
    guard(state, headers)
}

fn root_dir(state: &AppState) -> Result<PathBuf, ApiError> {
    let configured = state.config.resolved_files_root().ok_or_else(|| {
        ApiError::unavailable("尚未配置文件管理目录；请设置 webdesk.toml 的 files_root")
    })?;
    std::fs::canonicalize(configured)
        .map_err(|_| ApiError::unavailable("文件管理目录不可读取或不存在"))
}

fn resolve_path(root: &Path, relative: &str) -> Result<PathBuf, ApiError> {
    if relative.len() > 4096 || relative.contains('\0') {
        return Err(ApiError::bad_request("文件路径无效"));
    }
    let mut target = root.to_path_buf();
    for component in Path::new(relative).components() {
        let Component::Normal(part) = component else {
            return Err(ApiError::bad_request(
                "只允许访问文件管理根目录内的相对路径",
            ));
        };
        let name = part.to_string_lossy();
        if name.starts_with('.') || name.is_empty() {
            return Err(ApiError::not_found("文件或文件夹不存在"));
        }
        target.push(part);
        let metadata = std::fs::symlink_metadata(&target)
            .map_err(|_| ApiError::not_found("文件或文件夹不存在"))?;
        if metadata.file_type().is_symlink() {
            return Err(ApiError::forbidden("文件管理不跟随符号链接"));
        }
    }
    let canonical =
        std::fs::canonicalize(&target).map_err(|_| ApiError::not_found("文件或文件夹不存在"))?;
    if !canonical.starts_with(root) {
        return Err(ApiError::forbidden("路径超出文件管理根目录"));
    }
    Ok(canonical)
}

fn list_directory(
    state: &AppState,
    relative: &str,
) -> Result<(String, Vec<FileItem>, bool), ApiError> {
    let root = root_dir(state)?;
    let target = resolve_path(&root, relative)?;
    if !target.is_dir() {
        return Err(ApiError::bad_request("指定路径不是文件夹"));
    }
    let root_name = root
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("文件")
        .to_string();
    let mut items = Vec::new();
    let mut scanned = 0;
    let mut truncated = false;
    let entries =
        std::fs::read_dir(&target).map_err(|_| ApiError::unavailable("无法读取此文件夹"))?;
    for entry in entries {
        let entry = entry.map_err(|_| ApiError::unavailable("读取文件夹条目失败"))?;
        scanned += 1;
        if scanned > MAX_SCANNED_ITEMS {
            truncated = true;
            break;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        let file_type = entry
            .file_type()
            .map_err(|_| ApiError::unavailable("读取文件属性失败"))?;
        if file_type.is_symlink() || (!file_type.is_dir() && !file_type.is_file()) {
            continue;
        }
        let metadata = entry
            .metadata()
            .map_err(|_| ApiError::unavailable("读取文件属性失败"))?;
        let item_path = if relative.is_empty() {
            name.clone()
        } else {
            format!("{relative}/{name}")
        };
        items.push(FileItem {
            name,
            path: item_path,
            kind: if file_type.is_dir() {
                "directory"
            } else {
                "file"
            },
            size_bytes: if file_type.is_file() {
                metadata.len()
            } else {
                0
            },
            modified_at_ms: metadata
                .modified()
                .ok()
                .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                .map(|duration| duration.as_millis().min(u64::MAX as u128) as u64),
        });
    }
    items.sort_by(|left, right| {
        (right.kind == "directory")
            .cmp(&(left.kind == "directory"))
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
    });
    if items.len() > MAX_ITEMS {
        items.truncate(MAX_ITEMS);
        truncated = true;
    }
    Ok((root_name, items, truncated))
}

async fn read_preview(state: &AppState, relative: &str) -> Result<String, ApiError> {
    if !is_text_preview(relative) {
        return Err(ApiError::bad_request("仅支持预览常见文本文件"));
    }
    let root = root_dir(state)?;
    let path = resolve_path(&root, relative)?;
    let metadata = tokio::fs::metadata(&path)
        .await
        .map_err(|_| ApiError::not_found("文件不存在"))?;
    if !metadata.is_file() || metadata.len() > MAX_PREVIEW_BYTES {
        return Err(ApiError::bad_request(
            "文件过大，无法在线预览（上限 256 KiB）",
        ));
    }
    let bytes = tokio::fs::read(path)
        .await
        .map_err(|_| ApiError::unavailable("读取文件失败"))?;
    String::from_utf8(bytes).map_err(|_| ApiError::bad_request("文件不是有效的 UTF-8 文本"))
}

async fn open_download(
    state: &AppState,
    relative: &str,
) -> Result<(tokio::fs::File, u64, String), ApiError> {
    let root = root_dir(state)?;
    let path = resolve_path(&root, relative)?;
    let file = tokio::fs::File::open(&path)
        .await
        .map_err(|_| ApiError::not_found("文件不存在"))?;
    let metadata = file
        .metadata()
        .await
        .map_err(|_| ApiError::unavailable("读取文件属性失败"))?;
    if !metadata.is_file() {
        return Err(ApiError::bad_request("只能下载普通文件"));
    }
    if metadata.len() > MAX_DOWNLOAD_BYTES {
        return Err(ApiError::bad_request("单个文件下载上限为 4 GiB"));
    }
    let filename = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("download")
        .to_string();
    Ok((file, metadata.len(), filename))
}

fn parent_path(relative: &str) -> Option<String> {
    let path = Path::new(relative);
    let parent = path.parent()?.to_string_lossy().into_owned();
    (!parent.is_empty()).then_some(parent)
}

fn is_text_preview(relative: &str) -> bool {
    let extension = Path::new(relative)
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    matches!(
        extension.as_str(),
        "txt"
            | "md"
            | "markdown"
            | "csv"
            | "json"
            | "yaml"
            | "yml"
            | "toml"
            | "log"
            | "ini"
            | "xml"
            | "html"
            | "css"
            | "js"
            | "ts"
            | "rs"
            | "py"
            | "sh"
    )
}

fn encode_filename(value: &str) -> String {
    let mut encoded = String::new();
    for byte in value.as_bytes() {
        if byte.is_ascii_alphanumeric() || b"!#$&+-.^_`|~".contains(byte) {
            encoded.push(*byte as char);
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;
    use tokio::io::AsyncReadExt;

    fn test_state(root: &Path) -> AppState {
        let mut config = crate::config::Config::from_toml("").unwrap();
        config.files_root = Some(root.to_path_buf());
        AppState {
            audit: crate::audit::AuditLog::new(&root.join("../audit-test.jsonl")),
            sessions: crate::auth::SessionStore::new(3600, 3600),
            throttle: crate::auth::LoginThrottle::new(5),
            metrics: crate::metrics::Sampler::new(2_000, 10).shared(),
            version: "test".into(),
            started_ms: crate::util::now_ms(),
            insecure_no_auth: false,
            config,
        }
    }

    #[test]
    fn paths_are_confined_to_root_and_reject_hidden_or_symlink_targets() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::create_dir(temp.path().join("docs")).unwrap();
        std::fs::write(temp.path().join("docs/readme.md"), "hello").unwrap();
        symlink("/etc", temp.path().join("outside")).unwrap();
        let root = std::fs::canonicalize(temp.path()).unwrap();

        assert_eq!(
            resolve_path(&root, "docs/readme.md").unwrap(),
            root.join("docs/readme.md")
        );
        assert_eq!(
            resolve_path(&root, "../etc/passwd")
                .unwrap_err()
                .into_response()
                .status(),
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            resolve_path(&root, ".secret")
                .unwrap_err()
                .into_response()
                .status(),
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            resolve_path(&root, "outside/passwd")
                .unwrap_err()
                .into_response()
                .status(),
            StatusCode::FORBIDDEN
        );
    }

    #[test]
    fn parent_path_and_preview_allowlist_are_bounded() {
        assert_eq!(
            parent_path("docs/notes/readme.md"),
            Some("docs/notes".into())
        );
        assert_eq!(parent_path("readme.md"), None);
        assert!(is_text_preview("notes.md"));
        assert!(!is_text_preview("photo.jpg"));
        assert_eq!(encode_filename("项目 1.md"), "%E9%A1%B9%E7%9B%AE%201.md");
    }

    #[test]
    fn listing_hides_dotfiles_and_symlinks_and_sorts_folders_first() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::create_dir(temp.path().join("B folder")).unwrap();
        std::fs::write(temp.path().join("z.txt"), "z").unwrap();
        std::fs::write(temp.path().join(".secret"), "secret").unwrap();
        symlink("/etc/passwd", temp.path().join("linked-file")).unwrap();
        let state = test_state(temp.path());

        let (root_name, items, truncated) = list_directory(&state, "").unwrap();
        assert_eq!(
            root_name,
            temp.path().file_name().unwrap().to_string_lossy()
        );
        assert!(!truncated);
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].name, "B folder");
        assert_eq!(items[0].kind, "directory");
        assert_eq!(items[1].name, "z.txt");
    }

    #[tokio::test]
    async fn preview_and_download_are_scoped_to_supported_regular_files() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::write(temp.path().join("readme.md"), "safe text").unwrap();
        std::fs::write(temp.path().join("payload.bin"), [0u8, 1, 2, 3]).unwrap();
        let state = test_state(temp.path());

        assert_eq!(
            read_preview(&state, "readme.md").await.unwrap(),
            "safe text"
        );
        assert!(read_preview(&state, "payload.bin").await.is_err());
        let (mut file, size, name) = open_download(&state, "payload.bin").await.unwrap();
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes).await.unwrap();
        assert_eq!(size, 4);
        assert_eq!(name, "payload.bin");
        assert_eq!(bytes, [0, 1, 2, 3]);
    }
}
