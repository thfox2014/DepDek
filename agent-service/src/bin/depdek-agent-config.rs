//! Narrow privileged broker for writing model Provider settings.
//! It never returns or logs API keys and can only replace managed lines in the
//! fixed agent environment file, then restart depdek-agent.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};

use depdek_agent::provider::{
    decode_profiles, encode_profiles, ApiProtocol, ProviderDescriptor, ProviderProfile,
    ACTIVE_PROVIDER_ENV, MAX_KEY_BYTES, MAX_PROVIDERS, PROVIDERS_ENV,
};
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{UnixListener, UnixStream};
use tokio::process::Command;

const MAX_REQUEST_BYTES: usize = 16 * 1024;
const MAX_RESPONSE_BYTES: usize = 16 * 1024;
static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
enum Request {
    List,
    Save { provider: SaveProvider },
    Activate { id: String },
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct SaveProvider {
    id: String,
    name: String,
    base_url: String,
    protocol: ApiProtocol,
    model: String,
    #[serde(default)]
    api_key: String,
}

#[derive(Debug, Serialize)]
struct Reply {
    ok: bool,
    providers: Vec<ProviderDescriptor>,
    active_id: String,
    restart_ok: bool,
    message: String,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let socket = std::env::var_os("DEPDEK_AGENT_CONFIG_SOCKET")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/run/depdek-agent-config/config.sock"));
    let env_path = std::env::var_os("DEPDEK_AGENT_ENV_PATH")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/etc/depdek/agent.env"));
    prepare_socket(&socket)?;
    let listener = UnixListener::bind(&socket)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&socket, std::fs::Permissions::from_mode(0o660))?;
    }
    eprintln!("[depdek-agent-config] listening on {}", socket.display());
    loop {
        let (stream, _) = listener.accept().await?;
        let env_path = env_path.clone();
        tokio::spawn(async move {
            if let Err(error) = handle(stream, &env_path).await {
                eprintln!("[depdek-agent-config] request failed: {error}");
            }
        });
    }
}

