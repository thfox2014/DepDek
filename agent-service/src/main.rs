//! Isolated DeepSeek Harness runner exposed only through a local Unix socket.
//! No DepDek Home, Vault, arbitrary filesystem, shell, web, or sub-agent tools
//! are granted to the Harness profile.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use anyhow::{bail, Context, Result};
use depdek_agent::provider::{
    decode_profiles, ApiProtocol, ProviderDescriptor, ProviderProfile, ACTIVE_PROVIDER_ENV,
    PROVIDERS_ENV, SELECTED_KEY_ENV,
};
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{UnixListener, UnixStream};
use tokio::process::Command;

const MAX_REQUEST_BYTES: usize = 32 * 1024;
const MAX_RESPONSE_BYTES: usize = 128 * 1024;
const MAX_MESSAGE_CHARS: usize = 8_000;
const MAX_HISTORY_MESSAGES: usize = 8;
const MAX_HISTORY_CHARS: usize = 14_000;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(120);
static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);
static RUN_LIMIT: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);
static LOCAL_CONFIGURATION: std::sync::OnceLock<agent_workbench_lib::vault::LocalAgentEnvFile> =
    std::sync::OnceLock::new();

#[derive(Debug, Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "snake_case")]
enum AgentId {
    #[default]
    Wukong,
    Bajie,
    Master,
    #[serde(rename = "shaseng")]
    ShaSeng,
}

#[derive(Debug, Deserialize)]
struct Request {
    op: String,
    #[serde(default)]
    agent: AgentId,
    #[serde(default)]
    message: String,
    #[serde(default)]
    history: Vec<Message>,
}

#[derive(Debug, Deserialize)]
struct Message {
    role: String,
    content: String,
}

