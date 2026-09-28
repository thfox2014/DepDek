//! Login, logout and session introspection, plus the auth guard used by every
//! protected handler.

use std::net::SocketAddr;

use axum::extract::{ConnectInfo, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::auth::{
    self, client_ip, session_cookie, Session, CSRF_HEADER, SESSION_COOKIE,
};
use crate::state::AppState;

pub const VERSION: &str = env!("DEPDEK_VERSION");

#[derive(Debug)]
pub struct ApiError {
    status: StatusCode,
    message: String,
}

impl ApiError {
    pub fn unauthorized(message: impl Into<String>) -> Self {
        Self { status: StatusCode::UNAUTHORIZED, message: message.into() }
    }
    pub fn forbidden(message: impl Into<String>) -> Self {
        Self { status: StatusCode::FORBIDDEN, message: message.into() }
    }
    pub fn bad_request(message: impl Into<String>) -> Self {
        Self { status: StatusCode::BAD_REQUEST, message: message.into() }
    }
    pub fn not_found(message: impl Into<String>) -> Self {
        Self { status: StatusCode::NOT_FOUND, message: message.into() }
    }
    pub fn unavailable(message: impl Into<String>) -> Self {
        Self { status: StatusCode::SERVICE_UNAVAILABLE, message: message.into() }
    }
    pub fn too_many(retry_after_secs: u64) -> Self {
        Self {
            status: StatusCode::TOO_MANY_REQUESTS,
            message: format!("尝试过于频繁，请在 {retry_after_secs} 秒后重试"),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.status, Json(json!({ "error": self.message }))).into_response()
    }
}

/// Anonymous session used when the operator disabled authentication.
fn anonymous_session() -> Session {
    Session {
        id: "insecure".into(),
        csrf: "insecure".into(),
        user: "admin",
        created_ms: crate::util::now_ms(),
        last_seen_ms: crate::util::now_ms(),
        ip: "local".into(),
    }
}

/// Resolve the caller's session, or `Err(401)`.
pub fn guard(state: &AppState, headers: &HeaderMap) -> Result<Session, ApiError> {
    if state.insecure_no_auth {
        return Ok(anonymous_session());
    }
    let session_id = auth::cookie(headers, SESSION_COOKIE)
        .ok_or_else(|| ApiError::unauthorized("未登录"))?;
    state
        .sessions
        .touch(session_id)
        .ok_or_else(|| ApiError::unauthorized("会话已过期，请重新登录"))
}

/// State-changing requests must echo the session CSRF token.
pub fn guard_csrf(state: &AppState, headers: &HeaderMap, session: &Session) -> Result<(), ApiError> {
    if state.insecure_no_auth {
        return Ok(());
    }
    let token = headers
        .get(CSRF_HEADER)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    if token != session.csrf {
        return Err(ApiError::forbidden("CSRF 校验失败"));
    }
    Ok(())
}

#[derive(Debug, Serialize)]
pub struct SessionInfo {
    pub authenticated: bool,
    pub user: Option<String>,
    pub csrf: Option<String>,
    pub version: String,
    pub insecure_no_auth: bool,
    pub tls: bool,
    pub session_ttl_secs: u64,
}

/// `GET /api/session` — never fails, the SPA uses it to pick login vs desktop.
pub async fn current(State(state): State<std::sync::Arc<AppState>>, headers: HeaderMap) -> Response {
    let session = if state.insecure_no_auth {
        Some(anonymous_session())
    } else {
        auth::cookie(&headers, SESSION_COOKIE).and_then(|id| state.sessions.touch(id))
    };
    let info = match session {
        Some(session) => SessionInfo {
            authenticated: true,
            user: Some(session.user.to_string()),
            csrf: Some(session.csrf),
            version: state.version.clone(),
            insecure_no_auth: state.insecure_no_auth,
            tls: state.config.tls_enabled(),
            session_ttl_secs: state.config.auth.session_ttl_secs,
        },
        None => SessionInfo {
            authenticated: false,
            user: None,
            csrf: None,
            version: state.version.clone(),
            insecure_no_auth: false,
            tls: state.config.tls_enabled(),
            session_ttl_secs: state.config.auth.session_ttl_secs,
        },
    };
    Json(info).into_response()
}

#[derive(Debug, Deserialize)]
pub struct LoginRequest {
    pub password: String,
}

/// `POST /api/login`
pub async fn login(
    State(state): State<std::sync::Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<LoginRequest>,
) -> Result<Response, ApiError> {
    let ip = client_ip(&headers, Some(peer));

    if state.insecure_no_auth {
        return Err(ApiError::bad_request("服务已关闭认证，无需登录"));
    }
    if state.config.auth.password_hash.trim().is_empty() {
        return Err(ApiError::unavailable(
            "尚未配置密码：请运行 depdek-webdesk hash-password 并写入配置",
        ));
    }
    if let Some(wait) = state.throttle.blocked_for(&ip) {
        state
            .audit
            .record("login.blocked", "anon", &ip, false, json!({ "retry_after": wait }));
        return Err(ApiError::too_many(wait));
    }

    if !auth::verify_password(&body.password, &state.config.auth.password_hash) {
        let failures = state.throttle.record_failure(&ip);
        state
            .audit
            .record("login.failure", "anon", &ip, false, json!({ "failures": failures }));
        return Err(ApiError::unauthorized("密码错误"));
    }

    state.throttle.record_success(&ip);
    let session = state.sessions.create(&ip);
    state.audit.record(
        "login.success",
        session.user,
        &ip,
        true,
        json!({ "sessions": state.sessions.active_count() }),
    );

    let cookie = session_cookie(
        &session.id,
        state.config.auth.session_ttl_secs,
        state.secure_cookies(),
    );
    let payload = Json(SessionInfo {
        authenticated: true,
        user: Some(session.user.to_string()),
        csrf: Some(session.csrf),
        version: state.version.clone(),
        insecure_no_auth: false,
        tls: state.config.tls_enabled(),
        session_ttl_secs: state.config.auth.session_ttl_secs,
    });
    Ok(([(header::SET_COOKIE, cookie)], payload).into_response())
}

/// `POST /api/logout`
pub async fn logout(
    State(state): State<std::sync::Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let session = guard(&state, &headers)?;
    guard_csrf(&state, &headers, &session)?;
    if !state.insecure_no_auth {
        state.sessions.remove(&session.id);
    }
    state.audit.record("session.logout", session.user, &session.ip, true, json!({}));
    let cookie = auth::cleared_cookie(state.secure_cookies());
    Ok((
        [(header::SET_COOKIE, cookie)],
        Json(json!({ "authenticated": false })),
    )
        .into_response())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Config;
    use crate::state::AppState;
    use std::sync::Arc;

    fn state(password_hash: &str) -> Arc<AppState> {
        let mut config = Config::from_toml("").unwrap();
        config.auth.password_hash = password_hash.to_string();
        let dir = std::env::temp_dir().join("depdek-webdesk-api-tests");
        Arc::new(AppState {
            audit: crate::audit::AuditLog::new(&dir.join("audit.jsonl")),
            sessions: crate::auth::SessionStore::new(config.auth.session_ttl_secs, config.auth.idle_timeout_secs),
            throttle: crate::auth::LoginThrottle::new(config.auth.max_failures),
            metrics: crate::metrics::Sampler::new(2_000, 60).shared(),
            version: VERSION.to_string(),
            started_ms: crate::util::now_ms(),
            insecure_no_auth: false,
            config,
        })
    }

    #[test]
    fn guard_rejects_missing_and_expired_sessions() {
        let state = state("");
        let empty = HeaderMap::new();
        assert_eq!(guard(&state, &empty).unwrap_err().status, StatusCode::UNAUTHORIZED);

        let session = state.sessions.create("127.0.0.1");
        let mut headers = HeaderMap::new();
        headers.insert(
            header::COOKIE,
            format!("{SESSION_COOKIE}={}", session.id).parse().unwrap(),
        );
        assert!(guard(&state, &headers).is_ok());

        state.sessions.remove(&session.id);
        assert!(guard(&state, &headers).is_err());
    }

    #[test]
    fn csrf_token_must_match() {
        let state = state("");
        let session = state.sessions.create("127.0.0.1");
        let mut headers = HeaderMap::new();
        assert!(guard_csrf(&state, &headers, &session).is_err());
        headers.insert(CSRF_HEADER, session.csrf.parse().unwrap());
        assert!(guard_csrf(&state, &headers, &session).is_ok());
    }

    #[test]
    fn insecure_mode_skips_auth_but_is_reported() {
        let mut state = state("");
        Arc::get_mut(&mut state).unwrap().insecure_no_auth = true;
        assert!(guard(&state, &HeaderMap::new()).is_ok());
        assert!(guard_csrf(&state, &HeaderMap::new(), &anonymous_session()).is_ok());
    }

    #[test]
    fn api_error_maps_to_expected_status_codes() {
        assert_eq!(ApiError::unauthorized("x").status, StatusCode::UNAUTHORIZED);
        assert_eq!(ApiError::forbidden("x").status, StatusCode::FORBIDDEN);
        assert_eq!(ApiError::bad_request("x").status, StatusCode::BAD_REQUEST);
        assert_eq!(ApiError::unavailable("x").status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(ApiError::too_many(3).status, StatusCode::TOO_MANY_REQUESTS);
    }
}
