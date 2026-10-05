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
            let uid = stream
                .peer_cred()
                .map_err(|_| ApiError::unavailable("无法验证 Provider 配置服务身份"))?
                .uid();
            if uid != 0 && uid != unsafe { libc::geteuid() } {
                return Err(ApiError::unavailable("Provider 配置服务身份不匹配"));
            }
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

#[derive(Deserialize)]
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
impl Drop for SaveProviderRequest {
    fn drop(&mut self) {
        use zeroize::Zeroize;
        self.api_key.zeroize();
    }
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
    if !is_loopback {
        return Err(ApiError::forbidden(
            "当前服务没有直接 TLS 监听；请经本机回环的受信 TLS 反向代理配置 API Key",
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
    let mut submission = json!({
        "op": "save",
        "provider": {
            "id": provider_id.clone(),
            "name": body.name,
            "base_url": body.base_url,
            "protocol": body.protocol,
            "model": body.model,
            "api_key": body.api_key,
        }
    });
    let serialized = serde_json::to_vec(&submission);
    if let Some(serde_json::Value::String(secret)) = submission.pointer_mut("/provider/api_key") {
        use zeroize::Zeroize;
        secret.zeroize();
    }
    let payload = zeroize::Zeroizing::new(
        serialized.map_err(|_| ApiError::bad_request("Provider 配置格式无效"))?,
    );
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
    use axum::{
        body::{to_bytes, Body},
        http::{Request, StatusCode},
        Router,
    };
    use tower::ServiceExt;

    fn state(temp: &std::path::Path, insecure: bool, fake_tls: bool) -> Arc<AppState> {
        let mut config = crate::config::Config::from_toml("").unwrap();
        config.agent_config_socket = temp.join("config.sock");
        if fake_tls {
            config.tls_cert = Some(temp.join("unused-cert"));
            config.tls_key = Some(temp.join("unused-key"));
        }
        Arc::new(AppState {
            config,
            audit: crate::audit::AuditLog::new(&temp.join("audit.jsonl")),
            sessions: crate::auth::SessionStore::new(3600, 600),
            throttle: crate::auth::LoginThrottle::new(5),
            metrics: crate::metrics::Sampler::new(2000, 60).shared(),
            version: "test".into(),
            started_ms: 0,
            insecure_no_auth: insecure,
        })
    }
    async fn http(
        router: &Router,
        method: &str,
        path: &str,
        session: Option<&crate::auth::Session>,
        csrf: bool,
        peer: &str,
        body: serde_json::Value,
    ) -> (StatusCode, serde_json::Value) {
        let mut request = Request::builder()
            .method(method)
            .uri(path)
            .header("content-type", "application/json")
            .extension(ConnectInfo(peer.parse::<std::net::SocketAddr>().unwrap()));
        if let Some(session) = session {
            request = request.header(
                "cookie",
                format!("{}={}", crate::auth::SESSION_COOKIE, session.id),
            );
            if csrf {
                request = request.header(crate::auth::CSRF_HEADER, &session.csrf);
            }
        }
        let response = router
            .clone()
            .oneshot(request.body(Body::from(body.to_string())).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let bytes = to_bytes(response.into_body(), 64 * 1024).await.unwrap();
        assert!(!String::from_utf8_lossy(&bytes).contains("SYNTHETIC_PROVIDER_KEY"));
        (status, serde_json::from_slice(&bytes).unwrap())
    }

    #[tokio::test]
    async fn admin_provider_http_save_list_activate_are_redacted_and_guarded() {
        let temp = tempfile::Builder::new()
            .prefix("depdek-provider-http-")
            .tempdir_in("/tmp")
            .unwrap();
        let state = state(temp.path(), false, true);
        let session = state.sessions.create("127.0.0.1");
        let router = crate::api::router(state.clone());
        let input = json!({"id":"synthetic","name":"Synthetic","base_url":"https://example.invalid/v1","protocol":"openai-completions","model":"model-test","api_key":"SYNTHETIC_PROVIDER_KEY_NOT_REAL"});
        for (auth, csrf, peer, expected) in [
            (None, false, "127.0.0.1:1234", StatusCode::UNAUTHORIZED),
            (
                Some(&session),
                false,
                "127.0.0.1:1234",
                StatusCode::FORBIDDEN,
            ),
            (
                Some(&session),
                true,
                "192.0.2.1:1234",
                StatusCode::FORBIDDEN,
            ),
        ] {
            assert_eq!(
                http(
                    &router,
                    "POST",
                    "/api/agent/providers",
                    auth,
                    csrf,
                    peer,
                    input.clone()
                )
                .await
                .0,
                expected
            );
        }
        assert_eq!(
            http(
                &router,
                "POST",
                "/api/agent/providers",
                Some(&session),
                true,
                "127.0.0.1:1234",
                input.clone()
            )
            .await
            .0,
            StatusCode::SERVICE_UNAVAILABLE
        );
        let listener = tokio::net::UnixListener::bind(&state.config.agent_config_socket).unwrap();
        let broker = tokio::spawn(async move {
            for expected in ["save", "list", "activate"] {
                let (stream, _) = listener.accept().await.unwrap();
                use tokio::io::AsyncBufReadExt;
                let mut reader = tokio::io::BufReader::new(stream);
                let mut line = String::new();
                reader.read_line(&mut line).await.unwrap();
                let request: serde_json::Value = serde_json::from_str(&line).unwrap();
                assert_eq!(request["op"], expected);
                if expected == "save" {
                    assert_eq!(
                        request["provider"]["api_key"],
                        "SYNTHETIC_PROVIDER_KEY_NOT_REAL"
                    );
                }
                let reply = json!({"ok":true,"restart_ok":true,"active_id":"synthetic","message":"loaded","providers":[{"id":"synthetic","name":"Synthetic","base_url":"https://example.invalid/v1","protocol":"openai-completions","model":"model-test","active":true,"configured":true}]});
                reader
                    .get_mut()
                    .write_all(format!("{reply}\n").as_bytes())
                    .await
                    .unwrap();
            }
        });
        for (method, path, input) in [
            ("POST", "/api/agent/providers", input),
            ("GET", "/api/agent/providers", json!(null)),
            (
                "POST",
                "/api/agent/providers/activate",
                json!({"id":"synthetic"}),
            ),
        ] {
            let (status, reply) = http(
                &router,
                method,
                path,
                Some(&session),
                true,
                "127.0.0.1:1234",
                input,
            )
            .await;
            assert_eq!(status, StatusCode::OK);
            assert_eq!(reply["active_id"], "synthetic");
            assert!(reply["providers"][0].get("api_key").is_none());
        }
        broker.await.unwrap();
        let audit = std::fs::read_to_string(temp.path().join("audit.jsonl")).unwrap();
        assert!(!audit.contains("SYNTHETIC_PROVIDER_KEY"));
    }

    #[tokio::test]
    async fn insecure_mode_cannot_save_or_activate_provider() {
        let temp = tempfile::tempdir().unwrap();
        let router = crate::api::router(state(temp.path(), true, false));
        let body = json!({"id":"synthetic","name":"Synthetic","base_url":"https://example.invalid/v1","protocol":"openai-completions","model":"model-test","api_key":"SYNTHETIC_PROVIDER_KEY_NOT_REAL"});
        assert_eq!(
            http(
                &router,
                "POST",
                "/api/agent/providers",
                None,
                false,
                "127.0.0.1:1234",
                body
            )
            .await
            .0,
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            http(
                &router,
                "POST",
                "/api/agent/providers/activate",
                None,
                false,
                "127.0.0.1:1234",
                json!({"id":"synthetic"})
            )
            .await
            .0,
            StatusCode::FORBIDDEN
        );
    }

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