fn prepare_socket(socket: &Path) -> Result<(), Box<dyn std::error::Error>> {
    use std::os::unix::fs::FileTypeExt;
    let parent = socket
        .parent()
        .ok_or("socket must have a parent directory")?;
    std::fs::create_dir_all(parent)?;
    if let Ok(metadata) = std::fs::symlink_metadata(socket) {
        if !metadata.file_type().is_socket() {
            return Err("refusing to replace non-socket path".into());
        }
        match std::os::unix::net::UnixStream::connect(socket) {
            Ok(_) => return Err("config helper already running".into()),
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::ConnectionRefused | std::io::ErrorKind::NotFound
                ) =>
            {
                std::fs::remove_file(socket)?
            }
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}

async fn handle(mut stream: UnixStream, env_path: &Path) -> Result<(), Box<dyn std::error::Error>> {
    let mut line = Vec::with_capacity(1024);
    let mut chunk = [0u8; 2048];
    loop {
        let count =
            tokio::time::timeout(std::time::Duration::from_secs(5), stream.read(&mut chunk))
                .await??;
        if count == 0 {
            return Ok(());
        }
        let newline = chunk[..count].iter().position(|byte| *byte == b'\n');
        let end = newline.unwrap_or(count);
        if line.len() + end > MAX_REQUEST_BYTES {
            return write_reply(&mut stream, error_reply("配置请求超过安全上限")).await;
        }
        line.extend_from_slice(&chunk[..end]);
        if newline.is_some() {
            break;
        }
    }
    let request: Request = match serde_json::from_slice(&line) {
        Ok(value) => value,
        Err(_) => return write_reply(&mut stream, error_reply("配置请求格式无效")).await,
    };
    let reply = match request {
        Request::List => list_reply(env_path),
        Request::Save { provider } => save_provider(env_path, provider).await,
        Request::Activate { id } => activate_provider(env_path, &id).await,
    };
    write_reply(&mut stream, reply).await
}

fn list_reply(env_path: &Path) -> Reply {
    match read_configuration(env_path) {
        Ok((profiles, active_id)) => Reply {
            ok: true,
            providers: profiles
                .iter()
                .map(|profile| profile.descriptor(&active_id))
                .collect(),
            active_id,
            restart_ok: true,
            message: String::new(),
        },
        Err(_) => error_reply("无法读取 Provider 配置"),
    }
}

async fn save_provider(env_path: &Path, submitted: SaveProvider) -> Reply {
    let current = match read_configuration(env_path) {
        Ok(value) => value,
        Err(_) => return error_reply("无法读取 Provider 配置"),
    };
    let mut profiles = current.0;
    let previous = profiles.iter().find(|profile| profile.id == submitted.id);
    let api_key = if submitted.api_key.is_empty() {
        match previous {
            Some(profile) => profile.api_key.clone(),
            None => return error_reply("新 Provider 必须填写 API Key"),
        }
    } else {
        submitted.api_key
    };
    if api_key.len() > MAX_KEY_BYTES || api_key.chars().any(char::is_control) {
        return error_reply("API Key 无效或超过 2048 字节");
    }
    let profile = ProviderProfile {
        id: submitted.id,
        name: submitted.name.trim().to_string(),
        base_url: submitted.base_url.trim().trim_end_matches('/').to_string(),
        protocol: submitted.protocol,
        model: submitted.model,
        api_key,
    };
    if profile.validate(true).is_err() {
        return error_reply("Provider 配置无效，请检查名称、ID、地址、协议、模型和密钥");
    }
    let active_id = profile.id.clone();
    if let Some(existing) = profiles.iter_mut().find(|item| item.id == profile.id) {
        *existing = profile;
    } else {
        if profiles.len() >= MAX_PROVIDERS {
            return error_reply("Provider 数量已达到安全上限");
        }
        profiles.push(profile);
    }
    let encoded = match encode_profiles(&profiles) {
        Ok(value) => value,
        Err(_) => return error_reply("Provider 配置无法安全保存"),
    };
    if write_configuration(env_path, &encoded, &active_id, &profiles).is_err() {
        return error_reply("无法安全写入 /etc/depdek/agent.env");
    }
    let restart_ok = restart_agent().await;
    Reply {
        ok: true,
        providers: profiles
            .iter()
            .map(|profile| profile.descriptor(&active_id))
            .collect(),
        active_id,
        restart_ok,
        message: if restart_ok {
            "Provider 已安全保存并生效".into()
        } else {
            "Provider 已保存，但 Agent 服务重启未确认；请检查 depdek-agent 服务状态".into()
        },
    }
}

async fn activate_provider(env_path: &Path, id: &str) -> Reply {
    let (profiles, _) = match set_active_provider(env_path, id) {
        Ok(value) => value,
        Err(message) => return error_reply(message),
    };
    let restart_ok = restart_agent().await;
    Reply {
        ok: true,
        providers: profiles
            .iter()
            .map(|profile| profile.descriptor(id))
            .collect(),
        active_id: id.to_string(),
        restart_ok,
        message: if restart_ok {
            "已切换 Harness 当前模型 Provider".into()
        } else {
            "Provider 已切换，但 Agent 服务重启未确认；请检查 depdek-agent 服务状态".into()
        },
    }
}

fn set_active_provider(
    env_path: &Path,
    id: &str,
) -> Result<(Vec<ProviderProfile>, String), &'static str> {
    if id.is_empty()
        || id.len() > 48
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
    {
        return Err("Provider ID 格式无效");
    }
    let (profiles, _) = read_configuration(env_path).map_err(|_| "无法读取 Provider 配置")?;
    if !profiles.iter().any(|profile| profile.id == id) {
        return Err("该 Provider 尚未保存或缺少 API Key");
    }
    let encoded = encode_profiles(&profiles).map_err(|_| "Provider 配置无法安全保存")?;
    write_configuration(env_path, &encoded, id, &profiles)
        .map_err(|_| "无法安全更新 /etc/depdek/agent.env")?;
    Ok((profiles, id.to_string()))
}

