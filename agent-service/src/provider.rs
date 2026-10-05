use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use url::Url;

pub const PROVIDERS_ENV: &str = "DEPDEK_AGENT_PROVIDERS_B64";
pub const ACTIVE_PROVIDER_ENV: &str = "DEPDEK_AGENT_PROVIDER";
pub const SELECTED_KEY_ENV: &str = "DEPDEK_AGENT_SELECTED_API_KEY";
pub const MAX_PROVIDERS: usize = 24;
pub const MAX_KEY_BYTES: usize = 2048;
pub const MAX_PROVIDERS_JSON_BYTES: usize = 56 * 1024;

#[derive(Clone, Deserialize, Serialize)]
pub struct ProviderProfile {
    pub id: String,
    pub name: String,
    pub base_url: String,
    pub protocol: ApiProtocol,
    pub model: String,
    pub api_key: String,
}
impl std::fmt::Debug for ProviderProfile {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ProviderProfile")
            .field("id", &self.id)
            .field("model", &self.model)
            .field("api_key", &"[REDACTED]")
            .finish()
    }
}
impl Drop for ProviderProfile {
    fn drop(&mut self) {
        use zeroize::Zeroize;
        self.api_key.zeroize();
    }
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ApiProtocol {
    OpenaiCompletions,
    OpenaiResponses,
    AnthropicMessages,
}

impl ApiProtocol {
    pub fn patch_value(self) -> &'static str {
        match self {
            Self::OpenaiCompletions => "openai-completions",
            Self::OpenaiResponses => "openai-responses",
            Self::AnthropicMessages => "anthropic-messages",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ProviderDescriptor {
    pub id: String,
    pub name: String,
    pub base_url: String,
    pub protocol: ApiProtocol,
    pub model: String,
    pub active: bool,
    pub configured: bool,
}

impl ProviderProfile {
    pub fn descriptor(&self, active_id: &str) -> ProviderDescriptor {
        ProviderDescriptor {
            id: self.id.clone(),
            name: self.name.clone(),
            base_url: self.base_url.clone(),
            protocol: self.protocol,
            model: self.model.clone(),
            active: self.id == active_id,
            configured: !self.api_key.is_empty(),
        }
    }

    pub fn validate(&self, require_key: bool) -> Result<(), &'static str> {
        if self.id.is_empty()
            || self.id.len() > 48
            || !self.id.as_bytes()[0].is_ascii_lowercase()
            || !self
                .id
                .bytes()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
        {
            return Err("Provider ID 须以小写字母开头，并仅包含小写字母、数字和短横线");
        }
        if self.name.trim().is_empty()
            || self.name.chars().count() > 64
            || self.name.chars().any(char::is_control)
        {
            return Err("Provider 名称无效（最多 64 个字符）");
        }
        if self.model.is_empty()
            || self.model.len() > 128
            || !self
                .model
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"._:/-".contains(&c))
        {
            return Err("模型 ID 仅支持字母、数字、点、下划线、冒号、斜杠和短横线");
        }
        let parsed = Url::parse(&self.base_url).map_err(|_| "基础 URL 格式无效")?;
        if !matches!(parsed.scheme(), "https" | "http")
            || parsed.host_str().is_none()
            || !parsed.username().is_empty()
            || parsed.password().is_some()
            || parsed.query().is_some()
            || parsed.fragment().is_some()
        {
            return Err("基础 URL 须使用 HTTP(S)，且不能包含账号、密码、查询参数或片段");
        }
        let loopback_host = parsed.host_str().is_some_and(|host| {
            host.eq_ignore_ascii_case("localhost")
                || host
                    .trim_matches(['[', ']'])
                    .parse::<std::net::IpAddr>()
                    .is_ok_and(|address| address.is_loopback())
        });
        if parsed.scheme() == "http" && !loopback_host {
            return Err("远程 Provider 必须使用 HTTPS；HTTP 仅允许本机回环地址");
        }
        if self.api_key.len() > MAX_KEY_BYTES || self.api_key.chars().any(char::is_control) {
            return Err("API Key 无效或超过 2048 字节");
        }
        if require_key && self.api_key.trim().is_empty() {
            return Err("请填写 API Key");
        }
        Ok(())
    }
}

pub fn decode_profiles(encoded: &str) -> Result<Vec<ProviderProfile>, &'static str> {
    if encoded.len() > MAX_PROVIDERS_JSON_BYTES * 2 {
        return Err("Provider 配置超过安全上限");
    }
    let bytes = STANDARD
        .decode(encoded)
        .map_err(|_| "Provider 配置格式无效")?;
    if bytes.len() > MAX_PROVIDERS_JSON_BYTES {
        return Err("Provider 配置超过安全上限");
    }
    let profiles: Vec<ProviderProfile> =
        serde_json::from_slice(&bytes).map_err(|_| "Provider 配置格式无效")?;
    if profiles.len() > MAX_PROVIDERS {
        return Err("Provider 数量超过安全上限");
    }
    let mut ids = HashSet::with_capacity(profiles.len());
    for profile in &profiles {
        profile.validate(true)?;
        if !ids.insert(profile.id.as_str()) {
            return Err("Provider ID 不能重复");
        }
    }
    Ok(profiles)
}

