#![cfg(unix)]
use agent_workbench_lib::{secrets::SecretText, vault::hash_business_password};
use serde_json::{json, Value};
use std::{
    io::{BufRead, BufReader, Read, Write},
    os::unix::{fs::PermissionsExt, net::UnixStream},
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};
struct Running(Child);
impl Drop for Running {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
fn rpc(socket: &std::path::Path, method: &str, params: Value) -> Value {
    let mut stream = UnixStream::connect(socket).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(20)))
        .unwrap();
    let mut bytes =
        serde_json::to_vec(&json!({"jsonrpc":"2.0","id":1,"method":method,"params":params}))
            .unwrap();
    bytes.push(b'\n');
    stream.write_all(&bytes).unwrap();
    let mut response = String::new();
    BufReader::new(stream).read_line(&mut response).unwrap();
    serde_json::from_str(&response).unwrap()
}
#[test]
fn real_process_loads_private_identity_config_and_delegates_only_read_scope() {
    if unsafe { libc::geteuid() } == 0 {
        eprintln!("SKIP non-root business process test");
        return;
    }
    const PASS: &str = "SYNTHETIC_PROCESS_BUSINESS_PASSWORD";
    let temp = tempfile::Builder::new()
        .prefix("dd-business-")
        .tempdir_in("/tmp")
        .unwrap();
    let root = temp.path().join("home");
    std::fs::set_permissions(temp.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
    std::fs::create_dir_all(root.join("documents/alice")).unwrap();
    std::fs::create_dir(root.join("documents/bob")).unwrap();
    std::fs::write(root.join("documents/alice/a.md"), "alice-only-evidence").unwrap();
    std::fs::write(root.join("documents/bob/b.md"), "bob-only-evidence").unwrap();
    let config = temp.path().join("control.json");
    let socket = temp.path().join("runtime/core.sock");
    let hash = hash_business_password(SecretText::new(PASS.into())).unwrap();
    std::fs::write(&config,serde_json::to_vec(&json!({"workspace_id":"family-demo","root":root,"read_paths":["documents"],"socket":socket,"access_users":[{"principal_id":"alice","password_hash":hash,"read_paths":["documents/alice"]}]})).unwrap()).unwrap();
    std::fs::set_permissions(&config, std::fs::Permissions::from_mode(0o600)).unwrap();
    let mut daemon = Running(
        Command::new(env!("CARGO_BIN_EXE_depdekd"))
            .args(["serve", "--config"])
            .arg(&config)
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap(),
    );
    let deadline = Instant::now() + Duration::from_secs(10);
    while !socket.exists() {
        assert!(daemon.0.try_wait().unwrap().is_none());
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(20));
    }
    let login = rpc(
        &socket,
        "v2/auth.login",
        json!({"username":"alice","password":PASS}),
    );
    assert!(login.get("error").is_none());
    assert!(!login.to_string().contains(PASS));
    assert!(!login.to_string().contains(&hash));
    let token = login["result"]["data"]["session_token"].clone();
    let csrf = login["result"]["data"]["csrf_token"].clone();
    let input = json!({"session_token":token,"csrf_token":csrf,"workspace_id":"family-demo","command":"file.read","command_version":"1.0","input":{"path":"documents/alice/a.md"}});
    assert_eq!(
        rpc(&socket, "v2/delegated.invoke", input.clone())["result"]["data"]["result"]["content"],
        "alice-only-evidence"
    );
    let mut denied = input.clone();
    denied["input"]["path"] = json!("documents/bob/b.md");
    let response = rpc(&socket, "v2/delegated.invoke", denied);
    assert_eq!(response["error"]["data"]["error"]["code"], "NOT_FOUND");
    assert!(!response.to_string().contains("bob-only-evidence"));
    let mut forged = input.clone();
    forged["actor"] = json!("local:admin");
    assert_eq!(
        rpc(&socket, "v2/delegated.invoke", forged)["error"]["data"]["error"]["code"],
        "INVALID_INPUT"
    );
    rpc(
        &socket,
        "v2/auth.logout",
        json!({"session_token":token,"csrf_token":csrf}),
    );
    assert_eq!(
        rpc(&socket, "v2/delegated.invoke", input)["error"]["data"]["error"]["code"],
        "SESSION_EXPIRED"
    );
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
    for secret in [
        PASS,
        token.as_str().unwrap(),
        csrf.as_str().unwrap(),
        hash.as_str(),
    ] {
        assert!(!logs.contains(secret));
    }
}
