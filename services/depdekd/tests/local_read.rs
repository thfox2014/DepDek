#![cfg(unix)]

use std::io::{BufRead, BufReader, Write};
use std::os::unix::fs::{symlink, PermissionsExt};
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use depdekd::service::{manifests, RpcRequest, ServeConfig, Service};
use serde_json::{json, Value};

struct Running(Child);
impl Drop for Running {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn prepare() -> (tempfile::TempDir, ServeConfig) {
    let temp = tempfile::Builder::new()
        .prefix("dd-r1-")
        .tempdir_in("/tmp")
        .unwrap();
    let root = temp.path().join("workspace");
    std::fs::create_dir_all(root.join("documents")).unwrap();
    std::fs::create_dir(root.join("private")).unwrap();
    std::fs::write(
        root.join("documents/receipt.md"),
        "你好，维修资料\nforms@support.empf.org.hk",
    )
    .unwrap();
    std::fs::write(root.join("private/secret.txt"), "never expose me").unwrap();
    let config = ServeConfig {
        workspace_id: "family-demo".into(),
        root,
        read_paths: vec!["documents".into()],
        socket: temp.path().join("runtime/depdekd.sock"),
        secret_dir: None,
        access_users: vec![],
    };
    (temp, config)
}

fn invocation(command: &str, path: &str) -> Value {
    json!({"workspace_id":"family-demo","command":command,"command_version":"1.0","input":{"path":path}})
}
fn request(method: &str, params: Value) -> RpcRequest {
    serde_json::from_value(json!({"jsonrpc":"2.0","id":7,"method":method,"params":params})).unwrap()
}

#[test]
fn manifests_are_versioned_queries_with_closed_input_and_output() {
    let manifests = manifests();
    assert_eq!(manifests.as_array().unwrap().len(), 3);
    for item in manifests.as_array().unwrap() {
        assert_eq!(item["effect"], "query");
        assert_eq!(item["version"], "1.0");
        assert_eq!(item["input_schema"]["additionalProperties"], false);
        assert_eq!(item["output_schema"]["additionalProperties"], false);
        assert_eq!(item["engine_required"], false);
    }
}

#[test]
fn local_identity_cannot_be_claimed_in_input_and_writes_remain_unavailable() {
    if unsafe { libc::geteuid() } == 0 {
        return;
    }
    let (_temp, config) = prepare();
    let service = Service::open(&config).unwrap();
    let uid = service.owner_uid();
    let response = service.dispatch(
        uid + 1,
        request(
            "v2/command.invoke",
            invocation("file.read", "documents/receipt.md"),
        ),
    );
    assert_eq!(
        response.pointer("/error/data/error/code").unwrap(),
        "FORBIDDEN"
    );
    let mut forged = invocation("file.read", "documents/receipt.md");
    forged["actor"] = json!("administrator");
    let response = service.dispatch(uid, request("v2/command.invoke", forged));
    assert_eq!(
        response.pointer("/error/data/error/code").unwrap(),
        "INVALID_INPUT"
    );
    let response = service.dispatch(
        uid,
        request(
            "v2/command.invoke",
            invocation("file.delete", "documents/receipt.md"),
        ),
    );
    assert_eq!(
        response.pointer("/error/data/error/code").unwrap(),
        "CAPABILITY_UNAVAILABLE"
    );
    assert!(config.root.join("documents/receipt.md").exists());
    let mut wrong = invocation("file.read", "documents/receipt.md");
    wrong["workspace_id"] = json!("other-private-space");
    let response = service.dispatch(uid, request("v2/command.invoke", wrong));
    assert_eq!(
        response.pointer("/error/data/error/code").unwrap(),
        "FORBIDDEN"
    );
}

#[test]
fn no_privileged_daemon_or_whole_root_registration() {
    let (_temp, mut config) = prepare();
    if unsafe { libc::geteuid() } == 0 {
        assert!(Service::open(&config).is_err());
    } else {
        config.read_paths = vec![".".into()];
        assert!(Service::open(&config).is_err());
    }
}

fn rpc(socket: &Path, value: Value) -> Value {
    let mut stream = UnixStream::connect(socket).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    let mut bytes = serde_json::to_vec(&value).unwrap();
    bytes.push(b'\n');
    stream.write_all(&bytes).unwrap();
    let mut line = String::new();
    BufReader::new(stream).read_line(&mut line).unwrap();
    serde_json::from_str(&line).unwrap()
}

fn cli(socket: &Path, extra: &[&str], ok: bool) -> Value {
    let output = Command::new(env!("CARGO_BIN_EXE_depdek"))
        .arg("--socket")
        .arg(socket)
        .args(extra)
        .output()
        .unwrap();
    assert_eq!(
        output.status.success(),
        ok,
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}

#[test]
fn real_daemon_cli_and_socket_end_to_end() {
    if unsafe { libc::geteuid() } == 0 {
        eprintln!("SKIP: run end-to-end as non-root local owner");
        return;
    }
    let (temp, config) = prepare();
    let config_path = temp.path().join("config.json");
    std::fs::write(
        &config_path,
        serde_json::to_vec(&json!({"workspace_id":config.workspace_id,
        "root":config.root,"read_paths":config.read_paths,"socket":config.socket}))
        .unwrap(),
    )
    .unwrap();
    let mut child = Running(
        Command::new(env!("CARGO_BIN_EXE_depdekd"))
            .arg("serve")
            .arg("--config")
            .arg(&config_path)
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap(),
    );
    let deadline = Instant::now() + Duration::from_secs(10);
    while !config.socket.exists() {
        if let Some(status) = child.0.try_wait().unwrap() {
            panic!("daemon exited before listening: {status}");
        }
        assert!(Instant::now() < deadline, "socket not ready");
        std::thread::sleep(Duration::from_millis(20));
    }
    // Readiness includes authenticated socket and CLI response.
    let health = cli(&config.socket, &["health"], true);
    assert_eq!(
        health.pointer("/result/data/mode").unwrap(),
        "local_owner_read_only"
    );
    assert!(!health.to_string().contains(config.root.to_str().unwrap()));
    let commands = cli(
        &config.socket,
        &["commands", "--workspace", "family-demo"],
        true,
    );
    assert_eq!(
        commands
            .pointer("/result/data")
            .unwrap()
            .as_array()
            .unwrap()
            .len(),
        3
    );
    let content = cli(
        &config.socket,
        &[
            "command",
            "file.read",
            "--workspace",
            "family-demo",
            "--input",
            r#"{"path":"documents/receipt.md"}"#,
            "--json",
        ],
        true,
    );
    assert_eq!(
        content.pointer("/result/data/result/content").unwrap(),
        "你好，维修资料\nforms@support.empf.org.hk"
    );
    assert_eq!(content.pointer("/result/data/freshness").unwrap(), "live");
    let stat = cli(
        &config.socket,
        &[
            "command",
            "file.stat",
            "--workspace",
            "family-demo",
            "--input",
            r#"{"path":"documents/receipt.md"}"#,
        ],
        true,
    );
    assert_eq!(stat.pointer("/result/data/result/kind").unwrap(), "file");
    let denied = cli(
        &config.socket,
        &[
            "command",
            "file.read",
            "--workspace",
            "family-demo",
            "--input",
            r#"{"path":"private/secret.txt"}"#,
        ],
        false,
    );
    assert_eq!(
        denied.pointer("/error/data/error/code").unwrap(),
        "FORBIDDEN"
    );
    assert!(!denied.to_string().contains("never expose"));
    symlink(
        config.root.join("private/secret.txt"),
        config.root.join("documents/alias.txt"),
    )
    .unwrap();
    std::fs::write(config.root.join("documents/workspace.sqlite"), "internal").unwrap();
    let listing = cli(
        &config.socket,
        &[
            "command",
            "file.list",
            "--workspace",
            "family-demo",
            "--input",
            r#"{"path":"documents"}"#,
        ],
        true,
    );
    assert_eq!(
        listing
            .pointer("/result/data/result/entries")
            .unwrap()
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let forged = rpc(
        &config.socket,
        json!({"jsonrpc":"2.0","id":9,"method":"v2/command.invoke",
        "params":{"workspace_id":"family-demo","command":"file.read","command_version":"1.0","actor":"root","input":{"path":"documents/receipt.md"}}}),
    );
    assert_eq!(
        forged.pointer("/error/data/error/code").unwrap(),
        "INVALID_INPUT"
    );
    let denied_version = rpc(
        &config.socket,
        json!({"jsonrpc":"2.0","id":10,"method":"v2/command.invoke",
        "params":{"workspace_id":"family-demo","command":"file.read","command_version":"999.0","input":{"path":"documents/receipt.md"}}}),
    );
    assert_eq!(
        denied_version.pointer("/error/data/error/code").unwrap(),
        "CAPABILITY_UNAVAILABLE"
    );
    let unknown = rpc(
        &config.socket,
        json!({"jsonrpc":"2.0","id":11,"method":"v2/plan.apply","params":{}}),
    );
    assert_eq!(
        unknown.pointer("/error/data/error/code").unwrap(),
        "CAPABILITY_UNAVAILABLE"
    );
    // A second daemon cannot steal or overwrite the active socket.
    let duplicate = Command::new(env!("CARGO_BIN_EXE_depdekd"))
        .arg("serve")
        .arg("--config")
        .arg(&config_path)
        .output()
        .unwrap();
    assert!(!duplicate.status.success());
    assert_eq!(
        cli(&config.socket, &["health"], true)
            .pointer("/result/data/ready")
            .unwrap(),
        true
    );
    // Oversized and malformed frames are rejected without logging their body.
    let mut stream = UnixStream::connect(&config.socket).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    let payload = vec![b'x'; depdekd::MAX_REQUEST_BYTES + 1];
    let _ = stream.write_all(&payload);
    let mut line = String::new();
    BufReader::new(stream).read_line(&mut line).unwrap();
    let error: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(error.pointer("/error/code").unwrap(), -32600);
    let audit = std::fs::read_to_string(config.root.join(".vault-audit.jsonl")).unwrap();
    let entries: Vec<Value> = audit
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect();
    assert_eq!(entries.len(), 4); // read/stat/denied read/list, not transport metadata
    assert!(entries.iter().all(|e| e["session_id"]
        .as_str()
        .unwrap()
        .starts_with(&format!("v2:local:{}:", unsafe { libc::geteuid() }))));
    assert!(entries.iter().any(|e| e["ok"] == false));
    assert!(!audit.contains("forms@support") && !audit.contains("never expose"));
    // SIGTERM removes only the socket it created and leaves all user files intact.
    unsafe {
        libc::kill(child.0.id() as i32, libc::SIGTERM);
    }
    assert!(child.0.wait().unwrap().success());
    assert!(!config.socket.exists());
    assert!(config.root.join("documents/receipt.md").exists());
}

#[tokio::test]
async fn socket_safety_rejects_public_parent_and_never_unlinks_other_files() {
    let temp = tempfile::tempdir().unwrap();
    let public = temp.path().join("public");
    std::fs::create_dir(&public).unwrap();
    std::fs::set_permissions(&public, std::fs::Permissions::from_mode(0o755)).unwrap();
    assert!(depdekd::transport::bind_socket(&public.join("socket")).is_err());
    let private = temp.path().join("private");
    std::fs::create_dir(&private).unwrap();
    std::fs::set_permissions(&private, std::fs::Permissions::from_mode(0o700)).unwrap();
    let socket = private.join("socket");
    std::fs::write(&socket, "preserve this file").unwrap();
    assert!(depdekd::transport::bind_socket(&socket).is_err());
    assert_eq!(
        std::fs::read_to_string(&socket).unwrap(),
        "preserve this file"
    );
    std::fs::remove_file(&socket).unwrap(); // known fixture created by this test
    let (_listener, guard) = depdekd::transport::bind_socket(&socket).unwrap();
    std::fs::remove_file(&socket).unwrap();
    std::fs::write(&socket, "replacement").unwrap();
    drop(guard);
    assert_eq!(std::fs::read_to_string(&socket).unwrap(), "replacement");
    let link = temp.path().join("link");
    symlink(&private, &link).unwrap();
    assert!(depdekd::transport::bind_socket(&link.join("other.sock")).is_err());
}

#[tokio::test]
async fn split_utf8_frame_is_reassembled_before_json_decoding() {
    let (mut sender, mut receiver) = tokio::net::UnixStream::pair().unwrap();
    let bytes = serde_json::to_vec(&json!({"text":"你好📦forms@support.empf.org.hk"})).unwrap();
    let expected = bytes.clone();
    let task = tokio::spawn(async move {
        use tokio::io::AsyncWriteExt;
        for byte in bytes {
            sender.write_all(&[byte]).await.unwrap();
        }
        sender.write_all(b"\n").await.unwrap();
    });
    let received = depdekd::transport::read_frame(&mut receiver, 1024)
        .await
        .unwrap();
    task.await.unwrap();
    assert_eq!(received, expected);
    assert!(serde_json::from_slice::<Value>(&received).is_ok());
}
