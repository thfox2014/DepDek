//! `depdek-webdesk` — remote web management console for the DepDek appliance.
//!
//! Subcommands:
//!   serve [--config PATH] [--insecure-no-auth]   start the console (default)
//!   hash-password [PASSWORD]                     print an Argon2 PHC hash
//!   check-config [--config PATH]                 validate the configuration
//!   version                                      print the repository version

mod api;
mod audit;
mod auth;
mod config;
mod metrics;
mod state;
mod util;
mod web;

use std::io::Write;
use std::net::{IpAddr, Ipv4Addr, SocketAddr, UdpSocket};
use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{bail, Context, Result};
use tracing_subscriber::EnvFilter;

use crate::api::session::VERSION;
use crate::audit::AuditLog;
use crate::auth::{LoginThrottle, SessionStore};
use crate::config::Config;
use crate::metrics::Sampler;
use crate::state::AppState;

#[tokio::main]
async fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let command = args.first().map(String::as_str).unwrap_or("serve");

    match command {
        "serve" => serve(parse_flags(&args[1..])).await,
        "hash-password" => hash_password(&args[1..]),
        "check-config" => check_config(parse_flags(&args[1..])),
        "version" | "--version" | "-V" => {
            println!("{VERSION}");
            Ok(())
        }
        "help" | "--help" | "-h" => {
            print_help();
            Ok(())
        }
        other => {
            print_help();
            bail!("未知命令：{other}")
        }
    }
}

#[derive(Debug, Default)]
struct Flags {
    config: Option<PathBuf>,
    insecure_no_auth: bool,
}

fn parse_flags(args: &[String]) -> Flags {
    let mut flags = Flags::default();
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--config" | "-c" => {
                flags.config = args.get(index + 1).map(PathBuf::from);
                index += 2;
            }
            "--insecure-no-auth" => {
                flags.insecure_no_auth = true;
                index += 1;
            }
            _ => index += 1,
        }
    }
    flags
}

fn print_help() {
    println!(
        "depdek-webdesk {VERSION} — DepDek 远程 Web 管理控制台

用法:
  depdek-webdesk serve [--config PATH] [--insecure-no-auth]
  depdek-webdesk hash-password [PASSWORD]
  depdek-webdesk check-config [--config PATH]
  depdek-webdesk version

配置查找顺序: --config → $DEPDEK_WEBDESK_CONFIG → /etc/depdek/webdesk.toml → 内置默认值
环境变量覆盖: DEPDEK_WEBDESK_BIND / DEPDEK_WEBDESK_PASSWORD_HASH / DEPDEK_WEBDESK_DATA_DIR / DEPDEK_WEBDESK_FILES_ROOT"
    );
}

fn hash_password(args: &[String]) -> Result<()> {
    let password = match args.first() {
        Some(value) => value.clone(),
        None => {
            print!("请输入新密码（至少 8 位）: ");
            std::io::stdout().flush().ok();
            let mut buffer = String::new();
            std::io::stdin().read_line(&mut buffer)?;
            buffer.trim().to_string()
        }
    };
    let hash = auth::hash_password(&password)?;
    println!("\n将下面一行写入 webdesk.toml（注意单引号，避免 $ 被 shell 展开）：\n");
    println!("[auth]");
    println!("password_hash = '{hash}'");
    Ok(())
}

fn check_config(flags: Flags) -> Result<()> {
    let (config, path) = Config::load(flags.config.as_deref())?;
    println!(
        "配置文件: {}",
        path.map(|path| path.display().to_string())
            .unwrap_or_else(|| "（未找到，使用默认值）".into())
    );
    println!("监听地址: {}", config.bind);
    println!("数据目录: {}", config.resolved_data_dir().display());
    println!("审计日志: {}", config.audit_path().display());
    println!(
        "文件管理根目录: {}",
        config
            .resolved_files_root()
            .map(|path| path.display().to_string())
            .unwrap_or_else(|| "未配置".into())
    );
    println!(
        "采样间隔: {} ms（保留 {} 个采样点）",
        config.metrics.interval_ms, config.metrics.history
    );
    println!(
        "认证: {}",
        if config.auth.password_hash.trim().is_empty() {
            "未配置密码（serve 将拒绝启动）"
        } else {
            "已配置 Argon2 密码"
        }
    );
    println!(
        "TLS: {}",
        if config.tls_enabled() {
            "配置了证书（当前版本由反向代理终止 TLS，见 docs/webdesk-design.md）"
        } else {
            "未启用"
        }
    );
    Ok(())
}

