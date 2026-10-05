//! Static SPA delivery.
//!
//! Production builds embed `web/dist` into the binary with `rust-embed`, so the
//! console is a single file to deploy. During frontend work, `web_root` in the
//! config serves the same tree from disk instead.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use axum::body::Body;
use axum::extract::State;
use axum::http::{header, HeaderValue, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use rust_embed::RustEmbed;
use serde_json::json;

use crate::state::AppState;

#[derive(RustEmbed)]
#[folder = "web/dist"]
struct Assets;

/// Fallback handler: static files, then SPA index, then JSON 404 for `/api/*`.
pub async fn serve(State(state): State<Arc<AppState>>, uri: Uri) -> Response {
    let requested = uri.path().trim_start_matches('/');
    let requested = if requested.is_empty() {
        "index.html"
    } else {
        requested
    };

    // Never let the SPA fallback swallow an unknown API route: the client wants
    // JSON, and a 200 with HTML would look like a success.
    if requested.starts_with("api/") {
        return (
            StatusCode::NOT_FOUND,
            axum::Json(json!({ "error": format!("未知接口 /{requested}") })),
        )
            .into_response();
    }

    if let Some(response) = read_asset(state.config.web_root.as_ref(), requested).await {
        return response;
    }
    match read_asset(state.config.web_root.as_ref(), "index.html").await {
        Some(response) => response,
        None => (StatusCode::NOT_FOUND, "webdesk 前端未构建").into_response(),
    }
}

async fn read_asset(web_root: Option<&PathBuf>, path: &str) -> Option<Response> {
    let (bytes, mime) = match web_root {
        Some(root) => {
            let candidate = safe_join(root, path)?;
            let bytes = tokio::fs::read(&candidate).await.ok()?;
            let mime = mime_guess::from_path(&candidate).first_or_octet_stream();
            (bytes, mime)
        }
        None => {
            let asset = Assets::get(path)?;
            let mime = mime_guess::from_path(path).first_or_octet_stream();
            (asset.data.into_owned(), mime)
        }
    };

    let cache = if path.starts_with("assets/") {
        "public, max-age=31536000, immutable"
    } else {
        "no-cache"
    };
    let mut response = Response::new(Body::from(bytes));
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_str(mime.as_ref())
            .unwrap_or_else(|_| HeaderValue::from_static("application/octet-stream")),
    );
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static(cache));
    Some(response)
}

/// Reject `..` traversal when serving from a development `web_root`.
fn safe_join(root: &Path, path: &str) -> Option<PathBuf> {
    if path.contains("..") {
        return None;
    }
    Some(root.join(path))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedded_index_is_always_present() {
        // build.rs writes a placeholder, so a fresh clone still compiles and serves.
        assert!(Assets::get("index.html").is_some());
    }

    #[test]
    fn traversal_is_rejected_for_disk_serving() {
        let root = PathBuf::from("/tmp/webdesk");
        assert!(safe_join(&root, "assets/app.js").is_some());
        assert!(safe_join(&root, "../../etc/passwd").is_none());
    }
}
