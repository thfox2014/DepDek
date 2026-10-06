//! Trusted local Worker adapter: one fixed RPC, no owner/credential APIs.
#[cfg(unix)]
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    use std::io::{BufRead, Read, Write};
    use zeroize::Zeroizing;
    let mut args: Vec<_> = std::env::args().skip(1).collect();
    if args == ["--help"] {
        println!("depdek-worker --socket PATH [--server-uid UID] [--model]\nBounded NDJSON stdin; fixed file/model invoke only. Client, not an OS sandbox; requires independently provisioned Linux isolation.");
        return Ok(());
    }
    let model = if let Some(index) = args.iter().position(|s| s == "--model") {
        args.remove(index);
        true
    } else {
        false
    };
    let uid = if let Some(index) = args.iter().position(|s| s == "--server-uid") {
        if index + 1 >= args.len() {
            anyhow::bail!("server uid required");
        }
        let uid: u32 = args
            .remove(index + 1)
            .parse()
            .map_err(|_| anyhow::anyhow!("invalid server uid"))?;
        args.remove(index);
        uid
    } else {
        unsafe { libc::geteuid() }
    };
    if uid == 0 || args.len() != 2 || args[0] != "--socket" {
        anyhow::bail!("use depdek-worker --socket PATH; no secret argv");
    }
    let socket = std::path::Path::new(&args[1]);
    let stdin = std::io::stdin();
    let mut reader = stdin.lock();
    loop {
        let mut line = Zeroizing::new(String::new());
        let count = (&mut reader)
            .take((depdekd::MAX_REQUEST_BYTES + 1) as u64)
            .read_line(&mut line)?;
        if count == 0 {
            break;
        }
        if count > depdekd::MAX_REQUEST_BYTES || !line.ends_with('\n') {
            anyhow::bail!("invalid Worker frame budget or delimiter");
        }
        let mut params: serde_json::Value = serde_json::from_str(&line)
            .map_err(|_| anyhow::anyhow!("invalid Worker JSON frame"))?;
        let valid = if model {
            serde_json::from_value::<agent_workbench_lib::vault::ModelCall>(params.clone()).is_ok()
        } else {
            serde_json::from_value::<agent_workbench_lib::vault::WorkerCall>(params.clone()).is_ok()
        };
        if !valid {
            agent_workbench_lib::secrets::wipe_json(&mut params);
            anyhow::bail!("invalid Worker request shape");
        }
        let mut response = depdekd::transport::call_as(
            socket,
            if model {
                "v2/model.invoke"
            } else {
                "v2/worker.invoke"
            },
            params,
            uid,
        )
        .await
        .map_err(|_| anyhow::anyhow!("Worker service unavailable"))?;
        let text = Zeroizing::new(serde_json::to_string(&response)?);
        agent_workbench_lib::secrets::wipe_json(&mut response);
        let stdout = std::io::stdout();
        let mut writer = stdout.lock();
        writeln!(writer, "{}", &*text)?;
        writer.flush()?;
    }
    Ok(())
}
#[cfg(not(unix))]
fn main() {
    eprintln!("Worker adapter requires Unix transport");
    std::process::exit(1);
}
