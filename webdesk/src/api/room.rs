//! Fixed BFF only. No process spawning, Home/Secret files or caller RPC method.
use super::{
    business::{self, Failure},
    session,
};
use crate::state::AppState;
use axum::{
    extract::{ConnectInfo, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{net::SocketAddr, sync::Arc};
use zeroize::Zeroize;
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Input {
    pub workspace_id: String,
    #[serde(default)]
    pub action: Option<String>,
    #[serde(default)]
    pub input: Value,
}
impl Drop for Input {
    fn drop(&mut self) {
        business::wipe(&mut self.input)
    }
}
pub async fn config(State(s): State<Arc<AppState>>, h: HeaderMap) -> Response {
    let result = async {
        if s.config.business_socket.is_none() {
            return Ok::<_, Failure>(business::reply(
                StatusCode::OK,
                json!({"data":{"enabled":false,"legacy_enabled":s.config.legacy_agent_room}}),
            ));
        }
        business::enabled(&s)?;
        session::guard(&s, &h)
            .map_err(|_| Failure(StatusCode::UNAUTHORIZED, "ADMIN_AUTH_REQUIRED"))?;
        // The workspace is assigned by core health/delegated registration, never a pathname.
        let health = business::rpc(&s, "v2/health", json!({})).await?;
        let result = business::rpc(
            &s,
            "v2/room.config",
            json!({"workspace_id":health["workspace_id"]}),
        )
        .await?;
        Ok(business::reply(StatusCode::OK, result))
    }
    .await;
    result.unwrap_or_else(IntoResponse::into_response)
}
async fn control(
    s: Arc<AppState>,
    h: HeaderMap,
    peer: SocketAddr,
    method: &'static str,
    body: Input,
) -> Response {
    async {
        business::origin(&s, &h)?;
        if !peer.ip().is_loopback() {
            return Err(Failure(StatusCode::FORBIDDEN, "SECURE_TRANSPORT_REQUIRED"));
        }
        let admin = session::guard(&s, &h)
            .map_err(|_| Failure(StatusCode::UNAUTHORIZED, "ADMIN_AUTH_REQUIRED"))?;
        session::guard_csrf(&s, &h, &admin)
            .map_err(|_| Failure(StatusCode::FORBIDDEN, "CSRF_REQUIRED"))?;
        let params = if let Some(action) = &body.action {
            json!({"workspace_id":body.workspace_id,"action":action,"input":body.input})
        } else {
            json!({"workspace_id":body.workspace_id,"input":body.input})
        };
        let result = business::rpc(&s, method, params).await;
        s.audit.record(
            "room.control",
            admin.user,
            &admin.ip,
            result.is_ok(),
            json!({"method":method}),
        );
        Ok::<_, Failure>(business::reply(StatusCode::OK, result?))
    }
    .await
    .unwrap_or_else(IntoResponse::into_response)
}
pub async fn store(
    State(s): State<Arc<AppState>>,
    ConnectInfo(p): ConnectInfo<SocketAddr>,
    h: HeaderMap,
    Json(body): Json<Input>,
) -> Response {
    control(s, h, p, "v2/room.store", body).await
}
pub async fn provider(
    State(s): State<Arc<AppState>>,
    ConnectInfo(p): ConnectInfo<SocketAddr>,
    h: HeaderMap,
    Json(body): Json<Input>,
) -> Response {
    control(s, h, p, "v2/room.provider.save", body).await
}
pub async fn migration(
    State(s): State<Arc<AppState>>,
    ConnectInfo(p): ConnectInfo<SocketAddr>,
    h: HeaderMap,
    Json(mut body): Json<Input>,
) -> Response {
    let method = match body.action.as_deref() {
        Some("preview") => "v2/room.migration.preview",
        Some("apply") => "v2/room.migration.apply",
        Some("activate") => "v2/room.migration.activate",
        _ => return Failure(StatusCode::BAD_REQUEST, "INVALID_INPUT").into_response(),
    };
    body.action = None;
    control(s, h, p, method, body).await
}
pub async fn provider_test(
    State(s): State<Arc<AppState>>,
    ConnectInfo(p): ConnectInfo<SocketAddr>,
    h: HeaderMap,
    Json(body): Json<Input>,
) -> Response {
    control(s, h, p, "v2/room.provider.test", body).await
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Chat {
    workspace_id: String,
    provider_id: String,
    profile_revision: u64,
    engine: String,
    prompt: String,
    max_tokens: u32,
    cloud_consent: bool,
    #[serde(default = "default_agent")]
    agent_id: String,
    #[serde(default)]
    computer: bool,
}
fn default_agent() -> String {
    "wukong".into()
}
impl Drop for Chat {
    fn drop(&mut self) {
        self.prompt.zeroize()
    }
}
pub async fn chat(
    State(s): State<Arc<AppState>>,
    h: HeaderMap,
    Json(body): Json<Chat>,
) -> Response {
    async {
        business::origin(&s,&h)?;let token=business::session(&s,&h)?;let csrf=business::csrf(&h)?;
        let result=business::rpc(&s,"v2/delegated.room.chat",json!({"session_token":&*token,"csrf_token":&*csrf,"workspace_id":body.workspace_id,"provider_id":body.provider_id,"profile_revision":body.profile_revision,"engine":body.engine,"prompt":body.prompt,"max_tokens":body.max_tokens,"cloud_consent":body.cloud_consent,"agent_id":body.agent_id,"computer":body.computer})).await?;
        Ok::<_,Failure>(business::reply(StatusCode::OK,result))
    }.await.unwrap_or_else(IntoResponse::into_response)
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Household {
    workspace_id: String,
    command: String,
    input: Value,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Computer {
    workspace_id: String,
    action: Value,
}
impl Drop for Computer {
    fn drop(&mut self) {
        business::wipe(&mut self.action)
    }
}
pub async fn computer(
    State(s): State<Arc<AppState>>,
    h: HeaderMap,
    Json(body): Json<Computer>,
) -> Response {
    async {business::origin(&s,&h)?;let token=business::session(&s,&h)?;let csrf=business::csrf(&h)?;
        let result=business::rpc(&s,"v2/delegated.computer",json!({"session_token":&*token,"csrf_token":&*csrf,"workspace_id":body.workspace_id,"action":body.action})).await?;
        Ok::<_,Failure>(business::reply(StatusCode::OK,result))
    }.await.unwrap_or_else(IntoResponse::into_response)
}
impl Drop for Household {
    fn drop(&mut self) {
        business::wipe(&mut self.input)
    }
}
pub async fn household(
    State(s): State<Arc<AppState>>,
    h: HeaderMap,
    Json(body): Json<Household>,
) -> Response {
    async {business::origin(&s,&h)?;let token=business::session(&s,&h)?;let csrf=business::csrf(&h)?;
        let result=business::rpc(&s,"v2/delegated.household",json!({"session_token":&*token,"csrf_token":&*csrf,"workspace_id":body.workspace_id,"command":body.command,"input":body.input})).await?;
        Ok::<_,Failure>(business::reply(StatusCode::OK,result))
    }.await.unwrap_or_else(IntoResponse::into_response)
}
