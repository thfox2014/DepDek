#!/usr/bin/env node
/**
 * One-shot migration of plaintext credentials into the encrypted secret
 * store (P1, contract sections 7 and 9).
 *
 *   node scripts/migrate-credentials.mjs --root <data-folder>
 *
 * What it does per file, always safely:
 *   1. ensures `secrets/master.key` exists (32 random bytes, chmod 600);
 *   2. for every plaintext credential found in mail/accounts.json,
 *      calendar/accounts.json and settings/settings.json, encrypts it into
 *      `secrets/<scope>.enc.json` and replaces the field with a `$secret:`
 *      reference;
 *   3. writes each config file back atomically (temp + rename). If that write
 *      fails the plaintext stays on disk and a warning is printed — the
 *      encrypted copy is kept but the file is left untouched for the user.
 *
 * Idempotent: already-migrated fields and `$secret:` references are skipped,
 * so re-running is a no-op that only reports the remaining plaintext.
 */

import { randomBytes, createCipheriv } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const SECRET_REF_PREFIX = "$secret:";
const DEFAULT_ROOT = join(homedir(), "DepDek-Home");

function cliValue(flag) {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === flag) return argv[i + 1];
    if (argv[i]?.startsWith(`${flag}=`)) return argv[i].slice(flag.length + 1);
  }
  return undefined;
}

function encrypt(key, plain) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([nonce, ciphertext, tag]).toString("base64");
}

function secretRef(scope, key) {
  return `${SECRET_REF_PREFIX}${scope}.${key}`;
}

function isSecretRef(value) {
  return typeof value === "string" && value.startsWith(SECRET_REF_PREFIX);
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

async function writeJsonAtomic(path, value) {
  const tmp = `${path}.migrating.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`);
  await rename(tmp, path);
}

async function ensureMasterKey(root) {
  const keyPath = join(root, "secrets/master.key");
  try {
    const bytes = await readFile(keyPath);
    if (bytes.length !== 32) throw new Error(`master key has wrong length: ${bytes.length}`);
    return bytes;
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
    const key = randomBytes(32);
    await mkdir(dirname(keyPath), { recursive: true });
    await writeFile(keyPath, key);
    try {
      await chmod(keyPath, 0o600);
    } catch {
      // Windows: no POSIX permission model; skip.
    }
    return key;
  }
}

/**
 * Migrate one config file. `entriesFor(file)` must return an array of
 * `[id, entry]` pairs where `entry` is the LIVE object from the parsed file —
 * mutating it is what makes the rewritten file carry `$secret:` refs.
 */
async function migrateFile(root, key, report, scopeStates, relPath, entriesFor, fieldKeys) {
  const path = join(root, relPath);
  const file = await readJson(path);
  if (file == null) return;

  const list = entriesFor(file);
  if (!Array.isArray(list)) return;

  const scope = fieldKeys.scope;
  let state = scopeStates.get(scope);
  if (!state) {
    state = (await readJson(join(root, `secrets/${scope}.enc.json`))) ?? { version: 1, entries: {} };
    scopeStates.set(scope, state);
  }

  let changed = false;
  for (const [id, entry] of list) {
    if (!id || !entry) continue;
    for (const field of fieldKeys.fields) {
      const value = entry[field];
      if (typeof value !== "string") continue;
      if (isSecretRef(value)) {
        report.skipped += 1;
        continue;
      }
      if (value === "") continue;
      const refKey = `${id}.${field}`;
      state.entries[refKey] = encrypt(key, value);
      entry[field] = secretRef(scope, refKey);
      report.encrypted += 1;
      changed = true;
    }
  }
  if (!changed) return;

  // Persist ciphertext first; only then rewrite the config file. A failed
  // config write keeps the plaintext on disk and logs a warning.
  await writeJsonAtomic(join(root, `secrets/${scope}.enc.json`), state);
  try {
    await writeJsonAtomic(path, file);
  } catch (err) {
    report.warnings.push(`无法写回 ${path}（明文已保留，可手工迁移）：${err.message}`);
  }
}

async function run() {
  const root = resolve(cliValue("--root") ?? process.env.DEPDEK_HOME ?? DEFAULT_ROOT);
  const report = { encrypted: 0, skipped: 0, warnings: [] };
  const key = await ensureMasterKey(root);
  const scopeStates = new Map();

  // mail/accounts.json — password.
  await migrateFile(root, key, report, scopeStates, "mail/accounts.json", (f) =>
    (f?.accounts ?? []).map((a) => [a?.name, a]),
  {
    scope: "mail",
    fields: ["password"],
  });

  // calendar/accounts.json — password and access_token.
  await migrateFile(root, key, report, scopeStates, "calendar/accounts.json", (f) =>
    (f?.accounts ?? []).map((a) => [a?.id, a]),
  {
    scope: "calendar",
    fields: ["password", "access_token"],
  });

  // settings/settings.json — provider api_key (lives inside provider records).
  await migrateFile(root, key, report, scopeStates, "settings/settings.json", (f) =>
    Object.entries(f?.providers ?? {}),
  {
    scope: "providers",
    fields: ["api_key"],
  });

  console.log(`凭据迁移完成（数据目录 ${root}）`);
  console.log(`  加密 ${report.encrypted} 项，跳过 ${report.skipped} 项（已是占位或未配置）`);
  if (report.warnings.length) {
    console.warn("  警告：");
    for (const warning of report.warnings) console.warn(`    - ${warning}`);
  }
  console.log("  说明：明文将不再写入配置；密钥文件位于 secrets/master.key（0600）。");
}

run().catch((err) => {
  console.error(`迁移失败：${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});