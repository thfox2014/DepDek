//! Process and per-application resource endpoints.

use std::sync::Arc;

use axum::extract::{Query, State};
use axum::http::HeaderMap;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;
use serde_json::json;

use super::session::{guard, ApiError};
use crate::metrics::SortKey;
use crate::state::AppState;

#[derive(Debug, Deserialize)]
pub struct ListQuery {
    #[serde(default)]
    pub sort: Option<String>,
    #[serde(default)]
    pub limit: Option<usize>,
}

/// `GET /api/apps?limit=12` — per-application (cgroup) rollup.
pub async fn apps(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<ListQuery>,
) -> Result<Response, ApiError> {
    guard(&state, &headers)?;
    let limit = query.limit.unwrap_or(24).clamp(1, 200);
    let metrics = state.metrics.read().expect("metrics lock");
    let mut apps = metrics.apps.clone();
    apps.truncate(limit);
    Ok(Json(json!({
        "sampled_at_ms": metrics.sampled_at_ms,
        "cores": metrics.host.cores_logical,
        "total_memory_bytes": metrics.memory.total_bytes,
        "apps": apps,
    }))
    .into_response())
}

/// `GET /api/processes?sort=cpu|mem|disk&limit=50`
pub async fn list(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<ListQuery>,
) -> Result<Response, ApiError> {
    guard(&state, &headers)?;
    let sort = SortKey::parse(query.sort.as_deref());
    let limit = query.limit.unwrap_or(50).clamp(1, 500);
    let metrics = state.metrics.read().expect("metrics lock");
    Ok(Json(json!({
        "sampled_at_ms": metrics.sampled_at_ms,
        "cores": metrics.host.cores_logical,
        "total": metrics.processes.len(),
        "processes": metrics.top_processes(sort, limit),
    }))
    .into_response())
}
