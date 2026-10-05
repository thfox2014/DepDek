//! HTTP routing.

pub mod agent;
pub mod business;
pub mod files;
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
        .route("/api/v2/auth/login", post(business::login))
        .route("/api/v2/auth/session", get(business::current))
        .route("/api/v2/auth/logout", post(business::logout))
        .route("/api/v2/workspaces", get(business::workspaces))
        .route("/api/v2/commands", get(business::commands))
        .route("/api/v2/commands/invoke", post(business::invoke))
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
        .route("/api/files", get(files::list))
        .route("/api/files/preview", get(files::preview))
        .route("/api/files/download", get(files::download))
        .route("/api/agent/status", get(agent::status))
        .route(
            "/api/agent/providers",
            get(agent::providers).post(agent::save_provider),
        )
        .route(
            "/api/agent/providers/activate",
            post(agent::activate_provider),
        )
        .route("/api/agent/chat", post(agent::chat))
        .fallback(web::serve)
        .layer(DefaultBodyLimit::max(64 * 1024))
        .layer(CompressionLayer::new())
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}