#[derive(Debug, Serialize)]
struct Reply {
    ok: bool,
    available: bool,
    configured: bool,
    engine: &'static str,
    model: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    provider_id: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    providers: Vec<ProviderDescriptor>,
    #[serde(skip_serializing_if = "Option::is_none")]
    text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[tokio::main]
async fn main() -> Result<()> {
    if let Some(path) = depdek_agent::local_config::local_path() {
        let file = agent_workbench_lib::vault::LocalAgentEnvFile::open(&path, false)?;
        depdek_agent::local_config::parse_snapshot(&file.read()?).map_err(anyhow::Error::msg)?;
        LOCAL_CONFIGURATION
            .set(file)
            .map_err(|_| anyhow::anyhow!("local config already initialized"))?;
    }
    let socket = std::env::var_os("DEPDEK_AGENT_SOCKET")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/run/depdek-agent/agent.sock"));
    let local = LOCAL_CONFIGURATION.get().is_some();
    if local {
        agent_workbench_lib::vault::validate_private_service_directory(
            socket
                .parent()
                .context("private socket directory required")?,
        )?;
        if std::fs::symlink_metadata(&socket).is_ok() {
            bail!("local agent socket already exists; explicit recovery required");
        }
    }
    prepare_socket(&socket)?;
    let listener = UnixListener::bind(&socket)
        .with_context(|| format!("无法监听 Agent socket：{}", socket.display()))?;
    let _local_socket = if local {
        Some(agent_workbench_lib::vault::PrivateServiceSocketGuard::attach(&socket)?)
    } else {
        None
    };
    eprintln!("[depdek-agent] listening on {}", socket.display());

    let shutdown = async {
        let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("SIGTERM handler");
        tokio::select! { _ = tokio::signal::ctrl_c() => {}, _ = term.recv() => {} }
    };
    tokio::pin!(shutdown);
    loop {
        tokio::select! {
            _ = &mut shutdown => break,
            accepted = listener.accept() => {
                let (stream, _) = accepted.context("Agent socket accept 失败")?;
                tokio::spawn(async move {
                    if let Err(error) = handle_connection(stream).await {
                        eprintln!("[depdek-agent] request failed: {error:#}");
                    }
                });
            }
        }
    }
    drop(listener);
    if !local {
        let _ = std::fs::remove_file(socket);
    }
    Ok(())
}

fn prepare_socket(socket: &Path) -> Result<()> {
    use std::os::unix::fs::FileTypeExt;
    let parent = socket.parent().context("Agent socket 必须包含目录")?;
    std::fs::create_dir_all(parent)
        .with_context(|| format!("无法创建 socket 目录：{}", parent.display()))?;
    if let Ok(metadata) = std::fs::symlink_metadata(socket) {
        if metadata.file_type().is_socket() {
            match std::os::unix::net::UnixStream::connect(socket) {
                Ok(_) => bail!("Agent 服务已在运行：{}", socket.display()),
                Err(error)
                    if matches!(
                        error.kind(),
                        std::io::ErrorKind::ConnectionRefused | std::io::ErrorKind::NotFound
                    ) => {}
                Err(error) => {
                    bail!("无法确认旧 socket 是否仍在使用：{error}")
                }
            }
            std::fs::remove_file(socket).context("无法清理遗留 Agent socket")?;
        } else {
            bail!("拒绝覆盖非 socket 文件：{}", socket.display());
        }
    }
    Ok(())
}

async fn handle_connection(mut stream: UnixStream) -> Result<()> {
    if LOCAL_CONFIGURATION.get().is_some()
        && stream.peer_cred()?.uid() != unsafe { libc::geteuid() }
    {
        return Ok(());
    }
    let mut line = Vec::with_capacity(2048);
    let mut chunk = [0u8; 2048];
    loop {
        let count = tokio::time::timeout(Duration::from_secs(10), stream.read(&mut chunk))
            .await
            .context("读取 Agent 请求超时")??;
        if count == 0 {
            return Ok(());
        }
        let newline = chunk[..count].iter().position(|byte| *byte == b'\n');
        let end = newline.unwrap_or(count);
        if line.len() + end > MAX_REQUEST_BYTES {
            return write_reply(&mut stream, error_reply("请求超过 32 KB 安全上限")).await;
        }
        line.extend_from_slice(&chunk[..end]);
        if newline.is_some() {
            break;
        }
    }
    let request: Request = match serde_json::from_slice(&line) {
        Ok(value) => value,
        Err(_) => return write_reply(&mut stream, error_reply("请求格式无效")).await,
    };
    let reply = dispatch(request).await;
    write_reply(&mut stream, reply).await
}

async fn write_reply(stream: &mut UnixStream, reply: Reply) -> Result<()> {
    let mut payload = serde_json::to_vec(&reply)?;
    if payload.len() > MAX_RESPONSE_BYTES {
        payload = serde_json::to_vec(&error_reply("Agent 响应超过安全上限"))?;
    }
    stream.write_all(&payload).await?;
    stream.write_all(b"\n").await?;
    stream.shutdown().await?;
    Ok(())
}

async fn dispatch(request: Request) -> Reply {
    let (profiles, active_id) =
        if let Some(file) = LOCAL_CONFIGURATION.get() {
            match file.read().map_err(|_| ()).and_then(|bytes| {
                depdek_agent::local_config::parse_snapshot(&bytes).map_err(|_| ())
            }) {
                Ok(snapshot) => snapshot,
                Err(_) => return error_reply("本机 Provider 私有配置不可用；请检查配置服务与权限"),
            }
        } else {
            let profiles = provider_profiles();
            let active = active_provider_id(&profiles);
            (profiles, active)
        };
    let active = profiles.iter().find(|profile| profile.id == active_id);
    let model = active
        .map(|profile| profile.model.clone())
        .unwrap_or_else(model_name);
    let executable = resolve_dsh();
    let has_api_key = active.is_some_and(|profile| !profile.api_key.trim().is_empty());
    let configured = has_api_key && executable.is_some();
    if request.op == "status" {
        return Reply {
            ok: true,
            available: true,
            configured,
            engine: "deepseek-harness",
            model,
            provider_id: active_id.clone(),
            providers: profiles
                .iter()
                .map(|profile| profile.descriptor(&active_id))
                .collect(),
            text: None,
            error: None,
        };
    }
    if request.op != "chat" {
        return error_reply("不支持的 Agent 操作");
    }
    if !has_api_key {
        return error_reply(
            "尚未配置当前模型 Provider 的 API Key；请在 Agent Team 的 Provider 设置中保存凭据",
        );
    }
    let Some(executable) = executable else {
        return error_reply(
            "未找到 dsh。请安装 @deepseek-ai/dsh，或设置 DEPDEK_DSH_COMMAND 为可执行文件绝对路径",
        );
    };
    let message = request.message.trim();
    if message.is_empty() || message.chars().count() > MAX_MESSAGE_CHARS {
        return error_reply("请输入内容（最多 8000 个字符）");
    }
    if request.history.len() > MAX_HISTORY_MESSAGES
        || request.history.iter().any(|item| {
            !matches!(item.role.as_str(), "user" | "assistant")
                || item.content.chars().count() > MAX_HISTORY_CHARS
        })
        || request
            .history
            .iter()
            .map(|item| item.content.chars().count())
            .sum::<usize>()
            > MAX_HISTORY_CHARS
    {
        return error_reply("对话上下文格式无效或过长");
    }

    let permit = match RUN_LIMIT.try_acquire() {
        Ok(permit) => permit,
        Err(_) => return error_reply("Agent 当前有较多任务，请稍后重试"),
    };
    let result = run_harness(
        &executable,
        active.expect("configured provider has a profile"),
        request.agent,
        message,
        &request.history,
    )
    .await;
    drop(permit);
    match result {
        Ok(text) => Reply {
            ok: true,
            available: true,
            configured: true,
            engine: "deepseek-harness",
            model,
            provider_id: active_id,
            providers: Vec::new(),
            text: Some(text),
            error: None,
        },
        Err(error) => {
            eprintln!("[depdek-agent] harness run failed: {error:#}");
            error_reply(&format!("DeepSeek Harness 执行失败：{error}"))
        }
    }
}

fn error_reply(message: &str) -> Reply {
    Reply {
        ok: false,
        available: false,
        configured: false,
        engine: "deepseek-harness",
        model: model_name(),
        provider_id: String::new(),
        providers: Vec::new(),
        text: None,
        error: Some(message.chars().take(400).collect()),
    }
}

fn provider_profiles() -> Vec<ProviderProfile> {
    if let Ok(encoded) = std::env::var(PROVIDERS_ENV) {
        if let Ok(profiles) = decode_profiles(&encoded) {
            return profiles;
        }
        eprintln!("[depdek-agent] Provider 配置格式无效");
        return Vec::new();
    }
    let key = std::env::var("DEEPSEEK_API_KEY").unwrap_or_default();
    if key.trim().is_empty() {
        return Vec::new();
    }
    vec![ProviderProfile {
        id: "deepseek-official".into(),
        name: "DeepSeek Official".into(),
        base_url: "https://api.deepseek.com".into(),
        protocol: ApiProtocol::OpenaiCompletions,
        model: model_name(),
        api_key: key,
    }]
}

fn active_provider_id(profiles: &[ProviderProfile]) -> String {
    let configured = std::env::var(ACTIVE_PROVIDER_ENV).unwrap_or_default();
    if profiles.iter().any(|profile| profile.id == configured) {
        configured
    } else {
        profiles
            .first()
            .map(|profile| profile.id.clone())
            .unwrap_or_default()
    }
}

fn model_name() -> String {
    let requested =
        std::env::var("DEPDEK_AGENT_MODEL").unwrap_or_else(|_| "deepseek-v4-flash".into());
    if requested
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
        && !requested.is_empty()
    {
        requested
    } else {
        "deepseek-v4-flash".into()
    }
}

fn resolve_dsh() -> Option<PathBuf> {
    let configured = std::env::var("DEPDEK_DSH_COMMAND").unwrap_or_else(|_| "dsh".into());
    if configured.contains('/') {
        return is_executable(Path::new(&configured)).then(|| PathBuf::from(configured));
    }
    std::env::var_os("PATH")?
        .to_string_lossy()
        .split(':')
        .map(|directory| PathBuf::from(directory).join(&configured))
        .find(|candidate| is_executable(candidate))
}

fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path)
        .is_ok_and(|metadata| metadata.is_file() && metadata.permissions().mode() & 0o111 != 0)
}

