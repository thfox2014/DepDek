#![cfg(unix)]
use agent_workbench_lib::{secrets::SecretText, vault::hash_business_password};
use depdekd::service::{RpcRequest, ServeConfig, Service};
use serde_json::{json, Value};
use std::{
    io::{Read, Write},
    os::unix::fs::PermissionsExt,
    path::Path,
    process::{Child, Command, Output, Stdio},
    time::{Duration, Instant},
};

const PASSWORD: &str = "SYNTHETIC_WORKER_PROCESS_PASSWORD";
struct Running(Child);
impl Drop for Running {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
fn start(config: &Path, socket: &Path) -> Running {
    let mut child = Running(
        Command::new(env!("CARGO_BIN_EXE_depdekd"))
            .args(["serve", "--config"])
            .arg(config)
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap(),
    );
    let deadline = Instant::now() + Duration::from_secs(10);
    while !socket.exists() {
        assert!(child.0.try_wait().unwrap().is_none());
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(20));
    }
    child
}
fn stop(child: &mut Running) -> String {
    unsafe {
        libc::kill(child.0.id() as i32, libc::SIGTERM);
    }
    assert!(child.0.wait().unwrap().success());
    let mut logs = String::new();
    child
        .0
        .stderr
        .take()
        .unwrap()
        .read_to_string(&mut logs)
        .unwrap();
    logs
}
fn cli(socket: &Path, args: &[&str], input: Value) -> (Output, Value) {
    let mut child = Command::new(env!("CARGO_BIN_EXE_depdek"))
        .arg("--socket")
        .arg(socket)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(input.to_string().as_bytes())
        .unwrap();
    let output = child.wait_with_output().unwrap();
    let reply = serde_json::from_slice(&output.stdout).unwrap_or(Value::Null);
    assert!(!String::from_utf8_lossy(&output.stderr).contains(PASSWORD));
    (output, reply)
}
fn worker(socket: &Path, input: Value) -> (Output, Value) {
    let mut child = Command::new(env!("CARGO_BIN_EXE_depdek-worker"))
        .arg("--socket")
        .arg(socket)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    writeln!(child.stdin.take().unwrap(), "{input}").unwrap();
    let output = child.wait_with_output().unwrap();
    let reply = serde_json::from_slice(&output.stdout).unwrap_or(Value::Null);
    (output, reply)
}
#[test]
fn real_daemon_cli_worker_unicode_scope_revoke_restart_and_redaction() {
    if unsafe { libc::geteuid() } == 0 {
        eprintln!("SKIP non-root Worker process test");
        return;
    }
    let temp = tempfile::Builder::new()
        .prefix("dd-worker-")
        .tempdir_in("/tmp")
        .unwrap();
    std::fs::set_permissions(temp.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
    let root = temp.path().join("home");
    for path in ["documents/alice", "documents/bob"] {
        std::fs::create_dir_all(root.join(path)).unwrap();
    }
    let evidence = "维修资料\nforms@support.example.invalid";
    std::fs::write(root.join("documents/alice/a.md"), evidence).unwrap();
    std::fs::write(root.join("documents/bob/b.md"), "never-expose-bob").unwrap();
    let socket = temp.path().join("runtime/core.sock");
    let config = temp.path().join("control.json");
    let hash = hash_business_password(SecretText::new(PASSWORD.into())).unwrap();
    std::fs::write(&config,json!({"workspace_id":"w1","root":root,"read_paths":["documents"],"socket":socket,"access_users":[{"principal_id":"alice","password_hash":hash,"read_paths":["documents/alice"]}]}).to_string()).unwrap();
    std::fs::set_permissions(&config, std::fs::Permissions::from_mode(0o600)).unwrap();
    let mut daemon = start(&config, &socket);
    let (output, login) = cli(
        &socket,
        &["auth", "login", "--stdin"],
        json!({"username":"alice","password":PASSWORD}),
    );
    assert!(output.status.success());
    let session = login["result"]["data"].clone();
    let issue = json!({"session_token":session["session_token"],"csrf_token":session["csrf_token"],"scope":{"paths":["documents/alice"],"commands":["file.read"],"max_calls":8}});
    let (output, lease) = cli(
        &socket,
        &["worker", "issue", "--workspace", "w1", "--stdin"],
        issue.clone(),
    );
    assert!(output.status.success());
    let lease = lease["result"]["data"].clone();
    let input = json!({"lease_token":lease["lease_token"],"workspace_id":"w1","run_id":lease["run_id"],"call_id":"first","command":"file.read","command_version":"1.0","input":{"path":"documents/alice/a.md"}});
    let (output, reply) = worker(&socket, input.clone());
    assert!(output.status.success());
    assert_eq!(reply["result"]["data"]["result"]["content"], evidence);
    for secret in [
        session["session_token"].as_str().unwrap(),
        session["csrf_token"].as_str().unwrap(),
        lease["lease_token"].as_str().unwrap(),
        PASSWORD,
    ] {
        assert!(!String::from_utf8_lossy(&output.stdout).contains(secret));
        assert!(!String::from_utf8_lossy(&output.stderr).contains(secret));
    }
    let mut denied = input.clone();
    denied["call_id"] = json!("other-user");
    denied["input"]["path"] = json!("documents/bob/b.md");
    let (_, reply) = worker(&socket, denied);
    assert_eq!(reply["error"]["data"]["error"]["code"], "NOT_FOUND");
    assert!(!reply.to_string().contains("never-expose-bob"));
    let mut forged = input.clone();
    forged["method"] = json!("v2/credentials.list");
    let (output, _) = worker(&socket, forged);
    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    assert!(
        !String::from_utf8_lossy(&output.stderr).contains(lease["lease_token"].as_str().unwrap())
    );
    let (output, reply) = cli(
        &socket,
        &["worker", "revoke", "--workspace", "w1", "--stdin"],
        json!({"session_token":session["session_token"],"csrf_token":session["csrf_token"],"run_id":lease["run_id"]}),
    );
    assert!(output.status.success());
    assert_eq!(reply["result"]["data"]["revoked"], true);
    assert_eq!(
        worker(&socket, input.clone()).1["error"]["data"]["error"]["code"],
        "SESSION_EXPIRED"
    );
    let (_, second) = cli(
        &socket,
        &["worker", "issue", "--workspace", "w1", "--stdin"],
        issue,
    );
    let second = second["result"]["data"].clone();
    let mut old = input;
    old["lease_token"] = second["lease_token"].clone();
    old["run_id"] = second["run_id"].clone();
    let logs = stop(&mut daemon);
    assert!(!socket.exists());
    let mut restarted = start(&config, &socket);
    assert_eq!(
        worker(&socket, old).1["error"]["data"]["error"]["code"],
        "SESSION_EXPIRED"
    );
    let restart_logs = stop(&mut restarted);
    let audit = std::fs::read_to_string(root.join(".vault-audit.jsonl")).unwrap();
    for secret in [
        PASSWORD,
        hash.as_str(),
        session["session_token"].as_str().unwrap(),
        session["csrf_token"].as_str().unwrap(),
        lease["lease_token"].as_str().unwrap(),
        second["lease_token"].as_str().unwrap(),
        evidence,
    ] {
        assert!(!logs.contains(secret));
        assert!(!restart_logs.contains(secret));
        assert!(!audit.contains(secret));
    }
    let (output, _) = cli(
        &socket,
        &[
            "worker",
            "invoke",
            "--workspace",
            "w1",
            "--input",
            "SYNTHETIC_SECRET_ARGV",
        ],
        json!(null),
    );
    assert!(!output.status.success());
    assert!(!String::from_utf8_lossy(&output.stderr).contains("SYNTHETIC_SECRET_ARGV"));
}

fn request(method: &str, params: Value) -> RpcRequest {
    serde_json::from_value(json!({"jsonrpc":"2.0","id":1,"method":method,"params":params})).unwrap()
}
#[test]
fn provider_reference_reports_locked_stored_rotated_revoked_without_exposing_key() {
    if unsafe { libc::geteuid() } == 0 {
        return;
    }
    const KEY: &str = "SYNTHETIC_PROFILE_KEY_NOT_REAL";
    const PASS: &str = "synthetic-profile-store-passphrase";
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("home");
    let private = temp.path().join("private");
    std::fs::create_dir_all(root.join("documents")).unwrap();
    std::fs::create_dir(&private).unwrap();
    std::fs::set_permissions(&private, std::fs::Permissions::from_mode(0o700)).unwrap();
    let mut config = ServeConfig {
        local_model_profiles: vec![],
        worker_transport: None,
        workspace_id: "w1".into(),
        root: root.clone(),
        read_paths: vec!["documents".into()],
        socket: temp.path().join("runtime/core.sock"),
        secret_dir: Some(private.clone()),
        access_users: vec![],
        provider_profiles: vec![],
    };
    let service = Service::open(&config).unwrap();
    let uid = service.owner_uid();
    let credentials = |method: &str, input: Value| {
        service.dispatch(
            uid,
            request(method, json!({"workspace_id":"w1","input":input})),
        )
    };
    assert!(credentials(
        "v2/credentials.init",
        json!({"operation_id":"init-profile","passphrase":PASS})
    )
    .get("error")
    .is_none());
    let binding = json!({"kind":"provider","account_id":"test","field":"api_key"});
    let stored = credentials(
        "v2/credentials.put",
        json!({"operation_id":"store-profile","binding":binding,"expected_revision":0,"secret":KEY}),
    );
    let reference = stored["result"]["data"]["credential"]["credential_ref"].clone();
    assert!(reference.as_str().is_some());
    drop(service);
    config.provider_profiles.push(serde_json::from_value(json!({"id":"test","name":"Test","base_url":"https://example.invalid/v1","protocol":"openai-completions","model":"model-test","profile_revision":1,"credential_ref":reference,"credential_revision":1,"credential_binding":binding})).unwrap());
    let service = Service::open(&config).unwrap();
    let catalog = || {
        service.dispatch(
            uid,
            request("v2/providers.list", json!({"workspace_id":"w1"})),
        )
    };
    assert_eq!(
        catalog()["result"]["data"]["profiles"][0]["credential_state"],
        "locked"
    );
    let credential = |method: &str, input: Value| {
        service.dispatch(
            uid,
            request(method, json!({"workspace_id":"w1","input":input})),
        )
    };
    assert!(
        credential("v2/credentials.unlock", json!({"passphrase":PASS}))
            .get("error")
            .is_none()
    );
    let result = catalog();
    assert_eq!(
        result["result"]["data"]["profiles"][0]["credential_state"],
        "stored"
    );
    assert_eq!(
        result["result"]["data"]["profiles"][0]["model_execution_enabled"],
        false
    );
    assert!(!result.to_string().contains(KEY));
    assert!(!result.to_string().contains(PASS));
    assert!(credential("v2/credentials.put",json!({"operation_id":"rotate-profile","binding":binding,"expected_revision":1,"secret":"SYNTHETIC_ROTATED_PROFILE_KEY"})).get("error").is_none());
    assert_eq!(
        catalog()["result"]["data"]["profiles"][0]["credential_state"],
        "revision_mismatch"
    );
    assert!(credential(
        "v2/credentials.revoke",
        json!({"operation_id":"revoke-profile","credential_ref":reference,"expected_revision":2})
    )
    .get("error")
    .is_none());
    assert_eq!(
        catalog()["result"]["data"]["profiles"][0]["credential_state"],
        "revoked"
    );
    let denied = service.dispatch(
        uid + 1,
        request("v2/providers.list", json!({"workspace_id":"w1"})),
    );
    assert_eq!(denied["error"]["data"]["error"]["code"], "FORBIDDEN");
    for path in [
        root.join(".vault-audit.jsonl"),
        private.join(".secret-audit.jsonl"),
    ] {
        let text = std::fs::read_to_string(path).unwrap();
        assert!(!text.contains(KEY));
        assert!(!text.contains(PASS));
        assert!(!text.contains("SYNTHETIC_ROTATED_PROFILE_KEY"));
    }
}

#[test]
fn real_model_cli_and_worker_use_only_selected_context_and_consumed_grant() {
    if unsafe { libc::geteuid() } == 0 {
        return;
    }
    use std::net::TcpListener;
    const KEY: &str = "synthetic-process-model-key";
    const PASS: &str = "SyntheticProcessSecretStore2026!";
    let temp = tempfile::Builder::new()
        .prefix("dd-gateway-")
        .tempdir_in("/tmp")
        .unwrap();
    std::fs::set_permissions(temp.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
    let root = temp.path().join("home");
    let private = temp.path().join("private");
    std::fs::create_dir_all(root.join("documents/alice")).unwrap();
    std::fs::create_dir(&private).unwrap();
    std::fs::set_permissions(&private, std::fs::Permissions::from_mode(0o700)).unwrap();
    let socket = temp.path().join("runtime/core.sock");
    let path = temp.path().join("config.json");
    let hash = hash_business_password(SecretText::new(PASSWORD.into())).unwrap();
    let mut config = json!({"workspace_id":"w1","root":root,"read_paths":["documents"],"socket":socket,"secret_dir":private,"access_users":[{"principal_id":"alice","password_hash":hash,"read_paths":["documents/alice"]}]});
    let setup = Service::open(&serde_json::from_value(config.clone()).unwrap()).unwrap();
    let uid = setup.owner_uid();
    let init = setup.dispatch(
        uid,
        request(
            "v2/credentials.init",
            json!({"workspace_id":"w1","input":{"operation_id":"init","passphrase":PASS}}),
        ),
    );
    assert!(init.get("result").is_some());
    let binding = json!({"kind":"provider","account_id":"local-test","field":"api_key"});
    let receipt=setup.dispatch(uid,request("v2/credentials.put",json!({"workspace_id":"w1","input":{"operation_id":"put","binding":binding,"expected_revision":0,"secret":KEY}})));
    let reference = receipt["result"]["data"]["credential"]["credential_ref"].clone();
    drop(setup);
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    config["provider_profiles"] = json!([{"id":"local-test","name":"Synthetic","base_url":format!("http://{}/v1",listener.local_addr().unwrap()),"protocol":"openai-completions","model":"synthetic-model","profile_revision":1,"credential_ref":reference,"credential_revision":1,"credential_binding":binding}]);
    config["local_model_profiles"] = json!(["local-test"]);
    std::fs::write(&path, config.to_string()).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
    let server = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(10)))
            .unwrap();
        let mut header = vec![];
        let mut b = [0; 1];
        while !header.ends_with(b"\r\n\r\n") {
            stream.read_exact(&mut b).unwrap();
            header.push(b[0]);
            assert!(header.len() < 8192);
        }
        let header = String::from_utf8(header).unwrap();
        assert!(header.contains(&format!("Bearer {KEY}")));
        let n: usize = header
            .lines()
            .find_map(|line| {
                line.to_lowercase()
                    .strip_prefix("content-length: ")
                    .map(str::to_owned)
            })
            .unwrap()
            .parse()
            .unwrap();
        let mut body = vec![0; n];
        stream.read_exact(&mut body).unwrap();
        let body: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(
            body["messages"],
            json!([{"role":"user","content":"选定合成材料"}])
        );
        let body =
            json!({"choices":[{"message":{"content":"已核对 forms@support.example.invalid"}}]})
                .to_string();
        write!(
            stream,
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        )
        .unwrap();
    });
    let mut daemon = start(&path, &socket);
    let (output, _) = cli(
        &socket,
        &["credentials", "unlock", "--workspace", "w1", "--stdin"],
        json!({"passphrase":PASS}),
    );
    assert!(output.status.success());
    let (_, session) = cli(
        &socket,
        &["auth", "login", "--stdin"],
        json!({"username":"alice","password":PASSWORD}),
    );
    let session = session["result"]["data"].clone();
    let (output, lease) = cli(
        &socket,
        &["model", "issue", "--workspace", "w1", "--stdin"],
        json!({"session_token":session["session_token"],"csrf_token":session["csrf_token"],"provider_id":"local-test","profile_revision":1,"prompt":"选定合成材料","max_tokens":128,"ttl_seconds":60}),
    );
    assert!(output.status.success());
    let lease = lease["result"]["data"].clone();
    let input = json!({"lease_token":lease["lease_token"],"workspace_id":"w1","run_id":lease["run_id"],"call_id":"model-one"});
    let mut child = Command::new(env!("CARGO_BIN_EXE_depdek-worker"))
        .arg("--socket")
        .arg(&socket)
        .arg("--model")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    writeln!(child.stdin.take().unwrap(), "{input}").unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(output.status.success());
    let reply: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(
        reply["result"]["data"]["result"]["text"],
        "已核对 forms@support.example.invalid"
    );
    assert!(reply["result"]["data"]["result"]["usage"].is_null());
    server.join().unwrap();
    let mut replay = input.clone();
    replay.as_object_mut().unwrap().remove("workspace_id");
    let (_, reply) = cli(
        &socket,
        &["model", "invoke", "--workspace", "w1", "--stdin"],
        replay,
    );
    assert_eq!(reply["error"]["data"]["error"]["code"], "CONFLICT");
    let logs = stop(&mut daemon);
    for content in [
        logs,
        String::from_utf8(output.stdout).unwrap(),
        std::fs::read_to_string(root.join(".vault-audit.jsonl")).unwrap(),
        std::fs::read_to_string(private.join(".secret-audit.jsonl")).unwrap(),
    ] {
        for secret in [
            KEY,
            PASS,
            PASSWORD,
            lease["lease_token"].as_str().unwrap(),
            session["session_token"].as_str().unwrap(),
            session["csrf_token"].as_str().unwrap(),
        ] {
            assert!(!content.contains(secret));
        }
    }
}
