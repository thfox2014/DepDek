use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

use agent_workbench_lib::vault::{
    AccessError, AccessUser, LoginInput, ManagedReadError, ManagedReadOperation, ManagedReadVault,
    ReadAuthority, MANAGED_MAX_LIST_ENTRIES, MANAGED_MAX_TEXT_BYTES,
};
use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::VERSION;
use agent_workbench_lib::secrets::{
    wipe_json, ImportCredentials, InitializeStore, LegacySources, PutCredential, RevokeCredential,
    SecretError, SecretOperation, SecretStore, SecretText,
};

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ServeConfig {
    pub workspace_id: String,
    pub root: PathBuf,
    pub read_paths: Vec<String>,
    pub socket: PathBuf,
    #[serde(default)]
    pub secret_dir: Option<PathBuf>,
    #[serde(default)]
    pub access_users: Vec<AccessUser>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RpcRequest {
    pub jsonrpc: String,
    pub id: u64,
    pub method: String,
    pub params: Value,
}
impl Drop for RpcRequest {
    fn drop(&mut self) {
        wipe_json(&mut self.params);
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CredentialRequest {
    workspace_id: String,
    input: Value,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct UnlockInput {
    passphrase: SecretText,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct OperationInput {
    operation_id: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct BusinessSessionInput {
    session_token: SecretText,
    #[serde(default)]
    csrf_token: Option<SecretText>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DelegatedInput {
    session_token: SecretText,
    workspace_id: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DelegatedCommand {
    session_token: SecretText,
    csrf_token: SecretText,
    workspace_id: String,
    command: String,
    command_version: String,
    input: Value,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WorkspaceParams {
    workspace_id: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CommandRequest {
    workspace_id: String,
    command: String,
    command_version: String,
    input: Value,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PathInput {
    path: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ListInput {
    path: String,
    #[serde(default = "default_list_limit")]
    limit: usize,
}
fn default_list_limit() -> usize {
    MANAGED_MAX_LIST_ENTRIES
}

#[derive(Debug, Serialize)]
pub struct ApiError {
    pub code: &'static str,
    pub message: &'static str,
    pub retryable: bool,
}

impl ApiError {
    pub fn invalid() -> Self {
        Self {
            code: "INVALID_INPUT",
            message: "invalid request parameters",
            retryable: false,
        }
    }
    pub fn forbidden() -> Self {
        Self {
            code: "FORBIDDEN",
            message: "identity or resource is not authorized",
            retryable: false,
        }
    }
    fn unavailable() -> Self {
        Self {
            code: "CAPABILITY_UNAVAILABLE",
            message: "command/version is not available in this read-only slice",
            retryable: false,
        }
    }
}

impl From<ManagedReadError> for ApiError {
    fn from(error: ManagedReadError) -> Self {
        match error {
            ManagedReadError::Forbidden => Self::forbidden(),
            ManagedReadError::NotFound => Self {
                code: "NOT_FOUND",
                message: "resource not found",
                retryable: false,
            },
            ManagedReadError::PolicyChanged => Self {
                code: "POLICY_CHANGED",
                message: "refresh authorization",
                retryable: false,
            },
            ManagedReadError::TooLarge => Self {
                code: "LIMIT_EXCEEDED",
                message: "read budget exceeded",
                retryable: false,
            },
            ManagedReadError::NotUtf8 => Self {
                code: "INVALID_INPUT",
                message: "only UTF-8 text is supported",
                retryable: false,
            },
            ManagedReadError::InvalidInput => Self::invalid(),
            ManagedReadError::AuditUnavailable => Self {
                code: "AUDIT_UNAVAILABLE",
                message: "audit persistence failed; no data released",
                retryable: false,
            },
            ManagedReadError::Io => Self {
                code: "RESOURCE_UNAVAILABLE",
                message: "resource I/O unavailable",
                retryable: true,
            },
        }
    }
}
impl From<SecretError> for ApiError {
    fn from(error: SecretError) -> Self {
        Self {
            code: error.code(),
            message: error.message(),
            retryable: false,
        }
    }
}
impl From<AccessError> for ApiError {
    fn from(error: AccessError) -> Self {
        Self {
            code: error.code(),
            message: error.message(),
            retryable: false,
        }
    }
}

/// Immutable startup registration. End-user identity is assigned from the
/// verified Unix peer, never from RpcRequest or command input fields.
pub struct Service {
    owner_uid: u32,
    workspace_id: String,
    principal_id: String,
    request_prefix: String,
    sequence: AtomicU64,
    vault: ManagedReadVault,
    secret_store: Option<SecretStore>,
}

impl Service {
    pub fn open(config: &ServeConfig) -> Result<Self> {
        let owner_uid = unsafe { libc::geteuid() };
        if owner_uid == 0 {
            bail!("depdekd refuses root; run as the intended local data owner");
        }
        if !config.root.is_absolute() || !config.socket.is_absolute() {
            bail!("root and socket must be absolute paths");
        }
        let principal_id = format!("local:{owner_uid}");
        let vault = ManagedReadVault::open(
            &config.root,
            &config.workspace_id,
            &principal_id,
            &config.read_paths,
        )?;
        // Configuration remains immutable; no caller can register users/scopes.
        // AccessUser contains a redacted PHC only, never a plaintext password.
        let access_users: Vec<AccessUser> = config
            .access_users
            .iter()
            .map(|user| AccessUser {
                principal_id: user.principal_id.clone(),
                password_hash: user.password_hash.clone(),
                read_paths: user.read_paths.clone(),
            })
            .collect();
        vault.configure_access(access_users)?;
        let secret_store = config
            .secret_dir
            .as_ref()
            .map(|directory| {
                vault
                    .open_secret_files(directory)
                    .map(|files| SecretStore::new(files, config.workspace_id.clone()))
            })
            .transpose()?;
        let started = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_nanos();
        Ok(Self {
            owner_uid,
            workspace_id: config.workspace_id.clone(),
            principal_id,
            request_prefix: format!("r1-{}-{started:x}", std::process::id()),
            sequence: AtomicU64::new(1),
            vault,
            secret_store,
        })
    }

    pub fn owner_uid(&self) -> u32 {
        self.owner_uid
    }

    pub fn dispatch(&self, peer_uid: u32, mut request: RpcRequest) -> Value {
        let id = request.id;
        let request_id = format!(
            "{}-{}",
            self.request_prefix,
            self.sequence.fetch_add(1, Ordering::Relaxed)
        );
        let result = if peer_uid != self.owner_uid {
            Err(ApiError::forbidden())
        } else if request.jsonrpc != "2.0" {
            Err(ApiError::invalid())
        } else {
            self.handle(&request_id, &request.method, request.params.take())
        };
        match result {
            Ok(data) => json!({"jsonrpc":"2.0","id":id,"result":{
                "api_version":"2.0","request_id":request_id,"trace_id":request_id,
                "workspace_id":self.workspace_id,"policy_revision":1,"data":data}}),
            Err(error) => json!({"jsonrpc":"2.0","id":id,"error":{
                "code":-32000,"message":error.message,"data":{
                    "api_version":"2.0","request_id":request_id,"trace_id":request_id,"error":error}}}),
        }
    }

    fn handle(&self, request_id: &str, method: &str, params: Value) -> Result<Value, ApiError> {
        match method {
            "v2/health" => {
                if params != json!({}) {
                    return Err(ApiError::invalid());
                }
                Ok(
                    json!({"ready":true,"version":VERSION,"mode":"local_owner_read_only",
                    "engine_enabled":false,"business_writes_enabled":false,"credential_management_enabled":self.secret_store.is_some()}),
                )
            }
            "v2/commands.list" => {
                let params: WorkspaceParams =
                    serde_json::from_value(params).map_err(|_| ApiError::invalid())?;
                self.check_workspace(&params.workspace_id)?;
                Ok(manifests())
            }
            "v2/command.invoke" => {
                let req: CommandRequest =
                    serde_json::from_value(params).map_err(|_| ApiError::invalid())?;
                let operation = match (req.command.as_str(), req.command_version.as_str()) {
                    ("file.read", "1.0") => {
                        let input: PathInput =
                            serde_json::from_value(req.input).map_err(|_| ApiError::invalid())?;
                        ManagedReadOperation::Read { path: input.path }
                    }
                    ("file.list", "1.0") => {
                        let input: ListInput =
                            serde_json::from_value(req.input).map_err(|_| ApiError::invalid())?;
                        ManagedReadOperation::List {
                            path: input.path,
                            limit: input.limit,
                        }
                    }
                    ("file.stat", "1.0") => {
                        let input: PathInput =
                            serde_json::from_value(req.input).map_err(|_| ApiError::invalid())?;
                        ManagedReadOperation::Stat { path: input.path }
                    }
                    _ => return Err(ApiError::unavailable()),
                };
                // File access and its denied audit are both evaluated in Vault.
                let authority =
                    ReadAuthority::new(&self.principal_id, &req.workspace_id, 1, request_id);
                let value = self
                    .vault
                    .execute(&authority, operation)
                    .map_err(ApiError::from)?;
                Ok(
                    json!({"status":"completed","result":value,"freshness":"live",
                    "source_revisions_available":false}),
                )
            }
            method if method.starts_with("v2/credentials.") => {
                self.credentials(request_id, method, params)
            }
            "v2/auth.login" => self
                .vault
                .login_business(request_id, parse::<LoginInput>(params)?)
                .map_err(ApiError::from),
            "v2/auth.session" | "v2/auth.logout" => {
                let input: BusinessSessionInput = parse(params)?;
                if method == "v2/auth.session" && input.csrf_token.is_some() {
                    return Err(ApiError::invalid());
                }
                self.vault
                    .business_session(
                        request_id,
                        &input.session_token,
                        input.csrf_token.as_ref(),
                        method == "v2/auth.logout",
                    )
                    .map_err(ApiError::from)
            }
            "v2/delegated.workspaces" => {
                let input: BusinessSessionInput = parse(params)?;
                if input.csrf_token.is_some() {
                    return Err(ApiError::invalid());
                }
                let info = self
                    .vault
                    .delegated_info(request_id, &input.session_token, None)
                    .map_err(ApiError::from)?;
                Ok(json!({"workspaces":[{"id":info["workspace_id"],"policy_revision":1}]}))
            }
            "v2/delegated.commands" => {
                let input: DelegatedInput = parse(params)?;
                self.vault
                    .delegated_info(request_id, &input.session_token, Some(&input.workspace_id))
                    .map_err(ApiError::from)?;
                Ok(manifests())
            }
            "v2/delegated.invoke" => {
                let input: DelegatedCommand = parse(params)?;
                // Authenticate before version/capability discovery.
                self.vault
                    .delegated_info(request_id, &input.session_token, Some(&input.workspace_id))
                    .map_err(ApiError::from)?;
                let operation =
                    read_operation(&input.command, &input.command_version, input.input)?;
                let result = self
                    .vault
                    .delegated_read(
                        request_id,
                        &input.session_token,
                        &input.csrf_token,
                        &input.workspace_id,
                        operation,
                    )
                    .map_err(ApiError::from)?;
                Ok(
                    json!({"status":"completed","result":result,"freshness":"live","source_revisions_available":false}),
                )
            }
            _ => Err(ApiError::unavailable()),
        }
    }

    pub fn expire_credentials(&self) {
        if let Some(store) = &self.secret_store {
            store.expire_idle();
        }
    }

    fn credentials(
        &self,
        request_id: &str,
        method: &str,
        params: Value,
    ) -> Result<Value, ApiError> {
        let store = self
            .secret_store
            .as_ref()
            .ok_or_else(ApiError::unavailable)?;
        let req: CredentialRequest =
            serde_json::from_value(params).map_err(|_| ApiError::invalid())?;
        let input = req.input;
        let operation = match method {
            "v2/credentials.status" if input == json!({}) => SecretOperation::Status,
            "v2/credentials.list" if input == json!({}) => SecretOperation::List,
            "v2/credentials.lock" if input == json!({}) => SecretOperation::Lock,
            "v2/credentials.init" => SecretOperation::Initialize(parse::<InitializeStore>(input)?),
            "v2/credentials.unlock" => {
                SecretOperation::Unlock(parse::<UnlockInput>(input)?.passphrase)
            }
            "v2/credentials.put" => SecretOperation::Put(parse::<PutCredential>(input)?),
            "v2/credentials.revoke" => SecretOperation::Revoke(parse::<RevokeCredential>(input)?),
            "v2/credentials.receipt" => {
                SecretOperation::Receipt(parse::<OperationInput>(input)?.operation_id)
            }
            "v2/credentials.import.preview" => {
                SecretOperation::ImportPreview(parse::<LegacySources>(input)?)
            }
            "v2/credentials.import.apply" => {
                SecretOperation::ImportApply(parse::<ImportCredentials>(input)?)
            }
            "v2/credentials.status" | "v2/credentials.list" | "v2/credentials.lock" => {
                return Err(ApiError::invalid())
            }
            _ => return Err(ApiError::unavailable()),
        };
        let authority = ReadAuthority::new(&self.principal_id, &req.workspace_id, 1, request_id);
        store.execute(&authority, operation).map_err(ApiError::from)
    }

    fn check_workspace(&self, workspace: &str) -> Result<(), ApiError> {
        if workspace != self.workspace_id {
            return Err(ApiError::forbidden());
        }
        Ok(())
    }
}

fn read_operation(
    command: &str,
    version: &str,
    input: Value,
) -> Result<ManagedReadOperation, ApiError> {
    match (command, version) {
        ("file.read", "1.0") => Ok(ManagedReadOperation::Read {
            path: parse::<PathInput>(input)?.path,
        }),
        ("file.stat", "1.0") => Ok(ManagedReadOperation::Stat {
            path: parse::<PathInput>(input)?.path,
        }),
        ("file.list", "1.0") => {
            let input: ListInput = parse(input)?;
            Ok(ManagedReadOperation::List {
                path: input.path,
                limit: input.limit,
            })
        }
        _ => Err(ApiError::unavailable()),
    }
}

fn parse<T: serde::de::DeserializeOwned>(value: Value) -> Result<T, ApiError> {
    serde_json::from_value(value).map_err(|_| ApiError::invalid())
}

pub fn protocol_error(code: i64, message: &str) -> Value {
    json!({"jsonrpc":"2.0","id":null,"error":{"code":code,"message":message}})
}

pub fn manifests() -> Value {
    let path_schema = json!({"type":"object","additionalProperties":false,"required":["path"],
        "properties":{"path":{"type":"string","minLength":1,"maxLength":1024}}});
    let mut list_schema = path_schema.clone();
    list_schema["properties"]["limit"] = json!({"type":"integer","minimum":1,"maximum":MANAGED_MAX_LIST_ENTRIES,"default":MANAGED_MAX_LIST_ENTRIES});
    let read_output = json!({"type":"object","additionalProperties":false,"required":["content","size","sha256"],
        "properties":{"content":{"type":"string"},"size":{"type":"integer","minimum":0},
            "sha256":{"type":"string","pattern":"^[0-9a-f]{64}$"}}});
    let stat_output = json!({"type":"object","additionalProperties":false,"required":["kind","size","modified_ms"],
        "properties":{"kind":{"type":"string","enum":["file","dir"]},"size":{"type":"integer","minimum":0},
            "modified_ms":{"type":"integer","minimum":0}}});
    let list_output = json!({"type":"object","additionalProperties":false,"required":["entries","truncated","coverage"],
        "properties":{"entries":{"type":"array","maxItems":MANAGED_MAX_LIST_ENTRIES,"items":{
            "type":"object","additionalProperties":false,"required":["name","kind","size"],"properties":{
                "name":{"type":"string"},"kind":{"type":"string","enum":["file","dir"]},"size":{"type":"integer","minimum":0}}}},
            "truncated":{"type":"boolean"},"coverage":{"const":"bounded_live_directory"}}});
    json!([
        manifest("file.list", list_schema, list_output),
        manifest("file.read", path_schema.clone(), read_output),
        manifest("file.stat", path_schema, stat_output)
    ])
}

fn manifest(name: &str, input: Value, output: Value) -> Value {
    json!({"name":name,"version":"1.0","input_schema":input,"output_schema":output,
        "capabilities":[name],"effect":"query","authorization":"registered_local_owner_paths",
        "idempotency":"none","compensation":"not_applicable","offline":true,"engine_required":false,
        "limits":{"text_bytes":MANAGED_MAX_TEXT_BYTES,"list_entries":MANAGED_MAX_LIST_ENTRIES}})
}