fn restricted_patch(provider: &ProviderProfile) -> String {
    const DISABLED: &[&str] = &[
        "subprocess",
        "sandbox",
        "sandbox-policy",
        "fs-sandbox",
        "bash-sandbox",
        "pwsh-sandbox",
        "approval",
        "permission",
        "shell-env",
        "tool-bash",
        "tool-pwsh",
        "jobs",
        "tool-jobs",
        "fs-observation-policy",
        "tool-fs",
        "tool-fs-search",
        "agent-instructions",
        "skill",
        "skill-filesystem",
        "tool-skill",
        "web",
        "web-search-deepseek",
        "tool-web",
        "code-runtime",
        "subagent",
        "subagent-spawn-in-process",
        "subagent-fork-in-process",
        "tool-subagent-control",
        "tool-subagent-list-agents",
        "tool-subagent",
        "tool-subagent-fork",
        "tool-subagent-report",
        "workflow-worker-thread",
        "tool-workflow",
        "tool-todo",
        "tool-goal",
        "tool-ralph",
        "tool-str-replace-editor",
    ];
    let mut patch = DISABLED
        .iter()
        .map(|id| format!("- id: {id}\n  disabled: true\n"))
        .collect::<String>();
    let quote = |value: &str| {
        format!(
            "\"{}\"",
            value
                .replace('\\', "\\\\")
                .replace('"', "\\\"")
                .replace('\n', "\\n")
                .replace('\r', "\\r")
        )
    };
    patch.push_str(&format!(
        "- id: llm-pi-ai\n  config:\n    providers:\n      {}:\n        apiKeyEnv: {}\n        api: {}\n        baseURL: {}\n        models:\n          - id: {}\n- id: agent-default-model\n  config:\n    provider: {}\n    model: {}\n",
        provider.id,
        SELECTED_KEY_ENV,
        provider.protocol.patch_value(),
        quote(&provider.base_url),
        quote(&provider.model),
        provider.id,
        quote(&provider.model),
    ));
    patch
}

