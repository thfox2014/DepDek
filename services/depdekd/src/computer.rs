//! Fixed browser broker; authority and action checks remain in Vault.
use crate::service::{ApiError, Service};
use agent_workbench_lib::secrets::{wipe_json, SecretText};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    io::{Read, Write},
    path::PathBuf,
    process::{Command, Stdio},
    time::{Duration, Instant},
};
use zeroize::Zeroizing;
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ComputerRuntime {
    pub node: PathBuf,
    pub script: PathBuf,
    pub docker: PathBuf,
    pub image: String,
    pub docker_host: String,
    pub allowed_hosts: Vec<String>,
}
impl ComputerRuntime {
    pub fn validate(&self) -> anyhow::Result<()> {
        use std::os::unix::fs::MetadataExt;
        for p in [&self.node, &self.script, &self.docker] {
            let m = std::fs::metadata(p)?;
            if !p.is_absolute() || !m.is_file() || m.mode() & 0o022 != 0 {
                anyhow::bail!("computer code paths must be absolute and not publicly writable");
            }
        }
        if self.image.len() != 71
            || !self.image.starts_with("sha256:")
            || !self.image[7..].bytes().all(|b| b.is_ascii_hexdigit())
            || !self.docker_host.starts_with("unix:///")
            || self.allowed_hosts.is_empty()
            || self.allowed_hosts.len() > 16
            || self.allowed_hosts.iter().any(|h| {
                h.len() > 253
                    || !h.contains('.')
                    || !h
                        .bytes()
                        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b".-".contains(&b))
            })
        {
            anyhow::bail!("invalid fixed computer configuration");
        }
        Ok(())
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ComputerRequest {
    pub session_token: SecretText,
    pub csrf_token: SecretText,
    pub workspace_id: String,
    pub action: Value,
}
impl Drop for ComputerRequest {
    fn drop(&mut self) {
        wipe_json(&mut self.action)
    }
}
impl Service {
    pub(super) fn computer_request(&self, request: &str, input: Value) -> Result<Value, ApiError> {
        let c: ComputerRequest = serde_json::from_value(input).map_err(|_| ApiError::invalid())?;
        self.computer_action(
            request,
            &c.session_token,
            &c.csrf_token,
            &c.workspace_id,
            &c.action,
        )
    }
    pub(super) fn computer_action(
        &self,
        request: &str,
        token: &SecretText,
        csrf: &SecretText,
        workspace: &str,
        action: &Value,
    ) -> Result<Value, ApiError> {
        let actor = self
            .vault
            .computer_authorize(request, token, csrf, workspace, action)?;
        let runtime = self
            .room_runtime
            .as_ref()
            .and_then(|r| r.computer.as_ref())
            .ok_or_else(ApiError::unavailable)?;
        let _guard = self
            .room_control
            .lock()
            .map_err(|_| ApiError::unavailable())?;
        let result = invoke(
            runtime,
            json!({"owner":format!("{}:{}:{}",self.workspace_id,self.room_socket.display(),actor),"action":action}),
        );
        self.vault
            .computer_result(request, &actor, action, result.is_ok())?;
        self.vault.delegated_info(request, token, Some(workspace))?;
        result
    }
}
fn invoke(runtime: &ComputerRuntime, mut input: Value) -> Result<Value, ApiError> {
    let encoded = serde_json::to_vec(&input);
    wipe_json(&mut input);
    let bytes = Zeroizing::new(encoded.map_err(|_| ApiError::invalid())?);
    let mut child = Command::new(&runtime.node)
        .arg(&runtime.script)
        .arg("--docker")
        .arg(&runtime.docker)
        .arg("--image")
        .arg(&runtime.image)
        .arg("--docker-host")
        .arg(&runtime.docker_host)
        .arg("--hosts")
        .arg(runtime.allowed_hosts.join(","))
        .env_clear()
        .env("LANG", "C.UTF-8")
        .current_dir("/")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| ApiError::unavailable())?;
    let result = (|| {
        child
            .stdin
            .take()
            .ok_or_else(ApiError::unavailable)?
            .write_all(&bytes)
            .map_err(|_| ApiError::unavailable())?;
        let stdout = child.stdout.take().ok_or_else(ApiError::unavailable)?;
        let reader = std::thread::spawn(move || {
            let mut out = Zeroizing::new(Vec::new());
            stdout.take(1_100_001).read_to_end(&mut out).map(|_| out)
        });
        let deadline = Instant::now() + Duration::from_secs(32);
        while child
            .try_wait()
            .map_err(|_| ApiError::unavailable())?
            .is_none()
        {
            if Instant::now() > deadline {
                let _ = child.kill();
                let _ = child.wait();
                return Err(ApiError::unavailable());
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        let bytes = reader
            .join()
            .map_err(|_| ApiError::unavailable())?
            .map_err(|_| ApiError::unavailable())?;
        if bytes.len() > 1_100_000 {
            return Err(ApiError::unavailable());
        }
        let value: Value = serde_json::from_slice(&bytes).map_err(|_| ApiError::unavailable())?;
        if value.get("error").is_some() {
            return Err(ApiError {
                code: match value["error"].as_str() {
                    Some("PAGE_CHANGED") => "PAGE_CHANGED",
                    Some("HOST_NOT_ALLOWED") => "HOST_NOT_ALLOWED",
                    Some("INPUT_NOT_REQUESTED") => "INPUT_NOT_REQUESTED",
                    _ => "COMPUTER_UNAVAILABLE",
                },
                message: "browser action unavailable; refresh status before another action",
                retryable: false,
            });
        }
        Ok(value)
    })();
    let _ = child.kill();
    let _ = child.wait();
    result
}
