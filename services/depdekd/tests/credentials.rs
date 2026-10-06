#![cfg(unix)]
use depdekd::service::{RpcRequest, ServeConfig, Service};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

const PASS: &str = "synthetic-cli-store-passphrase";
const KEY: &str = "SYNTHETIC_KEY_NEVER_PRINTED";
struct Running(Child);
impl Drop for Running {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
fn prepare() -> (tempfile::TempDir, ServeConfig) {
    let temp = tempfile::Builder::new()
        .prefix("dd-secrets-")
        .tempdir_in("/tmp")
        .unwrap();
    let root = temp.path().join("home");
    std::fs::create_dir_all(root.join("documents")).unwrap();
    let private = temp.path().join("private");
    std::fs::create_dir(&private).unwrap();
    std::fs::set_permissions(&private, std::fs::Permissions::from_mode(0o700)).unwrap();
    let config = ServeConfig {
        local_model_profiles: vec![],
        worker_transport: None,
        workspace_id: "family-demo".into(),
        root,
        read_paths: vec!["documents".into()],
        socket: temp.path().join("runtime/command.sock"),
        secret_dir: Some(private),
        access_users: vec![],
        provider_profiles: vec![],
    };
    (temp, config)
}
fn start(config: &ServeConfig, path: &Path) -> Running {
    std::fs::write(path,serde_json::to_vec(&json!({"workspace_id":config.workspace_id,"root":config.root,"read_paths":config.read_paths,"socket":config.socket,"secret_dir":config.secret_dir})).unwrap()).unwrap();
    let mut child = Running(
        Command::new(env!("CARGO_BIN_EXE_depdekd"))
            .arg("serve")
            .arg("--config")
            .arg(path)
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap(),
    );
    let deadline = Instant::now() + Duration::from_secs(10);
    while !config.socket.exists() {
        assert!(child.0.try_wait().unwrap().is_none(), "daemon exited");
        assert!(Instant::now() < deadline, "socket not ready");
        std::thread::sleep(Duration::from_millis(20));
    }
    child
}
fn assert_redacted(text: &str) {
    assert!(!text.contains(KEY));
    assert!(!text.contains(PASS));
    for secret in [
        "DEMO_ONLY_NOT_A_VALID_PROVIDER_KEY",
        "DEMO_ONLY_NOT_A_VALID_MAIL_PASSWORD",
        "DEMO_ONLY_NOT_A_VALID_CALENDAR_PASSWORD",
        "DEMO_ONLY_NOT_A_VALID_CALENDAR_TOKEN",
    ] {
        assert!(!text.contains(secret));
    }
}
fn stop(daemon: &mut Running) {
    unsafe {
        libc::kill(daemon.0.id() as i32, libc::SIGTERM);
    }
    assert!(daemon.0.wait().unwrap().success());
    let mut logs = String::new();
    daemon
        .0
        .stderr
        .take()
        .unwrap()
        .read_to_string(&mut logs)
        .unwrap();
    assert_redacted(&logs);
}
fn cli(socket: &Path, action: &str, input: Option<Value>, success: bool) -> Value {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_depdek"));
    cmd.arg("--socket")
        .arg(socket)
        .args(["credentials", action, "--workspace", "family-demo"]);
    if input.is_some() {
        cmd.arg("--stdin");
    }
    let mut child = cmd
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    if let Some(input) = input {
        child
            .stdin
            .take()
            .unwrap()
            .write_all(&serde_json::to_vec(&input).unwrap())
            .unwrap();
    }
    let output = child.wait_with_output().unwrap();
    assert_redacted(&String::from_utf8_lossy(&output.stdout));
    assert_redacted(&String::from_utf8_lossy(&output.stderr));
    assert_eq!(
        output.status.success(),
        success,
        "unexpected CLI status (diagnostic redacted)"
    );
    serde_json::from_slice(&output.stdout).unwrap()
}
fn rpc(socket: &Path, method: &str, params: Value) -> Value {
    let mut stream = UnixStream::connect(socket).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(20)))
        .unwrap();
    let mut request =
        serde_json::to_vec(&json!({"jsonrpc":"2.0","id":8,"method":method,"params":params}))
            .unwrap();
    request.push(b'\n');
    stream.write_all(&request).unwrap();
    let mut line = String::new();
    BufReader::new(stream).read_line(&mut line).unwrap();
    assert_redacted(&line);
    serde_json::from_str(&line).unwrap()
}

#[test]
fn disabled_credentials_are_unavailable_and_never_agent_manifest_tools() {
    if unsafe { libc::geteuid() } == 0 {
        eprintln!("SKIP non-root credential service test");
        return;
    }
    let (_temp, mut config) = prepare();
    config.secret_dir = None;
    let service = Service::open(&config).unwrap();
    let request:RpcRequest=serde_json::from_value(json!({"jsonrpc":"2.0","id":1,"method":"v2/credentials.status","params":{"workspace_id":"family-demo","input":{}}})).unwrap();
    let result = service.dispatch(service.owner_uid(), request);
    assert_eq!(
        result["error"]["data"]["error"]["code"],
        "CAPABILITY_UNAVAILABLE"
    );
    assert_eq!(depdekd::service::manifests().as_array().unwrap().len(), 3);
}