pub fn encode_profiles(profiles: &[ProviderProfile]) -> Result<String, &'static str> {
    if profiles.len() > MAX_PROVIDERS {
        return Err("Provider 数量超过安全上限");
    }
    let mut ids = HashSet::with_capacity(profiles.len());
    for profile in profiles {
        profile.validate(true)?;
        if !ids.insert(profile.id.as_str()) {
            return Err("Provider ID 不能重复");
        }
    }
    let bytes = serde_json::to_vec(profiles).map_err(|_| "Provider 配置编码失败")?;
    if bytes.len() > MAX_PROVIDERS_JSON_BYTES {
        return Err("Provider 配置超过安全上限");
    }
    Ok(STANDARD.encode(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile() -> ProviderProfile {
        ProviderProfile {
            id: "my-model".into(),
            name: "我的模型".into(),
            base_url: "https://api.example.com/v1".into(),
            protocol: ApiProtocol::OpenaiCompletions,
            model: "example-chat".into(),
            api_key: "secret-not-for-display".into(),
        }
    }

    #[test]
    fn profile_round_trip_is_write_only_in_descriptor() {
        let profile = profile();
        let encoded = encode_profiles(std::slice::from_ref(&profile)).unwrap();
        let decoded = decode_profiles(&encoded).unwrap();
        assert_eq!(decoded[0].api_key, profile.api_key);
        let descriptor = serde_json::to_string(&profile.descriptor(&profile.id)).unwrap();
        assert!(!descriptor.contains(&profile.api_key));
    }

    #[test]
    fn rejects_urls_with_embedded_credentials_or_query_secrets() {
        let mut profile = profile();
        profile.base_url = "https://user:pass@example.com/v1".into();
        assert!(profile.validate(true).is_err());
        profile.base_url = "https://example.com/v1?token=secret".into();
        assert!(profile.validate(true).is_err());
    }

    #[test]
    fn plaintext_http_is_limited_to_loopback_endpoints() {
        let mut profile = profile();
        profile.base_url = "http://api.example.com/v1".into();
        assert!(profile.validate(true).is_err());
        profile.base_url = "http://127.0.0.1:1234/v1".into();
        assert!(profile.validate(true).is_ok());
    }

    #[test]
    fn rejects_newlines_in_credentials_and_yaml_identifiers() {
        let mut item = profile();
        item.api_key = "secret\nINJECTED=value".into();
        assert!(item.validate(true).is_err());
        item = profile();
        item.model = "model\n- id: tool-bash".into();
        assert!(item.validate(true).is_err());
    }
}