async fn restart_agent() -> bool {
    Command::new("/usr/bin/systemctl")
        .args(["restart", "depdek-agent.service"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await
        .is_ok_and(|status| status.success())
}

fn read_configuration(
    path: &Path,
) -> Result<(Vec<ProviderProfile>, String), Box<dyn std::error::Error>> {
    let contents = read_env_file(path)?;
    let values = parse_env(&contents);
    let active_id = values
        .get("DEPDEK_AGENT_PROVIDER")
        .cloned()
        .unwrap_or_default();
    let profiles = if let Some(encoded) = values.get(PROVIDERS_ENV) {
        decode_profiles(encoded)?
    } else if let Some(key) = values
        .get("DEEPSEEK_API_KEY")
        .filter(|key| !key.trim().is_empty())
    {
        vec![ProviderProfile {
            id: "deepseek-official".into(),
            name: "DeepSeek Official".into(),
            base_url: "https://api.deepseek.com".into(),
            protocol: ApiProtocol::OpenaiCompletions,
            model: values
                .get("DEPDEK_AGENT_MODEL")
                .cloned()
                .unwrap_or_else(|| "deepseek-v4-flash".into()),
            api_key: key.clone(),
        }]
    } else {
        Vec::new()
    };
    let active_id = if active_id.is_empty() {
        profiles
            .first()
            .map(|profile| profile.id.clone())
            .unwrap_or_default()
    } else {
        active_id
    };
    Ok((profiles, active_id))
}

fn write_configuration(
    path: &Path,
    encoded_profiles: &str,
    active_id: &str,
    profiles: &[ProviderProfile],
) -> Result<(), Box<dyn std::error::Error>> {
    let parent = path.parent().ok_or("configuration path must have parent")?;
    let contents = read_env_file(path)?;
    let mut retained = contents
        .lines()
        .filter(|line| {
            let key = line
                .split_once('=')
                .map(|(key, _)| key.trim())
                .unwrap_or("");
            !matches!(
                key,
                "DEPDEK_AGENT_PROVIDERS_B64"
                    | ACTIVE_PROVIDER_ENV
                    | "DEPDEK_AGENT_MODEL"
                    | "DEEPSEEK_API_KEY"
            )
        })
        .map(str::to_owned)
        .collect::<Vec<_>>();
    retained.push(format!("{PROVIDERS_ENV}={encoded_profiles}"));
    retained.push(format!("{ACTIVE_PROVIDER_ENV}={active_id}"));
    if let Some(active) = profiles.iter().find(|profile| profile.id == active_id) {
        retained.push(format!("DEPDEK_AGENT_MODEL={}", active.model));
    }
    let mut body = retained.join("\n");
    body.push('\n');
    let temp = parent.join(format!(
        ".agent.env.{}.{}.tmp",
        std::process::id(),
        TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let result = (|| -> Result<(), Box<dyn std::error::Error>> {
        let mut file = options.open(&temp)?;
        use std::io::Write;
        file.write_all(body.as_bytes())?;
        file.sync_all()?;
        std::fs::rename(&temp, path)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
        }
        if let Ok(directory) = std::fs::File::open(parent) {
            let _ = directory.sync_all();
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    result
}

fn read_env_file(path: &Path) -> Result<String, std::io::Error> {
    match std::fs::read_to_string(path) {
        Ok(contents) => Ok(contents),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(error) => Err(error),
    }
}

fn parse_env(contents: &str) -> std::collections::HashMap<String, String> {
    contents
        .lines()
        .filter_map(|line| {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                return None;
            }
            let (key, value) = line.split_once('=')?;
            let key = key.trim();
            if key.is_empty()
                || !key
                    .bytes()
                    .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == b'_')
            {
                return None;
            }
            let value = value.trim();
            let unquoted = if value.len() >= 2
                && ((value.starts_with('"') && value.ends_with('"'))
                    || (value.starts_with('\'') && value.ends_with('\'')))
            {
                &value[1..value.len() - 1]
            } else {
                value
            };
            Some((
                key.to_string(),
                unquoted.replace("\\\\", "\\").replace("\\\"", "\""),
            ))
        })
        .collect()
}

fn error_reply(message: &str) -> Reply {
    Reply {
        ok: false,
        providers: Vec::new(),
        active_id: String::new(),
        restart_ok: false,
        message: message.into(),
    }
}

async fn write_reply(
    stream: &mut UnixStream,
    reply: Reply,
) -> Result<(), Box<dyn std::error::Error>> {
    let mut payload = serde_json::to_vec(&reply)?;
    if payload.len() > MAX_RESPONSE_BYTES {
        payload = serde_json::to_vec(&error_reply("配置响应超过安全上限"))?;
    }
    stream.write_all(&payload).await?;
    stream.write_all(b"\n").await?;
    stream.shutdown().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_env_preserves_other_settings_and_replaces_only_managed_keys() {
        let contents = "# keep me\nDEPDEK_DSH_COMMAND=/usr/local/bin/dsh\nDEPDEK_AGENT_MODEL=old\n";
        let values = parse_env(contents);
        assert_eq!(
            values.get("DEPDEK_DSH_COMMAND").unwrap(),
            "/usr/local/bin/dsh"
        );
        assert_eq!(values.get("DEPDEK_AGENT_MODEL").unwrap(), "old");
    }

    #[test]
    fn redacted_reply_never_contains_api_key() {
        let mut profile = ProviderProfile {
            id: "custom".into(),
            name: "Custom".into(),
            base_url: "https://api.example.com".into(),
            protocol: ApiProtocol::OpenaiCompletions,
            model: "example".into(),
            api_key: "super-secret".into(),
        };
        let reply = Reply {
            ok: true,
            providers: vec![profile.descriptor("custom")],
            active_id: "custom".into(),
            restart_ok: true,
            message: "saved".into(),
        };
        assert!(!serde_json::to_string(&reply)
            .unwrap()
            .contains(&profile.api_key));
        profile.api_key.clear();
    }

    #[test]
    fn saved_environment_is_root_only_and_preserves_unmanaged_values() {
        let root = std::env::temp_dir().join(format!(
            "depdek-agent-config-test-{}-{}",
            std::process::id(),
            TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir(&root).unwrap();
        let path = root.join("agent.env");
        std::fs::write(
            &path,
            "DEPDEK_DSH_COMMAND=/usr/local/bin/dsh\nDEEPSEEK_API_KEY=legacy-key\n# keep comment\n",
        )
        .unwrap();
        let profile = ProviderProfile {
            id: "custom".into(),
            name: "Custom".into(),
            base_url: "https://api.example.com/v1".into(),
            protocol: ApiProtocol::OpenaiCompletions,
            model: "example".into(),
            api_key: "secret-for-root-only".into(),
        };
        let encoded = encode_profiles(&[profile.clone()]).unwrap();
        write_configuration(&path, &encoded, "custom", &[profile]).unwrap();
        let contents = std::fs::read_to_string(&path).unwrap();
        assert!(contents.contains("DEPDEK_DSH_COMMAND=/usr/local/bin/dsh"));
        assert!(contents.contains("# keep comment"));
        assert!(!contents.contains("DEEPSEEK_API_KEY"));
        assert!(!contents.contains("secret-for-root-only"));
        let (profiles, active) = read_configuration(&path).unwrap();
        assert_eq!(active, "custom");
        assert_eq!(profiles[0].api_key, "secret-for-root-only");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn selecting_provider_updates_harness_binding_without_dropping_secrets() {
        let root = std::env::temp_dir().join(format!(
            "depdek-agent-activate-test-{}-{}",
            std::process::id(),
            TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir(&root).unwrap();
        let path = root.join("agent.env");
        let profiles = vec![
            ProviderProfile {
                id: "provider-one".into(),
                name: "One".into(),
                base_url: "https://one.example.com/v1".into(),
                protocol: ApiProtocol::OpenaiCompletions,
                model: "model-one".into(),
                api_key: "one-secret".into(),
            },
            ProviderProfile {
                id: "provider-two".into(),
                name: "Two".into(),
                base_url: "https://two.example.com/v1".into(),
                protocol: ApiProtocol::OpenaiCompletions,
                model: "model-two".into(),
                api_key: "two-secret".into(),
            },
        ];
        let encoded = encode_profiles(&profiles).unwrap();
        std::fs::write(&path, format!("{PROVIDERS_ENV}={encoded}\n")).unwrap();

        let (activated, active_id) = set_active_provider(&path, "provider-two").unwrap();

        assert_eq!(active_id, "provider-two");
        assert_eq!(activated[1].api_key, "two-secret");
        let values = parse_env(&std::fs::read_to_string(&path).unwrap());
        assert_eq!(values.get(ACTIVE_PROVIDER_ENV).unwrap(), "provider-two");
        assert_eq!(values.get("DEPDEK_AGENT_MODEL").unwrap(), "model-two");
        std::fs::remove_dir_all(root).unwrap();
    }
}
