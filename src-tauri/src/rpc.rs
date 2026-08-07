//! NDJSON stdio JSON-RPC layer between Rust and the Node sidecar
//! (contract section 2).
//!
//! Rust plays both roles on the same pipe:
//! - client: Tauri `agent_*` commands become `agent/*` requests (ids 1..=99999);
//! - server: sidecar `vault/*` requests are served from the Vault service;
//! - sidecar `agent/event` notifications are forwarded as `agent://event`.
//!
//! The vault service never depends on the sidecar being alive.

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::oneshot;

use crate::vault::{Vault, VaultError};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(120);
/// Rust-owned JSON-RPC id space (sidecar uses ids >= 100000).
const MAX_RUST_ID: i64 = 99_999;

/// Called with `(event_name, payload)` to forward events to the frontend.
pub type EmitFn = Arc<dyn Fn(&str, Value) + Send + Sync>;

/// Handle to the sidecar process. Cheap to clone.
#[derive(Clone)]
pub struct Sidecar {
    inner: Arc<SidecarInner>,
}

struct SidecarInner {
    vault: Vault,
    emit: EmitFn,
    node_path: PathBuf,
    sidecar_path: PathBuf,
    proc: tokio::sync::Mutex<Option<SidecarProc>>,
    pending: Mutex<HashMap<i64, oneshot::Sender<Result<Value, String>>>>,
    next_id: AtomicI64,
    alive: Arc<AtomicBool>,
}

struct SidecarProc {
    // Kept so the process is killed when the handle is dropped/replaced.
    #[allow(dead_code)]
    child: Child,
    stdin: ChildStdin,
}

impl Sidecar {
    pub fn new(vault: Vault, emit: EmitFn) -> Self {
        Self::with_runtime(vault, emit, default_node_path(), default_sidecar_path())
    }

    /// Constructor with an explicit sidecar script path. `new` resolves the
    /// path from `AGENT_WORKBENCH_SIDECAR` / the dev layout; this variant
    /// exists mainly for integration tests.
    pub fn with_sidecar_path(vault: Vault, emit: EmitFn, sidecar_path: PathBuf) -> Self {
        Self::with_runtime(vault, emit, PathBuf::from("node"), sidecar_path)
    }

    /// Constructor for packaged applications that ship their own Node runtime
    /// and bundled sidecar script.
    pub fn with_runtime(
        vault: Vault,
        emit: EmitFn,
        node_path: PathBuf,
        sidecar_path: PathBuf,
    ) -> Self {
        Self {
            inner: Arc::new(SidecarInner {
                vault,
                emit,
                node_path,
                sidecar_path,
                proc: tokio::sync::Mutex::new(None),
                pending: Mutex::new(HashMap::new()),
                next_id: AtomicI64::new(0),
                alive: Arc::new(AtomicBool::new(false)),
            }),
        }
    }

    /// Whether the sidecar process is currently running.
    pub fn is_alive(&self) -> bool {
        self.inner.alive.load(Ordering::SeqCst)
    }

    /// Spawn the sidecar if not already running. Called lazily by
    /// `request`; exposed so tests (and eager startup) can spawn the
    /// process without sending a request first.
    pub async fn start(&self) -> Result<(), String> {
        self.ensure_started().await
    }

