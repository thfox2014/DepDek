//! Atomic encrypted control profiles + write-only credentials. No env reads.
use super::*;
use crate::vault::{validate_provider_registration, ProviderRegistration};

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SaveProvider {
    pub operation_id: String,
    pub id: String,
    pub name: String,
    pub base_url: String,
    pub model: String,
    pub expected_revision: u64,
    pub api_key: SecretText,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ActivateImportedProvider {
    pub operation_id: String,
    pub id: String,
    pub name: String,
    pub base_url: String,
    pub model: String,
    pub expected_revision: u64,
}
pub(super) fn validate_profiles(snapshot: &Snapshot) -> Result<(), SecretError> {
    if snapshot.profiles.len() > 24 {
        return Err(SecretError::Capacity);
    }
    let mut ids = std::collections::BTreeSet::new();
    for p in &snapshot.profiles {
        validate_provider_registration(p).map_err(|_| SecretError::InvalidFormat)?;
        if !ids.insert(&p.id) {
            return Err(SecretError::InvalidFormat);
        }
        // Rotation/revoke of a credential may leave a profile intentionally stale.
        if !snapshot
            .credentials
            .iter()
            .any(|c| c.credential_ref == p.credential_ref && c.binding == p.credential_binding)
        {
            return Err(SecretError::InvalidFormat);
        }
    }
    Ok(())
}
impl SecretStore {
    pub(super) fn save_provider(
        &self,
        unlocked: &mut Unlocked,
        input: SaveProvider,
    ) -> Result<Value, SecretError> {
        validate_operation(&input.operation_id)?;
        let fingerprint = digest(&input)?;
        if !input.api_key.bytes().is_empty()
            && (input.api_key.bytes().len() > 512
                || !input.api_key.bytes().iter().all(u8::is_ascii_graphic)
                || input.api_key.bytes().starts_with(b"$secret:"))
        {
            return Err(SecretError::InvalidInput);
        }
        if let Some(receipt) = replay(&unlocked.snapshot, &input.operation_id, &fingerprint)? {
            return Ok(receipt);
        }
        let mut next = unlocked.snapshot.clone();
        let previous = next.profiles.iter().find(|p| p.id == input.id);
        if previous.map_or(0, |p| p.profile_revision) != input.expected_revision {
            return Err(SecretError::Conflict);
        }
        let binding = CredentialBinding {
            kind: CredentialKind::Provider,
            account_id: input.id.clone(),
            field: CredentialField::ApiKey,
        };
        let index = next.credentials.iter().position(|c| c.binding == binding);
        if !input.api_key.bytes().is_empty() {
            validate_secret(&input.api_key)?;
            if let Some(index) = index {
                let c = &mut next.credentials[index];
                c.revision = c.revision.checked_add(1).ok_or(SecretError::Capacity)?;
                c.secret = input.api_key;
                c.revoked = false;
            } else {
                next.credentials.push(StoredCredential {
                    credential_ref: new_reference()?,
                    revision: 1,
                    binding: binding.clone(),
                    revoked: false,
                    secret: input.api_key,
                });
            }
        } else if previous.is_none() {
            return Err(SecretError::InvalidInput);
        }
        self.commit_profile(
            unlocked,
            next,
            &input.operation_id,
            &fingerprint,
            input.id,
            input.name,
            input.base_url,
            input.model,
            input.expected_revision,
        )
    }
    pub(super) fn activate_provider(
        &self,
        unlocked: &mut Unlocked,
        input: ActivateImportedProvider,
    ) -> Result<Value, SecretError> {
        validate_operation(&input.operation_id)?;
        let fingerprint = digest(&input)?;
        if let Some(receipt) = replay(&unlocked.snapshot, &input.operation_id, &fingerprint)? {
            return Ok(receipt);
        }
        if unlocked
            .snapshot
            .profiles
            .iter()
            .find(|p| p.id == input.id)
            .map_or(0, |p| p.profile_revision)
            != input.expected_revision
        {
            return Err(SecretError::Conflict);
        }
        self.commit_profile(
            unlocked,
            unlocked.snapshot.clone(),
            &input.operation_id,
            &fingerprint,
            input.id,
            input.name,
            input.base_url,
            input.model,
            input.expected_revision,
        )
    }
    #[allow(clippy::too_many_arguments)]
    fn commit_profile(
        &self,
        unlocked: &mut Unlocked,
        mut next: Snapshot,
        operation: &str,
        fingerprint: &str,
        id: String,
        name: String,
        base_url: String,
        model: String,
        revision: u64,
    ) -> Result<Value, SecretError> {
        let binding = CredentialBinding {
            kind: CredentialKind::Provider,
            account_id: id.clone(),
            field: CredentialField::ApiKey,
        };
        let c = next
            .credentials
            .iter()
            .find(|c| c.binding == binding && !c.revoked)
            .ok_or(SecretError::Conflict)?;
        let p = ProviderRegistration {
            id,
            name,
            base_url,
            model,
            protocol: serde_json::from_value(json!("openai-completions")).unwrap(),
            profile_revision: revision.checked_add(1).ok_or(SecretError::Capacity)?,
            credential_ref: c.credential_ref.clone(),
            credential_revision: c.revision,
            credential_binding: binding,
        };
        validate_provider_registration(&p).map_err(|_| SecretError::InvalidInput)?;
        next.profiles.retain(|old| old.id != p.id);
        next.profiles.push(p.clone());
        let receipt = json!({"operation_id":operation,"status":"stored","profile":p,"connection_verified":false});
        next.operations.insert(
            operation.into(),
            OperationRecord {
                digest: fingerprint.into(),
                receipt: receipt.clone(),
            },
        );
        self.commit(unlocked, next)?;
        Ok(receipt)
    }
}

#[cfg(test)]
mod tests {
    use super::super::tests::{init, owner, prepare};
    use super::*;
    const KEY: &str = "SYNTHETIC_ATOMIC_PROFILE_KEY";
    fn input(operation: &str, revision: u64, key: &str) -> SaveProvider {
        serde_json::from_value(json!({"operation_id":operation,"id":"test","name":"Synthetic","base_url":"https://api.deepseek.com/v1","model":"test-model","expected_revision":revision,"api_key":key})).unwrap()
    }
    #[test]
    fn encrypted_profile_atomic_save_replay_revision_rotation_restart_and_no_secret_output() {
        let (_temp, vault, private) = prepare();
        let store = SecretStore::new(vault.open_secret_files(&private).unwrap(), "w1".into());
        init(&store);
        let first = store
            .execute(
                &owner(),
                SecretOperation::SaveProvider(input("save", 0, KEY)),
            )
            .unwrap();
        assert_eq!(
            first,
            store
                .execute(
                    &owner(),
                    SecretOperation::SaveProvider(input("save", 0, KEY))
                )
                .unwrap()
        );
        assert!(!first.to_string().contains(KEY));
        assert!(matches!(
            store.execute(
                &owner(),
                SecretOperation::SaveProvider(input("save", 0, "CHANGED"))
            ),
            Err(SecretError::Conflict)
        ));
        assert!(matches!(
            store.execute(
                &owner(),
                SecretOperation::SaveProvider(input("stale", 0, KEY))
            ),
            Err(SecretError::Conflict)
        ));
        let old: ProviderRegistration = serde_json::from_value(first["profile"].clone()).unwrap();
        let updated = store
            .execute(
                &owner(),
                SecretOperation::SaveProvider(input("update", 1, "")),
            )
            .unwrap();
        assert_eq!(updated["profile"]["credential_revision"], 1);
        assert_eq!(updated["profile"]["profile_revision"], 2);
        assert!(matches!(
            store.use_provider_profile(&owner(), &old, |_| ()),
            Err(SecretError::Conflict)
        ));
        let locked = store.execute(&owner(), SecretOperation::Lock).unwrap();
        assert!(locked["locked"].as_bool().unwrap());
        let ciphertext = std::fs::read(private.join("credentials.enc")).unwrap();
        assert!(!String::from_utf8(ciphertext).unwrap().contains(KEY));
        drop(store);
        let store = SecretStore::new(vault.open_secret_files(&private).unwrap(), "w1".into());
        store
            .execute(
                &owner(),
                SecretOperation::Unlock(SecretText::new(super::super::tests::PASSPHRASE.into())),
            )
            .unwrap();
        assert_eq!(
            store.execute(&owner(), SecretOperation::Profiles).unwrap()["profiles"][0]
                ["profile_revision"],
            2
        );
    }
    #[test]
    fn legacy_env_and_resolved_refs_are_explicit_and_import_is_not_activation() {
        let (_temp, vault, private) = prepare();
        let store = SecretStore::new(vault.open_secret_files(&private).unwrap(), "w1".into());
        init(&store);
        let env=format!("DEPDEK_AGENT_PROVIDERS_B64={}\n",STANDARD.encode(json!([{"id":"test","name":"Synthetic","base_url":"https://api.deepseek.com/v1","model":"test-model","protocol":"openai-completions","api_key":KEY}]).to_string()));
        let sources = || serde_json::from_value::<LegacySources>(json!({"agent_env":env})).unwrap();
        let preview = store
            .execute(&owner(), SecretOperation::ImportPreview(sources()))
            .unwrap();
        assert!(!preview.to_string().contains(KEY));
        store
            .execute(
                &owner(),
                SecretOperation::ImportApply(ImportCredentials {
                    operation_id: "import-env".into(),
                    sources: sources(),
                }),
            )
            .unwrap();
        assert!(
            store.execute(&owner(), SecretOperation::Profiles).unwrap()["profiles"]
                .as_array()
                .unwrap()
                .is_empty()
        );
        store.execute(&owner(),SecretOperation::ActivateProvider(serde_json::from_value(json!({"operation_id":"activate","id":"test","name":"Synthetic","base_url":"https://api.deepseek.com/v1","model":"test-model","expected_revision":0})).unwrap())).unwrap();
        assert_eq!(
            store.execute(&owner(), SecretOperation::Profiles).unwrap()["profiles"][0]["id"],
            "test"
        );
        let unresolved:LegacySources=serde_json::from_value(json!({"settings":{"providers":{"other":{"kind":"openai","api_key":"$secret:providers.other.api_key","model":"test"}}}})).unwrap();
        assert!(unresolved.extract().is_err());
        let resolved:LegacySources=serde_json::from_value(json!({"settings":{"providers":{"other":{"kind":"openai","api_key":"$secret:providers.other.api_key","model":"test"}}},"resolved_refs":{"$secret:providers.other.api_key":KEY}})).unwrap();
        assert!(resolved.extract().is_ok());
    }
}
