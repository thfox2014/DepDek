//! Run-scoped read capabilities, never a raw filesystem or credential channel.
use super::*;
use std::collections::HashSet;

const LEASE_LIMIT: usize = 64;
#[derive(Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
pub enum WorkerCommand {
    #[serde(rename = "file.read")]
    Read,
    #[serde(rename = "file.list")]
    List,
    #[serde(rename = "file.stat")]
    Stat,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorkerScope {
    paths: Vec<String>,
    commands: Vec<WorkerCommand>,
    #[serde(default = "default_ttl")]
    ttl_seconds: u64,
    #[serde(default = "default_calls")]
    max_calls: usize,
}
fn default_ttl() -> u64 {
    60
}
fn default_calls() -> usize {
    8
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorkerIssue {
    session_token: SecretText,
    csrf_token: SecretText,
    workspace_id: String,
    scope: WorkerScope,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorkerRevoke {
    session_token: SecretText,
    csrf_token: SecretText,
    workspace_id: String,
    run_id: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorkerCall {
    lease_token: SecretText,
    workspace_id: String,
    run_id: String,
    call_id: String,
    command: String,
    command_version: String,
    input: Value,
}
pub(super) struct WorkerLease {
    pub(super) session_id: String,
    principal: String,
    run_id: String,
    paths: Vec<String>,
    commands: Vec<WorkerCommand>,
    expires: Instant,
    max_calls: usize,
    used: HashSet<String>,
}
fn lease_id(value: &SecretText) -> Result<String, AccessError> {
    let bytes = value.bytes();
    if bytes.len() != 67
        || !bytes.starts_with(b"wl_")
        || !bytes[3..].iter().all(u8::is_ascii_hexdigit)
    {
        return Err(AccessError::Expired);
    }
    Ok(digest(bytes))
}
pub(super) fn prune(state: &mut AccessState) {
    let live: HashSet<String> = state
        .sessions
        .iter()
        .filter(|(_, s)| !s.expired())
        .map(|(id, _)| id.clone())
        .collect();
    state
        .workers
        .retain(|_, w| w.expires > Instant::now() && live.contains(&w.session_id));
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
fn operation(
    command: &str,
    version: &str,
    input: Value,
) -> Result<(WorkerCommand, ManagedReadOperation), AccessError> {
    if version != "1.0" {
        return Err(AccessError::Unavailable);
    }
    match command {
        "file.read" => {
            let input: PathInput =
                serde_json::from_value(input).map_err(|_| AccessError::Invalid)?;
            Ok((
                WorkerCommand::Read,
                ManagedReadOperation::Read { path: input.path },
            ))
        }
        "file.stat" => {
            let input: PathInput =
                serde_json::from_value(input).map_err(|_| AccessError::Invalid)?;
            Ok((
                WorkerCommand::Stat,
                ManagedReadOperation::Stat { path: input.path },
            ))
        }
        "file.list" => {
            let input: ListInput =
                serde_json::from_value(input).map_err(|_| AccessError::Invalid)?;
            Ok((
                WorkerCommand::List,
                ManagedReadOperation::List {
                    path: input.path,
                    limit: input.limit,
                },
            ))
        }
        _ => Err(AccessError::Unavailable),
    }
}

impl ManagedReadVault {
    pub fn issue_worker(
        &self,
        request: &str,
        mut input: WorkerIssue,
    ) -> Result<Value, AccessError> {
        let mut state = self.access.lock().map_err(|_| AccessError::Unavailable)?;
        let result = (|| {
            let parent = token_id(&input.session_token)?;
            let principal = checked_session(&state, &parent, Some(&input.csrf_token))?
                .principal
                .clone();
            if input.workspace_id != self.workspace_id {
                return Err(AccessError::NotFound);
            }
            if !(1..=120).contains(&input.scope.ttl_seconds)
                || !(1..=32).contains(&input.scope.max_calls)
                || input.scope.paths.is_empty()
                || input.scope.paths.len() > 16
                || input.scope.commands.is_empty()
                || input.scope.commands.len() > 3
            {
                return Err(AccessError::Invalid);
            }
            let user = state.users.get(&principal).ok_or(AccessError::Expired)?;
            let mut paths = Vec::new();
            for path in &input.scope.paths {
                let path = self.visible_scoped(path, &user.read_paths)?;
                let file = managed_open_beneath(&self.root, &path)?;
                managed_regular_metadata(&file)?;
                paths.push(path);
            }
            paths.sort();
            paths.dedup();
            input.scope.commands.sort();
            input.scope.commands.dedup();
            prune(&mut state);
            if state.workers.len() >= LEASE_LIMIT {
                return Err(AccessError::Limited);
            }
            checked_session(&state, &parent, Some(&input.csrf_token))?;
            let raw = zeroize::Zeroizing::new(token("wl")?);
            let run_id = token("run")?;
            self.access_audit(
                request,
                &principal,
                "worker.issue",
                &Ok::<_, AccessError>(()),
            )?;
            checked_session(&state, &parent, Some(&input.csrf_token))?;
            state.workers.insert(
                digest(raw.as_bytes()),
                WorkerLease {
                    session_id: parent.clone(),
                    principal,
                    run_id: run_id.clone(),
                    paths: paths.clone(),
                    commands: input.scope.commands.clone(),
                    expires: Instant::now() + Duration::from_secs(input.scope.ttl_seconds),
                    max_calls: input.scope.max_calls,
                    used: HashSet::new(),
                },
            );
            state.sessions.get_mut(&parent).unwrap().last_seen = Instant::now();
            Ok(
                json!({"run_id":run_id,"lease_token":&*raw,"expires_in":input.scope.ttl_seconds,
                "max_calls":input.scope.max_calls,"commands":input.scope.commands,"paths":paths,
                "purpose":"file-query","policy_revision":1}),
            )
        })();
        if result.is_err() {
            self.access_audit(request, &self.principal_id, "worker.issue.denied", &result)?;
        }
        result
    }

    pub fn revoke_worker(&self, request: &str, input: WorkerRevoke) -> Result<Value, AccessError> {
        let mut state = self.access.lock().map_err(|_| AccessError::Unavailable)?;
        let result = (|| {
            let parent = token_id(&input.session_token)?;
            checked_session(&state, &parent, Some(&input.csrf_token))?;
            if input.workspace_id != self.workspace_id {
                return Err(AccessError::NotFound);
            }
            let id = state
                .workers
                .iter()
                .find(|(_, w)| w.session_id == parent && w.run_id == input.run_id)
                .map(|(id, _)| id.clone())
                .ok_or(AccessError::NotFound)?;
            // Revocation is effective even if reporting its audit subsequently fails.
            state.workers.remove(&id);
            Ok(json!({"revoked":true}))
        })();
        self.access_audit(request, &self.principal_id, "worker.revoke", &result)?;
        result
    }

    pub fn worker_read(&self, request: &str, input: WorkerCall) -> Result<Value, AccessError> {
        // Same mutex as logout and explicit revocation: no late release after either returns.
        let mut state = self.access.lock().map_err(|_| AccessError::Unavailable)?;
        let result = (|| {
            let id = lease_id(&input.lease_token)?;
            let lease = state.workers.get(&id).ok_or(AccessError::Expired)?;
            checked_session(&state, &lease.session_id, None)?;
            if lease.expires <= Instant::now() {
                return Err(AccessError::Expired);
            }
            if input.workspace_id != self.workspace_id || input.run_id != lease.run_id {
                return Err(AccessError::NotFound);
            }
            if !managed_id(&input.call_id) {
                return Err(AccessError::Invalid);
            }
            if lease.used.contains(&input.call_id) {
                return Err(AccessError::Conflict);
            }
            if lease.used.len() >= lease.max_calls {
                return Err(AccessError::Limited);
            }
            let principal = lease.principal.clone();
            let session_id = lease.session_id.clone();
            let paths = lease.paths.clone();
            let commands = lease.commands.clone();
            self.access_audit(
                request,
                &principal,
                "worker.invoke.intent",
                &Ok::<_, AccessError>(()),
            )?;
            state
                .workers
                .get_mut(&id)
                .unwrap()
                .used
                .insert(input.call_id);
            let (command, operation) =
                operation(&input.command, &input.command_version, input.input)?;
            if !commands.contains(&command) {
                return Err(AccessError::Forbidden);
            }
            // Revalidate the parent policy in addition to the attenuated lease scope.
            let user = state.users.get(&principal).ok_or(AccessError::Expired)?;
            let target = match &operation {
                ManagedReadOperation::Read { path }
                | ManagedReadOperation::Stat { path }
                | ManagedReadOperation::List { path, .. } => path,
            };
            self.visible_scoped(target, &user.read_paths)?;
            checked_session(&state, &session_id, None)?;
            if state.workers.get(&id).ok_or(AccessError::Expired)?.expires <= Instant::now() {
                return Err(AccessError::Expired);
            }
            let authority = ReadAuthority::new(&principal, &self.workspace_id, 1, request);
            let value = self.execute_scoped(&authority, operation, &paths, true)?;
            self.access_audit(
                request,
                &principal,
                "worker.invoke.complete",
                &Ok::<_, AccessError>(()),
            )?;
            checked_session(&state, &session_id, None)?;
            let lease = state.workers.get(&id).ok_or(AccessError::Expired)?;
            if lease.expires <= Instant::now() {
                return Err(AccessError::Expired);
            }
            Ok(
                json!({"status":"completed","result":value,"remaining_calls":lease.max_calls-lease.used.len(),"freshness":"live"}),
            )
        })();
        if result.is_err() {
            self.access_audit(request, &self.principal_id, "worker.invoke.denied", &result)?;
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, OnceLock};
    const PASSWORD: &str = "SYNTHETIC_WORKER_BUSINESS_PASSWORD";
    fn fixture() -> (tempfile::TempDir, ManagedReadVault, Value) {
        let root = tempfile::tempdir().unwrap();
        for dir in [
            "documents/alice/work",
            "documents/alice/other",
            "documents/bob",
        ] {
            fs::create_dir_all(root.path().join(dir)).unwrap();
            fs::write(
                root.path().join(dir).join("a.md"),
                format!("evidence:{dir}"),
            )
            .unwrap();
        }
        let vault =
            ManagedReadVault::open(root.path(), "w1", "local:test", &["documents".into()]).unwrap();
        static HASH: OnceLock<String> = OnceLock::new();
        let hash = HASH
            .get_or_init(|| hash_business_password(SecretText::new(PASSWORD.into())).unwrap())
            .clone();
        vault
            .configure_access(vec![AccessUser {
                principal_id: "alice".into(),
                password_hash: hash,
                read_paths: vec!["documents/alice".into()],
            }])
            .unwrap();
        let session = vault
            .login_business(
                "login-worker",
                LoginInput {
                    username: "alice".into(),
                    password: SecretText::new(PASSWORD.into()),
                },
            )
            .unwrap();
        (root, vault, session)
    }
    fn issue(vault: &ManagedReadVault, session: &Value, max_calls: usize) -> Value {
        vault.issue_worker("issue-worker", serde_json::from_value(json!({"session_token":session["session_token"],"csrf_token":session["csrf_token"],"workspace_id":"w1","scope":{"paths":["documents/alice/work"],"commands":["file.read"],"max_calls":max_calls}})).unwrap()).unwrap()
    }
    fn call(lease: &Value, id: &str, path: &str) -> WorkerCall {
        serde_json::from_value(json!({"lease_token":lease["lease_token"],"workspace_id":"w1","run_id":lease["run_id"],"call_id":id,"command":"file.read","command_version":"1.0","input":{"path":path}})).unwrap()
    }
    #[test]
    fn attenuated_scope_commands_aliases_and_replay_are_enforced() {
        let (root, vault, session) = fixture();
        let lease = issue(&vault, &session, 12);
        let response = vault
            .worker_read("worker-1", call(&lease, "one", "documents/alice/work/a.md"))
            .unwrap();
        assert_eq!(
            response["result"]["content"],
            "evidence:documents/alice/work"
        );
        assert_eq!(response["remaining_calls"], 11);
        assert!(matches!(
            vault.worker_read(
                "worker-replay",
                call(&lease, "one", "documents/alice/work/a.md")
            ),
            Err(AccessError::Conflict)
        ));
        for (index, path) in [
            "documents/alice/other/a.md",
            "documents/bob/a.md",
            "documents",
            "../outside",
            "/etc/passwd",
            "documents/alice/work/accounts.json",
        ]
        .iter()
        .enumerate()
        {
            assert!(matches!(
                vault.worker_read(
                    "worker-denied",
                    call(&lease, &format!("deny-{index}"), path)
                ),
                Err(AccessError::NotFound)
            ));
        }
        let target = root.path().join("documents/alice/other/a.md");
        std::os::unix::fs::symlink(&target, root.path().join("documents/alice/work/symlink.md"))
            .unwrap();
        fs::hard_link(target, root.path().join("documents/alice/work/hardlink.md")).unwrap();
        for (id, path) in [
            ("symlink", "documents/alice/work/symlink.md"),
            ("hardlink", "documents/alice/work/hardlink.md"),
        ] {
            assert!(matches!(
                vault.worker_read("worker-alias", call(&lease, id, path)),
                Err(AccessError::NotFound)
            ));
        }
        let mut denied = call(&lease, "wrong-command", "documents/alice/work/a.md");
        denied.command = "file.stat".into();
        assert!(matches!(
            vault.worker_read("command-denied", denied),
            Err(AccessError::Forbidden)
        ));
        let mut denied = call(&lease, "write-command", "documents/alice/work/a.md");
        denied.command = "file.delete".into();
        assert!(matches!(
            vault.worker_read("write-denied", denied),
            Err(AccessError::Unavailable)
        ));
        assert!(root.path().join("documents/alice/work/a.md").exists());
        let text = fs::read_to_string(root.path().join(AUDIT_FILE_NAME)).unwrap();
        for secret in [
            PASSWORD,
            session["session_token"].as_str().unwrap(),
            session["csrf_token"].as_str().unwrap(),
            lease["lease_token"].as_str().unwrap(),
            "evidence:documents",
        ] {
            assert!(!text.contains(secret));
        }
    }
    #[test]
    fn scope_escalation_bounds_wrong_csrf_workspace_and_run_are_refused() {
        let (_root, vault, session) = fixture();
        for path in ["documents", "documents/bob", ".", "/tmp", "../documents"] {
            let input = json!({"session_token":session["session_token"],"csrf_token":session["csrf_token"],"workspace_id":"w1","scope":{"paths":[path],"commands":["file.read"]}});
            assert!(vault
                .issue_worker("escalate", serde_json::from_value(input).unwrap())
                .is_err());
        }
        for (ttl, calls) in [(0, 1), (121, 1), (1, 0), (1, 33)] {
            let input = json!({"session_token":session["session_token"],"csrf_token":session["csrf_token"],"workspace_id":"w1","scope":{"paths":["documents/alice/work"],"commands":["file.read"],"ttl_seconds":ttl,"max_calls":calls}});
            assert!(matches!(
                vault.issue_worker("budget", serde_json::from_value(input).unwrap()),
                Err(AccessError::Invalid)
            ));
        }
        let lease = issue(&vault, &session, 2);
        let mut wrong = call(&lease, "wrong-run", "documents/alice/work/a.md");
        wrong.run_id = "claimed-agent-run".into();
        assert!(matches!(
            vault.worker_read("wrong-run", wrong),
            Err(AccessError::NotFound)
        ));
        let mut wrong = call(&lease, "wrong-space", "documents/alice/work/a.md");
        wrong.workspace_id = "w2".into();
        assert!(matches!(
            vault.worker_read("wrong-space", wrong),
            Err(AccessError::NotFound)
        ));
        let bad = json!({"session_token":session["session_token"],"csrf_token":"WRONG_SYNTHETIC_CSRF","workspace_id":"w1","scope":{"paths":["documents/alice/work"],"commands":["file.read"]}});
        assert!(matches!(
            vault.issue_worker("csrf", serde_json::from_value(bad).unwrap()),
            Err(AccessError::Forbidden)
        ));
    }
    #[test]
    fn explicit_revoke_logout_parent_expiry_and_lease_expiry_stop_reads() {
        let (_root, vault, session) = fixture();
        let lease = issue(&vault, &session, 8);
        vault.revoke_worker("revoke",serde_json::from_value(json!({"session_token":session["session_token"],"csrf_token":session["csrf_token"],"workspace_id":"w1","run_id":lease["run_id"]})).unwrap()).unwrap();
        assert!(matches!(
            vault.worker_read("revoked", call(&lease, "one", "documents/alice/work/a.md")),
            Err(AccessError::Expired)
        ));
        let lease = issue(&vault, &session, 8);
        let id = digest(lease["lease_token"].as_str().unwrap().as_bytes());
        vault
            .access
            .lock()
            .unwrap()
            .workers
            .get_mut(&id)
            .unwrap()
            .expires = Instant::now();
        assert!(matches!(
            vault.worker_read("expired", call(&lease, "one", "documents/alice/work/a.md")),
            Err(AccessError::Expired)
        ));
        let lease = issue(&vault, &session, 8);
        let parent = digest(session["session_token"].as_str().unwrap().as_bytes());
        vault
            .access
            .lock()
            .unwrap()
            .sessions
            .get_mut(&parent)
            .unwrap()
            .last_seen = Instant::now() - Duration::from_secs(IDLE_TTL + 1);
        assert!(matches!(
            vault.worker_read(
                "parent-expired",
                call(&lease, "one", "documents/alice/work/a.md")
            ),
            Err(AccessError::Expired)
        ));
        let session = vault
            .login_business(
                "relogin",
                LoginInput {
                    username: "alice".into(),
                    password: SecretText::new(PASSWORD.into()),
                },
            )
            .unwrap();
        let lease = issue(&vault, &session, 8);
        let token = SecretText::new(session["session_token"].as_str().unwrap().into());
        let csrf = SecretText::new(session["csrf_token"].as_str().unwrap().into());
        vault
            .business_session("logout", &token, Some(&csrf), true)
            .unwrap();
        assert!(matches!(
            vault.worker_read(
                "logged-out",
                call(&lease, "one", "documents/alice/work/a.md")
            ),
            Err(AccessError::Expired)
        ));
    }
    #[test]
    fn concurrent_calls_cannot_overrun_quota_and_worker_does_not_refresh_parent() {
        let (_root, vault, session) = fixture();
        let lease = issue(&vault, &session, 1);
        let parent = digest(session["session_token"].as_str().unwrap().as_bytes());
        let seen = vault.access.lock().unwrap().sessions[&parent].last_seen;
        let vault = Arc::new(vault);
        let successes = std::thread::scope(|scope| {
            let handles: Vec<_> = (0..4)
                .map(|index| {
                    let vault = &vault;
                    let lease = &lease;
                    scope.spawn(move || {
                        vault.worker_read(
                            "parallel",
                            call(lease, &format!("call-{index}"), "documents/alice/work/a.md"),
                        )
                    })
                })
                .collect();
            handles
                .into_iter()
                .map(|h| h.join().unwrap())
                .filter(Result::is_ok)
                .count()
        });
        assert_eq!(successes, 1);
        assert_eq!(
            vault.access.lock().unwrap().sessions[&parent].last_seen,
            seen
        );
    }
    #[test]
    fn failing_audit_does_not_issue_token_or_release_worker_content() {
        let (root, vault, session) = fixture();
        let lease = issue(&vault, &session, 1);
        vault.audit.set_file(
            root.path().join(AUDIT_FILE_NAME),
            fs::File::open(root.path().join(AUDIT_FILE_NAME)).unwrap(),
        );
        assert!(matches!(
            vault.worker_read(
                "audit-failed",
                call(&lease, "one", "documents/alice/work/a.md")
            ),
            Err(AccessError::Audit)
        ));
        let input = serde_json::from_value(json!({"session_token":session["session_token"],"csrf_token":session["csrf_token"],"workspace_id":"w1","scope":{"paths":["documents/alice/work"],"commands":["file.read"]}})).unwrap();
        assert!(matches!(
            vault.issue_worker("issue-audit-failed", input),
            Err(AccessError::Audit)
        ));
        assert_eq!(vault.access.lock().unwrap().workers.len(), 1);
    }
    #[test]
    fn expiry_during_durable_audit_does_not_revive_parent_or_release_content() {
        let (_root, vault, session) = fixture();
        let parent = digest(session["session_token"].as_str().unwrap().as_bytes());
        vault
            .access
            .lock()
            .unwrap()
            .sessions
            .get_mut(&parent)
            .unwrap()
            .last_seen =
            Instant::now() - Duration::from_secs(IDLE_TTL) + Duration::from_millis(500);
        vault.audit.add_listener(Arc::new(|entry| {
            if entry.path == "worker.issue" {
                std::thread::sleep(Duration::from_secs(1));
            }
        }));
        let input = serde_json::from_value(json!({"session_token":session["session_token"],"csrf_token":session["csrf_token"],"workspace_id":"w1","scope":{"paths":["documents/alice/work"],"commands":["file.read"]}})).unwrap();
        assert!(matches!(
            vault.issue_worker("late-issue", input),
            Err(AccessError::Expired)
        ));
        assert!(vault.access.lock().unwrap().workers.is_empty());
        let (_root, vault, session) = fixture();
        let lease = issue(&vault, &session, 1);
        let id = digest(lease["lease_token"].as_str().unwrap().as_bytes());
        vault
            .access
            .lock()
            .unwrap()
            .workers
            .get_mut(&id)
            .unwrap()
            .expires = Instant::now() + Duration::from_secs(1);
        vault.audit.add_listener(Arc::new(|entry| {
            if entry.path == "documents/alice/work/a.md" {
                std::thread::sleep(Duration::from_secs(1));
            }
        }));
        assert!(matches!(
            vault.worker_read(
                "late-read",
                call(&lease, "one", "documents/alice/work/a.md")
            ),
            Err(AccessError::Expired)
        ));
    }
}
