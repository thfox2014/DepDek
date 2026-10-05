use std::os::unix::fs::{DirBuilderExt, FileTypeExt, MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{bail, Context, Result};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{UnixListener, UnixStream};

use crate::service::{protocol_error, RpcRequest, Service};
use crate::{MAX_REQUEST_BYTES, MAX_RESPONSE_BYTES};
use zeroize::Zeroizing;

const IO_TIMEOUT: Duration = Duration::from_secs(5);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
const CONNECTION_LIMIT: usize = 16;

/// Runtime socket validation is transport security, not data-root access.
/// Never chmod an existing broad directory or unlink an unknown/stale file.
pub fn bind_socket(socket: &Path) -> Result<(UnixListener, SocketGuard)> {
    if !socket.is_absolute() {
        bail!("socket must be absolute");
    }
    let parent = socket.parent().context("socket parent required")?;
    match std::fs::symlink_metadata(parent) {
        Ok(meta) => check_runtime_meta(&meta)?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            std::fs::DirBuilder::new()
                .mode(0o700)
                .create(parent)
                .context("create private runtime directory (its parent must already exist)")?;
            check_runtime_meta(&std::fs::symlink_metadata(parent)?)?;
        }
        Err(error) => return Err(error.into()),
    }
    let listener =
        UnixListener::bind(socket).context("bind socket; existing paths are never overwritten")?;
    let meta = std::fs::symlink_metadata(socket)?;
    let guard = SocketGuard {
        path: socket.into(),
        dev: meta.dev(),
        ino: meta.ino(),
    };
    std::fs::set_permissions(socket, std::fs::Permissions::from_mode(0o600))?;
    Ok((listener, guard))
}

fn check_runtime_meta(meta: &std::fs::Metadata) -> Result<()> {
    if !meta.is_dir()
        || meta.file_type().is_symlink()
        || meta.uid() != unsafe { libc::geteuid() }
        || meta.mode() & 0o077 != 0
    {
        bail!("socket parent must be a non-symlink private 0700 directory owned by this user");
    }
    Ok(())
}

pub struct SocketGuard {
    path: PathBuf,
    dev: u64,
    ino: u64,
}
impl Drop for SocketGuard {
    fn drop(&mut self) {
        if let Ok(meta) = std::fs::symlink_metadata(&self.path) {
            if meta.file_type().is_socket() && meta.dev() == self.dev && meta.ino() == self.ino {
                let _ = std::fs::remove_file(&self.path);
            }
        }
    }
}

pub async fn serve(
    listener: UnixListener,
    service: Arc<Service>,
    shutdown: impl std::future::Future<Output = ()>,
) -> Result<()> {
    let permits = Arc::new(tokio::sync::Semaphore::new(CONNECTION_LIMIT));
    let mut tasks = tokio::task::JoinSet::new();
    let mut credential_timer = tokio::time::interval(Duration::from_secs(5));
    tokio::pin!(shutdown);
    loop {
        tokio::select! {
            _ = &mut shutdown => break,
            _ = credential_timer.tick() => service.expire_credentials(),
            Some(_) = tasks.join_next(), if !tasks.is_empty() => {},
            accepted = listener.accept() => {
                let (stream,_) = accepted.context("accept command connection")?;
                let Ok(permit) = permits.clone().try_acquire_owned() else { drop(stream); continue; };
                let service = service.clone();
                tasks.spawn(async move {
                    let _permit = permit;
                    // Errors contain no requests or content. A disconnected
                    // client does not turn an audited read into a retryable write.
                    if handle_connection(stream,service).await.is_err() {
                        eprintln!("[depdekd] connection closed without a result");
                    }
                });
            }
        }
    }
    tasks.abort_all();
    while tasks.join_next().await.is_some() {}
    Ok(())
}

async fn handle_connection(mut stream: UnixStream, service: Arc<Service>) -> Result<()> {
    let uid = stream.peer_cred().context("verify Unix peer")?.uid();
    if uid != service.owner_uid() {
        write_response(
            &mut stream,
            protocol_error(-32000, "local owner authentication required"),
        )
        .await?;
        return Ok(());
    }
    let payload = Zeroizing::new(
        match tokio::time::timeout(IO_TIMEOUT, read_frame(&mut stream, MAX_REQUEST_BYTES)).await {
            Ok(Ok(payload)) => payload,
            _ => {
                write_response(
                    &mut stream,
                    protocol_error(-32600, "bounded newline-delimited request required"),
                )
                .await?;
                return Ok(());
            }
        },
    );
    let request: RpcRequest = match serde_json::from_slice(&payload) {
        Ok(request) => request,
        Err(_) => {
            write_response(&mut stream, protocol_error(-32600, "invalid request shape")).await?;
            return Ok(());
        }
    };
    let response = tokio::time::timeout(
        REQUEST_TIMEOUT,
        tokio::task::spawn_blocking(move || service.dispatch(uid, request)),
    )
    .await
    .context("command deadline exceeded")??;
    write_response(&mut stream, response).await
}

pub async fn read_frame(stream: &mut UnixStream, limit: usize) -> Result<Vec<u8>> {
    let mut bytes = Zeroizing::new(Vec::with_capacity(limit + 1));
    let mut buffer = Zeroizing::new([0u8; 4096]);
    loop {
        let n = stream.read(&mut *buffer).await?;
        if n == 0 {
            bail!("incomplete frame");
        }
        if let Some(end) = buffer[..n].iter().position(|b| *b == b'\n') {
            if bytes.len() + end > limit || end + 1 != n {
                bail!("oversized or pipelined frame");
            }
            bytes.extend_from_slice(&buffer[..end]);
            return Ok(std::mem::take(&mut *bytes));
        }
        if bytes.len() + n > limit {
            bail!("frame limit exceeded");
        }
        bytes.extend_from_slice(&buffer[..n]);
    }
}

async fn write_response(stream: &mut UnixStream, response: serde_json::Value) -> Result<()> {
    let mut bytes = serde_json::to_vec(&response)?;
    if bytes.len() > MAX_RESPONSE_BYTES {
        bail!("response budget exceeded");
    }
    bytes.push(b'\n');
    tokio::time::timeout(IO_TIMEOUT, stream.write_all(&bytes)).await??;
    Ok(())
}

pub async fn call(
    socket: &Path,
    method: &str,
    params: serde_json::Value,
) -> Result<serde_json::Value> {
    let mut request = serde_json::json!({"jsonrpc":"2.0","id":1,"method":method,"params":params});
    let serialized = serde_json::to_vec(&request);
    agent_workbench_lib::secrets::wipe_json(&mut request);
    let mut bytes = Zeroizing::new(serialized?);
    if bytes.len() > MAX_REQUEST_BYTES {
        bail!("request budget exceeded");
    }
    bytes.push(b'\n');
    let mut stream = UnixStream::connect(socket)
        .await
        .context("connect to depdekd")?;
    if stream.peer_cred()?.uid() != unsafe { libc::geteuid() } {
        bail!("server is not owned by the local user");
    }
    tokio::time::timeout(IO_TIMEOUT, stream.write_all(&bytes)).await??;
    let bytes = tokio::time::timeout(REQUEST_TIMEOUT, read_frame(&mut stream, MAX_RESPONSE_BYTES))
        .await??;
    let response: serde_json::Value =
        serde_json::from_slice(&bytes).context("invalid service response")?;
    if response["jsonrpc"] != "2.0" || response["id"] != 1 {
        bail!("unexpected RPC response");
    }
    Ok(response)
}
