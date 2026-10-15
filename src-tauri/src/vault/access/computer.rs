//! Browser capability gate stays in Vault; no caller role or filesystem path.
use super::*;
impl ManagedReadVault {
    pub fn computer_authorize(
        &self,
        request: &str,
        token: &SecretText,
        csrf: &SecretText,
        workspace: &str,
        action: &Value,
    ) -> Result<String, AccessError> {
        let mut actor = self.principal_id.clone();
        let result = (|| {
            let mut state = self.access.lock().map_err(|_| AccessError::Unavailable)?;
            let id = token_id(token)?;
            let session = checked_session(&state, &id, Some(csrf))?;
            if workspace != self.workspace_id {
                return Err(AccessError::NotFound);
            }
            actor = session.principal.clone();
            validate_action(action)?;
            state.sessions.get_mut(&id).unwrap().last_seen = Instant::now();
            Ok(actor.clone())
        })();
        // Only a fixed operation category reaches audit, never user text.
        self.access_audit(request, &actor, "computer.authorize", &result)?;
        result
    }
    pub fn computer_result(
        &self,
        request: &str,
        actor: &str,
        action: &Value,
        ok: bool,
    ) -> Result<(), AccessError> {
        validate_action(action)?;
        let kind = action["kind"].as_str().ok_or(AccessError::Invalid)?;
        self.access_audit(
            request,
            actor,
            &format!("computer.{kind}.result"),
            &if ok {
                Ok(())
            } else {
                Err(AccessError::Unavailable)
            },
        )
    }
}
fn validate_action(v: &Value) -> Result<(), AccessError> {
    let o = v.as_object().ok_or(AccessError::Invalid)?;
    let keys: &[&str] = match v["kind"].as_str() {
        Some("status" | "screenshot" | "request_input" | "stop") => &["kind"],
        Some("open") => {
            let u = v["url"].as_str().ok_or(AccessError::Invalid)?;
            if u != "depdek:demo-login" {
                let url = reqwest::Url::parse(u).map_err(|_| AccessError::Invalid)?;
                if u.len() > 2048
                    || url.scheme() != "https"
                    || !url.username().is_empty()
                    || url.password().is_some()
                    || url.port_or_known_default() != Some(443)
                    || url.host_str().is_none()
                    || url.host_str().unwrap().parse::<std::net::IpAddr>().is_ok()
                {
                    return Err(AccessError::Forbidden);
                }
            }
            &["kind", "url"]
        }
        Some("click") => {
            target(&v["target"])?;
            revision(&v["page_revision"])?;
            &["kind", "target", "page_revision"]
        }
        Some("respond") => {
            revision(&v["page_revision"])?;
            let values = v["values"].as_object().ok_or(AccessError::Invalid)?;
            if values.is_empty() || values.len() > 12 {
                return Err(AccessError::Invalid);
            }
            for (k, v) in values {
                target(&json!(k))?;
                if v.as_str()
                    .is_none_or(|s| s.len() > 1024 || s.contains('\0'))
                {
                    return Err(AccessError::Invalid);
                }
            }
            &["kind", "values", "page_revision"]
        }
        _ => return Err(AccessError::Forbidden),
    };
    if o.len() != keys.len() || keys.iter().any(|k| !o.contains_key(*k)) {
        return Err(AccessError::Invalid);
    }
    Ok(())
}
fn target(v: &Value) -> Result<(), AccessError> {
    let s = v.as_str().ok_or(AccessError::Invalid)?;
    if !(2..=4).contains(&s.len())
        || !s.starts_with('e')
        || !s[1..].bytes().all(|b| b.is_ascii_digit())
    {
        Err(AccessError::Invalid)
    } else {
        Ok(())
    }
}
fn revision(v: &Value) -> Result<(), AccessError> {
    if v.as_u64().is_none_or(|n| n == 0) {
        Err(AccessError::Invalid)
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn computer_rejects_shell_paths_and_stale_shape() {
        for v in [
            json!({"kind":"shell","command":"ls"}),
            json!({"kind":"open","url":"file:///etc/passwd"}),
            json!({"kind":"open","url":"https://127.0.0.1"}),
            json!({"kind":"click","target":"#password","page_revision":1}),
            json!({"kind":"respond","values":{"e1":"test"},"page_revision":0}),
            json!({"kind":"status","actor":"admin"}),
        ] {
            assert!(validate_action(&v).is_err());
        }
        for v in [
            json!({"kind":"open","url":"https://example.com"}),
            json!({"kind":"open","url":"depdek:demo-login"}),
            json!({"kind":"respond","values":{"e1":"test"},"page_revision":1}),
        ] {
            assert!(validate_action(&v).is_ok());
        }
    }
    #[test]
    fn computer_requires_business_session_and_csrf() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join("documents")).unwrap();
        let vault =
            ManagedReadVault::open(root.path(), "w1", "local:test", &["documents".into()]).unwrap();
        assert!(vault
            .computer_authorize(
                "unauth",
                &SecretText::new("admin".into()),
                &SecretText::new("admin".into()),
                "w1",
                &json!({"kind":"status"})
            )
            .is_err());
    }
}
