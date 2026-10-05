//! webdesk configuration: `webdesk.toml` plus a few environment overrides.

use std::net::SocketAddr;
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    /// Address the console listens on. Defaults to `0.0.0.0:8787` (LAN reachable).
    #[serde(default = "default_bind")]
    pub bind: SocketAddr,

    /// Optional TLS. When set, both `tls_cert` and `tls_key` are required.
    #[serde(default)]
    pub tls_cert: Option<PathBuf>,
    #[serde(default)]
    pub tls_key: Option<PathBuf>,

    /// Where the audit log and runtime files live. Defaults to
    /// `$XDG_DATA_HOME/depdek-webdesk` (or `~/.local/share/depdek-webdesk`).
    #[serde(default)]
    pub data_dir: Option<PathBuf>,

    /// Explicit read-only root exposed by the Webdesk file manager.
    #[serde(default)]
    pub files_root: Option<PathBuf>,

    /// Unix socket for the separately sandboxed DeepSeek Harness executor.
    #[serde(default = "default_agent_socket")]
    pub agent_socket: PathBuf,

    /// Unix socket for the narrow privileged broker that writes Provider secrets.
    #[serde(default = "default_agent_config_socket")]
    pub agent_config_socket: PathBuf,

    /// Opt-in business BFF. No Home directory or privileged RPC access.
    #[serde(default)]
    pub business_socket: Option<PathBuf>,
    #[serde(default)]
    pub business_origin: Option<String>,

    /// Serve the SPA from disk instead of the embedded copy (frontend dev).
    #[serde(default)]
    pub web_root: Option<PathBuf>,

    #[serde(default)]
    pub auth: AuthConfig,

    #[serde(default)]
    pub metrics: MetricsConfig,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct AuthConfig {
    /// Argon2 PHC hash. Generate with `depdek-webdesk hash-password`.
    /// Empty means "no account configured": the console refuses to start unless
    /// `--insecure-no-auth` is passed.
    #[serde(default)]
    pub password_hash: String,

    /// Session lifetime, in seconds. Default 12h.
    #[serde(default = "default_session_ttl")]
    pub session_ttl_secs: u64,

    /// Idle timeout, in seconds. Default 2h.
    #[serde(default = "default_idle_timeout")]
    pub idle_timeout_secs: u64,

    /// Failed logins before the source address is temporarily blocked.
    #[serde(default = "default_max_failures")]
    pub max_failures: u32,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct MetricsConfig {
    /// Sampling interval in milliseconds (default 2000).
    #[serde(default = "default_interval")]
    pub interval_ms: u64,
    /// Ring-buffer length (default 300 samples ≈ 10 min at 2s).
    #[serde(default = "default_history")]
    pub history: usize,
}

impl Default for AuthConfig {
    fn default() -> Self {
        Self {
            password_hash: String::new(),
            session_ttl_secs: default_session_ttl(),
            idle_timeout_secs: default_idle_timeout(),
            max_failures: default_max_failures(),
        }
    }
}

impl Default for MetricsConfig {
    fn default() -> Self {
        Self {
            interval_ms: default_interval(),
            history: default_history(),
        }
    }
}

fn default_bind() -> SocketAddr {
    "0.0.0.0:8787".parse().expect("valid default bind address")
}
fn default_agent_socket() -> PathBuf {
    PathBuf::from("/run/depdek-agent/agent.sock")
}
fn default_agent_config_socket() -> PathBuf {
    PathBuf::from("/run/depdek-agent-config/config.sock")
}
fn default_session_ttl() -> u64 {
    12 * 60 * 60
}
fn default_idle_timeout() -> u64 {
    2 * 60 * 60
}
fn default_max_failures() -> u32 {
    5
}
fn default_interval() -> u64 {
    2_000
}
fn default_history() -> usize {
    300
}

impl Config {
    /// Load `config_path`, falling back to built-in defaults when the file does
    /// not exist (a warning is logged by the caller).
    pub fn load(config_path: Option<&Path>) -> Result<(Self, Option<PathBuf>)> {
        let path = match config_path {
            Some(path) => Some(path.to_path_buf()),
            None => default_config_path().filter(|candidate| candidate.exists()),
        };

        let Some(path) = path else {
            let mut config = Config::from_toml("")?;
            config.apply_env();
            config.validate()?;
            return Ok((config, None));
        };

        let raw = std::fs::read_to_string(&path)
            .with_context(|| format!("读取配置失败：{}", path.display()))?;
        let mut config =
            Config::from_toml(&raw).with_context(|| format!("解析配置失败：{}", path.display()))?;
        config.apply_env();
        config.validate()?;
        Ok((config, Some(path)))
    }

    pub fn from_toml(raw: &str) -> Result<Self> {
        if raw.trim().is_empty() {
            return Ok(Self {
                bind: default_bind(),
                tls_cert: None,
                tls_key: None,
                data_dir: None,
                files_root: None,
                agent_socket: default_agent_socket(),
                agent_config_socket: default_agent_config_socket(),
                business_socket: None,
                business_origin: None,
                web_root: None,
                auth: AuthConfig::default(),
                metrics: MetricsConfig::default(),
            });
        }
        let config: Config = toml::from_str(raw)?;
        config.validate()?;
        Ok(config)
    }

    /// Environment overrides win over the file, which keeps systemd units simple:
    /// `DEPDEK_WEBDESK_BIND`, `DEPDEK_WEBDESK_PASSWORD_HASH`,
    /// `DEPDEK_WEBDESK_DATA_DIR`, and `DEPDEK_WEBDESK_FILES_ROOT`.
    fn apply_env(&mut self) {
        if let Ok(bind) = std::env::var("DEPDEK_WEBDESK_BIND") {
            if let Ok(parsed) = bind.parse() {
                self.bind = parsed;
            }
        }
        if let Ok(hash) = std::env::var("DEPDEK_WEBDESK_PASSWORD_HASH") {
            if !hash.trim().is_empty() {
                self.auth.password_hash = hash.trim().to_string();
            }
        }
        if let Ok(dir) = std::env::var("DEPDEK_WEBDESK_DATA_DIR") {
            if !dir.trim().is_empty() {
                self.data_dir = Some(PathBuf::from(dir));
            }
        }
        if let Ok(dir) = std::env::var("DEPDEK_WEBDESK_FILES_ROOT") {
            if !dir.trim().is_empty() {
                self.files_root = Some(PathBuf::from(dir));
            }
        }
        if let Ok(path) = std::env::var("DEPDEK_WEBDESK_AGENT_SOCKET") {
            if !path.trim().is_empty() {
                self.agent_socket = PathBuf::from(path);
            }
        }
        if let Ok(path) = std::env::var("DEPDEK_WEBDESK_AGENT_CONFIG_SOCKET") {
            if !path.trim().is_empty() {
                self.agent_config_socket = PathBuf::from(path);
            }
        }
    }

    pub fn validate(&self) -> Result<()> {
        if self
            .files_root
            .as_ref()
            .is_some_and(|path| !path.is_absolute())
        {
            bail!("files_root 必须是绝对路径");
        }
        if self.files_root.as_deref() == Some(Path::new("/")) {
            bail!("files_root 不能是系统根目录");
        }
        if !self.agent_socket.is_absolute() {
            bail!("agent_socket 必须是绝对路径");
        }
        if !self.agent_config_socket.is_absolute() {
            bail!("agent_config_socket 必须是绝对路径");
        }
        if self.tls_cert.is_some() != self.tls_key.is_some() {
            bail!("tls_cert 与 tls_key 必须同时配置");
        }
        if self.business_socket.is_some() != self.business_origin.is_some() {
            bail!("business_socket 与 business_origin 必须同时配置");
        }
        if let (Some(socket), Some(origin)) = (&self.business_socket, &self.business_origin) {
            if !socket.is_absolute() {
                bail!("business_socket 必须是绝对路径");
            }
            let parsed = url::Url::parse(origin).context("business_origin 非法")?;
            if !parsed.username().is_empty()
                || parsed.password().is_some()
                || parsed.query().is_some()
                || parsed.fragment().is_some()
                || parsed.origin().ascii_serialization() != *origin
            {
                bail!("business_origin 必须是精确 origin，不含路径或凭据");
            }
            let loopback = parsed
                .host_str()
                .is_some_and(|host| matches!(host, "127.0.0.1" | "[::1]" | "::1"));
            // Existing tls_* only advertises reverse-proxy termination;
            // serve() is plain HTTP. Never treat those flags as TLS proof.
            if self.tls_enabled()
                || !self.bind.ip().is_loopback()
                || !loopback
                || parsed.scheme() != "http"
            {
                bail!("业务代理当前仅支持 loopback HTTP 开发；远程 TLS 尚未验收");
            }
        }
        if self.metrics.interval_ms < 500 {
            bail!("metrics.interval_ms 不得小于 500（CPU 采样需要最小间隔）");
        }
        if self.metrics.history == 0 || self.metrics.history > 20_000 {
            bail!("metrics.history 取值范围 1..=20000");
        }
        if self.auth.session_ttl_secs == 0 {
            bail!("auth.session_ttl_secs 必须大于 0");
        }
        Ok(())
    }

    /// Directory for the audit log and any runtime state.
    pub fn resolved_data_dir(&self) -> PathBuf {
        if let Some(dir) = &self.data_dir {
            return dir.clone();
        }
        if let Ok(dir) = std::env::var("XDG_DATA_HOME") {
            if !dir.trim().is_empty() {
                return PathBuf::from(dir).join("depdek-webdesk");
            }
        }
        let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
        PathBuf::from(home).join(".local/share/depdek-webdesk")
    }

    pub fn audit_path(&self) -> PathBuf {
        self.resolved_data_dir().join("webdesk-audit.jsonl")
    }

    pub fn resolved_files_root(&self) -> Option<PathBuf> {
        self.files_root.clone()
    }

    pub fn tls_enabled(&self) -> bool {
        self.tls_cert.is_some() && self.tls_key.is_some()
    }
}

pub fn default_config_path() -> Option<PathBuf> {
    if let Ok(path) = std::env::var("DEPDEK_WEBDESK_CONFIG") {
        if !path.trim().is_empty() {
            return Some(PathBuf::from(path));
        }
    }
    Some(PathBuf::from("/etc/depdek/webdesk.toml"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_lan_reachable_and_require_a_password() {
        let config = Config::from_toml("").unwrap();
        assert_eq!(config.bind.to_string(), "0.0.0.0:8787");
        assert!(config.auth.password_hash.is_empty());
        assert_eq!(config.metrics.interval_ms, 2_000);
        assert_eq!(
            config.agent_socket,
            PathBuf::from("/run/depdek-agent/agent.sock")
        );
        assert_eq!(
            config.agent_config_socket,
            PathBuf::from("/run/depdek-agent-config/config.sock")
        );
        assert!(!config.tls_enabled());
    }

    #[test]
    fn parses_partial_config_and_rejects_bad_values() {
        let config = Config::from_toml(
            r#"
            bind = "127.0.0.1:9000"
            [auth]
            password_hash = "$argon2id$v=19$m=19456,t=2,p=1$abc$def"
            "#,
        )
        .unwrap();
        assert_eq!(config.bind.to_string(), "127.0.0.1:9000");
        assert_eq!(config.metrics.history, 300, "未声明的字段取默认值");

        assert!(Config::from_toml("[metrics]\ninterval_ms = 10\n").is_err());
        assert!(Config::from_toml("[metrics]\nhistory = 0\n").is_err());
        assert!(Config::from_toml("tls_cert = \"/tmp/a.pem\"\n").is_err());
        assert!(Config::from_toml("files_root = \"shared\"\n").is_err());
        assert!(Config::from_toml("files_root = \"/\"\n").is_err());
        assert!(Config::from_toml("agent_socket = \"relative/agent.sock\"\n").is_err());
        assert!(Config::from_toml("agent_config_socket = \"relative/config.sock\"\n").is_err());
        assert!(Config::from_toml("unknown_field = 1\n").is_err());
    }

    #[test]
    fn data_dir_prefers_config_then_xdg() {
        let mut config = Config::from_toml("").unwrap();
        config.data_dir = Some(PathBuf::from("/var/lib/depdek-webdesk"));
        assert_eq!(
            config.resolved_data_dir(),
            PathBuf::from("/var/lib/depdek-webdesk")
        );
        assert!(config.audit_path().ends_with("webdesk-audit.jsonl"));
    }

    #[test]
    fn file_manager_requires_an_explicit_root() {
        let mut config = Config::from_toml("").unwrap();
        assert_eq!(config.resolved_files_root(), None);
        config.files_root = Some(PathBuf::from("/srv/depdek/shared"));
        assert_eq!(
            config.resolved_files_root(),
            Some(PathBuf::from("/srv/depdek/shared"))
        );
    }
}
