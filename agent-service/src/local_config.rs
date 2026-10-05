//! Explicit non-root development configuration for this independent broker.
//! Not DepDek Home access and not an encrypted Secret Store / Agent tool.
use crate::provider::{decode_profiles, ProviderProfile, ACTIVE_PROVIDER_ENV, PROVIDERS_ENV};
use agent_workbench_lib::vault::LocalAgentEnvFile;
use std::path::{Path, PathBuf};

pub const LOCAL_ENV: &str = "DEPDEK_AGENT_LOCAL_ENV_PATH";

pub fn validate_local_path(path: &Path) -> Result<(), &'static str> {
    LocalAgentEnvFile::open(path, false)
        .and_then(|file| file.read())
        .map(|_| ())
        .map_err(|_| "private local configuration unavailable")
}
pub fn load_local(path: &Path) -> Result<(Vec<ProviderProfile>, String), &'static str> {
    let bytes = LocalAgentEnvFile::open(path, false)
        .and_then(|file| file.read())
        .map_err(|_| "private local configuration unavailable")?;
    parse_snapshot(&bytes)
}
pub fn parse_snapshot(bytes: &[u8]) -> Result<(Vec<ProviderProfile>, String), &'static str> {
    let text = std::str::from_utf8(bytes).map_err(|_| "local config encoding invalid")?;
    let mut encoded = None;
    let mut active = String::new();
    for line in text.lines() {
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        match key.trim() {
            PROVIDERS_ENV => {
                if encoded.is_some() {
                    return Err("duplicate profile config");
                }
                encoded = Some(value.trim());
            }
            ACTIVE_PROVIDER_ENV => {
                if !active.is_empty() {
                    return Err("duplicate active config");
                }
                active = value.trim().to_owned();
            }
            _ => {}
        }
    }
    let profiles = match encoded {
        Some(value) => decode_profiles(value)?,
        None => vec![],
    };
    if !active.is_empty() && !profiles.iter().any(|p| p.id == active) {
        return Err("active profile is not configured");
    }
    if active.is_empty() {
        active = profiles.first().map(|p| p.id.clone()).unwrap_or_default();
    }
    Ok((profiles, active))
}
pub fn local_path() -> Option<PathBuf> {
    std::env::var_os(LOCAL_ENV).map(PathBuf::from)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::{symlink, PermissionsExt};
    #[test]
    fn local_reader_rejects_broad_permissions_alias_and_bad_name() {
        if unsafe { libc::geteuid() } == 0 {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        let path = dir.path().join("agent.env");
        assert!(load_local(&path).unwrap().0.is_empty());
        std::fs::write(&path, "").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(load_local(&path).is_err());
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert!(load_local(&path).is_ok());
        std::fs::hard_link(&path, dir.path().join("alias")).unwrap();
        assert!(load_local(&path).is_err());
        let other = tempfile::tempdir().unwrap();
        std::fs::set_permissions(other.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        symlink(&path, other.path().join("agent.env")).unwrap();
        assert!(load_local(&other.path().join("agent.env")).is_err());
        assert!(validate_local_path(&dir.path().join("arbitrary-file")).is_err());
    }
    #[test]
    fn local_reader_tracks_atomic_replacement_without_environment_mutation() {
        if unsafe { libc::geteuid() } == 0 {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        let path = dir.path().join("agent.env");
        for model in ["first-model", "second-model"] {
            let profile = ProviderProfile {
                id: "custom".into(),
                name: "Custom".into(),
                base_url: "https://example.invalid/v1".into(),
                protocol: crate::provider::ApiProtocol::OpenaiCompletions,
                model: model.into(),
                api_key: "SYNTHETIC_LOCAL_SECRET".into(),
            };
            let next = dir.path().join("new.env");
            std::fs::write(
                &next,
                format!(
                    "{}={}\n{}=custom\n",
                    PROVIDERS_ENV,
                    crate::provider::encode_profiles(&[profile]).unwrap(),
                    ACTIVE_PROVIDER_ENV
                ),
            )
            .unwrap();
            std::fs::set_permissions(&next, std::fs::Permissions::from_mode(0o600)).unwrap();
            std::fs::rename(next, &path).unwrap();
            let (profiles, active) = load_local(&path).unwrap();
            assert_eq!(active, "custom");
            assert_eq!(profiles[0].model, model);
        }
    }
}
