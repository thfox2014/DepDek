//! One-shot exact-text authorization, local-only bounded model exchange.
use super::*;
use crate::secrets::{wipe_json, SecretStore};
use crate::vault::{ProviderProfiles, ProviderRegistration};
use std::io::Read;
use std::net::IpAddr;
use zeroize::Zeroizing;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ModelIssue {
    session_token: SecretText,
    csrf_token: SecretText,
    workspace_id: String,
    provider_id: String,
    profile_revision: u64,
    prompt: SecretText,
    max_tokens: u32,
    ttl_seconds: u64,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::secrets::{CredentialBinding, InitializeStore, PutCredential, SecretOperation};
    use std::io::Write;
    use std::net::TcpListener;
    use std::sync::{mpsc, Arc, OnceLock};
    const PASSWORD: &str = "SYNTHETIC_GATEWAY_PASSWORD";
    const KEY: &str = "synthetic-gateway-only-key";
    const PROMPT: &str = "整理维修材料 forms@support.example.invalid";
    struct Fixture {
        temp: tempfile::TempDir,
        vault: ManagedReadVault,
        store: SecretStore,
        profiles: ProviderProfiles,
        session: Value,
    }
    fn fixture(base: String) -> Fixture {
        use std::os::unix::fs::PermissionsExt;
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("data");
        let secrets = temp.path().join("private");
        fs::create_dir_all(root.join("documents/alice")).unwrap();
        fs::create_dir(&secrets).unwrap();
        fs::set_permissions(&secrets, fs::Permissions::from_mode(0o700)).unwrap();
        let vault =
            ManagedReadVault::open(&root, "w1", "local:test", &["documents".into()]).unwrap();
        static HASH: OnceLock<String> = OnceLock::new();
        vault
            .configure_access(vec![AccessUser {
                principal_id: "alice".into(),
                password_hash: HASH
                    .get_or_init(|| {
                        hash_business_password(SecretText::new(PASSWORD.into())).unwrap()
                    })
                    .clone(),
                read_paths: vec!["documents/alice".into()],
            }])
            .unwrap();
        let session = vault
            .login_business(
                "login",
                LoginInput {
                    username: "alice".into(),
                    password: SecretText::new(PASSWORD.into()),
                },
            )
            .unwrap();
        let store = SecretStore::new(vault.open_secret_files(&secrets).unwrap(), "w1".into());
        let auth = ReadAuthority::new("local:test", "w1", 1, "setup");
        store
            .execute(
                &auth,
                SecretOperation::Initialize(InitializeStore {
                    operation_id: "init".into(),
                    passphrase: SecretText::new("SyntheticGatewayStore2026!".into()),
                }),
            )
            .unwrap();
        let receipt = store
            .execute(
                &auth,
                SecretOperation::Put(PutCredential {
                    operation_id: "put".into(),
                    binding: binding(),
                    expected_revision: 0,
                    secret: SecretText::new(KEY.into()),
                }),
            )
            .unwrap();
        let profiles = vault.register_provider_profiles(vec![serde_json::from_value(json!({"id":"local-test","name":"Local test","base_url":base,"protocol":"openai-completions","model":"synthetic-model","profile_revision":1,"credential_ref":receipt["credential"]["credential_ref"],"credential_revision":1,"credential_binding":binding()})).unwrap()]).unwrap();
        Fixture {
            temp,
            vault,
            store,
            profiles,
            session,
        }
    }
    fn binding() -> CredentialBinding {
        serde_json::from_value(
            json!({"kind":"provider","account_id":"local-test","field":"api_key"}),
        )
        .unwrap()
    }
    fn issue_input(f: &Fixture, ttl: u64) -> ModelIssue {
        serde_json::from_value(json!({"session_token":f.session["session_token"],"csrf_token":f.session["csrf_token"],"workspace_id":"w1","provider_id":"local-test","profile_revision":1,"prompt":PROMPT,"max_tokens":128,"ttl_seconds":ttl})).unwrap()
    }
    fn issue(f: &Fixture, ttl: u64) -> Value {
        f.vault
            .issue_model(
                "issue",
                issue_input(f, ttl),
                &f.profiles,
                &["local-test".into()],
            )
            .unwrap()
    }
    fn call(lease: &Value) -> ModelCall {
        serde_json::from_value(json!({"lease_token":lease["lease_token"],"workspace_id":"w1","run_id":lease["run_id"],"call_id":"call-one"})).unwrap()
    }
    fn read_request(stream: &mut std::net::TcpStream) -> Value {
        stream
            .set_read_timeout(Some(Duration::from_secs(4)))
            .unwrap();
        let mut bytes = Vec::new();
        let mut b = [0u8; 1];
        while !bytes.ends_with(b"\r\n\r\n") {
            stream.read_exact(&mut b).unwrap();
            bytes.push(b[0]);
            assert!(bytes.len() < 8192);
        }
        let header = String::from_utf8(bytes).unwrap();
        assert!(header.starts_with("POST /v1/chat/completions HTTP/1.1"));
        assert!(header.contains(&format!("Bearer {KEY}")));
        let n: usize = header
            .lines()
            .find_map(|line| {
                line.to_lowercase()
                    .strip_prefix("content-length: ")
                    .map(str::to_owned)
            })
            .unwrap()
            .parse()
            .unwrap();
        assert!(n < 20_000);
        let mut body = vec![0; n];
        stream.read_exact(&mut body).unwrap();
        serde_json::from_slice(&body).unwrap()
    }
    fn respond(stream: &mut std::net::TcpStream, value: Value) {
        let body = value.to_string();
        write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",body.len()).unwrap();
        // Real multibyte byte-splitting, not a mock function result.
        for b in body.bytes() {
            stream.write_all(&[b]).unwrap();
        }
    }
    #[test]
    fn exact_context_one_shot_unicode_usage_and_no_secret_output() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let f = fixture(format!("http://{}/v1", listener.local_addr().unwrap()));
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let body = read_request(&mut stream);
            assert_eq!(
                body,
                json!({"model":"synthetic-model","messages":[{"role":"user","content":PROMPT}],"stream":false,"max_tokens":128})
            );
            respond(
                &mut stream,
                json!({"choices":[{"message":{"content":"材料已整理：forms@support.example.invalid"}}],"usage":{"prompt_tokens":20,"completion_tokens":8},"ignored_key":KEY}),
            );
        });
        let lease = issue(&f, 30);
        let result = f
            .vault
            .invoke_model("invoke", call(&lease), &f.store)
            .unwrap();
        assert_eq!(
            result["result"]["text"],
            "材料已整理：forms@support.example.invalid"
        );
        assert_eq!(
            result["result"]["usage"],
            json!({"input_tokens":20,"output_tokens":8})
        );
        assert!(matches!(
            f.vault.invoke_model("replay", call(&lease), &f.store),
            Err(AccessError::Conflict)
        ));
        server.join().unwrap();
        for content in [
            result.to_string(),
            fs::read_to_string(f.temp.path().join("data/.vault-audit.jsonl")).unwrap(),
            fs::read_to_string(f.temp.path().join("private/.secret-audit.jsonl")).unwrap(),
        ] {
            for secret in [
                KEY,
                PROMPT,
                PASSWORD,
                lease["lease_token"].as_str().unwrap(),
            ] {
                assert!(!content.contains(secret));
            }
        }
    }
    #[test]
    fn locked_store_denies_and_consumes_without_network() {
        let f = fixture("http://127.0.0.1:9/v1".into());
        let lease = issue(&f, 30);
        f.store
            .execute(
                &ReadAuthority::new("local:test", "w1", 1, "lock"),
                SecretOperation::Lock,
            )
            .unwrap();
        assert!(matches!(
            f.vault.invoke_model("locked", call(&lease), &f.store),
            Err(AccessError::Credential(crate::secrets::SecretError::Locked))
        ));
        assert!(matches!(
            f.vault.invoke_model("replay", call(&lease), &f.store),
            Err(AccessError::Conflict)
        ));
    }
    #[test]
    fn endpoint_scope_shape_expiry_logout_and_revoke() {
        let f = fixture("http://127.0.0.1:9/v1".into());
        for base in [
            "https://example.invalid/v1",
            "http://localhost:1234/v1",
            "http://127.0.0.1:1234/private",
            "http://127.0.0.1:1234/v1?key=secret",
        ] {
            let mut p = f.profiles.0[0].clone();
            p.base_url = base.into();
            assert!(endpoint(&p).is_err());
        }
        assert!(f
            .vault
            .issue_model("disabled", issue_input(&f, 30), &f.profiles, &[])
            .is_err());
        let mut input = issue_input(&f, 30);
        input.csrf_token = SecretText::new("forged".into());
        assert!(f
            .vault
            .issue_model("csrf", input, &f.profiles, &["local-test".into()])
            .is_err());
        let lease = issue(&f, 30);
        let mut expanded = json!({"lease_token":lease["lease_token"],"workspace_id":"w1","run_id":lease["run_id"],"call_id":"x","prompt":"expand"});
        assert!(serde_json::from_value::<ModelCall>(expanded.take()).is_err());
        f.vault.revoke_model("revoke",serde_json::from_value(json!({"session_token":f.session["session_token"],"csrf_token":f.session["csrf_token"],"workspace_id":"w1","run_id":lease["run_id"]})).unwrap()).unwrap();
        assert!(matches!(
            f.vault.invoke_model("revoked", call(&lease), &f.store),
            Err(AccessError::Expired)
        ));
        let lease = issue(&f, 30);
        let id = digest(lease["lease_token"].as_str().unwrap().as_bytes());
        f.vault
            .access
            .lock()
            .unwrap()
            .models
            .get_mut(&id)
            .unwrap()
            .expires = Instant::now();
        assert!(matches!(
            f.vault.invoke_model("expired", call(&lease), &f.store),
            Err(AccessError::Expired)
        ));
        f.vault.expire_delegations();
        assert!(!f.vault.access.lock().unwrap().models.contains_key(&id));
        let lease = issue(&f, 30);
        f.vault
            .business_session(
                "logout",
                &SecretText::new(f.session["session_token"].as_str().unwrap().into()),
                Some(&SecretText::new(
                    f.session["csrf_token"].as_str().unwrap().into(),
                )),
                true,
            )
            .unwrap();
        assert!(matches!(
            f.vault
                .invoke_model("logout-denied", call(&lease), &f.store),
            Err(AccessError::Expired)
        ));
    }
    #[test]
    fn failed_connection_and_reflected_key_are_never_retried_or_released() {
        let f = fixture("http://127.0.0.1:9/v1".into());
        let lease = issue(&f, 30);
        assert!(matches!(
            f.vault.invoke_model("no-server", call(&lease), &f.store),
            Err(AccessError::ModelUnknown)
        ));
        assert!(matches!(
            f.vault.invoke_model("retry", call(&lease), &f.store),
            Err(AccessError::Conflict)
        ));
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let f = fixture(format!("http://{}/v1", listener.local_addr().unwrap()));
        let server = std::thread::spawn(move || {
            let (mut s, _) = listener.accept().unwrap();
            read_request(&mut s);
            respond(&mut s, json!({"choices":[{"message":{"content":KEY}}]}));
        });
        assert!(matches!(
            f.vault
                .invoke_model("reflected", call(&issue(&f, 30)), &f.store),
            Err(AccessError::ModelUnknown)
        ));
        server.join().unwrap();
    }
    #[test]
    fn rotation_drains_inflight_use_and_old_revision_fails() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let f = Arc::new(fixture(format!(
            "http://{}/v1",
            listener.local_addr().unwrap()
        )));
        let (started_tx, started_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let server = std::thread::spawn(move || {
            let (mut s, _) = listener.accept().unwrap();
            read_request(&mut s);
            started_tx.send(()).unwrap();
            release_rx.recv_timeout(Duration::from_secs(3)).unwrap();
            respond(&mut s, json!({"choices":[{"message":{"content":"done"}}]}));
        });
        let lease = issue(&f, 30);
        let fc = f.clone();
        let invoke =
            std::thread::spawn(move || fc.vault.invoke_model("inflight", call(&lease), &fc.store));
        started_rx.recv_timeout(Duration::from_secs(4)).unwrap();
        let (done_tx, done_rx) = mpsc::channel();
        let fc = f.clone();
        let rotation = std::thread::spawn(move || {
            let result = fc.store.execute(
                &ReadAuthority::new("local:test", "w1", 1, "rotate"),
                SecretOperation::Put(PutCredential {
                    operation_id: "rotate".into(),
                    binding: binding(),
                    expected_revision: 1,
                    secret: SecretText::new("new-synthetic-key".into()),
                }),
            );
            done_tx.send(()).unwrap();
            result
        });
        assert!(done_rx.recv_timeout(Duration::from_millis(100)).is_err());
        release_tx.send(()).unwrap();
        assert!(invoke.join().unwrap().is_ok());
        assert!(rotation.join().unwrap().is_ok());
        server.join().unwrap();
        assert!(matches!(
            f.vault
                .invoke_model("old-revision", call(&issue(&f, 30)), &f.store),
            Err(AccessError::Credential(
                crate::secrets::SecretError::Conflict
            ))
        ));
    }
    #[test]
    fn audit_failure_never_issues_or_releases_and_late_result_is_withheld() {
        let f = fixture("http://127.0.0.1:9/v1".into());
        f.vault.audit.set_file(
            f.temp.path().join("data/.vault-audit.jsonl"),
            fs::File::open(f.temp.path().join("data/.vault-audit.jsonl")).unwrap(),
        );
        assert!(matches!(
            f.vault.issue_model(
                "audit-fail",
                issue_input(&f, 30),
                &f.profiles,
                &["local-test".into()]
            ),
            Err(AccessError::Audit)
        ));
        assert!(f.vault.access.lock().unwrap().models.is_empty());
        let f = fixture("http://127.0.0.1:9/v1".into());
        let parent = digest(f.session["session_token"].as_str().unwrap().as_bytes());
        f.vault
            .access
            .lock()
            .unwrap()
            .sessions
            .get_mut(&parent)
            .unwrap()
            .last_seen =
            Instant::now() - Duration::from_secs(IDLE_TTL) + Duration::from_millis(500);
        f.vault.audit.add_listener(Arc::new(|entry| {
            if entry.path == "model.issue" {
                std::thread::sleep(Duration::from_secs(1));
            }
        }));
        assert!(matches!(
            f.vault.issue_model(
                "late-issue",
                issue_input(&f, 30),
                &f.profiles,
                &["local-test".into()]
            ),
            Err(AccessError::Expired)
        ));
        assert!(f.vault.access.lock().unwrap().models.is_empty());
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let f = fixture(format!("http://{}/v1", listener.local_addr().unwrap()));
        let server = std::thread::spawn(move || {
            let (mut s, _) = listener.accept().unwrap();
            read_request(&mut s);
            std::thread::sleep(Duration::from_millis(1200));
            respond(
                &mut s,
                json!({"choices":[{"message":{"content":"must-withhold"}}]}),
            );
        });
        let lease = issue(&f, 1);
        assert!(matches!(
            f.vault.invoke_model("late", call(&lease), &f.store),
            Err(AccessError::Expired)
        ));
        server.join().unwrap();
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ModelRevoke {
    session_token: SecretText,
    csrf_token: SecretText,
    workspace_id: String,
    run_id: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ModelCall {
    lease_token: SecretText,
    workspace_id: String,
    run_id: String,
    call_id: String,
}
pub(super) struct ModelLease {
    pub(super) session_id: String,
    principal: String,
    run_id: String,
    profile: ProviderRegistration,
    prompt: SecretText,
    max_tokens: u32,
    expires: Instant,
    used: bool,
}

fn endpoint(profile: &ProviderRegistration) -> Result<url::Url, AccessError> {
    let mut url = url::Url::parse(&profile.base_url).map_err(|_| AccessError::Invalid)?;
    let host = url.host_str().ok_or(AccessError::Invalid)?;
    let ip: IpAddr = host
        .trim_matches(['[', ']'])
        .parse()
        .map_err(|_| AccessError::Invalid)?;
    if !ip.is_loopback()
        || url.scheme() != "http"
        || url.port().is_none()
        || url.path() != "/v1"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(AccessError::Invalid);
    }
    url.set_path("/v1/chat/completions");
    Ok(url)
}

fn exchange(
    profile: &ProviderRegistration,
    prompt: &SecretText,
    max_tokens: u32,
    key: &SecretText,
) -> Result<Value, AccessError> {
    let endpoint = endpoint(profile)?;
    let client = reqwest::blocking::Client::builder()
        .no_proxy()
        .retry(reqwest::retry::never())
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(1))
        .timeout(Duration::from_secs(3))
        .build()
        .map_err(|_| AccessError::ModelUnknown)?;
    let raw_key = std::str::from_utf8(key.bytes()).map_err(|_| AccessError::Invalid)?;
    if raw_key.is_empty() || raw_key.len() > 512 || !raw_key.bytes().all(|b| b.is_ascii_graphic()) {
        return Err(AccessError::Invalid);
    }
    let authorization = Zeroizing::new(format!("Bearer {raw_key}"));
    let mut header =
        reqwest::header::HeaderValue::from_str(&authorization).map_err(|_| AccessError::Invalid)?;
    header.set_sensitive(true);
    let prompt = std::str::from_utf8(prompt.bytes()).map_err(|_| AccessError::Invalid)?;
    let mut body = json!({"model":profile.model,"messages":[{"role":"user","content":prompt}],"stream":false,"max_tokens":max_tokens});
    let encoded = serde_json::to_vec(&body).map_err(|_| AccessError::Invalid);
    wipe_json(&mut body);
    let encoded = Zeroizing::new(encoded?);
    let response = client
        .post(endpoint)
        .header(reqwest::header::AUTHORIZATION, header)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(encoded.to_vec())
        .send()
        .map_err(|_| AccessError::ModelUnknown)?;
    if !response.status().is_success() {
        return Err(AccessError::ModelUnknown);
    }
    const LIMIT: usize = 64 * 1024;
    if response.content_length().is_some_and(|n| n > LIMIT as u64) {
        return Err(AccessError::ModelUnknown);
    }
    let mut bytes = Zeroizing::new(Vec::new());
    response
        .take((LIMIT + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| AccessError::ModelUnknown)?;
    if bytes.len() > LIMIT {
        return Err(AccessError::ModelUnknown);
    }
    let mut value: Value = serde_json::from_slice(&bytes).map_err(|_| AccessError::ModelUnknown)?;
    let result = (|| {
        // Do not forward arbitrary provider fields, reasoning, tools, headers or errors.
        let text = value["choices"][0]["message"]["content"]
            .as_str()
            .ok_or(AccessError::ModelUnknown)?;
        if text.len() > 16 * 1024
            || text.contains(raw_key)
            || !value["choices"][0]["message"]["tool_calls"].is_null()
        {
            return Err(AccessError::ModelUnknown);
        }
        let usage = if let (Some(input), Some(output)) = (
            value["usage"]["prompt_tokens"].as_u64(),
            value["usage"]["completion_tokens"].as_u64(),
        ) {
            if output > max_tokens as u64 || input > 1_000_000 {
                return Err(AccessError::ModelUnknown);
            }
            json!({"input_tokens":input,"output_tokens":output})
        } else {
            Value::Null
        };
        Ok(
            json!({"text":text,"usage":usage,"provider_id":profile.id,"model":profile.model,"profile_revision":profile.profile_revision,"source":"local-provider","engine":null}),
        )
    })();
    wipe_json(&mut value);
    result
}

impl ManagedReadVault {
    /// Drop expired in-memory prompt capabilities without extending sessions.
    /// Busy in-flight use is already deadline checked; a later timer prunes it.
    pub fn expire_delegations(&self) {
        if let Ok(mut state) = self.access.try_lock() {
            let live: std::collections::HashSet<_> = state
                .sessions
                .iter()
                .filter(|(_, session)| !session.expired())
                .map(|(id, _)| id.clone())
                .collect();
            state.models.retain(|_, lease| {
                lease.expires > Instant::now() && live.contains(&lease.session_id)
            });
            workers::prune(&mut state);
        }
    }
    pub fn validate_local_model_profiles(
        &self,
        profiles: &ProviderProfiles,
        ids: &[String],
    ) -> Result<(), AccessError> {
        let result = (|| {
            if ids.len() > 8 {
                return Err(AccessError::Invalid);
            }
            let mut unique = std::collections::HashSet::new();
            for id in ids {
                if !unique.insert(id) {
                    return Err(AccessError::Invalid);
                }
                endpoint(
                    profiles
                        .0
                        .iter()
                        .find(|p| p.id == *id)
                        .ok_or(AccessError::Invalid)?,
                )?;
            }
            Ok(())
        })();
        if !ids.is_empty() {
            self.access_audit(
                "startup-local-models",
                &self.principal_id,
                "model.configure",
                &result,
            )?;
        }
        result
    }
    pub fn issue_model(
        &self,
        request: &str,
        input: ModelIssue,
        profiles: &ProviderProfiles,
        enabled: &[String],
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
            if input.prompt.bytes().is_empty()
                || input.prompt.bytes().len() > 16 * 1024
                || !(1..=1024).contains(&input.max_tokens)
                || !(1..=120).contains(&input.ttl_seconds)
            {
                return Err(AccessError::Invalid);
            }
            if !enabled.contains(&input.provider_id) {
                return Err(AccessError::Unavailable);
            }
            let profile = profiles
                .0
                .iter()
                .find(|p| p.id == input.provider_id && p.profile_revision == input.profile_revision)
                .ok_or(AccessError::NotFound)?
                .clone();
            endpoint(&profile)?;
            let live: std::collections::HashSet<_> = state
                .sessions
                .iter()
                .filter(|(_, s)| !s.expired())
                .map(|(id, _)| id.clone())
                .collect();
            state
                .models
                .retain(|_, m| m.expires > Instant::now() && live.contains(&m.session_id));
            if state.models.len() >= 64 {
                return Err(AccessError::Limited);
            }
            let raw = Zeroizing::new(token("ml")?);
            let run = token("run")?;
            self.access_audit(
                request,
                &principal,
                "model.issue",
                &Ok::<_, AccessError>(()),
            )?;
            checked_session(&state, &parent, Some(&input.csrf_token))?;
            state.models.insert(
                digest(raw.as_bytes()),
                ModelLease {
                    session_id: parent.clone(),
                    principal,
                    run_id: run.clone(),
                    profile,
                    prompt: input.prompt,
                    max_tokens: input.max_tokens,
                    expires: Instant::now() + Duration::from_secs(input.ttl_seconds),
                    used: false,
                },
            );
            state.sessions.get_mut(&parent).unwrap().last_seen = Instant::now();
            Ok(
                json!({"run_id":run,"lease_token":&*raw,"expires_in":input.ttl_seconds,"purpose":"model-text-once"}),
            )
        })();
        if result.is_err() {
            self.access_audit(request, &self.principal_id, "model.issue.denied", &result)?;
        }
        result
    }
    pub fn revoke_model(&self, request: &str, input: ModelRevoke) -> Result<Value, AccessError> {
        let mut state = self.access.lock().map_err(|_| AccessError::Unavailable)?;
        let result = (|| {
            let parent = token_id(&input.session_token)?;
            checked_session(&state, &parent, Some(&input.csrf_token))?;
            if input.workspace_id != self.workspace_id {
                return Err(AccessError::NotFound);
            }
            let id = state
                .models
                .iter()
                .find(|(_, m)| m.session_id == parent && m.run_id == input.run_id)
                .map(|(id, _)| id.clone())
                .ok_or(AccessError::NotFound)?;
            state.models.remove(&id);
            Ok(json!({"revoked":true}))
        })();
        self.access_audit(request, &self.principal_id, "model.revoke", &result)?;
        result
    }
    pub fn invoke_model(
        &self,
        request: &str,
        input: ModelCall,
        store: &SecretStore,
    ) -> Result<Value, AccessError> {
        // Serialized with logout/revoke. Their successful response guarantees
        // no later use; existing bytes already sent cannot be undone.
        let mut state = self.access.lock().map_err(|_| AccessError::Unavailable)?;
        let result = (|| {
            let raw = input.lease_token.bytes();
            if raw.len() != 67
                || !raw.starts_with(b"ml_")
                || !raw[3..].iter().all(u8::is_ascii_hexdigit)
            {
                return Err(AccessError::Expired);
            }
            let id = digest(raw);
            let lease = state.models.get(&id).ok_or(AccessError::Expired)?;
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
            if lease.used {
                return Err(AccessError::Conflict);
            }
            let principal = lease.principal.clone();
            let parent = checked_session(&state, &lease.session_id, None)?;
            let deadline = lease
                .expires
                .min(parent.created + Duration::from_secs(ABSOLUTE_TTL))
                .min(parent.last_seen + Duration::from_secs(IDLE_TTL));
            self.access_audit(
                request,
                &principal,
                "model.invoke.intent",
                &Ok::<_, AccessError>(()),
            )?;
            let lease = state.models.get_mut(&id).unwrap();
            lease.used = true; // consume BEFORE any credential use/network attempt
            let owner = ReadAuthority::new(&self.principal_id, &self.workspace_id, 1, request);
            let answer = store.use_provider(
                &owner,
                &lease.profile.credential_ref,
                lease.profile.credential_revision,
                &lease.profile.credential_binding,
                |key| {
                    if Instant::now() >= deadline {
                        return Err(AccessError::Expired);
                    }
                    exchange(&lease.profile, &lease.prompt, lease.max_tokens, key)
                },
            );
            // Clear prompt immediately after the attempt; no long-term memory write.
            lease.prompt = SecretText::new(String::new());
            let answer = answer??;
            self.access_audit(
                request,
                &principal,
                "model.invoke.complete",
                &Ok::<_, AccessError>(()),
            )?;
            let lease = state.models.get(&id).ok_or(AccessError::Expired)?;
            checked_session(&state, &lease.session_id, None)?;
            if lease.expires <= Instant::now() {
                return Err(AccessError::Expired);
            }
            Ok(json!({"status":"completed","result":answer,"authorization_consumed":true}))
        })();
        if result.is_err() {
            self.access_audit(request, &self.principal_id, "model.invoke.denied", &result)?;
        }
        result
    }
    pub fn deny_worker_protocol(&self, request: &str) -> Result<(), AccessError> {
        self.access_audit(
            request,
            &self.principal_id,
            "worker.protocol.denied",
            &Err::<(), _>(AccessError::Forbidden),
        )?;
        Err(AccessError::Forbidden)
    }
}