fn agent_persona(agent: AgentId) -> (&'static str, &'static str) {
    match agent {
        AgentId::Wukong => (
            "悟空",
            "直率、机敏、有一点幽默，擅长全局分析并主动指出关键风险。",
        ),
        AgentId::Bajie => (
            "八戒",
            "亲切、务实、会照顾人的感受，擅长整理资料、比较选择并把复杂的话说清楚。",
        ),
        AgentId::Master => (
            "师傅",
            "沉稳、慈悲、重视原则，擅长澄清目标、梳理计划与审阅重要决定。",
        ),
        AgentId::ShaSeng => (
            "沙僧",
            "可靠、耐心、条理清楚，擅长记录要点、拆分步骤并跟进待办。",
        ),
    }
}

fn compose_prompt(agent: AgentId, message: &str, history: &[Message]) -> String {
    let mut context = String::new();
    let (name, style) = agent_persona(agent);
    for item in history {
        let role = if item.role == "assistant" {
            name
        } else {
            "用户"
        };
        context.push_str(&format!("{role}：{}\n", item.content.trim()));
    }
    format!(
        "你是 DepDek 取经小队的 Agent {name}。{style}用中文优先回答，像一位可信赖的伙伴，自然、有温度，不要机械复述指令。\n\
         你运行在隔离的 DeepSeek Harness 会话中，只能分析并提供建议；不能声称执行了文件、系统或外部服务操作。\n\
         {}
         用户：{}\n\
         请给出清晰、自然、有人情味的 Markdown 回复。",
        if context.is_empty() { String::new() } else { format!("近期对话：\n{context}") },
        message.trim(),
    )
}

async fn run_harness(
    command: &Path,
    provider: &ProviderProfile,
    agent: AgentId,
    message: &str,
    history: &[Message],
) -> Result<String> {
    let runtime_dir = runtime_dir()?;
    let result = run_in_runtime(command, provider, agent, message, history, &runtime_dir).await;
    let _ = std::fs::remove_dir_all(&runtime_dir);
    result
}

fn runtime_dir() -> Result<PathBuf> {
    let root = std::env::temp_dir();
    for _ in 0..8 {
        let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let path = root.join(format!("depdek-agent-{}-{sequence}", std::process::id()));
        match std::fs::create_dir(&path) {
            Ok(()) => {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700))?;
                return Ok(path);
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error.into()),
        }
    }
    bail!("无法建立隔离的 Harness 临时目录")
}