    /// Spawn the sidecar if not already running.
    async fn ensure_started(&self) -> Result<(), String> {
        if self.inner.alive.load(Ordering::SeqCst) {
            return Ok(());
        }
        let mut guard = self.inner.proc.lock().await;
        // Re-check under the lock: another task may have spawned it.
        if self.inner.alive.load(Ordering::SeqCst) {
            return Ok(());
        }
        if !self.inner.sidecar_path.exists() {
            return Err(format!(
                "sidecar script not found at {}; build the sidecar first \
                 or set AGENT_WORKBENCH_SIDECAR",
                self.inner.sidecar_path.display()
            ));
        }
        let mut child = Command::new(&self.inner.node_path)
            .arg(&self.inner.sidecar_path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            // Sidecar logs go to our stderr; stdout stays protocol-only.
            .stderr(Stdio::inherit())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| {
                format!(
                    "failed to spawn sidecar with {}: {e}",
                    self.inner.node_path.display()
                )
            })?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "failed to capture sidecar stdout".to_string())?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "failed to capture sidecar stdin".to_string())?;
        *guard = Some(SidecarProc { child, stdin });
        self.inner.alive.store(true, Ordering::SeqCst);

        let inner = self.inner.clone();
        tokio::spawn(async move {
            read_loop(inner.clone(), stdout).await;
            inner.mark_dead().await;
        });
        Ok(())
    }

    /// Send a request to the sidecar and await its response.
    pub async fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        self.ensure_started().await?;
        if !self.inner.alive.load(Ordering::SeqCst) {
            return Err(
                "sidecar process exited; check that node is installed and the sidecar is built"
                    .to_string(),
            );
        }
        let id = self.inner.next_id.fetch_add(1, Ordering::Relaxed) % MAX_RUST_ID + 1;
        let (tx, rx) = oneshot::channel();
        self.inner.pending.lock().unwrap().insert(id, tx);
        let request = json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params});
        if let Err(e) = self.send_value(&request).await {
            self.inner.pending.lock().unwrap().remove(&id);
            return Err(format!("failed to write to sidecar: {e}"));
        }
        match tokio::time::timeout(REQUEST_TIMEOUT, rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err("sidecar connection closed".to_string()),
            Err(_) => {
                self.inner.pending.lock().unwrap().remove(&id);
                Err(format!("sidecar request `{method}` timed out"))
            }
        }
    }

    /// Write one NDJSON message to the sidecar's stdin.
    async fn send_value(&self, value: &Value) -> Result<(), String> {
        let mut guard = self.inner.proc.lock().await;
        let proc = guard.as_mut().ok_or("sidecar is not running")?;
        let mut line = serde_json::to_string(value).map_err(|e| e.to_string())?;
        line.push('\n');
        proc.stdin
            .write_all(line.as_bytes())
            .await
            .map_err(|e| e.to_string())?;
        proc.stdin.flush().await.map_err(|e| e.to_string())
    }
}

impl SidecarInner {
    /// Mark the sidecar as dead, drop the process handle and fail every
    /// pending request so callers unblock with a friendly error.
    async fn mark_dead(&self) {
        self.alive.store(false, Ordering::SeqCst);
        *self.proc.lock().await = None;
        let pending: Vec<_> = self.pending.lock().unwrap().drain().collect();
        for (_, tx) in pending {
            let _ = tx.send(Err("sidecar process exited".to_string()));
        }
    }

    /// Dispatch one parsed line from the sidecar.
    async fn handle_line(self: &Arc<Self>, line: &str) {
        if line.trim().is_empty() {
            return;
        }
        let Ok(msg) = serde_json::from_str::<Value>(line) else {
            return; // ignore garbage on the wire
        };
        let method = msg.get("method").and_then(Value::as_str).map(str::to_owned);
        let id = msg.get("id").and_then(Value::as_i64);
        match (method, id) {
            // Incoming request from the sidecar (vault/*).
            (Some(method), Some(id)) => {
                let params = msg.get("params").cloned().unwrap_or(Value::Null);
                let response = match self.handle_request(&method, params).await {
                    Ok(result) => json!({"jsonrpc": "2.0", "id": id, "result": result}),
                    Err(e) => json!({
                        "jsonrpc": "2.0",
                        "id": id,
                        "error": {"code": e.code(), "message": e.to_string()}
                    }),
                };
                let _ = self.send_response(&response).await;
            }
            // Response to one of our requests.
            (None, Some(id)) => {
                if let Some(tx) = self.pending.lock().unwrap().remove(&id) {
                    let result = if let Some(error) = msg.get("error") {
                        let message = error
                            .get("message")
                            .and_then(Value::as_str)
                            .unwrap_or("unknown sidecar error");
                        let code = error.get("code").and_then(Value::as_i64).unwrap_or(0);
                        Err(format!("{message} (code {code})"))
                    } else {
                        Ok(msg.get("result").cloned().unwrap_or(Value::Null))
                    };
                    let _ = tx.send(result);
                }
            }
            // Notification from the sidecar.
            (Some(method), None) => {
                if method == "agent/event" {
                    let params = msg.get("params").cloned().unwrap_or(Value::Null);
                    (self.emit)("agent://event", params);
                }
            }
            (None, None) => {}
        }
    }

