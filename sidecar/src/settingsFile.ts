/**
 * Settings persisted inside the data folder: `settings/settings.json`.
 *
 * Same shape as the Rust `Settings` struct (contract section 3), so the
 * browser and the desktop shell read and write one file — through whichever
 * vault client is active (Rust over RPC, or the standalone filesystem vault).
 */

import type { VaultClient } from "./tools.js";

export const SETTINGS_PATH = "settings/settings.json";
export const SETTINGS_SESSION_ID = "settings";

export interface SettingsFile {
  last_root?: string | null;
  obsidian_root?: string | null;
  providers: Record<string, unknown>;
  agents: unknown[];
  [key: string]: unknown;
}

export const emptySettings = (): SettingsFile => ({ providers: {}, agents: [] });

function normalize(value: unknown): SettingsFile {
  const raw = (value ?? {}) as Record<string, unknown>;
  const providers = raw["providers"];
  const agents = raw["agents"];
  return {
    ...raw,
    providers:
      providers && typeof providers === "object" && !Array.isArray(providers)
        ? (providers as Record<string, unknown>)
        : {},
    agents: Array.isArray(agents) ? agents : [],
  };
}

export async function readSettings(client: VaultClient): Promise<SettingsFile> {
  try {
    const file = await client.request<{ content: string }>("vault/read_file", {
      session_id: SETTINGS_SESSION_ID,
      path: SETTINGS_PATH,
    });
    return normalize(JSON.parse(file.content));
  } catch {
    // Missing file or unparseable payload: start from the empty default.
    return emptySettings();
  }
}

export async function writeSettings(client: VaultClient, settings: unknown): Promise<void> {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    throw new Error("settings must be a JSON object");
  }
  await client.request("vault/write_file", {
    session_id: SETTINGS_SESSION_ID,
    path: SETTINGS_PATH,
    content: JSON.stringify(normalize(settings), null, 2) + "\n",
  });
}