async fn run_in_runtime(
    command: &Path,
    provider: &ProviderProfile,
    agent: AgentId,
    message: &str,
    history: &[Message],
    runtime: &Path,
) -> Result<String> {
    let patch_path = runtime.join("depdek-restricted.patch.yml");
    std::fs::write(&patch_path, restricted_patch(provider))?;
    let task = compose_prompt(agent, message, history);
    let command_dir = command.parent().unwrap_or_else(|| Path::new("/usr/bin"));
    let inherited_path = std::env::var("PATH").unwrap_or_else(|_| "/usr/bin:/bin".into());
    let path = format!("{}:{inherited_path}", command_dir.display());
    let mut process = Command::new(command);
    process
        .arg("--profile")
        .arg("headless")
        .arg("--patch")
        .arg(&patch_path)
        .arg(task)
        .current_dir(runtime)
        .env_clear()
        .env("PATH", path)
        .env("HOME", runtime)
        .env("DSH_HOME", runtime)
        .env("DSH_PERMISSION_MODE", "read-only")
        .env("DSH_TELEMETRY_DISABLED", "1")
        .env(SELECTED_KEY_ENV, &provider.api_key)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    for key in [
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "NO_PROXY",
        "http_proxy",
        "https_proxy",
        "all_proxy",
        "no_proxy",
    ] {
        if let Ok(value) = std::env::var(key) {
            process.env(key, value);
        }
    }
    let mut child = process
        .spawn()
        .context("无法启动 dsh；请检查 DEPDEK_DSH_COMMAND")?;
    let stdout = child.stdout.take().context("Harness stdout 不可用")?;
    let stderr = child.stderr.take().context("Harness stderr 不可用")?;
    let stdout_task = tokio::spawn(async move {
        let mut bytes = Vec::new();
        stdout
            .take((MAX_RESPONSE_BYTES + 1) as u64)
            .read_to_end(&mut bytes)
            .await?;
        Ok::<_, std::io::Error>(bytes)
    });
    let stderr_task = tokio::spawn(async move {
        let mut bytes = Vec::new();
        stderr.take(4096).read_to_end(&mut bytes).await?;
        Ok::<_, std::io::Error>(bytes)
    });
    let status = match tokio::time::timeout(REQUEST_TIMEOUT, child.wait()).await {
        Ok(status) => status.context("等待 Harness 进程失败")?,
        Err(_) => {
            let _ = child.kill().await;
            bail!("执行超过 120 秒，已中止")
        }
    };
    let stdout = stdout_task.await.context("读取 Harness 输出失败")??;
    let _stderr = stderr_task.await.context("读取 Harness 错误输出失败")??;
    if !status.success() {
        bail!("进程退出码 {}", status.code().unwrap_or(-1));
    }
    if stdout.len() > MAX_RESPONSE_BYTES {
        bail!("回答超过 128 KB 安全上限");
    }
    let text = String::from_utf8(stdout)
        .context("Harness 返回了无效 UTF-8")?
        .trim()
        .to_string();
    if text.is_empty() {
        bail!("Harness 返回空响应");
    }
    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn patch_disables_local_and_network_capabilities() {
        let provider = ProviderProfile {
            id: "deepseek-official".into(),
            name: "DeepSeek Official".into(),
            base_url: "https://api.deepseek.com".into(),
            protocol: ApiProtocol::OpenaiCompletions,
            model: "deepseek-v4-flash".into(),
            api_key: "test-only".into(),
        };
        let patch = restricted_patch(&provider);
        assert!(patch.contains("id: tool-bash\n  disabled: true"));
        assert!(patch.contains("id: tool-fs\n  disabled: true"));
        assert!(patch.contains("id: tool-web\n  disabled: true"));
        assert!(patch.contains("provider: deepseek-official\n    model: \"deepseek-v4-flash\""));
        assert!(patch.contains("apiKeyEnv: DEPDEK_AGENT_SELECTED_API_KEY"));
    }

    #[test]
    fn prompt_keeps_identity_and_recent_context_without_claiming_side_effects() {
        let history = vec![Message {
            role: "user".into(),
            content: "你好".into(),
        }];
        let prompt = compose_prompt(AgentId::Wukong, "整理我的照片", &history);
        assert!(prompt.contains("Agent 悟空"));
        assert!(prompt.contains("近期对话"));
        assert!(prompt.contains("不能声称执行了文件"));
        assert!(prompt.contains("整理我的照片"));
    }

    #[test]
    fn each_team_member_gets_a_distinct_persona() {
        assert!(compose_prompt(AgentId::Bajie, "你好", &[]).contains("Agent 八戒"));
        assert!(compose_prompt(AgentId::Master, "你好", &[]).contains("Agent 师傅"));
        assert!(compose_prompt(AgentId::ShaSeng, "你好", &[]).contains("Agent 沙僧"));
    }

    #[test]
    fn model_name_rejects_injected_config() {
        std::env::set_var("DEPDEK_AGENT_MODEL", "flash\n- id: tool-bash");
        assert_eq!(model_name(), "deepseek-v4-flash");
        std::env::remove_var("DEPDEK_AGENT_MODEL");
    }

    #[tokio::test]
    async fn runner_invokes_headless_cli_without_needing_a_network_provider() {
        use std::os::unix::fs::PermissionsExt;

        let dir = runtime_dir().unwrap();
        let fake_dsh = dir.join("fake-dsh");
        std::fs::write(
            &fake_dsh,
            "#!/bin/sh\nfor arg in \"$@\"; do last=\"$arg\"; done\nprintf 'mocked: %s' \"$last\"\n",
        )
        .unwrap();
        std::fs::set_permissions(&fake_dsh, std::fs::Permissions::from_mode(0o700)).unwrap();

        let provider = ProviderProfile {
            id: "deepseek-official".into(),
            name: "DeepSeek Official".into(),
            base_url: "https://api.deepseek.com".into(),
            protocol: ApiProtocol::OpenaiCompletions,
            model: "deepseek-v4-flash".into(),
            api_key: "test-only".into(),
        };
        let output = run_harness(&fake_dsh, &provider, AgentId::Wukong, "你好", &[])
            .await
            .unwrap();
        assert!(output.contains("mocked:"));
        assert!(output.contains("用户：你好"));
        let _ = std::fs::remove_dir_all(dir);
    }
}
