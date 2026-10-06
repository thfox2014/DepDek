#[cfg(unix)]
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let mut args: Vec<String> = std::env::args().skip(1).collect();
    if args == ["version"] || args == ["--version"] {
        println!("{}", depdekd::VERSION);
        return Ok(());
    }
    if args.is_empty() || args == ["--help"] {
        println!("depdek {}\n  depdek auth hash-password  (hidden TTY; prints PHC only)\n  depdek --socket PATH health\n  depdek --socket PATH commands|providers --workspace ID\n  depdek --socket PATH command file.list|file.read|file.stat --workspace ID --input '{{\"path\":\"documents\"}}' --json\n  depdek --socket PATH credentials status|init|unlock|lock|list|receipt|put|revoke|import-preview|import --workspace ID [--stdin] [--operation ID]\n  depdek --socket PATH auth login|session|logout --stdin\n  depdek --socket PATH worker issue|revoke|invoke --workspace ID --stdin\nSensitive input: hidden TTY for credential init/unlock, explicit stdin JSON otherwise. No secret --input/argv/env. Always prints JSON; no shell/data fallback. Session/lease bearer appears only in its issuance response; never send it to a model.",depdekd::VERSION);
        println!("  depdek --socket PATH model issue|revoke|invoke --workspace ID --stdin\n  depdek auth hash-password --stdin  (explicit bounded password JSON)");
        return Ok(());
    }
    if args == ["auth", "hash-password"] || args == ["auth", "hash-password", "--stdin"] {
        use agent_workbench_lib::secrets::SecretText;
        #[derive(serde::Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Password {
            password: SecretText,
        }
        let password = if args.len() == 3 {
            serde_json::from_value::<Password>(sensitive_stdin()?)
                .map_err(|_| anyhow::anyhow!("invalid password input"))?
                .password
        } else {
            SecretText::new(rpassword::prompt_password(
                "New business password (12+ bytes): ",
            )?)
        };
        println!(
            "{}",
            agent_workbench_lib::vault::hash_business_password(password)?
        );
        return Ok(());
    }
    let socket = option(&mut args, "--socket")?
        .or_else(|| std::env::var("DEPDEKD_SOCKET").ok())
        .ok_or_else(|| anyhow::anyhow!("--socket or DEPDEKD_SOCKET required"))?;
    let workspace = option(&mut args, "--workspace")?;
    let input = option(&mut args, "--input")?;
    let operation = option(&mut args, "--operation")?;
    let stdin_input = flag(&mut args, "--stdin")?;
    if let Some(index) = args.iter().position(|s| s == "--json") {
        args.remove(index);
    }
    let (method, params) = match args.as_slice() {
        [kind]
            if kind == "health"
                && workspace.is_none()
                && input.is_none()
                && operation.is_none()
                && !stdin_input =>
        {
            ("v2/health", serde_json::json!({}))
        }
        [kind] if kind == "commands" && input.is_none() && operation.is_none() && !stdin_input => (
            "v2/commands.list",
            serde_json::json!({"workspace_id":required(workspace,"workspace")?}),
        ),
        [kind] if kind == "providers" && input.is_none() && operation.is_none() && !stdin_input => {
            (
                "v2/providers.list",
                serde_json::json!({"workspace_id":required(workspace,"workspace")?}),
            )
        }
        [kind, action]
            if kind == "auth"
                && workspace.is_none()
                && input.is_none()
                && operation.is_none()
                && stdin_input =>
        {
            let method = match action.as_str() {
                "login" => "v2/auth.login",
                "session" => "v2/auth.session",
                "logout" => "v2/auth.logout",
                _ => anyhow::bail!("unsupported auth action"),
            };
            (method, sensitive_stdin()?)
        }
        [kind, action]
            if (kind == "worker" || kind == "model")
                && input.is_none()
                && operation.is_none()
                && stdin_input =>
        {
            let method = match (kind.as_str(), action.as_str()) {
                ("worker", "issue") => "v2/delegated.worker.issue",
                ("worker", "revoke") => "v2/delegated.worker.revoke",
                ("worker", "invoke") => "v2/worker.invoke",
                ("model", "issue") => "v2/delegated.model.issue",
                ("model", "revoke") => "v2/delegated.model.revoke",
                ("model", "invoke") => "v2/model.invoke",
                _ => anyhow::bail!("unsupported worker action"),
            };
            let mut params = sensitive_stdin()?;
            let object = params
                .as_object_mut()
                .ok_or_else(|| anyhow::anyhow!("invalid stdin JSON object"))?;
            if object.contains_key("workspace_id") {
                anyhow::bail!("workspace must be specified only via --workspace");
            }
            object.insert(
                "workspace_id".into(),
                serde_json::json!(required(workspace, "workspace")?),
            );
            (method, params)
        }
        [kind, command] if kind == "command" && operation.is_none() && !stdin_input => (
            "v2/command.invoke",
            serde_json::json!({
            "workspace_id":required(workspace,"workspace")?,"command":command,"command_version":"1.0",
            "input":serde_json::from_str::<serde_json::Value>(&required(input,"input")?)?}),
        ),
        [kind, action] if kind == "credentials" && input.is_none() => {
            let (method, credential_input) = credential_input(action, stdin_input, operation)?;
            (
                method,
                serde_json::json!({"workspace_id":required(workspace,"workspace")?,"input":credential_input}),
            )
        }
        _ => anyhow::bail!("unsupported command or duplicate/unknown option; see --help"),
    };
    let mut response =
        depdekd::transport::call(std::path::Path::new(&socket), method, params).await?;
    println!("{}", serde_json::to_string_pretty(&response)?);
    let failed = response.get("error").is_some();
    agent_workbench_lib::secrets::wipe_json(&mut response);
    if failed {
        std::process::exit(2);
    }
    Ok(())
}

