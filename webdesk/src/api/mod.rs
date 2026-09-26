//! HTTP routing.

pub mod processes;
pub mod session;
pub mod system;

use std::sync::Arc;

use axum::extract::DefaultBodyLimit;
use axum::routing::{get, post};
use axum::Router;
use tower_http::compression::CompressionLayer;
use tower_http::trace::TraceLayer;

use crate::state::AppState;
use crate::web;

pub fn router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/api/health", get(system::health))
        .route("/api/session", get(session::current))
        .route("/api/login", post(session::login))
        .route("/api/logout", post(session::logout))
        .route("/api/system/summary", get(system::summary))
        .route("/api/system/series", get(system::series))
        .route("/api/system/disks", get(system::disks))
        .route("/api/system/network", get(system::network))
        .route("/api/apps", get(processes::apps))
        .route("/api/processes", get(processes::list))
        .route("/api/audit", get(system::audit_tail))
        .fallback(web::serve)
        .layer(DefaultBodyLimit::max(64 * 1024))
        .layer(CompressionLayer::new())
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}
