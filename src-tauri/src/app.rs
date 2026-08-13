//! Tauri application wiring: plugins, commands and events
//! (contract sections 3 and 4). Only compiled with the `tauri-app` feature.

use std::path::Path;
use std::sync::{Arc, Mutex};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_store::StoreExt;

use crate::audit::AuditEntry;
use crate::obsidian::{ObsidianListResult, ObsidianReadResult, ObsidianStore};
use crate::rpc::Sidecar;
use crate::settings::{ProviderConfig, Settings};
use crate::vault::{
    ListDirResult, ReadBinaryResult, ReadFileResult, SearchResult, Vault, WriteFileResult,
};

pub struct AppState {
    vault: Vault,
    obsidian: ObsidianStore,
    sidecar: Sidecar,
    settings: Mutex<Settings>,
}

fn persist_settings(app: &AppHandle, settings: &Settings) -> Result<(), String> {
    let store = app.store("settings.json").map_err(|e| e.to_string())?;
    store.set(
        "settings".to_string(),
        serde_json::to_value(settings).map_err(|e| e.to_string())?,
    );
    store.save().map_err(|e| e.to_string())
}

fn load_settings(app: &AppHandle) -> Settings {
    app.store("settings.json")
        .ok()
        .and_then(|store| store.get("settings"))
        .and_then(|value| serde_json::from_value(value).ok())
        .unwrap_or_default()
}

// ---------------------------------------------------------------------
// Vault commands (contract section 3). All go through the same Vault
// service the sidecar uses, with session_id "user".
// ---------------------------------------------------------------------

#[tauri::command]
fn vault_set_root(state: State<AppState>, app: AppHandle, path: String) -> Result<String, String> {
    let canonical = state
        .vault
        .set_root(Path::new(&path))
        .map_err(|e| e.to_command_string())?;
    let root = canonical.to_string_lossy().into_owned();
    {
        let mut settings = state.settings.lock().unwrap();
        settings.last_root = Some(root.clone());
        persist_settings(&app, &settings)?;
    }
    Ok(root)
}

#[tauri::command]
fn vault_get_root(state: State<AppState>) -> Option<String> {
    state.vault.root().map(|p| p.to_string_lossy().into_owned())
}

#[tauri::command]
fn vault_read_file(state: State<AppState>, path: String) -> Result<ReadFileResult, String> {
    state
        .vault
        .read_file("user", &path)
        .map_err(|e| e.to_command_string())
}

#[tauri::command]
fn vault_read_binary(state: State<AppState>, path: String) -> Result<ReadBinaryResult, String> {
    state
        .vault
        .read_binary("user", &path)
        .map_err(|e| e.to_command_string())
}

#[tauri::command]
fn vault_write_file(
    state: State<AppState>,
    path: String,
    content: String,
) -> Result<WriteFileResult, String> {
    state
        .vault
        .write_file("user", &path, &content)
        .map_err(|e| e.to_command_string())
}

#[tauri::command]
fn vault_write_binary(
    state: State<AppState>,
    path: String,
    data_base64: String,
) -> Result<WriteFileResult, String> {
    state
        .vault
        .write_binary("user", &path, &data_base64)
        .map_err(|e| e.to_command_string())
}

#[tauri::command]
fn vault_list_dir(state: State<AppState>, path: String) -> Result<ListDirResult, String> {
    state
        .vault
        .list_dir("user", &path)
        .map_err(|e| e.to_command_string())
}

#[tauri::command]
fn vault_search_files(state: State<AppState>, query: String) -> Result<SearchResult, String> {
    state
        .vault
        .search_files("user", &query)
        .map_err(|e| e.to_command_string())
}

#[tauri::command]
fn vault_delete_file(state: State<AppState>, path: String) -> Result<(), String> {
    state
        .vault
        .delete_file("user", &path)
        .map_err(|e| e.to_command_string())
}

// ---------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------

#[derive(Serialize)]
struct AuditReadResult {
    entries: Vec<AuditEntry>,
    total: usize,
}

#[tauri::command]
fn audit_read(
    state: State<AppState>,
    offset: Option<usize>,
    limit: Option<usize>,
) -> AuditReadResult {
    let (entries, total) = state
        .vault
        .audit()
        .read(offset.unwrap_or(0), limit.unwrap_or(100).min(1000));
    AuditReadResult { entries, total }
}

// ---------------------------------------------------------------------
// Agent commands: forwarded to the sidecar over stdio JSON-RPC.
// ---------------------------------------------------------------------

