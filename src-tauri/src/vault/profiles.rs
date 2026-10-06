//! Immutable control profiles: metadata/reference validation, no networking or keys.
use super::*;
use crate::secrets::{CredentialBinding, CredentialField, CredentialKind};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashSet;

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ProviderRegistration {
    pub id: String,
    pub name: String,
    pub base_url: String,
    pub protocol: ProfileProtocol,
    pub model: String,
    pub profile_revision: u64,
    pub credential_ref: String,
    pub credential_revision: u64,
    pub credential_binding: CredentialBinding,
}
impl std::fmt::Debug for ProviderRegistration {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ProviderRegistration")
            .field("id", &self.id)
            .finish_non_exhaustive()
    }
}
#[derive(Clone, Deserialize, Serialize)]
pub enum ProfileProtocol {
    #[serde(rename = "openai-completions")]
    OpenAiCompletions,
}
pub struct ProviderProfiles(pub(super) Vec<ProviderRegistration>);
impl ProviderProfiles {
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}
pub enum CredentialCatalogue<'a> {
    Unavailable,
    NotInitialized,
    Locked,
    Metadata(&'a Value),
}

fn validate(profile: &ProviderRegistration) -> Result<(), ManagedReadError> {
    let reference = profile.credential_ref.as_bytes();
    if profile.id.is_empty()
        || profile.id.len() > 48
        || !profile.id.as_bytes()[0].is_ascii_lowercase()
        || !profile
            .id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        || profile.name.trim().is_empty()
        || profile.name.chars().count() > 64
        || profile.name.chars().any(char::is_control)
        || profile.model.is_empty()
        || profile.model.len() > 128
        || !profile
            .model
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._:/-".contains(&b))
        || profile.profile_revision == 0
        || profile.credential_revision == 0
        || reference.len() != 35
        || !reference.starts_with(b"cr_")
        || !reference[3..].iter().all(u8::is_ascii_hexdigit)
        || profile.credential_binding.kind != CredentialKind::Provider
        || profile.credential_binding.field != CredentialField::ApiKey
        || profile.credential_binding.account_id.trim().is_empty()
        || profile.credential_binding.account_id.len() > 128
        || profile
            .credential_binding
            .account_id
            .chars()
            .any(char::is_control)
        || profile.base_url.len() > 2048
    {
        return Err(ManagedReadError::InvalidInput);
    }
    let url = url::Url::parse(&profile.base_url).map_err(|_| ManagedReadError::InvalidInput)?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(ManagedReadError::InvalidInput);
    }
    let loopback = url.host_str().is_some_and(|host| {
        host.eq_ignore_ascii_case("localhost")
            || host
                .trim_matches(['[', ']'])
                .parse::<std::net::IpAddr>()
                .is_ok_and(|ip| ip.is_loopback())
    });
    if url.scheme() == "http" && !loopback {
        return Err(ManagedReadError::InvalidInput);
    }
    Ok(())
}
fn credential_state(
    profile: &ProviderRegistration,
    catalogue: &CredentialCatalogue<'_>,
) -> &'static str {
    let metadata = match catalogue {
        CredentialCatalogue::Unavailable => return "unavailable",
        CredentialCatalogue::NotInitialized => return "not_initialized",
        CredentialCatalogue::Locked => return "locked",
        CredentialCatalogue::Metadata(value) => *value,
    };
    let Some(record) = metadata["credentials"].as_array().and_then(|records| {
        records
            .iter()
            .find(|r| r["credential_ref"] == profile.credential_ref)
    }) else {
        return "not_found";
    };
    if record["state"] == "revoked" {
        return "revoked";
    }
    if record["binding"] != json!(profile.credential_binding) {
        return "binding_mismatch";
    }
    if record["revision"] != profile.credential_revision {
        return "revision_mismatch";
    }
    if record["state"] != "stored" {
        return "unavailable";
    }
    "stored"
}
impl ManagedReadVault {
    pub fn register_provider_profiles(
        &self,
        registrations: Vec<ProviderRegistration>,
    ) -> Result<ProviderProfiles, ManagedReadError> {
        let enabled = !registrations.is_empty();
        let result = (|| {
            if registrations.len() > 24 {
                return Err(ManagedReadError::TooLarge);
            }
            let mut ids = HashSet::new();
            for profile in &registrations {
                validate(profile)?;
                if !ids.insert(&profile.id) {
                    return Err(ManagedReadError::InvalidInput);
                }
            }
            Ok(ProviderProfiles(registrations))
        })();
        if enabled {
            self.profile_audit("startup-profiles", "profiles.configure", &result)?;
        }
        result
    }
    fn profile_audit<T>(
        &self,
        request: &str,
        action: &str,
        result: &Result<T, ManagedReadError>,
    ) -> Result<(), ManagedReadError> {
        let mut entry = AuditEntry::new(
            &format!("v2:{}:{request}", self.principal_id),
            Op::Read,
            action,
        );
        entry.ok = result.is_ok();
        entry.error = result.as_ref().err().map(|_| "profile unavailable".into());
        self.audit
            .record_durable(entry)
            .map_err(|_| ManagedReadError::AuditUnavailable)
    }
    pub fn provider_catalogue(
        &self,
        authority: &ReadAuthority,
        profiles: &ProviderProfiles,
        credentials: CredentialCatalogue<'_>,
    ) -> Result<Value, ManagedReadError> {
        let result = (|| {
            if authority.principal_id != self.principal_id
                || authority.workspace_id != self.workspace_id
                || !managed_id(&authority.request_id)
            {
                return Err(ManagedReadError::Forbidden);
            }
            if authority.policy_revision != 1 {
                return Err(ManagedReadError::PolicyChanged);
            }
            Ok(json!({"profiles":profiles.0.iter().map(|p| {
                let mut result = json!(p);
                result["credential_state"] = json!(credential_state(p,&credentials));
                result["model_execution_enabled"] = json!(false);
                result["connection_verified"] = json!(false);
                result
            }).collect::<Vec<_>>(),"read_only_registration":true}))
        })();
        self.profile_audit(&authority.request_id, "profiles.list", &result)?;
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn profile() -> ProviderRegistration {
        serde_json::from_value(json!({"id":"test","name":"Test","base_url":"https://example.invalid/v1","protocol":"openai-completions","model":"model-test","profile_revision":1,"credential_ref":"cr_0123456789abcdef0123456789abcdef","credential_revision":1,"credential_binding":{"kind":"provider","account_id":"test","field":"api_key"}})).unwrap()
    }
    fn fixture() -> (tempfile::TempDir, ManagedReadVault) {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join("documents")).unwrap();
        let vault =
            ManagedReadVault::open(root.path(), "w1", "local:test", &["documents".into()]).unwrap();
        (root, vault)
    }
    #[test]
    fn profile_registration_rejects_secrets_in_urls_bad_binding_and_duplicates() {
        let (_root, vault) = fixture();
        for url in [
            "http://example.invalid/v1",
            "https://user:password@example.invalid/v1",
            "https://example.invalid/v1?api_key=SYNTHETIC_KEY",
            "file:///tmp/key",
            "https://example.invalid/v1#key",
        ] {
            let mut p = profile();
            p.base_url = url.into();
            assert!(vault.register_provider_profiles(vec![p]).is_err());
        }
        let mut p = profile();
        p.credential_binding.kind = CredentialKind::Mail;
        assert!(vault.register_provider_profiles(vec![p]).is_err());
        let mut p = profile();
        p.credential_revision = 0;
        assert!(vault.register_provider_profiles(vec![p]).is_err());
        assert!(vault
            .register_provider_profiles(vec![profile(), profile()])
            .is_err());
        let mut input = json!(profile());
        input["api_key"] = json!("SYNTHETIC_KEY");
        assert!(serde_json::from_value::<ProviderRegistration>(input).is_err());
        for url in [
            "http://127.0.0.1:8000/v1",
            "http://[::1]:8000/v1",
            "http://localhost:8000/v1",
        ] {
            let mut p = profile();
            p.base_url = url.into();
            assert!(vault.register_provider_profiles(vec![p]).is_ok());
        }
    }
    #[test]
    fn profile_status_checks_reference_binding_revision_and_authority_without_enabling_models() {
        let (root, vault) = fixture();
        let profiles = vault.register_provider_profiles(vec![profile()]).unwrap();
        let auth = ReadAuthority::new("local:test", "w1", 1, "catalogue");
        for (status, state) in [
            (CredentialCatalogue::Unavailable, "unavailable"),
            (CredentialCatalogue::Locked, "locked"),
            (CredentialCatalogue::NotInitialized, "not_initialized"),
        ] {
            let result = vault.provider_catalogue(&auth, &profiles, status).unwrap();
            assert_eq!(result["profiles"][0]["credential_state"], state);
            assert_eq!(result["profiles"][0]["model_execution_enabled"], false);
            assert_eq!(result["profiles"][0]["connection_verified"], false);
        }
        let mut metadata = json!({"credentials":[{"credential_ref":profile().credential_ref,"revision":1,"binding":profile().credential_binding,"state":"stored"}]});
        assert_eq!(
            vault
                .provider_catalogue(&auth, &profiles, CredentialCatalogue::Metadata(&metadata))
                .unwrap()["profiles"][0]["credential_state"],
            "stored"
        );
        metadata["credentials"][0]["revision"] = json!(2);
        assert_eq!(
            vault
                .provider_catalogue(&auth, &profiles, CredentialCatalogue::Metadata(&metadata))
                .unwrap()["profiles"][0]["credential_state"],
            "revision_mismatch"
        );
        metadata["credentials"][0]["binding"]["account_id"] = json!("other-account");
        assert_eq!(
            vault
                .provider_catalogue(&auth, &profiles, CredentialCatalogue::Metadata(&metadata))
                .unwrap()["profiles"][0]["credential_state"],
            "binding_mismatch"
        );
        metadata["credentials"][0]["state"] = json!("revoked");
        assert_eq!(
            vault
                .provider_catalogue(&auth, &profiles, CredentialCatalogue::Metadata(&metadata))
                .unwrap()["profiles"][0]["credential_state"],
            "revoked"
        );
        assert!(vault
            .provider_catalogue(
                &ReadAuthority::new("claimed-admin", "w1", 1, "forged"),
                &profiles,
                CredentialCatalogue::Locked
            )
            .is_err());
        assert!(vault
            .provider_catalogue(
                &ReadAuthority::new("local:test", "w2", 1, "other-workspace"),
                &profiles,
                CredentialCatalogue::Locked
            )
            .is_err());
        vault.audit.set_file(
            root.path().join(AUDIT_FILE_NAME),
            fs::File::open(root.path().join(AUDIT_FILE_NAME)).unwrap(),
        );
        assert!(matches!(
            vault.provider_catalogue(&auth, &profiles, CredentialCatalogue::Locked),
            Err(ManagedReadError::AuditUnavailable)
        ));
    }
}
