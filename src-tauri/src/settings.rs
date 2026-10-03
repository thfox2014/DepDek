//! Settings and provider configuration types (contract section 3).
//! Persistence via tauri-plugin-store lives in `app.rs`.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

/// Model provider configuration; identical shape across all three tiers.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind")]
pub enum ProviderConfig {
    #[serde(rename = "openai")]
    OpenAi {
        api_key: String,
        model: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        base_url: Option<String>,
    },
    #[serde(rename = "anthropic")]
    Anthropic { api_key: String, model: String },
    /// Covers Ollama and other OpenAI-compatible local endpoints.
    #[serde(rename = "openai-compatible")]
    OpenAiCompatible {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        api_key: Option<String>,
        model: String,
        base_url: String,
    },
}

impl ProviderConfig {
    /// Borrow the mutable `api_key` (OpenAI-compatible providers make it optional).
    pub fn api_key_mut(&mut self) -> Option<&mut String> {
        match self {
            ProviderConfig::OpenAi { api_key, .. } | ProviderConfig::Anthropic { api_key, .. } => {
                Some(api_key)
            }
            ProviderConfig::OpenAiCompatible { api_key, .. } => api_key.as_mut(),
        }
    }

    /// Borrow the `api_key`.
    pub fn api_key(&self) -> Option<&str> {
        match self {
            ProviderConfig::OpenAi { api_key, .. } | ProviderConfig::Anthropic { api_key, .. } => {
                Some(api_key.as_str())
            }
            ProviderConfig::OpenAiCompatible { api_key, .. } => api_key.as_deref(),
        }
    }
}

/// A saved agent session configuration, restored on next launch.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SavedAgent {
    pub id: String,
    pub label: String,
    pub provider_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system_prompt: Option<String>,
    /// Relative vault directory containing optional agent.md/skill.md/mcp.md
    /// prompt material. These files are never treated as executable tools by
    /// the one-shot analysis endpoint.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub config_dir: Option<String>,
    /// Execution engine: `pi` (default) or the optional DeepSeek Harness bridge.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub engine: Option<String>,
    /// Capability groups enabled for this agent; an explicit empty list disables all tools.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled_skills: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(default)]
pub struct Settings {
    pub last_root: Option<String>,
    /// Read-only Obsidian vault connection, kept outside the writable Home.
    pub obsidian_root: Option<String>,
    /// Display name -> provider config.
    pub providers: HashMap<String, ProviderConfig>,
    /// Saved agent session configurations, restored on next launch.
    pub agents: Vec<SavedAgent>,
}

#[cfg(test)]
mod tests {
    use super::Settings;

    #[test]
    fn saved_agent_skills_are_backward_compatible_and_preserve_explicit_empty() {
        let old = serde_json::json!({
            "providers": {},
            "agents": [{ "id": "old", "label": "Old", "provider_name": "p" }]
        });
        let loaded: Settings = serde_json::from_value(old).unwrap();
        assert_eq!(loaded.agents[0].enabled_skills, None);

        let explicit_none = serde_json::json!({
            "providers": {},
            "agents": [{ "id": "isolated", "label": "Isolated", "provider_name": "p", "enabled_skills": [] }]
        });
        let loaded: Settings = serde_json::from_value(explicit_none).unwrap();
        assert_eq!(loaded.agents[0].enabled_skills, Some(Vec::new()));
    }
}
