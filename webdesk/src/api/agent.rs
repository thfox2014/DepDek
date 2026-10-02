//! Authenticated bridge to the isolated `depdek-agent` Unix-socket service.
//! Webdesk never starts a process or reads the key file. During explicit
//! Provider setup it forwards the submitted key transiently to the config
//! broker, but never persists, returns, or audits the secret.

use std::sync::Arc;
use std::time::Duration;

use axum::extract::{ConnectInfo, State};
use axum::http::HeaderMap;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixStream;

use super::session::{guard, guard_csrf, ApiError};
use crate::state::AppState;

const MAX_MESSAGE_CHARS: usize = 8_000;
const MAX_HISTORY_MESSAGES: usize = 8;
const MAX_HISTORY_CHARS: usize = 14_000;
const MAX_RPC_RESPONSE_BYTES: usize = 256 * 1024;
const MAX_CONFIG_REQUEST_BYTES: usize = 16 * 1024;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProviderProtocol {
    OpenaiCompletions,
    OpenaiResponses,
    AnthropicMessages,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ProviderDescriptor {
    pub id: String,
    pub name: String,
    pub base_url: String,
    pub protocol: ProviderProtocol,
    pub model: String,
    pub active: bool,
    pub configured: bool,
}

#[derive(Debug, Deserialize)]
struct ConfigReply {
    #[serde(default)]
    ok: bool,
    #[serde(default)]
    providers: Vec<ProviderDescriptor>,
    #[serde(default)]
    active_id: String,
    #[serde(default)]
    restart_ok: bool,
    #[serde(default)]
    message: String,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentId {
    #[default]
    Wukong,
    Bajie,
    Master,
    #[serde(rename = "shaseng")]
    ShaSeng,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentMessage {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Serialize)]
struct AgentRequest<'a> {
    op: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    agent: Option<AgentId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    history: Option<&'a [AgentMessage]>,
}

#[derive(Debug, Deserialize)]
struct AgentReply {
    #[serde(default)]
    ok: bool,
    #[serde(default)]
    configured: bool,
    #[serde(default)]
    available: bool,
    #[serde(default)]
    engine: String,
    #[serde(default)]
    model: String,
    #[serde(default)]
    provider_id: String,
    #[serde(default)]
    text: String,
    #[serde(default)]
    error: String,
}

async fn config_rpc(state: &AppState, payload: &[u8]) -> Result<ConfigReply, ApiError> {
    if payload.len() > MAX_CONFIG_REQUEST_BYTES {
        return Err(ApiError::bad_request("Provider 配置超过安全上限"));
    }
    #[cfg(unix)]
    {
        let call = async {
            let mut stream = UnixStream::connect(&state.config.agent_config_socket)
                .await
                .map_err(|_| {
                    ApiError::unavailable("Provider 安全配置服务未连接；请检查 depdek-agent-config")
                })?;
            stream
                .write_all(payload)
                .await
                .map_err(|_| ApiError::unavailable("无法提交 Provider 配置"))?;
            stream
                .write_all(b"\n")
                .await
                .map_err(|_| ApiError::unavailable("无法提交 Provider 配置"))?;
            let mut response = Vec::with_capacity(2048);
            let mut chunk = [0u8; 4096];
            loop {
                let count = stream
                    .read(&mut chunk)
                    .await
                    .map_err(|_| ApiError::unavailable("Provider 配置服务连接中断"))?;
                if count == 0 {
                    break;
                }
                if response.len() + count > 64 * 1024 {
                    return Err(ApiError::unavailable("Provider 配置响应超过安全上限"));
                }
                if let Some(end) = chunk[..count].iter().position(|byte| *byte == b'\n') {
                    response.extend_from_slice(&chunk[..end]);
                    break;
                }
                response.extend_from_slice(&chunk[..count]);
            }
            serde_json::from_slice::<ConfigReply>(&response)
                .map_err(|_| ApiError::unavailable("Provider 配置服务返回了无法识别的响应"))
        };
        tokio::time::timeout(Duration::from_secs(15), call)
            .await
            .map_err(|_| ApiError::unavailable("Provider 配置服务响应超时"))?
    }
    #[cfg(not(unix))]
    {
        let _ = (state, payload);
        Err(ApiError::unavailable(
            "Provider 配置服务当前仅支持 Linux/Unix 主机",
        ))
    }
}

/// `GET /api/agent/providers` — returns metadata only; secret fields never cross this API.
pub async fn providers(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let session = guard(&state, &headers)?;
    let payload = serde_json::to_vec(&json!({ "op": "list" }))
        .map_err(|_| ApiError::unavailable("Provider 配置请求失败"))?;
    let reply = config_rpc(&state, &payload).await?;
    if !reply.ok {
        return Err(ApiError::unavailable("无法读取 Provider 配置"));
    }
    state.audit.record(
        "agent.provider.list",
        session.user,
        &session.ip,
        true,
        json!({ "provider_count": reply.providers.len() }),
    );
    Ok(Json(json!({ "providers": reply.providers, "active_id": reply.active_id })).into_response())
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SaveProviderRequest {
    pub id: String,
    pub name: String,
    pub base_url: String,
    pub protocol: ProviderProtocol,
    pub model: String,
    #[serde(default)]
    pub api_key: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ActivateProviderRequest {
    pub id: String,
}

/// `POST /api/agent/providers` — API keys are write-only and excluded from audit/logs.
pub async fn save_provider(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<std::net::SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<SaveProviderRequest>,
) -> Result<Response, ApiError> {
    let session = guard(&state, &headers)?;
    guard_csrf(&state, &headers, &session)?;
    if state.insecure_no_auth {
        return Err(ApiError::forbidden(
            "请启用 Webdesk 登录后再保存 Provider 密钥",
        ));
    }
    // Use the transport peer, not X-Forwarded-For, for the secret transport
    // check; that header may be spoofable unless a trusted proxy is configured.
    let is_loopback = peer.ip().is_loopback();
    if !state.config.tls_enabled() && !is_loopback {
        return Err(ApiError::forbidden(
            "远程配置 API Key 需要启用 TLS；本机回环连接可直接配置",
        ));
    }
    if body.id.len() > 48
        || body.name.chars().count() > 64
        || body.model.len() > 128
        || body.api_key.len() > 2048
        || body.base_url.len() > 2048
    {
        return Err(ApiError::bad_request("Provider 配置超过安全上限"));
    }
    let provider_id = body.id.clone();
    let payload = serde_json::to_vec(&json!({
        "op": "save",
        "provider": {
            "id": provider_id.clone(),
            "name": body.name,
            "base_url": body.base_url,
            "protocol": body.protocol,
            "model": body.model,
            "api_key": body.api_key,
        }
    }))
    .map_err(|_| ApiError::bad_request("Provider 配置格式无效"))?;
    let reply = match config_rpc(&state, &payload).await {
        Ok(reply) => reply,
        Err(error) => {
            state.audit.record(
                "agent.provider.save",
                session.user,
                &session.ip,
                false,
                json!({ "provider_id": provider_id }),
            );
            return Err(error);
        }
    };
    state.audit.record(
        "agent.provider.save",
        session.user,
        &session.ip,
        reply.ok,
        json!({ "provider_id": provider_id, "restart_ok": reply.restart_ok }),
    );
    if !reply.ok {
        return Err(ApiError::bad_request(reply.message));
    }
    Ok(Json(json!({
        "providers": reply.providers,
        "active_id": reply.active_id,
        "restart_ok": reply.restart_ok,
        "message": reply.message,
    }))
    .into_response())
}

/// `POST /api/agent/providers/activate` — selects the provider used by the Harness executor.
pub async fn activate_provider(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<ActivateProviderRequest>,
) -> Result<Response, ApiError> {
    let session = guard(&state, &headers)?;
    guard_csrf(&state, &headers, &session)?;
    if state.insecure_no_auth {
        return Err(ApiError::forbidden(
            "请启用 Webdesk 登录后再切换 Agent 使用的模型",
        ));
    }
    if body.id.is_empty()
        || body.id.len() > 48
        || !body
            .id
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
    {
        return Err(ApiError::bad_request("Provider ID 格式无效"));
    }
    let provider_id = body.id;
    let payload = serde_json::to_vec(&json!({
        "op": "activate",
        "id": provider_id.clone(),
    }))
    .map_err(|_| ApiError::bad_request("Provider 切换请求格式无效"))?;
    let reply = match config_rpc(&state, &payload).await {
        Ok(reply) => reply,
        Err(error) => {
            state.audit.record(
                "agent.provider.activate",
                session.user,
                &session.ip,
                false,
                json!({ "provider_id": provider_id }),
            );
            return Err(error);
        }
    };
    state.audit.record(
        "agent.provider.activate",
        session.user,
        &session.ip,
        reply.ok,
        json!({ "provider_id": provider_id, "restart_ok": reply.restart_ok }),
    );
    if !reply.ok {
        return Err(ApiError::bad_request(reply.message));
    }
    Ok(Json(json!({
        "providers": reply.providers,
        "active_id": reply.active_id,
        "restart_ok": reply.restart_ok,
        "message": reply.message,
    }))
    .into_response())
}

async fn rpc(state: &AppState, request: &AgentRequest<'_>) -> Result<AgentReply, ApiError> {
    let payload =
        serde_json::to_vec(request).map_err(|_| ApiError::bad_request("Agent 请求格式无效"))?;
    if payload.len() > 32 * 1024 {
        return Err(ApiError::bad_request("对话上下文过长，请缩短后重试"));
    }

    #[cfg(unix)]
    {
        let call = async {
            let mut stream = UnixStream::connect(&state.config.agent_socket)
                .await
                .map_err(|_| ApiError::unavailable("Agent 服务未连接；请检查 depdek-agent 服务"))?;
            stream
                .write_all(&payload)
                .await
                .map_err(|_| ApiError::unavailable("无法向 Agent 服务发送请求"))?;
            stream
                .write_all(b"\n")
                .await
                .map_err(|_| ApiError::unavailable("无法向 Agent 服务发送请求"))?;

            let mut response = Vec::with_capacity(2048);
            let mut chunk = [0u8; 4096];
            loop {
                let count = stream
                    .read(&mut chunk)
                    .await
                    .map_err(|_| ApiError::unavailable("Agent 服务连接中断"))?;
                if count == 0 {
                    break;
                }
                if response.len() + count > MAX_RPC_RESPONSE_BYTES {
                    return Err(ApiError::unavailable("Agent 响应超过安全上限"));
                }
                if let Some(end) = chunk[..count].iter().position(|byte| *byte == b'\n') {
                    response.extend_from_slice(&chunk[..end]);
                    break;
                }
                response.extend_from_slice(&chunk[..count]);
            }
            serde_json::from_slice::<AgentReply>(&response)
                .map_err(|_| ApiError::unavailable("Agent 服务返回了无法识别的响应"))
        };
        tokio::time::timeout(Duration::from_secs(130), call)
            .await
            .map_err(|_| ApiError::unavailable("Agent 执行超时，请稍后重试"))?
    }
    #[cfg(not(unix))]
    {
        let _ = (state, payload);
        Err(ApiError::unavailable(
            "Agent 服务当前仅支持 Linux/Unix 主机",
        ))
    }
}

/// `GET /api/agent/status`
pub async fn status(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    guard(&state, &headers)?;
    let request = AgentRequest {
        op: "status",
        agent: None,
        message: None,
        history: None,
    };
    match rpc(&state, &request).await {
        Ok(reply) => Ok(Json(json!({
            "available": reply.available,
            "configured": reply.configured,
            "engine": if reply.engine.is_empty() { "deepseek-harness" } else { &reply.engine },
            "model": reply.model,
            "provider_id": reply.provider_id,
        }))
        .into_response()),
        Err(_) => Ok(Json(json!({
            "available": false,
            "configured": false,
            "engine": "deepseek-harness",
            "model": "",
            "provider_id": "",
        }))
        .into_response()),
    }
}

#[derive(Debug, Deserialize)]
pub struct ChatRequest {
    #[serde(default)]
    pub agent: AgentId,
    pub message: String,
    #[serde(default)]
    pub history: Vec<AgentMessage>,
}

/// `POST /api/agent/chat` — requires login and CSRF; payloads are not audited.
pub async fn chat(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<ChatRequest>,
) -> Result<Response, ApiError> {
    let session = guard(&state, &headers)?;
    guard_csrf(&state, &headers, &session)?;
    let message = body.message.trim();
    if message.is_empty() || message.chars().count() > MAX_MESSAGE_CHARS {
        return Err(ApiError::bad_request("请输入内容（最多 8000 个字符）"));
    }
    if body.history.len() > MAX_HISTORY_MESSAGES {
        return Err(ApiError::bad_request("对话轮数过多，请重新开始对话"));
    }
    if body.history.iter().any(|item| {
        !matches!(item.role.as_str(), "user" | "assistant")
            || item.content.chars().count() > MAX_HISTORY_CHARS
    }) || body
        .history
        .iter()
        .map(|item| item.content.chars().count())
        .sum::<usize>()
        > MAX_HISTORY_CHARS
    {
        return Err(ApiError::bad_request("对话上下文格式无效或过长"));
    }

    let request = AgentRequest {
        op: "chat",
        agent: Some(body.agent),
        message: Some(message),
        history: Some(&body.history),
    };
    let reply = match rpc(&state, &request).await {
        Ok(reply) => reply,
        Err(error) => {
            state.audit.record(
                "agent.chat",
                session.user,
                &session.ip,
                false,
                json!({
                    "engine": "deepseek-harness",
                    "stage": "executor-transport",
                    "history_messages": body.history.len(),
                    "message_chars": message.chars().count(),
                }),
            );
            return Err(error);
        }
    };
    if !reply.ok {
        state.audit.record(
            "agent.chat",
            session.user,
            &session.ip,
            false,
            json!({
                "engine": "deepseek-harness",
                "history_messages": body.history.len(),
                "message_chars": message.chars().count(),
            }),
        );
        return Err(ApiError::unavailable(if reply.error.is_empty() {
            "Agent 执行失败"
        } else {
            &reply.error
        }));
    }
    state.audit.record(
        "agent.chat",
        session.user,
        &session.ip,
        true,
        json!({
            "engine": if reply.engine.is_empty() { "deepseek-harness" } else { &reply.engine },
            "model": reply.model,
            "provider_id": reply.provider_id,
            "history_messages": body.history.len(),
            "message_chars": message.chars().count(),
        }),
    );
    Ok(
        Json(json!({ "engine": reply.engine, "model": reply.model, "provider_id": reply.provider_id, "text": reply.text }))
            .into_response(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chat_defaults_to_wukong_and_accepts_only_known_room_members() {
        let default: ChatRequest = serde_json::from_str(r#"{"message":"hello"}"#).unwrap();
        assert!(matches!(default.agent, AgentId::Wukong));

        let selected: ChatRequest =
            serde_json::from_str(r#"{"agent":"shaseng","message":"hello"}"#).unwrap();
        assert!(matches!(selected.agent, AgentId::ShaSeng));
        assert!(
            serde_json::from_str::<ChatRequest>(r#"{"agent":"unknown","message":"hello"}"#)
                .is_err()
        );
    }
}