    async fn send_response(&self, value: &Value) -> Result<(), String> {
        let mut guard = self.proc.lock().await;
        let Some(proc) = guard.as_mut() else {
            return Err("sidecar is not running".to_string());
        };
        let mut line = serde_json::to_string(value).map_err(|e| e.to_string())?;
        line.push('\n');
        proc.stdin
            .write_all(line.as_bytes())
            .await
            .map_err(|e| e.to_string())?;
        proc.stdin.flush().await.map_err(|e| e.to_string())
    }

    /// Serve a sidecar `vault/*` request through the Vault service.
    async fn handle_request(&self, method: &str, params: Value) -> Result<Value, VaultError> {
        let session_id = params
            .get("session_id")
            .and_then(Value::as_str)
            .unwrap_or("agent");
        let path = params.get("path").and_then(Value::as_str).unwrap_or("");
        let vault = &self.vault;
        let result = match method {
            "vault/read_file" => serde_json::to_value(vault.read_file(session_id, path)?),
            "vault/read_binary" => serde_json::to_value(vault.read_binary(session_id, path)?),
            "vault/write_file" => {
                let content = params
                    .get("content")
                    .and_then(Value::as_str)
                    .ok_or_else(|| VaultError::InvalidParams("content is required".to_string()))?;
                serde_json::to_value(vault.write_file(session_id, path, content)?)
            }
            "vault/list_dir" => serde_json::to_value(vault.list_dir(session_id, path)?),
            "vault/search_files" => {
                let query = params
                    .get("query")
                    .and_then(Value::as_str)
                    .ok_or_else(|| VaultError::InvalidParams("query is required".to_string()))?;
                serde_json::to_value(vault.search_files(session_id, query)?)
            }
            "vault/delete_file" => {
                vault.delete_file(session_id, path)?;
                Ok(json!({}))
            }
            "vault/stat" => serde_json::to_value(vault.stat(session_id, path)?),
            _ => return Err(VaultError::UnknownMethod(method.to_string())),
        };
        result.map_err(|e| VaultError::InvalidParams(format!("serialization failed: {e}")))
    }
}

/// Read sidecar stdout line by line and dispatch each message.
async fn read_loop(inner: Arc<SidecarInner>, stdout: ChildStdout) {
    let mut lines = BufReader::new(stdout).lines();
    loop {
        match lines.next_line().await {
            Ok(Some(line)) => {
                let inner = inner.clone();
                tokio::spawn(async move {
                    inner.handle_line(&line).await;
                });
            }
            // EOF or read error: the process is gone.
            _ => break,
        }
    }
}

/// Sidecar entry point: `AGENT_WORKBENCH_SIDECAR` override, otherwise
/// `<project root>/sidecar/dist/main.js` (dev layout).
fn default_sidecar_path() -> PathBuf {
    if let Ok(path) = std::env::var("AGENT_WORKBENCH_SIDECAR") {
        if !path.is_empty() {
            return PathBuf::from(path);
        }
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../sidecar/dist/main.js")
}

fn default_node_path() -> PathBuf {
    std::env::var("AGENT_WORKBENCH_NODE")
        .ok()
        .filter(|path| !path.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("node"))
}
