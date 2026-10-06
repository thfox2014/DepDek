//! Crate-private, drained credential use. No value crosses a public RPC boundary.
use super::*;

impl SecretStore {
    pub(crate) fn use_provider<T>(
        &self,
        authority: &ReadAuthority,
        reference: &str,
        revision: u64,
        binding: &CredentialBinding,
        action: impl FnOnce(&SecretText) -> T,
    ) -> Result<T, SecretError> {
        let mut inner = self.inner.lock().map_err(|_| SecretError::Unavailable)?;
        expire(&mut inner);
        let result = (|| {
            self.files.authorize(authority)?;
            self.files.audit(
                authority,
                "credentials/provider.intent",
                false,
                Some("INTENT"),
            )?;
            if binding.kind != CredentialKind::Provider || binding.field != CredentialField::ApiKey
            {
                return Err(SecretError::Forbidden);
            }
            let unlocked = inner.unlocked.as_mut().ok_or(SecretError::Locked)?;
            let record = unlocked
                .snapshot
                .credentials
                .iter()
                .find(|r| r.credential_ref == reference)
                .ok_or(SecretError::Conflict)?;
            if record.revoked || record.revision != revision || record.binding != *binding {
                return Err(SecretError::Conflict);
            }
            // The callback cannot outlive this lock. Rotation/revoke/lock drain
            // the bounded in-flight use instead of releasing a Key to a Worker.
            let value = action(&record.secret);
            self.files.authorize(authority)?;
            unlocked.last_activity = Instant::now();
            Ok(value)
        })();
        if let Err(error) = self.files.audit(
            authority,
            "credentials/provider.complete",
            result.is_ok(),
            result.as_ref().err().map(SecretError::code),
        ) {
            inner.unlocked = None;
            return Err(error.into());
        }
        if matches!(
            result,
            Err(SecretError::Forbidden | SecretError::Unavailable | SecretError::AuditUnavailable)
        ) {
            inner.unlocked = None;
        }
        result
    }
}
