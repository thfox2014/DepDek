//! Integration tests for the stdio JSON-RPC layer (`rpc.rs`) against real
//! child processes: a scripted mock sidecar and, if built, the real Node
//! sidecar. Run with `cargo test --no-default-features` (no Tauri needed).

use std::path::PathBuf;
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

use agent_workbench_lib::audit::Op;
use agent_workbench_lib::rpc::Sidecar;
use agent_workbench_lib::vault::Vault;
use serde_json::{json, Value};

fn node_available() -> bool {
    std::process::Command::new("node")
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

fn fixture_path(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(name)
}

fn real_sidecar_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../sidecar/dist/main.js")
}

type EventRx = Mutex<mpsc::Receiver<(String, Value)>>;

/// Collect events until `pred` matches or the deadline passes.
/// Non-matching events are drained and discarded.
async fn wait_event(
    rx: &EventRx,
    timeout: Duration,
    pred: impl Fn(&str, &Value) -> bool,
) -> Option<(String, Value)> {
    let deadline = Instant::now() + timeout;
    loop {
        if let Ok(ev) = rx.lock().unwrap().try_recv() {
            if pred(&ev.0, &ev.1) {
                return Some(ev);
            }
        }
        if Instant::now() >= deadline {
            return None;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

fn event_channel() -> (
    agent_workbench_lib::rpc::EmitFn,
    EventRx,
) {
    let (tx, rx) = mpsc::channel::<(String, Value)>();
    let emit: agent_workbench_lib::rpc::EmitFn =
        Arc::new(move |event: &str, payload: Value| {
            let _ = tx.send((event.to_string(), payload));
        });
    (emit, Mutex::new(rx))
}

/// The mock sidecar drives Rust with vault/* requests; Rust must serve
/// them from the real Vault service, audit every one (including the
/// rejected path escape) and forward the final agent/event notification.
#[tokio::test]
async fn mock_sidecar_vault_roundtrip() {
    if !node_available() {
        eprintln!("skipping mock_sidecar_vault_roundtrip: node not available");
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("hello.txt"), "hello vault").unwrap();
    let vault = Vault::new();
    vault.set_root(dir.path()).unwrap();

    let (emit, rx) = event_channel();
    let sidecar = Sidecar::with_sidecar_path(
        vault.clone(),
        emit,
        fixture_path("mock_sidecar.mjs"),
    );
    sidecar.start().await.expect("mock sidecar should spawn");
    assert!(sidecar.is_alive());

    // The mock validates all RPC responses itself and only sends
    // stop_reason "mock_done" when every check (including the -32001
    // escape rejection) passed.
    let ev = wait_event(&rx, Duration::from_secs(30), |event, payload| {
        event == "agent://event"
            && payload.get("type").and_then(Value::as_str) == Some("message_complete")
    })
    .await;
    let (_, payload) = ev.expect("expected agent://event message_complete within 30s");
    assert_eq!(
        payload.get("session_id").and_then(Value::as_str),
        Some("test-agent")
    );
    assert_eq!(
        payload.pointer("/data/stop_reason").and_then(Value::as_str),
        Some("mock_done"),
        "mock reported failure: {payload}"
    );

    // The write issued by the mock really happened in the vault root.
    let written = std::fs::read_to_string(dir.path().join("sub/new.txt")).unwrap();
    assert_eq!(written, "from mock");

    // All four operations were audited under the mock's session id,
    // including the failed escape attempt.
    let (entries, total) = vault.audit().read(0, 100);
    assert_eq!(total, 4, "audit entries: {entries:?}");
    assert!(entries.iter().all(|e| e.session_id == "test-agent"));

    // Newest first: the failed read comes first.
    let failed_read = &entries[0];
    assert_eq!(failed_read.op, Op::Read);
    assert!(!failed_read.ok);
    assert_eq!(failed_read.path, "../etc/passwd");
    assert!(
        failed_read
            .error
            .as_deref()
            .unwrap_or("")
            .contains("escapes root"),
        "unexpected error text: {failed_read:?}"
    );

    let write = entries.iter().find(|e| e.op == Op::Write).unwrap();
    assert!(write.ok);
    assert_eq!(write.path, "sub/new.txt");
    assert_eq!(write.size, Some(9));
    assert_eq!(write.sha256.as_deref().map(str::len), Some(64));

    assert!(entries.iter().any(|e| e.op == Op::List && e.ok));
    assert!(entries
        .iter()
        .any(|e| e.op == Op::Read && e.ok && e.path == "hello.txt"));

    // The mock exits after finishing; the Rust side notices the death.
    let deadline = Instant::now() + Duration::from_secs(10);
    while sidecar.is_alive() && Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(!sidecar.is_alive(), "sidecar should be marked dead after exit");
}

/// Against the real built sidecar: unknown-session errors come back as
/// -32011, and a session with an unreachable provider surfaces a network
/// failure as an agent/event error notification.
#[tokio::test]
async fn real_sidecar_agent_flow() {
    if !node_available() {
        eprintln!("skipping real_sidecar_agent_flow: node not available");
        return;
    }
    let sidecar_path = real_sidecar_path();
    if !sidecar_path.exists() {
        eprintln!(
            "skipping real_sidecar_agent_flow: sidecar not built at {}",
            sidecar_path.display()
        );
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let vault = Vault::new();
    vault.set_root(dir.path()).unwrap();

    let (emit, rx) = event_channel();
    let sidecar = Sidecar::with_sidecar_path(vault, emit, sidecar_path);

    // (a) send to an unknown session -> JSON-RPC error with code -32011.
    let err = sidecar
        .request(
            "agent/send",
            json!({"session_id": "no-such-session", "text": "hi"}),
        )
        .await
        .expect_err("send to unknown session must fail");
    assert!(err.contains("-32011"), "expected -32011, got: {err}");

    // (b) create a session whose provider points at an unreachable
    // endpoint; creation itself succeeds, the network failure arrives
    // later as an agent/event error notification.
    let session_id = "itest-unreachable";
    let created = sidecar
        .request(
            "agent/create_session",
            json!({
                "session_id": session_id,
                "provider": {
                    "kind": "openai-compatible",
                    "model": "test-model",
                    "base_url": "http://127.0.0.1:1"
                }
            }),
        )
        .await
        .expect("create_session should succeed even for unreachable endpoints");
    assert_eq!(
        created.get("session_id").and_then(Value::as_str),
        Some(session_id)
    );

    sidecar
        .request(
            "agent/send",
            json!({"session_id": session_id, "text": "hello"}),
        )
        .await
        .expect("agent/send ack should succeed");

    let ev = wait_event(&rx, Duration::from_secs(90), |event, payload| {
        event == "agent://event"
            && payload.get("session_id").and_then(Value::as_str) == Some(session_id)
            && payload.get("type").and_then(Value::as_str) == Some("error")
    })
    .await;
    let (_, payload) = ev
        .unwrap_or_else(|| panic!("expected an agent error event for {session_id} within 90s"));
    let message = payload
        .pointer("/data/message")
        .and_then(Value::as_str)
        .unwrap_or("");
    assert!(!message.is_empty(), "error event without message: {payload}");

    let _ = sidecar
        .request("agent/close_session", json!({"session_id": session_id}))
        .await;
}
