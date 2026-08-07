//! End-to-end test against a real local model (llama.cpp OpenAI-compatible
//! endpoint) driving the full chain:
//! test -> rpc.rs -> real sidecar (pi-agent-core) -> model with tools
//!      -> vault/* RPC back into the real Vault service -> audit log.
//!
//! Skips (does not fail) when node, the built sidecar or the local model
//! endpoint is unavailable. Run with:
//!   cargo test --no-default-features --test e2e_local_model -- --nocapture

use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::PathBuf;
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

use agent_workbench_lib::audit::Op;
use agent_workbench_lib::rpc::Sidecar;
use agent_workbench_lib::vault::Vault;
use serde_json::{json, Value};

const BASE_URL: &str = "http://localhost:8080/v1";
const MODEL: &str = "Qwen3.6";
const SESSION_ID: &str = "e2e-local-model";
const EVENT_TIMEOUT: Duration = Duration::from_secs(180);

fn node_available() -> bool {
    std::process::Command::new("node")
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

fn real_sidecar_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../sidecar/dist/main.js")
}

/// Plain-socket HTTP GET probe for the llama.cpp endpoint (no extra deps).
fn endpoint_reachable() -> bool {
    let addr = match "127.0.0.1:8080".parse() {
        Ok(addr) => addr,
        Err(_) => return false,
    };
    let Ok(mut stream) = TcpStream::connect_timeout(&addr, Duration::from_secs(3)) else {
        return false;
    };
    stream
        .set_read_timeout(Some(Duration::from_secs(3)))
        .ok();
    stream
        .set_write_timeout(Some(Duration::from_secs(3)))
        .ok();
    if stream
        .write_all(b"GET /v1/models HTTP/1.0\r\nHost: localhost:8080\r\n\r\n")
        .is_err()
    {
        return false;
    }
    let mut buf = [0u8; 1024];
    let Ok(n) = stream.read(&mut buf) else {
        return false;
    };
    String::from_utf8_lossy(&buf[..n]).contains(" 200")
}

#[tokio::test]
async fn e2e_local_model_agent_reads_and_writes() {
    if !node_available() {
        eprintln!("skipping e2e_local_model: node not available");
        return;
    }
    let sidecar_path = real_sidecar_path();
    if !sidecar_path.exists() {
        eprintln!(
            "skipping e2e_local_model: sidecar not built at {}",
            sidecar_path.display()
        );
        return;
    }
    if !endpoint_reachable() {
        eprintln!("skipping e2e_local_model: {BASE_URL} unreachable");
        return;
    }

    // Vault root with a small poem to summarize.
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(
        dir.path().join("poem.txt"),
        "The fog comes\non little cat feet.\n\nIt sits looking\nover harbor and city\non silent haunches\nand then moves on.\n",
    )
    .unwrap();
    let vault = Vault::new();
    vault.set_root(dir.path()).unwrap();

    let (tx, rx) = mpsc::channel::<(String, Value)>();
    let rx = Mutex::new(rx);
    let emit: agent_workbench_lib::rpc::EmitFn = Arc::new(move |event: &str, payload: Value| {
        let _ = tx.send((event.to_string(), payload));
    });
    let sidecar = Sidecar::with_sidecar_path(vault.clone(), emit, sidecar_path);

    let created = sidecar
        .request(
            "agent/create_session",
            json!({
                "session_id": SESSION_ID,
                "provider": {
                    "kind": "openai-compatible",
                    "api_key": "dummy",
                    "model": MODEL,
                    "base_url": BASE_URL
                }
            }),
        )
        .await
        .expect("create_session should succeed");
    assert_eq!(
        created.get("session_id").and_then(Value::as_str),
        Some(SESSION_ID)
    );

    sidecar
        .request(
            "agent/send",
            json!({
                "session_id": SESSION_ID,
                "text": concat!(
                    "Do exactly this, using the tools (do not answer from memory): ",
                    "1. Call the read_file tool with path \"poem.txt\". ",
                    "2. Then call the write_file tool with path \"summary.txt\" and ",
                    "a one-line summary of the poem as content."
                )
            }),
        )
        .await
        .expect("agent/send ack should succeed");

    // Collect events until message_complete (or a fatal error event).
    let deadline = Instant::now() + EVENT_TIMEOUT;
    let mut read_tool_seen = false;
    let mut write_tool_seen = false;
    let mut completed = false;
    let mut agent_error: Option<String> = None;
    while Instant::now() < deadline && !completed && agent_error.is_none() {
        let next = rx.lock().unwrap().try_recv();
        let Ok((event, payload)) = next else {
            tokio::time::sleep(Duration::from_millis(50)).await;
            continue;
        };
        eprintln!("[event] {event} {payload}");
        if event != "agent://event"
            || payload.get("session_id").and_then(Value::as_str) != Some(SESSION_ID)
        {
            continue;
        }
        match payload.get("type").and_then(Value::as_str) {
            Some("tool_call_start") => {
                match payload.pointer("/data/name").and_then(Value::as_str) {
                    Some("read_file") => read_tool_seen = true,
                    Some("write_file") => write_tool_seen = true,
                    _ => {}
                }
            }
            Some("message_complete") => completed = true,
            Some("error") => {
                agent_error = payload
                    .pointer("/data/message")
                    .and_then(Value::as_str)
                    .map(str::to_owned);
            }
            _ => {}
        }
    }

    if let Some(message) = &agent_error {
        panic!("agent reported error before completing: {message}");
    }
    assert!(completed, "no message_complete within {EVENT_TIMEOUT:?}");

    // (a)(b) the model actually called both tools.
    assert!(read_tool_seen, "expected a tool_call_start for read_file");
    assert!(write_tool_seen, "expected a tool_call_start for write_file");

    // (c) summary.txt really landed in the vault root.
    let summary = std::fs::read_to_string(dir.path().join("summary.txt"))
        .expect("summary.txt should exist in the vault root");
    assert!(!summary.trim().is_empty(), "summary.txt is empty");
    eprintln!("[e2e] summary.txt content: {}", summary.trim());

    // (d) audit log recorded both ops under the agent session id.
    let (entries, _total) = vault.audit().read(0, 100);
    for entry in &entries {
        eprintln!("[audit] {entry:?}");
    }
    let read_entry = entries.iter().find(|e| {
        e.session_id == SESSION_ID && e.op == Op::Read && e.path == "poem.txt"
    });
    assert!(
        read_entry.is_some_and(|e| e.ok),
        "missing successful audit entry for read poem.txt: {entries:?}"
    );
    let write_entry = entries.iter().find(|e| {
        e.session_id == SESSION_ID && e.op == Op::Write && e.path == "summary.txt"
    });
    assert!(
        write_entry.is_some_and(|e| e.ok && e.sha256.is_some()),
        "missing successful audit entry (with sha256) for write summary.txt: {entries:?}"
    );

    let _ = sidecar
        .request("agent/close_session", json!({"session_id": SESSION_ID}))
        .await;
}
