//! Shared Agent Team memory store.
//!
//! The source of truth is an append-only JSONL event stream inside the Vault.
//! The store deliberately does not depend on SQLite yet: the event stream is
//! portable, auditable and can be indexed later without changing the public
//! memory contract. Agents reach this module only through `memory/*` RPC.

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::vault::{Vault, VaultError};

const EVENTS_PATH: &str = "mydata/memory/events.jsonl";
const MAX_QUERY_LIMIT: usize = 100;
const DEFAULT_QUERY_LIMIT: usize = 24;
const DEFAULT_MAX_CHARS: usize = 6_000;
const MAX_QUERY_CHARS: usize = 20_000;
static NEXT_ID: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MemoryRecord {
    pub id: String,
    pub scope: String,
    pub kind: String,
    pub text: String,
    pub status: String,
    pub sensitivity: String,
    pub confidence: f64,
    #[serde(default)]
    pub source_refs: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_by: Option<MemoryCreator>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub valid_from: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub valid_until: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub supersedes: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MemoryCreator {
    #[serde(rename = "type")]
    pub creator_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub engine: Option<String>,
    pub session_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct MemoryEvent {
    pub event_id: String,
    pub op: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub memory: Option<MemoryRecord>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub memory_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    pub ts: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct MemoryQueryResult {
    pub items: Vec<MemoryRecord>,
    pub total: usize,
    pub index_version: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct MemoryStats {
    pub total: usize,
    pub by_status: BTreeMap<String, usize>,
    pub by_scope: BTreeMap<String, usize>,
    pub malformed_events: usize,
    pub index_version: String,
}

#[derive(Clone)]
pub struct MemoryStore {
    vault: Vault,
    lock: Arc<Mutex<()>>,
}

impl MemoryStore {
    pub fn new(vault: Vault) -> Self {
        Self {
            vault,
            lock: Arc::new(Mutex::new(())),
        }
    }

    /// Dispatch a memory RPC. `session_id` is required for audit attribution.
    pub fn handle(&self, method: &str, params: &Value) -> Result<Value, VaultError> {
        let session_id = params
            .get("session_id")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .unwrap_or("agent");
        match method {
            "memory/query" => to_json(self.query(session_id, params)?),
            "memory/get" => {
                let id = required_string(params, "id")?;
                let (_, memories, _) = self.load(session_id)?;
                memories
                    .get(&id)
                    .cloned()
                    .map(|memory| json!({ "memory": memory }))
                    .ok_or_else(|| VaultError::NotFound(format!("memory not found: {id}")))
            }
            "memory/propose" => to_json(self.propose(session_id, params)?),
            "memory/confirm" => to_json(self.change_status(session_id, params, "confirmed")?),
            "memory/reject" => to_json(self.change_status(session_id, params, "rejected")?),
            "memory/tombstone" => to_json(self.change_status(session_id, params, "tombstoned")?),
            "memory/stats" => to_json(self.stats(session_id)?),
            "memory/rebuild_index" => {
                let (_, memories, malformed) = self.load(session_id)?;
                Ok(json!({
                    "rebuilt": true,
                    "items": memories.len(),
                    "malformed_events": malformed,
                    "index_version": "jsonl-v1"
                }))
            }
            _ => Err(VaultError::UnknownMethod(method.to_string())),
        }
    }

    fn query(&self, session_id: &str, params: &Value) -> Result<MemoryQueryResult, VaultError> {
        let (_, memories, _) = self.load(session_id)?;
        let query = params
            .get("query")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_lowercase();
        let scopes = string_array(params, "scopes");
        let statuses = string_array(params, "statuses");
        let source_domains = string_array(params, "source_domains");
        let limit = params
            .get("limit")
            .and_then(Value::as_u64)
            .map(|value| value as usize)
            .unwrap_or(DEFAULT_QUERY_LIMIT)
            .clamp(1, MAX_QUERY_LIMIT);
        let max_chars = params
            .get("max_chars")
            .and_then(Value::as_u64)
            .map(|value| value as usize)
            .unwrap_or(DEFAULT_MAX_CHARS)
            .clamp(256, MAX_QUERY_CHARS);

        let mut items: Vec<MemoryRecord> = memories
            .into_values()
            .filter(|memory| memory.status != "tombstoned")
            .filter(|memory| scopes.is_empty() || scopes.iter().any(|scope| scope == &memory.scope))
            .filter(|memory| {
                statuses.is_empty() || statuses.iter().any(|status| status == &memory.status)
            })
            .filter(|memory| {
                source_domains.is_empty()
                    || memory.source_refs.iter().any(|source| {
                        let domain = source.split(['/', ':']).next().unwrap_or(source);
                        source_domains.iter().any(|wanted| wanted == domain)
                    })
            })
            .filter(|memory| {
                query.is_empty()
                    || memory.text.to_lowercase().contains(&query)
                    || memory.kind.to_lowercase().contains(&query)
                    || memory.scope.to_lowercase().contains(&query)
                    || memory
                        .source_refs
                        .iter()
                        .any(|source| source.to_lowercase().contains(&query))
            })
            .collect();
        items.sort_by(|a, b| {
            b.updated_at
                .cmp(&a.updated_at)
                .then_with(|| a.id.cmp(&b.id))
        });
        let total = items.len();
        let mut used_chars = 0usize;
        items.truncate(limit);
        items.retain(|item| {
            let size = item.text.chars().count();
            if used_chars > 0 && used_chars + size > max_chars {
                return false;
            }
            used_chars += size;
            true
        });
        Ok(MemoryQueryResult {
            items,
            total,
            index_version: "jsonl-v1".to_string(),
        })
    }

    fn propose(&self, session_id: &str, params: &Value) -> Result<MemoryRecord, VaultError> {
        let text = required_string(params, "text")?;
        if text.chars().count() > MAX_QUERY_CHARS {
            return Err(VaultError::InvalidParams(
                "memory text is too long".to_string(),
            ));
        }
        let scope = params
            .get("scope")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .unwrap_or("team")
            .to_string();
        validate_scope(&scope)?;
        let sensitivity = params
            .get("sensitivity")
            .and_then(Value::as_str)
            .unwrap_or("private")
            .to_string();
        if sensitivity == "secret" {
            return Err(VaultError::InvalidParams(
                "secret data cannot be stored in Agent Team memory".to_string(),
            ));
        }
        let source_refs = string_array(params, "source_refs");
        if (scope == "user" || scope == "team" || scope.starts_with("agent:"))
            && source_refs.is_empty()
        {
            return Err(VaultError::InvalidParams(
                "shared memory requires at least one source_refs entry".to_string(),
            ));
        }
        let now = now_ms();
        let id = params
            .get("id")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| new_id("mem"));
        let record = MemoryRecord {
            id,
            scope,
            kind: params
                .get("kind")
                .and_then(Value::as_str)
                .unwrap_or("fact")
                .to_string(),
            text,
            status: "candidate".to_string(),
            sensitivity,
            confidence: params
                .get("confidence")
                .and_then(Value::as_f64)
                .unwrap_or(0.5)
                .clamp(0.0, 1.0),
            source_refs,
            created_by: Some(MemoryCreator {
                creator_type: if session_id == "user" {
                    "user"
                } else {
                    "agent"
                }
                .to_string(),
                engine: params
                    .get("engine")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                session_id: session_id.to_string(),
            }),
            valid_from: params
                .get("valid_from")
                .and_then(Value::as_str)
                .map(str::to_string),
            valid_until: params
                .get("valid_until")
                .and_then(Value::as_str)
                .map(str::to_string),
            supersedes: params
                .get("supersedes")
                .and_then(Value::as_str)
                .map(str::to_string),
            created_at: now.clone(),
            updated_at: now.clone(),
        };
        self.append(
            session_id,
            MemoryEvent {
                event_id: new_id("evt"),
                op: "upsert".to_string(),
                memory: Some(record.clone()),
                memory_id: None,
                status: None,
                ts: record.updated_at.clone(),
            },
        )?;
        Ok(record)
    }

    fn change_status(
        &self,
        session_id: &str,
        params: &Value,
        status: &str,
    ) -> Result<MemoryRecord, VaultError> {
        let id = required_string(params, "id")?;
        let _guard = self.lock.lock().unwrap();
        let (_, mut memories, _) = self.load(session_id)?;
        let record = memories
            .get_mut(&id)
            .ok_or_else(|| VaultError::NotFound(format!("memory not found: {id}")))?;
        if status == "confirmed" && record.sensitivity == "secret" {
            return Err(VaultError::InvalidParams(
                "secret memory cannot be confirmed".to_string(),
            ));
        }
        if let Some(text) = params.get("text").and_then(Value::as_str) {
            if !text.trim().is_empty() {
                record.text = text.to_string();
            }
        }
        if let Some(scope) = params.get("scope").and_then(Value::as_str) {
            validate_scope(scope)?;
            record.scope = scope.to_string();
        }
        if status == "confirmed"
            && (record.scope == "user"
                || record.scope == "team"
                || record.scope.starts_with("agent:"))
            && record.source_refs.is_empty()
        {
            return Err(VaultError::InvalidParams(
                "shared memory requires at least one source_refs entry".to_string(),
            ));
        }
        record.status = status.to_string();
        record.updated_at = now_ms();
        let updated = record.clone();
        let event = if status == "tombstoned" {
            MemoryEvent {
                event_id: new_id("evt"),
                op: "tombstone".to_string(),
                memory: None,
                memory_id: Some(updated.id.clone()),
                status: Some(status.to_string()),
                ts: updated.updated_at.clone(),
            }
        } else {
            MemoryEvent {
                event_id: new_id("evt"),
                op: "upsert".to_string(),
                memory: Some(updated.clone()),
                memory_id: None,
                status: None,
                ts: updated.updated_at.clone(),
            }
        };
        self.append_unlocked(session_id, event)?;
        Ok(updated)
    }

    fn stats(&self, session_id: &str) -> Result<MemoryStats, VaultError> {
        let (_, memories, malformed_events) = self.load(session_id)?;
        let mut by_status = BTreeMap::new();
        let mut by_scope = BTreeMap::new();
        for memory in memories.values() {
            *by_status.entry(memory.status.clone()).or_insert(0) += 1;
            *by_scope.entry(memory.scope.clone()).or_insert(0) += 1;
        }
        Ok(MemoryStats {
            total: memories.len(),
            by_status,
            by_scope,
            malformed_events,
            index_version: "jsonl-v1".to_string(),
        })
    }

    fn load(
        &self,
        session_id: &str,
    ) -> Result<(String, BTreeMap<String, MemoryRecord>, usize), VaultError> {
        let raw = match self.vault.read_file(session_id, EVENTS_PATH) {
            Ok(result) => result.content,
            Err(VaultError::NotFound(_)) => String::new(),
            Err(error) => return Err(error),
        };
        let mut memories = BTreeMap::new();
        let mut malformed = 0;
        // Keep the V0.2 MyData files visible during migration. These are
        // virtual records until a future rebuild materializes them as events;
        // event-stream records are applied afterwards and therefore win over
        // a legacy record with the same id (including tombstones).
        for memory in self.load_legacy(session_id)? {
            memories.insert(memory.id.clone(), memory);
        }
        for line in raw.lines().filter(|line| !line.trim().is_empty()) {
            let Ok(event) = serde_json::from_str::<MemoryEvent>(line) else {
                malformed += 1;
                continue;
            };
            match event.op.as_str() {
                "upsert" => {
                    if let Some(memory) = event.memory {
                        memories.insert(memory.id.clone(), memory);
                    }
                }
                "tombstone" => {
                    if let Some(id) = event.memory_id {
                        if let Some(memory) = memories.get_mut(&id) {
                            memory.status = "tombstoned".to_string();
                            memory.updated_at = event.ts;
                        }
                    }
                }
                _ => malformed += 1,
            }
        }
        Ok((raw, memories, malformed))
    }

    fn load_legacy(&self, session_id: &str) -> Result<Vec<MemoryRecord>, VaultError> {
        let mut records = Vec::new();
        if let Ok(result) = self.vault.read_file(session_id, "mydata/long_term.jsonl") {
            for (line_no, line) in result.content.lines().enumerate() {
                let Ok(value) = serde_json::from_str::<Value>(line) else {
                    continue;
                };
                let Some(text) = value
                    .get("content")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|text| !text.is_empty())
                else {
                    continue;
                };
                let legacy_id = value
                    .get("id")
                    .and_then(Value::as_str)
                    .filter(|id| !id.is_empty())
                    .map(str::to_string)
                    .unwrap_or_else(|| format!("line-{line_no}"));
                records.push(MemoryRecord {
                    id: format!("legacy_mydata_{legacy_id}"),
                    scope: "user".to_string(),
                    kind: value
                        .get("type")
                        .and_then(Value::as_str)
                        .unwrap_or("fact")
                        .to_string(),
                    text: text.to_string(),
                    status: value
                        .get("status")
                        .and_then(Value::as_str)
                        .unwrap_or("candidate")
                        .to_string(),
                    sensitivity: "private".to_string(),
                    confidence: value
                        .get("confidence")
                        .and_then(Value::as_f64)
                        .unwrap_or(0.5)
                        .clamp(0.0, 1.0),
                    source_refs: vec![format!("mydata/long_term.jsonl#{}", legacy_id)],
                    created_by: Some(MemoryCreator {
                        creator_type: "user".to_string(),
                        engine: None,
                        session_id: "migration".to_string(),
                    }),
                    valid_from: None,
                    valid_until: None,
                    supersedes: None,
                    created_at: value
                        .get("created_at")
                        .and_then(Value::as_str)
                        .unwrap_or("0")
                        .to_string(),
                    updated_at: value
                        .get("updated_at")
                        .and_then(Value::as_str)
                        .unwrap_or("0")
                        .to_string(),
                });
            }
        }
        if let Ok(result) = self.vault.read_file(session_id, "myinfo/profile.json") {
            if let Ok(value) = serde_json::from_str::<Value>(&result.content) {
                if let Some(items) = value.get("items").and_then(Value::as_array) {
                    for (index, item) in items.iter().enumerate() {
                        if item
                            .get("status")
                            .and_then(Value::as_str)
                            .unwrap_or("candidate")
                            != "confirmed"
                        {
                            continue;
                        }
                        let Some(item_value) = item.get("value") else {
                            continue;
                        };
                        let text = item_value
                            .as_str()
                            .map(str::to_string)
                            .unwrap_or_else(|| item_value.to_string());
                        if text.trim().is_empty() {
                            continue;
                        }
                        let legacy_id = item
                            .get("id")
                            .and_then(Value::as_str)
                            .filter(|id| !id.is_empty())
                            .unwrap_or("item");
                        records.push(MemoryRecord {
                            id: format!("legacy_myinfo_{legacy_id}_{index}"),
                            scope: "user".to_string(),
                            kind: item
                                .get("kind")
                                .and_then(Value::as_str)
                                .unwrap_or("preference")
                                .to_string(),
                            text,
                            status: "confirmed".to_string(),
                            sensitivity: "private".to_string(),
                            confidence: 1.0,
                            source_refs: item
                                .get("source_refs")
                                .and_then(Value::as_array)
                                .map(|refs| {
                                    refs.iter()
                                        .filter_map(Value::as_str)
                                        .map(str::to_string)
                                        .collect()
                                })
                                .unwrap_or_else(|| {
                                    vec![format!("myinfo/profile.json#{legacy_id}")]
                                }),
                            created_by: Some(MemoryCreator {
                                creator_type: "user".to_string(),
                                engine: None,
                                session_id: "migration".to_string(),
                            }),
                            valid_from: None,
                            valid_until: None,
                            supersedes: None,
                            created_at: "0".to_string(),
                            updated_at: "0".to_string(),
                        });
                    }
                }
            }
        }
        Ok(records)
    }

    fn append(&self, session_id: &str, event: MemoryEvent) -> Result<(), VaultError> {
        let _guard = self.lock.lock().unwrap();
        self.append_unlocked(session_id, event)
    }

    fn append_unlocked(&self, session_id: &str, event: MemoryEvent) -> Result<(), VaultError> {
        let raw = match self.vault.read_file(session_id, EVENTS_PATH) {
            Ok(result) => result.content,
            Err(VaultError::NotFound(_)) => String::new(),
            Err(error) => return Err(error),
        };
        let mut line = serde_json::to_string(&event).map_err(|error| {
            VaultError::InvalidParams(format!("memory event serialize failed: {error}"))
        })?;
        line.push('\n');
        self.vault
            .write_file(session_id, EVENTS_PATH, &format!("{raw}{line}"))?;
        Ok(())
    }
}

fn required_string(params: &Value, key: &str) -> Result<String, VaultError> {
    params
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| VaultError::InvalidParams(format!("{key} is required")))
}

fn to_json<T: Serialize>(value: T) -> Result<Value, VaultError> {
    serde_json::to_value(value)
        .map_err(|error| VaultError::InvalidParams(format!("serialization failed: {error}")))
}

fn string_array(params: &Value, key: &str) -> Vec<String> {
    params
        .get(key)
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn validate_scope(scope: &str) -> Result<(), VaultError> {
    let valid = matches!(scope, "user" | "team")
        || scope.starts_with("agent:")
        || scope.starts_with("session:");
    if valid && !scope.contains('/') && !scope.contains(' ') {
        Ok(())
    } else {
        Err(VaultError::InvalidParams(format!(
            "invalid memory scope: {scope}"
        )))
    }
}

fn now_ms() -> String {
    let value = time::OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000;
    value.to_string()
}

fn new_id(prefix: &str) -> String {
    let now = time::OffsetDateTime::now_utc().unix_timestamp_nanos();
    let sequence = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    format!("{prefix}_{now}_{sequence}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn store() -> (MemoryStore, tempfile::TempDir) {
        let dir = tempdir().unwrap();
        let vault = Vault::new();
        vault.set_root(dir.path()).unwrap();
        (MemoryStore::new(vault), dir)
    }

    #[test]
    fn proposes_confirms_queries_and_tombstones() {
        let (store, _dir) = store();
        let candidate = store
            .handle(
                "memory/propose",
                &json!({"session_id":"agent-tanvis","scope":"team","kind":"procedure","text":"先给建议再执行","source_refs":["mail/a.md"]}),
            )
            .unwrap();
        let id = candidate
            .get("id")
            .and_then(Value::as_str)
            .unwrap()
            .to_string();
        let pending = store
            .handle(
                "memory/query",
                &json!({"session_id":"user","statuses":["candidate"]}),
            )
            .unwrap();
        assert_eq!(pending["total"], 1);
        store
            .handle("memory/confirm", &json!({"session_id":"user","id":id}))
            .unwrap();
        let confirmed = store
            .handle(
                "memory/query",
                &json!({"session_id":"agent-2","scopes":["team"],"statuses":["confirmed"]}),
            )
            .unwrap();
        assert_eq!(confirmed["items"][0]["text"], "先给建议再执行");
        store
            .handle("memory/tombstone", &json!({"session_id":"user","id":id}))
            .unwrap();
        let after = store
            .handle("memory/query", &json!({"session_id":"user"}))
            .unwrap();
        assert_eq!(after["total"], 0);
    }

    #[test]
    fn requires_sources_for_shared_memory_and_rejects_secret() {
        let (store, _dir) = store();
        let err = store
            .handle(
                "memory/propose",
                &json!({"session_id":"agent","scope":"team","text":"无来源"}),
            )
            .unwrap_err();
        assert!(err.to_string().contains("source_refs"));
        let err = store
            .handle("memory/propose", &json!({"session_id":"user","scope":"team","text":"密码","sensitivity":"secret","source_refs":["manual"]}))
            .unwrap_err();
        assert!(err.to_string().contains("secret"));
        let candidate = store
            .handle(
                "memory/propose",
                &json!({"session_id":"agent","scope":"session:s1","text":"无来源候选"}),
            )
            .unwrap();
        let id = candidate["id"].as_str().unwrap();
        let err = store
            .handle(
                "memory/confirm",
                &json!({"session_id":"user","id":id,"scope":"team"}),
            )
            .unwrap_err();
        assert!(err.to_string().contains("source_refs"));
    }

    #[test]
    fn exposes_legacy_mydata_and_confirmed_myinfo_during_migration() {
        let (store, _dir) = store();
        store
            .vault
            .write_file(
                "migration",
                "mydata/long_term.jsonl",
                r#"{"id":"old-1","type":"preference","content":"中文回答","status":"confirmed","confidence":0.9}"#,
            )
            .unwrap();
        store
            .vault
            .write_file(
                "migration",
                "myinfo/profile.json",
                r#"{"items":[{"id":"p1","kind":"constraint","value":"不自动发送","status":"confirmed"},{"id":"p2","kind":"fact","value":"候选","status":"candidate"}]}"#,
            )
            .unwrap();
        let result = store
            .handle(
                "memory/query",
                &json!({"session_id":"user","statuses":["confirmed"]}),
            )
            .unwrap();
        assert_eq!(result["total"], 2);
        assert!(result["items"].to_string().contains("中文回答"));
        assert!(result["items"].to_string().contains("不自动发送"));
        assert!(!result["items"].to_string().contains("候选"));
    }
}