#[tauri::command]
async fn agent_create_session(
    state: State<'_, AppState>,
    session_id: String,
    provider: ProviderConfig,
    system_prompt: Option<String>,
) -> Result<Value, String> {
    let mut params = json!({ "session_id": session_id, "provider": provider });
    if let Some(prompt) = system_prompt {
        params["system_prompt"] = json!(prompt);
    }
    state.sidecar.request("agent/create_session", params).await
}

#[tauri::command]
async fn agent_send(
    state: State<'_, AppState>,
    session_id: String,
    text: String,
) -> Result<(), String> {
    state
        .sidecar
        .request("agent/send", json!({ "session_id": session_id, "text": text }))
        .await?;
    Ok(())
}

#[tauri::command]
async fn agent_analyze(
    state: State<'_, AppState>,
    provider: Value,
    text: String,
    system_prompt: Option<String>,
) -> Result<Value, String> {
    state
        .sidecar
        .request(
            "agent/analyze",
            json!({
                "provider": provider,
                "text": text,
                "system_prompt": system_prompt,
            }),
        )
        .await
}

#[tauri::command]
async fn agent_abort(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    state
        .sidecar
        .request("agent/abort", json!({ "session_id": session_id }))
        .await?;
    Ok(())
}

#[tauri::command]
async fn agent_close(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    state
        .sidecar
        .request("agent/close_session", json!({ "session_id": session_id }))
        .await?;
    Ok(())
}

// ---------------------------------------------------------------------
// Mail: forwarded to the sidecar, which fetches over IMAP and writes
// messages into the vault (contract sections 2.5 and 7).
// ---------------------------------------------------------------------

#[tauri::command]
async fn mail_fetch(
    state: State<'_, AppState>,
    account: Option<String>,
    refresh_body: Option<bool>,
) -> Result<Value, String> {
    state
        .sidecar
        .request(
            "mail/fetch",
            json!({ "account": account, "refresh_body": refresh_body.unwrap_or(false) }),
        )
        .await
}

#[tauri::command]
async fn mail_delete(
    state: State<'_, AppState>,
    account: String,
    uids: Vec<u32>,
) -> Result<Value, String> {
    state
        .sidecar
        .request("mail/delete", json!({ "account": account, "uids": uids }))
        .await
}

#[tauri::command]
async fn mail_list_mailboxes(
    state: State<'_, AppState>,
    account: String,
) -> Result<Value, String> {
    state
        .sidecar
        .request("mail/list_mailboxes", json!({ "account": account }))
        .await
}

#[tauri::command]
async fn mail_action(
    state: State<'_, AppState>,
    account: String,
    action: String,
    uids: Vec<u32>,
    destination: Option<String>,
    mailbox: Option<String>,
) -> Result<Value, String> {
    state
        .sidecar
        .request(
            "mail/action",
            json!({
                "account": account,
                "action": action,
                "uids": uids,
                "destination": destination,
                "mailbox": mailbox,
            }),
        )
        .await
}

#[tauri::command]
async fn mail_send(
    state: State<'_, AppState>,
    account: String,
    to: String,
    cc: Option<String>,
    bcc: Option<String>,
    subject: Option<String>,
    text: String,
    html: Option<String>,
    attachments: Option<Vec<Value>>,
) -> Result<Value, String> {
    state
        .sidecar
        .request(
            "mail/send",
            json!({
                "account": account,
                "to": to,
                "cc": cc,
                "bcc": bcc,
                "subject": subject,
                "text": text,
                "html": html,
                "attachments": attachments,
            }),
        )
        .await
}

#[tauri::command]
async fn calendar_sync(
    state: State<'_, AppState>,
    account: Option<String>,
) -> Result<Value, String> {
    state
        .sidecar
        .request("calendar/sync", json!({ "account": account }))
        .await
}

#[tauri::command]
async fn calendar_push(
    state: State<'_, AppState>,
    account: String,
    event: Value,
) -> Result<Value, String> {
    state
        .sidecar
        .request("calendar/push", json!({ "account": account, "event": event }))
        .await
}

// Todo queue: normalized messages are owned by the sidecar bus and persisted
// through the same Vault trust boundary (contract sections 2.7 and 9).

#[tauri::command]
async fn todo_list(state: State<'_, AppState>) -> Result<Value, String> {
    state.sidecar.request("todo/list", json!({})).await
}

