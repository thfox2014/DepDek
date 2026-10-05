#![cfg(unix)]

use serde_json::{json, Value};
use std::{
    fs,
    io::{BufRead, BufReader, Write},
    os::unix::{fs::PermissionsExt, net::UnixStream},
    path::Path,
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};

struct Service(Child);
impl Drop for Service {
    fn drop(&mut self) {
        unsafe {
            libc::kill(self.0.id() as i32, libc::SIGTERM);
        }
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline {
            if self.0.try_wait().ok().flatten().is_some() {
                return;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
fn ready(path: &Path) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        if UnixStream::connect(path).is_ok() {
            return;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    panic!("fixture service did not start");
}
fn rpc(path: &Path, request: Value) -> Value {
    let mut stream = UnixStream::connect(path).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(10)))
        .unwrap();
    writeln!(stream, "{request}").unwrap();
    let mut line = String::new();
    BufReader::new(stream).read_line(&mut line).unwrap();
    assert!(!line.contains("SYNTHETIC_PROVIDER_KEY"));
    serde_json::from_str(&line).unwrap()
}
fn save(id: &str, model: &str, key: &str) -> Value {
    json!({"op":"save","provider":{"id":id,"name":id,"base_url":"https://example.invalid/v1","model":model,"protocol":"openai-completions","api_key":key}})
}

#[test]
fn admin_broker_saves_lists_activates_and_executor_reloads_without_cloud_calls() {
    if unsafe { libc::geteuid() } == 0 {
        eprintln!("SKIP explicit non-root local mode");
        return;
    }
    let temp = tempfile::Builder::new()
        .prefix("depdek-provider-test-")
        .tempdir_in("/tmp")
        .unwrap();
    fs::set_permissions(temp.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let env_dir = temp.path().join("config");
    fs::create_dir(&env_dir).unwrap();
    fs::set_permissions(&env_dir, fs::Permissions::from_mode(0o700)).unwrap();
    let env_file = env_dir.join("agent.env");
    let agent_socket = temp.path().join("agent.sock");
    let config_socket = temp.path().join("config.sock");
    let agent = Service(
        Command::new(env!("CARGO_BIN_EXE_depdek-agent"))
            .env_remove("DEEPSEEK_API_KEY")
            .env_remove("DEPDEK_AGENT_PROVIDERS_B64")
            .env("DEPDEK_AGENT_LOCAL_ENV_PATH", &env_file)
            .env("DEPDEK_AGENT_SOCKET", &agent_socket)
            .env("DEPDEK_DSH_COMMAND", "/usr/bin/true")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap(),
    );
    ready(&agent_socket);
    let broker = Service(
        Command::new(env!("CARGO_BIN_EXE_depdek-agent-config"))
            .env("DEPDEK_AGENT_CONFIG_MODE", "local-private")
            .env("DEPDEK_AGENT_ENV_PATH", &env_file)
            .env("DEPDEK_AGENT_CONFIG_SOCKET", &config_socket)
            .env("DEPDEK_AGENT_CONFIG_APPLY_SOCKET", &agent_socket)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap(),
    );
    ready(&config_socket);
    assert_eq!(
        rpc(&config_socket, json!({"op":"list"}))["providers"],
        json!([])
    );
    for (id, model) in [("first", "model-one"), ("second", "model-two")] {
        let reply = rpc(
            &config_socket,
            save(id, model, "SYNTHETIC_PROVIDER_KEY_NOT_REAL"),
        );
        assert_eq!(reply["ok"], true);
        assert_eq!(reply["restart_ok"], true);
        assert_eq!(reply["active_id"], id);
        let status = rpc(&agent_socket, json!({"op":"status"}));
        assert_eq!(status["provider_id"], id);
        assert_eq!(status["model"], model);
    }
    let reply = rpc(&config_socket, save("first", "model-edited", ""));
    assert_eq!(reply["restart_ok"], true);
    assert_eq!(reply["providers"].as_array().unwrap().len(), 2);
    assert_eq!(
        rpc(&agent_socket, json!({"op":"status"}))["model"],
        "model-edited"
    );
    assert_eq!(
        rpc(&config_socket, json!({"op":"activate","id":"second"}))["restart_ok"],
        true
    );
    assert_eq!(
        rpc(&agent_socket, json!({"op":"status"}))["model"],
        "model-two"
    );
    assert_eq!(
        rpc(&config_socket, json!({"op":"activate","id":"unknown"}))["ok"],
        false
    );
    std::thread::scope(|scope| {
        for id in ["third", "fourth"] {
            let socket = &config_socket;
            scope.spawn(move || {
                assert_eq!(
                    rpc(
                        socket,
                        save(id, "model-extra", "SYNTHETIC_PROVIDER_KEY_NOT_REAL")
                    )["ok"],
                    true
                )
            });
        }
    });
    assert_eq!(
        rpc(&config_socket, json!({"op":"list"}))["providers"]
            .as_array()
            .unwrap()
            .len(),
        4
    );
    assert_eq!(
        fs::metadata(&env_file).unwrap().permissions().mode() & 0o777,
        0o600
    );
    for audit in [
        ".agent-env-write-audit.jsonl",
        ".agent-env-read-audit.jsonl",
    ] {
        let text = fs::read_to_string(env_dir.join(audit)).unwrap();
        assert!(!text.contains("SYNTHETIC_PROVIDER_KEY"));
    }
    drop(broker);
    drop(agent);
    assert!(!config_socket.exists());
    assert!(!agent_socket.exists());
}
