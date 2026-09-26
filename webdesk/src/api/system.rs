//! System information endpoints: health, summary, history, disks, network,
//! audit tail.

use std::io::{Read, Seek, SeekFrom};
use std::sync::Arc;

use axum::extract::{Query, State};
use axum::http::HeaderMap;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use super::session::{guard, ApiError, VERSION};
use crate::state::AppState;

/// `GET /api/health` — unauthenticated liveness probe for systemd/monitoring.
pub async fn health(State(state): State<Arc<AppState>>) -> Response {
    let metrics = state.metrics.read().expect("metrics lock");
    Json(json!({
        "status": "ok",
        "version": VERSION,
        "uptime_secs": state.uptime_secs(),
        "samples": metrics.sample_count,
        "sampled_at_ms": metrics.sampled_at_ms,
        "password_configured": !state.config.auth.password_hash.trim().is_empty(),
        "insecure_no_auth": state.insecure_no_auth,
        "tls": state.config.tls_enabled(),
    }))
    .into_response()
}

#[derive(Debug, Deserialize)]
pub struct WindowQuery {
    #[serde(default)]
    pub window: Option<usize>,
}

/// `GET /api/system/summary`
pub async fn summary(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    guard(&state, &headers)?;
    let metrics = state.metrics.read().expect("metrics lock");
    Ok(Json(json!({
        "version": VERSION,
        "uptime_secs": state.uptime_secs(),
        "sampled_at_ms": metrics.sampled_at_ms,
        "sample_count": metrics.sample_count,
        "interval_ms": metrics.interval_ms,
        "host": metrics.host,
        "cpu": metrics.cpu,
        "memory": metrics.memory,
        "disks": metrics.disks,
        "disk_io": metrics.disk_io,
        "networks": metrics.networks,
        "apps": metrics.apps,
        "process_count": metrics.processes.len(),
    }))
    .into_response())
}

/// `GET /api/system/series?window=120`
pub async fn series(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<WindowQuery>,
) -> Result<Response, ApiError> {
    guard(&state, &headers)?;
    let window = query.window.unwrap_or(120).clamp(1, 2_000);
    let metrics = state.metrics.read().expect("metrics lock");
    Ok(Json(json!({
        "interval_ms": metrics.interval_ms,
        "sampled_at_ms": metrics.sampled_at_ms,
        "sample_count": metrics.sample_count,
        "samples": metrics.series(window),
    }))
    .into_response())
}

/// `GET /api/system/disks`
pub async fn disks(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    guard(&state, &headers)?;
    let metrics = state.metrics.read().expect("metrics lock");
    Ok(Json(json!({
        "disks": metrics.disks,
        "disk_io": metrics.disk_io,
    }))
    .into_response())
}

/// `GET /api/system/network`
pub async fn network(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    guard(&state, &headers)?;
    let metrics = state.metrics.read().expect("metrics lock");
    Ok(Json(json!({ "networks": metrics.networks })).into_response())
}

/// `GET /api/audit?limit=50` — tail of the append-only audit log.
pub async fn audit_tail(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<WindowQuery>,
) -> Result<Response, ApiError> {
    guard(&state, &headers)?;
    let limit = query.window.unwrap_or(50).clamp(1, 500);
    let entries = read_tail(state.audit.path(), limit).unwrap_or_default();
    Ok(Json(json!({
        "path": state.audit.path().to_string_lossy(),
        "entries": entries,
    }))
    .into_response())
}

/// Read at most the last 256 KiB of a JSONL file and return the newest `limit`
/// parsed entries (oldest first).
fn read_tail(path: &std::path::Path, limit: usize) -> std::io::Result<Vec<Value>> {
    const MAX_BYTES: u64 = 256 * 1024;
    let mut file = std::fs::File::open(path)?;
    let len = file.metadata()?.len();
    let start = len.saturating_sub(MAX_BYTES);
    file.seek(SeekFrom::Start(start))?;
    let mut buffer = String::new();
    file.read_to_string(&mut buffer)?;
    let mut lines: Vec<&str> = buffer.lines().filter(|line| !line.trim().is_empty()).collect();
    if start > 0 && !lines.is_empty() {
        // The first line may be a partial record.
        lines.remove(0);
    }
    let tail = if lines.len() > limit {
        &lines[lines.len() - limit..]
    } else {
        &lines[..]
    };
    Ok(tail
        .iter()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tail_returns_newest_entries_in_order() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("audit.jsonl");
        let body: String = (0..10)
            .map(|index| format!("{{\"n\":{index}}}\n"))
            .collect();
        std::fs::write(&path, body).unwrap();

        let entries = read_tail(&path, 3).unwrap();
        assert_eq!(entries.len(), 3);
        assert_eq!(entries[0]["n"], 7);
        assert_eq!(entries[2]["n"], 9);

        let all = read_tail(&path, 100).unwrap();
        assert_eq!(all.len(), 10);
    }

    #[test]
    fn tail_of_missing_file_is_an_error_not_a_panic() {
        assert!(read_tail(std::path::Path::new("/nonexistent/audit.jsonl"), 5).is_err());
    }
}
