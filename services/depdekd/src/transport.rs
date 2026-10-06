use std::os::unix::fs::{DirBuilderExt, FileTypeExt, MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{bail, Context, Result};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{UnixListener, UnixStream};

use crate::service::WorkerTransport;
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

/// Operator provisioned directory. Do not grant workers data or owner RPC access.
pub fn bind_worker_socket(config: &WorkerTransport) -> Result<(UnixListener, SocketGuard)> {
    if !cfg!(target_os = "linux")
        || !config.socket.is_absolute()
        || config.uid == 0
        || config.uid == unsafe { libc::geteuid() }
        || config.gid == 0
    {
        bail!("invalid isolated Worker transport");
    }
    let parent = config
        .socket
        .parent()
        .context("Worker socket parent required")?;
    let metadata = std::fs::symlink_metadata(parent)?;
    if !metadata.is_dir()
        || metadata.file_type().is_symlink()
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.gid() != config.gid
        || metadata.mode() & 0o777 != 0o710
        || std::fs::canonicalize(parent)? != parent
    {
        bail!("Worker socket parent requires owner uid, worker gid, canonical 0710 directory");
    }
    let listener = UnixListener::bind(&config.socket)
        .context("bind Worker socket; existing files never replaced")?;
    let meta = std::fs::symlink_metadata(&config.socket)?;
    let guard = SocketGuard {
        path: config.socket.clone(),
        dev: meta.dev(),
        ino: meta.ino(),
    };
    use std::os::unix::ffi::OsStrExt;
    let path = std::ffi::CString::new(config.socket.as_os_str().as_bytes())?;
    if unsafe { libc::chown(path.as_ptr(), u32::MAX, config.gid) } != 0 {
        bail!("Worker socket group assignment failed");
    }
    std::fs::set_permissions(&config.socket, std::fs::Permissions::from_mode(0o660))?;
    Ok((listener, guard))
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
    serve_channel(listener, service, None, shutdown).await
}
pub async fn serve_worker(
    listener: UnixListener,
    service: Arc<Service>,
    worker_uid: u32,
    shutdown: impl std::future::Future<Output = ()>,
) -> Result<()> {
    serve_channel(listener, service, Some(worker_uid), shutdown).await
}
async fn serve_channel(
    listener: UnixListener,
    service: Arc<Service>,
    worker_uid: Option<u32>,
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
                    if handle_connection(stream,service,worker_uid).await.is_err() {
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

async fn handle_connection(
    mut stream: UnixStream,
    service: Arc<Service>,
    worker_uid: Option<u32>,
) -> Result<()> {
    let uid = stream.peer_cred().context("verify Unix peer")?.uid();
    if uid != worker_uid.unwrap_or(service.owner_uid()) {
        write_response(
            &mut stream,
            protocol_error(-32000, "Unix peer authentication required"),
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
        tokio::task::spawn_blocking(move || {
            if worker_uid.is_some() {
                service.dispatch_worker(uid, request)
            } else {
                service.dispatch(uid, request)
            }
        }),
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

async fn write_response(stream: &mut UnixStream, mut response: serde_json::Value) -> Result<()> {
    let serialized = serde_json::to_vec(&response);
    agent_workbench_lib::secrets::wipe_json(&mut response);
    let mut bytes = Zeroizing::new(serialized?);
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
    call_as(socket, method, params, unsafe { libc::geteuid() }).await
}
pub async fn call_as(
    socket: &Path,
    method: &str,
    params: serde_json::Value,
    server_uid: u32,
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
    if stream.peer_cred()?.uid() != server_uid {
        bail!("server uid does not match trusted registration");
    }
    tokio::time::timeout(IO_TIMEOUT, stream.write_all(&bytes)).await??;
    let bytes = Zeroizing::new(
        tokio::time::timeout(REQUEST_TIMEOUT, read_frame(&mut stream, MAX_RESPONSE_BYTES))
            .await??,
    );
    let response: serde_json::Value =
        serde_json::from_slice(&bytes).context("invalid service response")?;
    if response["jsonrpc"] != "2.0" || response["id"] != 1 {
        bail!("unexpected RPC response");
    }
    Ok(response)
}