#[cfg(unix)]
fn sensitive_stdin() -> anyhow::Result<serde_json::Value> {
    use std::io::Read;
    let mut bytes = zeroize::Zeroizing::new(Vec::with_capacity(depdekd::MAX_REQUEST_BYTES + 1));
    std::io::stdin()
        .take((depdekd::MAX_REQUEST_BYTES + 1) as u64)
        .read_to_end(&mut bytes)?;
    if bytes.len() > depdekd::MAX_REQUEST_BYTES {
        anyhow::bail!("sensitive input exceeds budget");
    }
    serde_json::from_slice(&bytes).map_err(|_| anyhow::anyhow!("invalid sensitive JSON input"))
}

#[cfg(unix)]
fn flag(args: &mut Vec<String>, name: &str) -> anyhow::Result<bool> {
    let Some(index) = args.iter().position(|s| s == name) else {
        return Ok(false);
    };
    args.remove(index);
    if args.iter().any(|s| s == name) {
        anyhow::bail!("duplicate option");
    }
    Ok(true)
}

#[cfg(unix)]
fn credential_input(
    action: &str,
    stdin_input: bool,
    operation: Option<String>,
) -> anyhow::Result<(&'static str, serde_json::Value)> {
    use serde_json::json;
    use zeroize::Zeroizing;
    let method = match action {
        "status" => "v2/credentials.status",
        "init" => "v2/credentials.init",
        "unlock" => "v2/credentials.unlock",
        "lock" => "v2/credentials.lock",
        "list" => "v2/credentials.list",
        "receipt" => "v2/credentials.receipt",
        "put" => "v2/credentials.put",
        "revoke" => "v2/credentials.revoke",
        "import-preview" => "v2/credentials.import.preview",
        "import" => "v2/credentials.import.apply",
        _ => anyhow::bail!("unsupported credential action"),
    };
    if stdin_input {
        use std::io::Read;
        if operation.is_some() || matches!(action, "status" | "lock" | "list") {
            anyhow::bail!("unsupported credential input option");
        }
        let mut bytes = Zeroizing::new(Vec::with_capacity(depdekd::MAX_REQUEST_BYTES + 1));
        std::io::stdin()
            .take((depdekd::MAX_REQUEST_BYTES + 1) as u64)
            .read_to_end(&mut bytes)?;
        if bytes.len() > depdekd::MAX_REQUEST_BYTES {
            anyhow::bail!("credential input exceeds budget");
        }
        let input = serde_json::from_slice(&bytes)
            .map_err(|_| anyhow::anyhow!("invalid credential JSON input"))?;
        return Ok((method, input));
    }
    let input = match action {
        "status" | "lock" | "list" if operation.is_none() => json!({}),
        "receipt" => json!({"operation_id":required(operation,"operation")?}),
        "unlock" if operation.is_none() => {
            let passphrase =
                Zeroizing::new(rpassword::prompt_password("Secret Store passphrase: ")?);
            json!({"passphrase":&*passphrase})
        }
        "init" => {
            let passphrase = Zeroizing::new(rpassword::prompt_password(
                "New Secret Store passphrase (12+ characters): ",
            )?);
            let confirmation = Zeroizing::new(rpassword::prompt_password("Confirm passphrase: ")?);
            if *passphrase != *confirmation {
                anyhow::bail!("passphrases do not match");
            }
            let id = match operation {
                Some(id) => id,
                None => format!(
                    "init-cli-{}-{}",
                    std::process::id(),
                    std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)?
                        .as_nanos()
                ),
            };
            json!({"operation_id":id,"passphrase":&*passphrase})
        }
        _ => anyhow::bail!(
            "use explicit --stdin JSON for this credential action; no secret argv input"
        ),
    };
    Ok((method, input))
}

#[cfg(unix)]
fn required(value: Option<String>, name: &str) -> anyhow::Result<String> {
    value.ok_or_else(|| anyhow::anyhow!("--{name} required"))
}

#[cfg(unix)]
fn option(args: &mut Vec<String>, name: &str) -> anyhow::Result<Option<String>> {
    let Some(index) = args.iter().position(|s| s == name) else {
        return Ok(None);
    };
    if index + 1 >= args.len() || args[index + 1].starts_with("--") {
        anyhow::bail!("{name} needs a value");
    }
    let value = args.remove(index + 1);
    args.remove(index);
    if args.iter().any(|s| s == name) {
        anyhow::bail!("duplicate {name}");
    }
    Ok(Some(value))
}

#[cfg(not(unix))]
fn main() {
    eprintln!("R1 CLI currently supports Linux/macOS Unix sockets only");
    std::process::exit(1);
}
