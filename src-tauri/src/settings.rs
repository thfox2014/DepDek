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