#[test]
fn real_cli_stdin_roundtrip_restart_redaction_and_no_get_or_forged_actor() {
    if unsafe { libc::geteuid() } == 0 {
        eprintln!("SKIP non-root credential process test");
        return;
    }
    let (temp, config) = prepare();
    let config_path = temp.path().join("config.json");
    let mut daemon = start(&config, &config_path);
    let status = cli(&config.socket, "status", None, true);
    assert_eq!(status["result"]["data"]["initialized"], false);
    cli(
        &config.socket,
        "init",
        Some(json!({"operation_id":"init-cli-1","passphrase":PASS})),
        true,
    );
    let input = json!({"operation_id":"save-1","binding":{"kind":"provider","account_id":"demo","field":"api_key"},"expected_revision":0,"secret":KEY});
    let saved = cli(&config.socket, "put", Some(input.clone()), true);
    assert_eq!(saved["result"]["data"]["status"], "stored");
    assert_eq!(saved["result"]["data"]["runtime_enabled"], false);
    let replayed = cli(&config.socket, "put", Some(input.clone()), true);
    assert_eq!(replayed["result"]["data"], saved["result"]["data"]);
    let mut conflict = input;
    conflict["secret"] = json!("DIFFERENT_SYNTHETIC_VALUE");
    assert_eq!(
        cli(&config.socket, "put", Some(conflict), false)["error"]["data"]["error"]["code"],
        "CONFLICT"
    );
    let private = config.secret_dir.as_ref().unwrap();
    for entry in std::fs::read_dir(private).unwrap() {
        assert_redacted(&String::from_utf8_lossy(
            &std::fs::read(entry.unwrap().path()).unwrap(),
        ));
    }
    let get = rpc(
        &config.socket,
        "v2/credentials.get",
        json!({"workspace_id":"family-demo","input":{"credential_ref":saved["result"]["data"]["credential"]["credential_ref"]}}),
    );
    assert_eq!(
        get["error"]["data"]["error"]["code"],
        "CAPABILITY_UNAVAILABLE"
    );
    let forged = rpc(
        &config.socket,
        "v2/credentials.list",
        json!({"workspace_id":"family-demo","actor":"admin","input":{}}),
    );
    assert_eq!(forged["error"]["data"]["error"]["code"], "INVALID_INPUT");
    let wrong = rpc(
        &config.socket,
        "v2/credentials.list",
        json!({"workspace_id":"other-space","input":{}}),
    );
    assert_eq!(wrong["error"]["data"]["error"]["code"], "FORBIDDEN");
    stop(&mut daemon);
    let mut daemon = start(&config, &config_path);
    let status = cli(&config.socket, "status", None, true);
    assert_eq!(status["result"]["data"]["locked"], true);
    assert_eq!(
        cli(&config.socket, "list", None, false)["error"]["data"]["error"]["code"],
        "SECRET_STORE_LOCKED"
    );
    cli(
        &config.socket,
        "unlock",
        Some(json!({"passphrase":PASS})),
        true,
    );
    assert_eq!(
        cli(
            &config.socket,
            "receipt",
            Some(json!({"operation_id":"save-1"})),
            true
        )["result"]["data"],
        saved["result"]["data"]
    );
    let ref_id = saved["result"]["data"]["credential"]["credential_ref"].clone();
    cli(
        &config.socket,
        "revoke",
        Some(json!({"operation_id":"revoke-1","credential_ref":ref_id,"expected_revision":1})),
        true,
    );
    assert_eq!(
        cli(&config.socket, "list", None, true)["result"]["data"]["credentials"][0]["state"],
        "revoked"
    );
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../docs/agentos-v2/fixtures/legacy-credentials.example.json"
    ))
    .unwrap();
    let sources = json!({"settings":fixture["settings"],"mail":fixture["mail"],"calendar":fixture["calendar"]});
    let preview = cli(
        &config.socket,
        "import-preview",
        Some(sources.clone()),
        true,
    );
    assert_eq!(
        preview["result"]["data"]["bindings"]
            .as_array()
            .unwrap()
            .len(),
        4
    );
    assert_eq!(preview["result"]["data"]["skipped_empty_keys"], 1);
    let imported = cli(
        &config.socket,
        "import",
        Some(json!({"operation_id":"import-cli-1","sources":sources.clone()})),
        true,
    );
    assert_eq!(imported["result"]["data"]["status"], "staged");
    assert_eq!(imported["result"]["data"]["source_unchanged"], true);
    assert_eq!(imported["result"]["data"]["connection_verified"], false);
    assert_eq!(imported["result"]["data"]["runtime_enabled"], false);
    assert_eq!(
        cli(
            &config.socket,
            "import",
            Some(json!({"operation_id":"import-cli-1","sources":sources})),
            true
        )["result"]["data"],
        imported["result"]["data"]
    );
    for entry in std::fs::read_dir(private).unwrap() {
        assert_redacted(&String::from_utf8_lossy(
            &std::fs::read(entry.unwrap().path()).unwrap(),
        ));
    }
    cli(&config.socket, "lock", None, true);
    stop(&mut daemon);
}

#[test]
fn credential_cli_rejects_sensitive_argv_without_echo() {
    let output = Command::new(env!("CARGO_BIN_EXE_depdek"))
        .args([
            "--socket",
            "/not-connected.sock",
            "credentials",
            "put",
            "--workspace",
            "demo",
            "--input",
            KEY,
        ])
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert_redacted(&String::from_utf8_lossy(&output.stdout));
    assert_redacted(&String::from_utf8_lossy(&output.stderr));
}
