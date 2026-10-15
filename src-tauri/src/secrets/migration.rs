use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

use super::{
    validate_secret, CredentialBinding, CredentialField, CredentialKind, SecretError, SecretText,
    Snapshot,
};

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ImportCredentials {
    pub operation_id: String,
    pub sources: LegacySources,
}

#[derive(Serialize, Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub struct LegacySources {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    agent_env: Option<SecretText>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    resolved_refs: BTreeMap<String, SecretText>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    settings: Option<LegacySettings>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    mail: Option<Accounts<LegacyMail>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    calendar: Option<Accounts<LegacyCalendar>>,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct LegacySettings {
    #[serde(default)]
    providers: BTreeMap<String, LegacyProvider>,
    #[serde(default)]
    agents: Vec<crate::settings::SavedAgent>,
    #[serde(default)]
    last_root: Option<String>,
    #[serde(default)]
    obsidian_root: Option<String>,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct LegacyProvider {
    kind: String,
    model: String,
    #[serde(default)]
    api_key: Option<SecretText>,
    #[serde(default)]
    base_url: Option<String>,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Accounts<T> {
    accounts: Vec<T>,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct LegacyMail {
    name: String,
    host: String,
    user: String,
    password: SecretText,
    #[serde(default)]
    port: Option<u16>,
    #[serde(default)]
    secure: Option<bool>,
    #[serde(default)]
    mailbox: Option<String>,
    #[serde(default)]
    last_uid: Option<u64>,
    #[serde(default)]
    smtp_host: Option<String>,
    #[serde(default)]
    smtp_port: Option<u16>,
    #[serde(default)]
    smtp_secure: Option<bool>,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct LegacyCalendar {
    id: String,
    name: String,
    provider: String,
    #[serde(default)]
    endpoint: Option<String>,
    #[serde(default)]
    write_endpoint: Option<String>,
    #[serde(default)]
    calendar_id: Option<String>,
    #[serde(default)]
    user: Option<String>,
    #[serde(default)]
    password: Option<SecretText>,
    #[serde(default)]
    access_token: Option<SecretText>,
    #[serde(default)]
    enabled: Option<bool>,
    #[serde(default)]
    readonly: Option<bool>,
}

pub(super) struct Candidates {
    pub items: Vec<(CredentialBinding, SecretText)>,
    pub skipped: usize,
}
impl LegacySources {
    pub(super) fn extract(mut self) -> Result<Candidates, SecretError> {
        if self.resolved_refs.len() > 128 {
            return Err(SecretError::Capacity);
        }
        if let Some(s) = &mut self.settings {
            for p in s.providers.values_mut() {
                if let Some(secret) = &mut p.api_key {
                    resolve(secret, &self.resolved_refs)?
                }
            }
        }
        if let Some(m) = &mut self.mail {
            for a in &mut m.accounts {
                resolve(&mut a.password, &self.resolved_refs)?
            }
        }
        if let Some(c) = &mut self.calendar {
            for a in &mut c.accounts {
                for secret in [&mut a.password, &mut a.access_token].into_iter().flatten() {
                    resolve(secret, &self.resolved_refs)?
                }
            }
        }
        if self.settings.is_none()
            && self.mail.is_none()
            && self.calendar.is_none()
            && self.agent_env.is_none()
        {
            return Err(SecretError::InvalidInput);
        }
        let mut result = Candidates {
            items: Vec::new(),
            skipped: 0,
        };
        let mut accounts = BTreeSet::new();
        if let Some(env) = self.agent_env {
            #[derive(Deserialize)]
            #[serde(deny_unknown_fields)]
            struct P {
                id: String,
                name: String,
                base_url: String,
                protocol: String,
                model: String,
                api_key: SecretText,
            }
            let text = std::str::from_utf8(env.bytes()).map_err(|_| SecretError::InvalidInput)?;
            if text.len() > 56000 {
                return Err(SecretError::Capacity);
            }
            let encoded = text
                .lines()
                .filter_map(|line| line.split_once('='))
                .filter(|(key, _)| key.trim() == "DEPDEK_AGENT_PROVIDERS_B64")
                .map(|(_, v)| v.trim())
                .collect::<Vec<_>>();
            if encoded.len() != 1 {
                return Err(SecretError::InvalidInput);
            }
            use base64::Engine;
            let bytes = zeroize::Zeroizing::new(
                base64::engine::general_purpose::STANDARD
                    .decode(encoded[0])
                    .map_err(|_| SecretError::InvalidInput)?,
            );
            if bytes.len() > 56000 {
                return Err(SecretError::Capacity);
            }
            let profiles: Vec<P> =
                serde_json::from_slice(&bytes).map_err(|_| SecretError::InvalidInput)?;
            if profiles.len() > 24 {
                return Err(SecretError::Capacity);
            }
            for p in profiles {
                label(&p.name)?;
                label(&p.model)?;
                endpoint(&p.base_url)?;
                if !matches!(
                    p.protocol.as_str(),
                    "openai-completions" | "openai-responses" | "anthropic-messages"
                ) {
                    return Err(SecretError::InvalidInput);
                }
                result.push(
                    CredentialKind::Provider,
                    p.id,
                    CredentialField::ApiKey,
                    p.api_key,
                )?;
            }
        }
        if let Some(settings) = self.settings {
            if settings.providers.len() > 32 {
                return Err(SecretError::Capacity);
            }
            for (id, provider) in settings.providers {
                label(&id)?;
                label(&provider.model)?;
                if !matches!(
                    provider.kind.as_str(),
                    "openai" | "anthropic" | "openai-compatible"
                ) {
                    return Err(SecretError::InvalidInput);
                }
                if provider.kind == "openai-compatible" && provider.base_url.is_none() {
                    return Err(SecretError::InvalidInput);
                }
                if let Some(url) = provider.base_url {
                    endpoint(&url)?;
                }
                match provider.api_key {
                    Some(secret) if !secret.0.trim().is_empty() => result.push(
                        CredentialKind::Provider,
                        id,
                        CredentialField::ApiKey,
                        secret,
                    )?,
                    _ if provider.kind == "openai-compatible" => result.skipped += 1,
                    _ => return Err(SecretError::InvalidInput),
                }
            }
        }
        if let Some(mail) = self.mail {
            if mail.accounts.len() > 32 {
                return Err(SecretError::Capacity);
            }
            for account in mail.accounts {
                label(&account.name)?;
                label(&account.user)?;
                label(&account.host)?;
                if !accounts.insert((CredentialKind::Mail, account.name.clone()))
                    || account.name.contains('/')
                    || account.port == Some(0)
                    || account.smtp_port == Some(0)
                {
                    return Err(SecretError::InvalidInput);
                }
                result.push(
                    CredentialKind::Mail,
                    account.name,
                    CredentialField::Password,
                    account.password,
                )?;
            }
        }
        if let Some(calendar) = self.calendar {
            if calendar.accounts.len() > 32 {
                return Err(SecretError::Capacity);
            }
            for account in calendar.accounts {
                label(&account.id)?;
                label(&account.name)?;
                if !accounts.insert((CredentialKind::Calendar, account.id.clone()))
                    || !matches!(
                        account.provider.as_str(),
                        "google" | "microsoft" | "apple" | "caldav" | "ics"
                    )
                {
                    return Err(SecretError::InvalidInput);
                }
                if let Some(url) = account.endpoint {
                    endpoint(&url)?;
                }
                if let Some(url) = account.write_endpoint {
                    endpoint(&url)?;
                }
                for (field, secret) in [
                    (CredentialField::Password, account.password),
                    (CredentialField::AccessToken, account.access_token),
                ] {
                    if let Some(secret) = secret {
                        if secret.0.trim().is_empty() {
                            result.skipped += 1;
                        } else {
                            result.push(
                                CredentialKind::Calendar,
                                account.id.clone(),
                                field,
                                secret,
                            )?;
                        }
                    }
                }
            }
        }
        Ok(result)
    }
}
fn resolve(
    secret: &mut SecretText,
    refs: &BTreeMap<String, SecretText>,
) -> Result<(), SecretError> {
    if let Ok(value) = std::str::from_utf8(secret.bytes()) {
        if value.starts_with("$secret:") {
            *secret = refs.get(value).ok_or(SecretError::InvalidInput)?.clone();
        }
    }
    if std::str::from_utf8(secret.bytes())
        .is_ok_and(|v| v.starts_with("$secret:") || v.starts_with("cr_"))
    {
        return Err(SecretError::InvalidInput);
    }
    Ok(())
}
impl Candidates {
    fn push(
        &mut self,
        kind: CredentialKind,
        account_id: String,
        field: CredentialField,
        secret: SecretText,
    ) -> Result<(), SecretError> {
        validate_secret(&secret)?;
        let binding = CredentialBinding {
            kind,
            account_id,
            field,
        };
        binding.validate()?;
        if self.items.iter().any(|(b, _)| b == &binding) {
            return Err(SecretError::InvalidInput);
        }
        self.items.push((binding, secret));
        Ok(())
    }
}
pub(super) fn preview(snapshot: &Snapshot, candidates: &Candidates) -> (Vec<Value>, Vec<Value>) {
    let bindings = candidates
        .items
        .iter()
        .map(|(b, _)| serde_json::json!(b))
        .collect();
    let conflicts = candidates
        .items
        .iter()
        .filter(|(b, _)| snapshot.credentials.iter().any(|r| r.binding == *b))
        .map(|(b, _)| serde_json::json!(b))
        .collect();
    (conflicts, bindings)
}
fn label(value: &str) -> Result<(), SecretError> {
    if value.trim().is_empty() || value.len() > 256 || value.chars().any(char::is_control) {
        return Err(SecretError::InvalidInput);
    }
    Ok(())
}
fn endpoint(value: &str) -> Result<(), SecretError> {
    if value.len() > 2048 {
        return Err(SecretError::InvalidInput);
    }
    let url = url::Url::parse(value).map_err(|_| SecretError::InvalidInput)?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(SecretError::InvalidInput);
    }
    Ok(())
}
