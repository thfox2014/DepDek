//! Narrow BFF: fixed authenticated read RPCs only, never owner credentials RPC.
//! The daemon-issued user session is separate from the Webdesk admin cookie.
use crate::state::AppState;
use axum::{
    extract::{Query, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use zeroize::{Zeroize, Zeroizing};

const COOKIE: &str = "depdek_business_session";
const CSRF: &str = "x-depdek-business-csrf";
const MAX_REQUEST: usize = 64 * 1024;
const MAX_RESPONSE: usize = 2 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Login {
    username: String,
    password: String,
}
impl Drop for Login {
    fn drop(&mut self) {
        self.password.zeroize();
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Workspace {
    workspace_id: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Command {
    workspace_id: String,
    command: String,
    command_version: String,
    input: Value,
}
struct Failure(StatusCode, &'static str);
impl IntoResponse for Failure {
    fn into_response(self) -> Response {
        reply(self.0, json!({"error":{"code":self.1}}))
    }
}
fn reply(status: StatusCode, body: Value) -> Response {
    let mut response = (status, Json(body)).into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    response
}
fn enabled(state: &AppState) -> Result<(), Failure> {
    if state.insecure_no_auth {
        return Err(Failure(StatusCode::FORBIDDEN, "BUSINESS_AUTH_DISABLED"));
    }
    if state.config.business_socket.is_none() || state.config.business_origin.is_none() {
        return Err(Failure(
            StatusCode::SERVICE_UNAVAILABLE,
            "CAPABILITY_UNAVAILABLE",
        ));
    }
    Ok(())
}
fn origin(state: &AppState, headers: &HeaderMap) -> Result<(), Failure> {
    enabled(state)?;
    if headers.get(header::ORIGIN).and_then(|h| h.to_str().ok())
        != state.config.business_origin.as_deref()
    {
        return Err(Failure(StatusCode::FORBIDDEN, "ORIGIN_REJECTED"));
    }
    Ok(())
}
fn session(state: &AppState, headers: &HeaderMap) -> Result<Zeroizing<String>, Failure> {
    enabled(state)?;
    if headers.contains_key(header::ORIGIN) {
        origin(state, headers)?;
    }
    let value = crate::auth::cookie(headers, COOKIE)
        .ok_or(Failure(StatusCode::UNAUTHORIZED, "AUTH_REQUIRED"))?;
    if value.len() != 67
        || !value.starts_with("bs_")
        || !value.as_bytes()[3..].iter().all(|c| c.is_ascii_hexdigit())
    {
        return Err(Failure(StatusCode::UNAUTHORIZED, "SESSION_EXPIRED"));
    }
    Ok(Zeroizing::new(value.to_owned()))
}
fn csrf(headers: &HeaderMap) -> Result<Zeroizing<String>, Failure> {
    let value = headers
        .get(CSRF)
        .and_then(|h| h.to_str().ok())
        .ok_or(Failure(StatusCode::FORBIDDEN, "CSRF_REQUIRED"))?;
    if value.len() != 69
        || !value.starts_with("csrf_")
        || !value.as_bytes()[5..].iter().all(|c| c.is_ascii_hexdigit())
    {
        return Err(Failure(StatusCode::FORBIDDEN, "CSRF_REQUIRED"));
    }
    Ok(Zeroizing::new(value.to_owned()))
}
fn wipe(value: &mut Value) {
    match value {
        Value::String(s) => s.zeroize(),
        Value::Array(a) => a.iter_mut().for_each(wipe),
        Value::Object(o) => o.values_mut().for_each(wipe),
        _ => {}
    }
}
#[cfg(unix)]
async fn rpc(state: &AppState, method: &'static str, params: Value) -> Result<Value, Failure> {
    enabled(state)?;
    // Encoded requests are erased on timeout/connection error as well.
    let mut request = json!({"jsonrpc":"2.0","id":1,"method":method,"params":params});
    let encoded = serde_json::to_vec(&request);
    wipe(&mut request);
    let mut bytes =
        Zeroizing::new(encoded.map_err(|_| Failure(StatusCode::BAD_REQUEST, "INVALID_INPUT"))?);
    if bytes.len() > MAX_REQUEST {
        return Err(Failure(StatusCode::PAYLOAD_TOO_LARGE, "LIMIT_EXCEEDED"));
    }
    bytes.push(b'\n');
    let result = tokio::time::timeout(std::time::Duration::from_secs(20), async {
        let mut stream =
            tokio::net::UnixStream::connect(state.config.business_socket.as_ref().unwrap())
                .await
                .map_err(|_| ())?;
        if stream.peer_cred().map_err(|_| ())?.uid() != unsafe { libc::geteuid() } {
            return Err(());
        }
        stream.write_all(&bytes).await.map_err(|_| ())?;
        let mut output = Zeroizing::new(Vec::new());
        let mut buffer = Zeroizing::new([0u8; 4096]);
        loop {
            let n = stream.read(&mut *buffer).await.map_err(|_| ())?;
            if n == 0 {
                return Err(());
            }
            if let Some(end) = buffer[..n].iter().position(|b| *b == b'\n') {
                if end + 1 != n || output.len() + end > MAX_RESPONSE {
                    return Err(());
                }
                output.extend_from_slice(&buffer[..end]);
                break;
            }
            if output.len() + n > MAX_RESPONSE {
                return Err(());
            }
            output.extend_from_slice(&buffer[..n]);
        }
        serde_json::from_slice::<Value>(&output).map_err(|_| ())
    })
    .await
    .map_err(|_| Failure(StatusCode::SERVICE_UNAVAILABLE, "CORE_UNAVAILABLE"))?
    .map_err(|_| Failure(StatusCode::SERVICE_UNAVAILABLE, "CORE_UNAVAILABLE"))?;
    if result["jsonrpc"] != "2.0" || result["id"] != 1 {
        return Err(Failure(StatusCode::SERVICE_UNAVAILABLE, "CORE_UNAVAILABLE"));
    }
    if let Some(code) = result
        .pointer("/error/data/error/code")
        .and_then(Value::as_str)
    {
        return Err(match code {
            "AUTH_REQUIRED" => Failure(StatusCode::UNAUTHORIZED, "AUTH_REQUIRED"),
            "SESSION_EXPIRED" => Failure(StatusCode::UNAUTHORIZED, "SESSION_EXPIRED"),
            "FORBIDDEN" => Failure(StatusCode::FORBIDDEN, "FORBIDDEN"),
            "NOT_FOUND" => Failure(StatusCode::NOT_FOUND, "NOT_FOUND"),
            "INVALID_INPUT" => Failure(StatusCode::UNPROCESSABLE_ENTITY, "INVALID_INPUT"),
            "RATE_LIMITED" => Failure(StatusCode::TOO_MANY_REQUESTS, "RATE_LIMITED"),
            "AUDIT_UNAVAILABLE" => Failure(StatusCode::SERVICE_UNAVAILABLE, "AUDIT_UNAVAILABLE"),
            _ => Failure(StatusCode::SERVICE_UNAVAILABLE, "CAPABILITY_UNAVAILABLE"),
        });
    }
    result
        .get("result")
        .cloned()
        .ok_or(Failure(StatusCode::SERVICE_UNAVAILABLE, "CORE_UNAVAILABLE"))
}
#[cfg(not(unix))]
async fn rpc(_: &AppState, _: &'static str, mut params: Value) -> Result<Value, Failure> {
    wipe(&mut params);
    Err(Failure(
        StatusCode::SERVICE_UNAVAILABLE,
        "CAPABILITY_UNAVAILABLE",
    ))
}

fn set_cookie(response: &mut Response, value: &str, secure: bool, age: u64) {
    let text = format!(
        "{COOKIE}={value}; Path=/api/v2; HttpOnly; SameSite=Strict; Max-Age={age}{}",
        if secure { "; Secure" } else { "" }
    );
    response
        .headers_mut()
        .insert(header::SET_COOKIE, text.parse().unwrap());
}
pub async fn login(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(input): Json<Login>,
) -> Response {
    let response = async {
        origin(&state, &headers)?;
        // Admin login does not supply business identity, even if it exists.
        let mut result = rpc(
            &state,
            "v2/auth.login",
            json!({"username":input.username,"password":input.password}),
        )
        .await?;
        let mut token = result
            .get_mut("data")
            .and_then(Value::as_object_mut)
            .and_then(|d| d.remove("session_token"))
            .ok_or(Failure(StatusCode::SERVICE_UNAVAILABLE, "CORE_UNAVAILABLE"))?;
        let raw = token
            .as_str()
            .filter(|s| {
                s.len() == 67
                    && s.starts_with("bs_")
                    && s.as_bytes()[3..].iter().all(|b| b.is_ascii_hexdigit())
            })
            .ok_or(Failure(StatusCode::SERVICE_UNAVAILABLE, "CORE_UNAVAILABLE"))?;
        let mut response = reply(StatusCode::OK, result);
        set_cookie(&mut response, raw, state.secure_cookies(), 3600);
        wipe(&mut token);
        Ok::<_, Failure>(response)
    }
    .await
    .unwrap_or_else(IntoResponse::into_response);
    state.audit.record(
        "business.login",
        "business",
        "proxy",
        response.status().is_success(),
        json!({"http_status":response.status().as_u16()}),
    );
    response
}
pub async fn current(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    async {
        let token = session(&state, &headers)?;
        let result = rpc(&state, "v2/auth.session", json!({"session_token":&*token})).await?;
        Ok::<_, Failure>(reply(StatusCode::OK, result))
    }
    .await
    .unwrap_or_else(IntoResponse::into_response)
}
pub async fn logout(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    let response = async {
        origin(&state, &headers)?;
        let token = session(&state, &headers)?;
        let csrf = csrf(&headers)?;
        let result = rpc(
            &state,
            "v2/auth.logout",
            json!({"session_token":&*token,"csrf_token":&*csrf}),
        )
        .await?;
        let mut response = reply(StatusCode::OK, result);
        set_cookie(&mut response, "", state.secure_cookies(), 0);
        Ok::<_, Failure>(response)
    }
    .await
    .unwrap_or_else(IntoResponse::into_response);
    state.audit.record(
        "business.logout",
        "business",
        "proxy",
        response.status().is_success(),
        json!({"http_status":response.status().as_u16()}),
    );
    response
}
pub async fn workspaces(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    async {
        let token = session(&state, &headers)?;
        let result = rpc(
            &state,
            "v2/delegated.workspaces",
            json!({"session_token":&*token}),
        )
        .await?;
        Ok::<_, Failure>(reply(StatusCode::OK, result))
    }
    .await
    .unwrap_or_else(IntoResponse::into_response)
}
pub async fn commands(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<Workspace>,
) -> Response {
    async {
        let token = session(&state, &headers)?;
        let result = rpc(
            &state,
            "v2/delegated.commands",
            json!({"session_token":&*token,"workspace_id":query.workspace_id}),
        )
        .await?;
        Ok::<_, Failure>(reply(StatusCode::OK, result))
    }
    .await
    .unwrap_or_else(IntoResponse::into_response)
}
pub async fn invoke(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(input): Json<Command>,
) -> Response {
    async {origin(&state,&headers)?;let token=session(&state,&headers)?;let csrf=csrf(&headers)?;
        let result=rpc(&state,"v2/delegated.invoke",json!({"session_token":&*token,"csrf_token":&*csrf,"workspace_id":input.workspace_id,"command":input.command,"command_version":input.command_version,"input":input.input})).await?;
        Ok::<_,Failure>(reply(StatusCode::OK,result))
    }.await.unwrap_or_else(IntoResponse::into_response)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::{
        audit::AuditLog,
        auth::{LoginThrottle, SessionStore},
        config::Config,
    };
    use agent_workbench_lib::{
        secrets::SecretText,
        vault::{hash_business_password, AccessUser},
    };
    use axum::{
        body::{to_bytes, Body},
        http::Request,
        Router,
    };
    use depdekd::{
        service::{ServeConfig, Service},
        transport::{bind_socket, serve},
    };
    use tower::ServiceExt;
    const PASSWORD: &str = "SYNTHETIC_HTTP_BUSINESS_PASSWORD";
    const ORIGIN: &str = "http://127.0.0.1:8787";
    fn test_state(
        data: &std::path::Path,
        socket: std::path::PathBuf,
        insecure: bool,
    ) -> Arc<AppState> {
        let mut config = Config::from_toml("").unwrap();
        config.bind = "127.0.0.1:8787".parse().unwrap();
        config.data_dir = Some(data.into());
        config.business_socket = Some(socket);
        config.business_origin = Some(ORIGIN.into());
        config.validate().unwrap();
        Arc::new(AppState {
            config,
            audit: AuditLog::new(&data.join("audit.jsonl")),
            sessions: SessionStore::new(3600, 600),
            throttle: LoginThrottle::new(5),
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
        cookie: Option<&str>,
        csrf: Option<&str>,
        origin: Option<&str>,
        body: Value,
    ) -> (StatusCode, HeaderMap, Value) {
        let mut builder = Request::builder()
            .method(method)
            .uri(path)
            .header(header::CONTENT_TYPE, "application/json");
        if let Some(value) = cookie {
            builder = builder.header(header::COOKIE, value);
        }
        if let Some(value) = csrf {
            builder = builder.header(CSRF, value);
        }
        if let Some(value) = origin {
            builder = builder.header(header::ORIGIN, value);
        }
        let response = router
            .clone()
            .oneshot(builder.body(Body::from(body.to_string())).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let headers = response.headers().clone();
        let bytes = to_bytes(response.into_body(), MAX_RESPONSE).await.unwrap();
        let value =
            serde_json::from_slice(&bytes).unwrap_or_else(|_| json!({"raw_rejection":true}));
        assert!(!String::from_utf8_lossy(&bytes).contains(PASSWORD));
        (status, headers, value)
    }
    #[tokio::test]
    async fn http_bff_uses_real_daemon_socket_and_rejects_identity_and_scope_bypasses() {
        if unsafe { libc::geteuid() } == 0 {
            eprintln!("SKIP non-root business BFF test");
            return;
        }
        let temp = tempfile::Builder::new()
            .prefix("dd-bff-")
            .tempdir_in("/tmp")
            .unwrap();
        let root = temp.path().join("home");
        std::fs::create_dir_all(root.join("documents/alice")).unwrap();
        std::fs::create_dir(root.join("documents/bob")).unwrap();
        std::fs::write(root.join("documents/alice/receipt.md"), "alice-evidence").unwrap();
        std::fs::write(root.join("documents/bob/receipt.md"), "bob-evidence").unwrap();
        let socket = temp.path().join("runtime/command.sock");
        let core = Arc::new(
            Service::open(&ServeConfig {
                workspace_id: "family-demo".into(),
                root: root.clone(),
                read_paths: vec!["documents".into()],
                socket: socket.clone(),
                secret_dir: None,
                access_users: vec![AccessUser {
                    principal_id: "alice".into(),
                    password_hash: hash_business_password(SecretText::new(PASSWORD.into()))
                        .unwrap(),
                    read_paths: vec!["documents/alice".into()],
                }],
            })
            .unwrap(),
        );
        let (listener, guard) = bind_socket(&socket).unwrap();
        let (stop_tx, stop_rx) = tokio::sync::oneshot::channel::<()>();
        let daemon = tokio::spawn(serve(listener, core, async {
            let _ = stop_rx.await;
        }));
        let webdata = temp.path().join("webdata");
        std::fs::create_dir(&webdata).unwrap();
        let state = test_state(&webdata, socket.clone(), false);
        let router = crate::api::router(state.clone());
        // Existing admin cookie is not a business identity.
        let admin = state.sessions.create("127.0.0.1");
        let admin_cookie = format!("depdek_webdesk_session={}", admin.id);
        assert_eq!(
            http(
                &router,
                "GET",
                "/api/v2/workspaces",
                Some(&admin_cookie),
                None,
                None,
                json!({})
            )
            .await
            .0,
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            http(
                &router,
                "POST",
                "/api/v2/auth/login",
                None,
                None,
                Some("https://attacker.invalid"),
                json!({"username":"alice","password":PASSWORD})
            )
            .await
            .0,
            StatusCode::FORBIDDEN
        );
        let (status, headers, login) = http(
            &router,
            "POST",
            "/api/v2/auth/login",
            None,
            None,
            Some(ORIGIN),
            json!({"username":"alice","password":PASSWORD}),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert!(login["data"].get("session_token").is_none());
        assert_eq!(login["data"]["principal_id"], "alice");
        assert_eq!(headers[header::CACHE_CONTROL], "no-store");
        let cookie_header = headers[header::SET_COOKIE].to_str().unwrap();
        assert!(cookie_header.contains("HttpOnly; SameSite=Strict"));
        let cookie = cookie_header.split(';').next().unwrap();
        let raw = cookie.split_once('=').unwrap().1;
        assert!(!login.to_string().contains(raw));
        let csrf = login["data"]["csrf_token"].as_str().unwrap();
        assert_eq!(
            http(
                &router,
                "GET",
                "/api/v2/auth/session",
                Some(cookie),
                None,
                None,
                json!({})
            )
            .await
            .2["data"]["principal_id"],
            "alice"
        );
        let scopes = http(
            &router,
            "GET",
            "/api/v2/workspaces",
            Some(cookie),
            None,
            None,
            json!({}),
        )
        .await
        .2;
        assert_eq!(scopes["data"]["workspaces"].as_array().unwrap().len(), 1);
        assert_eq!(
            http(
                &router,
                "GET",
                "/api/v2/commands?workspace_id=family-demo",
                Some(cookie),
                None,
                None,
                json!({})
            )
            .await
            .2["data"]
                .as_array()
                .unwrap()
                .len(),
            3
        );
        let command = json!({"workspace_id":"family-demo","command":"file.read","command_version":"1.0","input":{"path":"documents/alice/receipt.md"}});
        assert_eq!(
            http(
                &router,
                "POST",
                "/api/v2/commands/invoke",
                Some(cookie),
                None,
                Some(ORIGIN),
                command.clone()
            )
            .await
            .0,
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            http(
                &router,
                "POST",
                "/api/v2/commands/invoke",
                Some(cookie),
                Some(csrf),
                Some(ORIGIN),
                command.clone()
            )
            .await
            .2["data"]["result"]["content"],
            "alice-evidence"
        );
        let mut hidden = command.clone();
        hidden["input"]["path"] = json!("documents/bob/receipt.md");
        let (status, _, result) = http(
            &router,
            "POST",
            "/api/v2/commands/invoke",
            Some(cookie),
            Some(csrf),
            Some(ORIGIN),
            hidden,
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert!(!result.to_string().contains("bob-evidence"));
        let mut forged = command.clone();
        forged["actor"] = json!("admin");
        assert_eq!(
            http(
                &router,
                "POST",
                "/api/v2/commands/invoke",
                Some(cookie),
                Some(csrf),
                Some(ORIGIN),
                forged
            )
            .await
            .0,
            StatusCode::UNPROCESSABLE_ENTITY
        );
        let mut write = command.clone();
        write["command"] = json!("file.delete");
        assert_eq!(
            http(
                &router,
                "POST",
                "/api/v2/commands/invoke",
                Some(cookie),
                Some(csrf),
                Some(ORIGIN),
                write
            )
            .await
            .0,
            StatusCode::SERVICE_UNAVAILABLE
        );
        assert_eq!(
            http(
                &router,
                "POST",
                "/api/v2/credentials.get",
                Some(cookie),
                Some(csrf),
                Some(ORIGIN),
                json!({})
            )
            .await
            .0,
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            http(
                &router,
                "POST",
                "/api/v2/auth/logout",
                Some(cookie),
                Some(csrf),
                Some(ORIGIN),
                json!({})
            )
            .await
            .0,
            StatusCode::OK
        );
        assert_eq!(
            http(
                &router,
                "GET",
                "/api/v2/workspaces",
                Some(cookie),
                None,
                None,
                json!({})
            )
            .await
            .0,
            StatusCode::UNAUTHORIZED
        );
        let audit = std::fs::read_to_string(root.join(".vault-audit.jsonl")).unwrap();
        for secret in [PASSWORD, raw, csrf, "alice-evidence", "bob-evidence"] {
            assert!(!audit.contains(secret));
        }
        let insecure = crate::api::router(test_state(&webdata, socket, true));
        assert_eq!(
            http(
                &insecure,
                "POST",
                "/api/v2/auth/login",
                None,
                None,
                Some(ORIGIN),
                json!({"username":"alice","password":PASSWORD})
            )
            .await
            .0,
            StatusCode::FORBIDDEN
        );
        stop_tx.send(()).unwrap();
        daemon.await.unwrap().unwrap();
        drop(guard);
    }
    #[test]
    fn bff_config_requires_exact_origin_and_tls_or_loopback() {
        let mut config = Config::from_toml("").unwrap();
        config.business_socket = Some("/tmp/private/core.sock".into());
        config.business_origin = Some("http://192.168.1.2:8787".into());
        assert!(config.validate().is_err());
        config.bind = "127.0.0.1:8787".parse().unwrap();
        config.business_origin = Some(ORIGIN.into());
        assert!(config.validate().is_ok());
        for bad in [
            "http://127.0.0.1:8787/",
            "http://user:password@127.0.0.1:8787",
            "http://127.0.0.1:8787?secret=1",
            "https://attacker.invalid",
        ] {
            config.business_origin = Some(bad.into());
            assert!(config.validate().is_err());
        }
        config.tls_cert = Some("/synthetic/cert.pem".into());
        config.tls_key = Some("/synthetic/key.pem".into());
        config.business_origin = Some("https://127.0.0.1:8787".into());
        assert!(config.validate().is_err());
    }
}