async fn serve(flags: Flags) -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new("info,tower_http=warn")),
        )
        .with_target(false)
        .init();

    let (config, path) = Config::load(flags.config.as_deref())?;
    tracing::info!(
        config = %path.as_ref().map(|p| p.display().to_string()).unwrap_or_else(|| "默认值".into()),
        "webdesk 启动中"
    );

    if config.auth.password_hash.trim().is_empty() && !flags.insecure_no_auth {
        bail!(
            "未配置登录密码，拒绝启动。\n  1) depdek-webdesk hash-password\n  2) 把输出的 password_hash 写入 webdesk.toml\n  （仅限本机调试可加 --insecure-no-auth，会在 UI 与审计日志中标记）"
        );
    }
    if flags.insecure_no_auth {
        tracing::warn!("--insecure-no-auth：控制台无认证，切勿暴露到局域网");
    }
    if config.tls_enabled() {
        tracing::warn!(
            "检测到 TLS 证书配置：当前版本请由 nginx/caddy 终止 TLS 后反向代理到 {}",
            config.bind
        );
    }

    let audit = AuditLog::new(&config.audit_path());
    audit.record(
        "service.start",
        "system",
        "local",
        true,
        serde_json::json!({
            "version": VERSION,
            "bind": config.bind.to_string(),
            "insecure_no_auth": flags.insecure_no_auth,
        }),
    );

    let sampler = Sampler::new(config.metrics.interval_ms, config.metrics.history);
    let metrics = sampler.shared();
    sampler.sample_once();
    let sampler_task = sampler.spawn();

    let state = Arc::new(AppState {
        sessions: SessionStore::new(
            config.auth.session_ttl_secs,
            config.auth.idle_timeout_secs,
        ),
        throttle: LoginThrottle::new(config.auth.max_failures),
        audit,
        metrics,
        version: VERSION.to_string(),
        started_ms: util::now_ms(),
        insecure_no_auth: flags.insecure_no_auth,
        config: config.clone(),
    });

    let app = api::router(Arc::clone(&state));
    let listener = tokio::net::TcpListener::bind(config.bind)
        .await
        .with_context(|| format!("无法监听 {}", config.bind))?;
    let local = listener.local_addr()?;

    tracing::info!("DepDek webdesk v{VERSION} 已就绪");
    tracing::info!("  本机:   http://{local}/");
    if let Some(ip) = lan_ip() {
        tracing::info!("  局域网: http://{}:{}/", ip, local.port());
    }
    if flags.insecure_no_auth {
        tracing::warn!("  认证已关闭（仅供本机调试）");
    } else {
        tracing::info!("  登录:   使用 webdesk.toml 中配置的密码");
    }

    let server = axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown_signal());

    let result = server.await;
    sampler_task.abort();
    state.audit.record(
        "service.stop",
        "system",
        "local",
        true,
        serde_json::json!({}),
    );
    result.context("HTTP 服务异常退出")
}

/// Best-effort LAN address discovery (no packet is sent for a UDP connect).
fn lan_ip() -> Option<IpAddr> {
    let socket = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).ok()?;
    socket.connect((Ipv4Addr::new(192, 168, 1, 1), 9)).ok()?;
    socket.local_addr().ok().map(|addr| addr.ip())
}

async fn shutdown_signal() {
    let ctrl_c = async {
        tokio::signal::ctrl_c().await.ok();
    };
    #[cfg(unix)]
    let terminate = async {
        if let Ok(mut signal) =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            signal.recv().await;
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
    tracing::info!("收到退出信号，正在停止 webdesk");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_flags_in_any_order() {
        let flags = parse_flags(&[
            "--insecure-no-auth".into(),
            "--config".into(),
            "/tmp/webdesk.toml".into(),
        ]);
        assert!(flags.insecure_no_auth);
        assert_eq!(flags.config.unwrap().to_str().unwrap(), "/tmp/webdesk.toml");

        let short = parse_flags(&["-c".into(), "/etc/depdek/webdesk.toml".into()]);
        assert!(!short.insecure_no_auth);
        assert!(short.config.is_some());
    }

    #[test]
    fn lan_ip_is_optional_but_never_panics() {
        let _ = lan_ip();
    }
}
