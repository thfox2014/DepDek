/**
 * Encrypted credential store for the standalone sidecar (browser preview,
 * headless appliances) — mirrors `src-tauri/src/credentials.rs`.
 *
 * The desktop shell encrypts through the Rust module; this file implements
 * the exact same wire format so both tiers share one key and one set of
 * ciphertext blobs:
 *
 *   - master key: 32 random bytes at `secrets/master.key` (created lazily)
 *   - blob file:   `secrets/<scope>.enc.json` = { version: 1, entries: { key: "<enc>" } }
 *   - ciphertext:  base64( nonce(12) || ciphertext || tag(16) ), AES-256-GCM
 *
 * All file access goes through the same vault client the agent tools use
 * (with a trusted first-party session id), never direct filesystem access.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import { RpcError } from "./rpc.js";
import type { VaultClient } from "./tools.js";

const ENC_NONCE_BYTES = 12;
const TAG_BYTES = 16;
const MASTER_KEY_BYTES = 32;
export const MASTER_KEY_REL = "secrets/master.key";
export const SECRET_REF_PREFIX = "$secret:";

export interface SecretRef {
  scope: string;
  key: string;
}

/** `$secret:<scope>.<key>` inline reference. */
export function secretRef(scope: string, key: string): string {
  return `${SECRET_REF_PREFIX}${scope}.${key}`;
}

export function isSecretRef(value: string | undefined | null): value is string {
  return typeof value === "string" && value.startsWith(SECRET_REF_PREFIX);
}

export function parseSecretRef(value: string): SecretRef | null {
  const rest = value.startsWith(SECRET_REF_PREFIX)
    ? value.slice(SECRET_REF_PREFIX.length)
    : null;
  if (!rest) return null;
  const dot = rest.indexOf(".");
  if (dot <= 0 || dot === rest.length - 1) return null;
  return { scope: rest.slice(0, dot), key: rest.slice(dot + 1) };
}

export function isSecretRefOrEmpty(value: string | undefined | null): boolean {
  return value == null || value === "" || isSecretRef(value) || value === "********";
}

/** Scope is a plain file name: no separators, no dots/empty. Dots are banned
 *  because `$secret:<scope>.<key>` parsing splits on the first dot. */
function assertValidScope(scope: string): void {
  if (
    !scope.trim() ||
    scope === "." ||
    scope === ".." ||
    scope.includes(".") ||
    scope.includes("/") ||
    scope.includes("\\") ||
    scope.includes("\0")
  ) {
    throw new RpcError(-32602, `invalid secret scope: ${JSON.stringify(scope)}`);
  }
}

function encrypt(key: Buffer, plain: string): string {
  const nonce = randomBytes(ENC_NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([nonce, ciphertext, tag]).toString("base64");
}

function decrypt(key: Buffer, blob: string): string {
  const raw = Buffer.from(blob, "base64");
  if (raw.length <= ENC_NONCE_BYTES + TAG_BYTES) {
    throw new RpcError(-32603, "credential blob is malformed");
  }
  const nonce = raw.subarray(0, ENC_NONCE_BYTES);
  const ciphertext = raw.subarray(ENC_NONCE_BYTES, raw.length - TAG_BYTES);
  const tag = raw.subarray(raw.length - TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

interface BlobFile {
  version: number;
  entries: Record<string, string>;
}

export interface CredentialsAccess {
  getSecret(scope: string, key: string): Promise<string | undefined>;
  setSecret(scope: string, key: string, value: string): Promise<void>;
  deleteSecret(scope: string, key: string): Promise<void>;
  hasSecret(scope: string, key: string): Promise<boolean>;
}

/**
 * Build a store bound to one vault client. `sessionId` must be a trusted
 * first-party session (`mail`/`calendar`/`settings`) so the Rust vault and
 * LocalVault both allow reads of the protected secrets/ tree.
 */
export async function createCredentialsAccess(
  vault: VaultClient,
  sessionId: string,
): Promise<CredentialsAccess> {
  assertValidScope("secrets");
  const key = await ensureMasterKey(vault, sessionId);
  return {
    async getSecret(scope, keyName) {
      const blob = await loadBlob(vault, sessionId, scope);
      const enc = blob.entries[keyName];
      return enc === undefined ? undefined : decrypt(key, enc);
    },
    async setSecret(scope, keyName, value) {
      const blob = await loadBlob(vault, sessionId, scope);
      blob.entries[keyName] = encrypt(key, value);
      await storeBlob(vault, sessionId, scope, blob);
    },
    async deleteSecret(scope, keyName) {
      const blob = await loadBlob(vault, sessionId, scope);
      if (keyName in blob.entries) {
        delete blob.entries[keyName];
        await storeBlob(vault, sessionId, scope, blob);
      }
    },
    async hasSecret(scope, keyName) {
      return keyName in (await loadBlob(vault, sessionId, scope)).entries;
    },
  };
}

async function ensureMasterKey(vault: VaultClient, sessionId: string): Promise<Buffer> {
  try {
    const file = await vault.request<{ data_base64: string; size: number }>(
      "vault/read_binary",
      { session_id: sessionId, path: MASTER_KEY_REL },
    );
    const key = Buffer.from(file.data_base64, "base64");
    if (key.length !== MASTER_KEY_BYTES) {
      throw new RpcError(-32603, `master key has wrong length: ${key.length}`);
    }
    return key;
  } catch (err) {
    if (err instanceof RpcError && (err.code === -32001 || err.code === -32002)) {
      const key = randomBytes(MASTER_KEY_BYTES);
      await vault.request("vault/write_binary", {
        session_id: sessionId,
        path: MASTER_KEY_REL,
        data_base64: key.toString("base64"),
      });
      return key;
    }
    throw err;
  }
}

async function loadBlob(
  vault: VaultClient,
  sessionId: string,
  scope: string,
): Promise<BlobFile> {
  assertValidScope(scope);
  try {
    const file = await vault.request<{ content: string }>("vault/read_file", {
      session_id: sessionId,
      path: `secrets/${scope}.enc.json`,
    });
    const parsed = JSON.parse(file.content) as BlobFile;
    return { version: 1, entries: parsed.entries ?? {} };
  } catch (err) {
    if (err instanceof RpcError && (err.code === -32001 || err.code === -32002)) {
      return { version: 1, entries: {} };
    }
    throw err;
  }
}

async function storeBlob(
  vault: VaultClient,
  sessionId: string,
  scope: string,
  blob: BlobFile,
): Promise<void> {
  await vault.request("vault/write_file", {
    session_id: sessionId,
    path: `secrets/${scope}.enc.json`,
    content: `${JSON.stringify(blob, null, 2)}\n`,
  });
}