#[tauri::command]
async fn todo_enqueue(state: State<'_, AppState>, input: Value) -> Result<Value, String> {
    state
        .sidecar
        .request("todo/enqueue", json!({ "input": input }))
        .await
}

#[tauri::command]
async fn todo_update(state: State<'_, AppState>, input: Value) -> Result<Value, String> {
    state
        .sidecar
        .request("todo/update", json!({ "input": input }))
        .await
}

// ---------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------

#[tauri::command]
fn settings_get(state: State<AppState>) -> Settings {
    state.settings.lock().unwrap().clone()
}

#[tauri::command]
fn settings_set(state: State<AppState>, app: AppHandle, settings: Settings) -> Result<(), String> {
    persist_settings(&app, &settings)?;
    *state.settings.lock().unwrap() = settings;
    Ok(())
}

// ---------------------------------------------------------------------
// Obsidian connector: read-only external vault, separate from DepDek Home.
// ---------------------------------------------------------------------

#[tauri::command]
fn obsidian_set_root(state: State<AppState>, app: AppHandle, path: String) -> Result<String, String> {
    let canonical = state.obsidian.set_root(Path::new(&path))?;
    let root = canonical.to_string_lossy().into_owned();
    let mut settings = state.settings.lock().unwrap();
    settings.obsidian_root = Some(root.clone());
    persist_settings(&app, &settings)?;
    Ok(root)
}

#[tauri::command]
fn obsidian_get_root(state: State<AppState>) -> Option<String> {
    state.obsidian.root().map(|path| path.to_string_lossy().into_owned())
}

#[tauri::command]
fn obsidian_clear_root(state: State<AppState>, app: AppHandle) -> Result<(), String> {
    state.obsidian.clear_root();
    let mut settings = state.settings.lock().unwrap();
    settings.obsidian_root = None;
    persist_settings(&app, &settings)
}

#[tauri::command]
fn obsidian_list_notes(state: State<AppState>, query: Option<String>) -> Result<ObsidianListResult, String> {
    state.obsidian.list_notes(query.as_deref())
}

#[tauri::command]
fn obsidian_read_note(state: State<AppState>, path: String) -> Result<ObsidianReadResult, String> {
    state.obsidian.read_note(&path)
}

// ---------------------------------------------------------------------
// App entry point
// ---------------------------------------------------------------------

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let vault = Vault::new();
            let obsidian = ObsidianStore::new(vault.audit());

            // Forward audit entries to the frontend (vault://audit).
            let handle = app.handle().clone();
            vault
                .audit()
                .add_listener(Arc::new(move |entry: &AuditEntry| {
                    let _ = handle.emit("vault://audit", entry);
                }));

            // Sidecar: agent/event notifications become agent://event.
            let handle = app.handle().clone();
            let emit = Arc::new(move |event: &str, payload: Value| {
                let _ = handle.emit(event, payload);
            });
            let sidecar = if cfg!(debug_assertions) {
                Sidecar::new(vault.clone(), emit)
            } else {
                let resources = app.path().resource_dir().map_err(|e| e.to_string())?;
                Sidecar::with_runtime(
                    vault.clone(),
                    emit,
                    resources.join("node"),
                    resources.join("sidecar.mjs"),
                )
            };

            // Restore the previous data folder, if any.
            let settings = load_settings(app.handle());
            if let Some(root) = settings.last_root.clone() {
                let _ = vault.set_root(Path::new(&root));
            }
            if let Some(root) = settings.obsidian_root.clone() {
                let _ = obsidian.set_root(Path::new(&root));
            }

            app.manage(AppState {
                vault,
                obsidian,
                sidecar,
                settings: Mutex::new(settings),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            vault_set_root,
            vault_get_root,
            vault_read_file,
            vault_read_binary,
            vault_write_file,
            vault_write_binary,
            vault_list_dir,
            vault_search_files,
            vault_delete_file,
            audit_read,
            agent_create_session,
            agent_send,
            agent_analyze,
            agent_abort,
            agent_close,
            settings_get,
            settings_set,
            obsidian_set_root,
            obsidian_get_root,
            obsidian_clear_root,
            obsidian_list_notes,
            obsidian_read_note,
            mail_fetch,
            mail_delete,
            mail_list_mailboxes,
            mail_action,
            mail_send,
            calendar_sync,
            calendar_push,
            todo_list,
            todo_enqueue,
            todo_update,
        ])
        .run(tauri::generate_context!())
        .expect("error while running DepDek");
}
