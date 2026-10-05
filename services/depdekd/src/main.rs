#[cfg(unix)]
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    use depdekd::service::{ServeConfig, Service};
    use depdekd::transport::{bind_socket, serve};
    let args: Vec<_> = std::env::args().skip(1).collect();
    if args == ["version"] || args == ["--version"] {
        println!("{}", depdekd::VERSION);
        return Ok(());
    }
    if args.is_empty() || args == ["--help"] {
        println!("depdekd {}\n  depdekd serve --config <absolute-config.json>\n  depdekd version\nLocal-owner read-only slice; not a full V2 server.",depdekd::VERSION);
        return Ok(());
    }
    if args.len() != 3 || args[0] != "serve" || args[1] != "--config" {
        anyhow::bail!("use: depdekd serve --config FILE");
    }
    let config_bytes = std::fs::read(&args[2])?;
    let config: ServeConfig = serde_json::from_slice(&config_bytes)?;
    if !config.access_users.is_empty() {
        let private_bytes = agent_workbench_lib::vault::read_private_runtime_config(
            std::path::Path::new(&args[2]),
            &config.root,
        )?;
        if private_bytes != config_bytes {
            anyhow::bail!("identity config changed during startup");
        }
    }
    let service = std::sync::Arc::new(Service::open(&config)?);
    let (listener, _guard) = bind_socket(&config.socket)?;
    eprintln!("[depdekd] ready: local_owner_read_only (no model or business writes)");
    let shutdown = async {
        let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("install SIGTERM handler");
        tokio::select! { _ = tokio::signal::ctrl_c() => {}, _ = term.recv() => {} }
    };
    serve(listener, service, shutdown).await
}

#[cfg(not(unix))]
fn main() {
    eprintln!("R1 service currently supports Linux/macOS Unix sockets only");
    std::process::exit(1);
}
