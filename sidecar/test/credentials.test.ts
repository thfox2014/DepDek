import { describe, expect, it } from "vitest";
import { createCipheriv, randomBytes } from "node:crypto";

import {
  createCredentialsAccess,
  isSecretRef,
  isSecretRefOrEmpty,
  MASTER_KEY_REL,
  parseSecretRef,
  secretRef,
} from "../src/credentials.js";
import { RpcError } from "../src/rpc.js";
import type { VaultClient } from "../src/tools.js";

/** In-memory vault with the binary methods credentials.ts depends on. */
function fakeVault(initial: Record<string, string> = {}, binary: Record<string, Buffer> = {}) {
  const files = new Map(Object.entries(initial));
  const binaryFiles = new Map(Object.entries(binary));
  const calls: string[] = [];
  const vault: VaultClient = {
    request: async (method: string, params: any) => {
      calls.push(method);
      if (method === "vault/read_file") {
        const content = files.get(params.path);
        if (content === undefined) throw new RpcError(-32002, "path not found");
        return { content, size: content.length, sha256: "x" };
      }
      if (method === "vault/write_file") {
        files.set(params.path, params.content);
        return { size: params.content.length, sha256: "x" };
      }
      if (method === "vault/read_binary") {
        const data = binaryFiles.get(params.path);
        if (data === undefined) throw new RpcError(-32002, "path not found");
        return { data_base64: data.toString("base64"), size: data.length, mime: "application/octet-stream" };
      }
      if (method === "vault/write_binary") {
        binaryFiles.set(params.path, Buffer.from(params.data_base64, "base64"));
        return { size: params.data_base64.length, sha256: "x" };
      }
      throw new Error(`unexpected method ${method}`);
    },
  };
  return { vault, files, binaryFiles, calls };
}

describe("credentials (sidecar credentials.ts)", () => {
  it("round-trips a secret through the AES-256-GCM blob", async () => {
    const { vault } = fakeVault();
    const access = await createCredentialsAccess(vault, "mail");
    await access.setSecret("mail", "work.password", "hunter2");

    const got = await createCredentialsAccess(vault, "mail").then((a) =>
      a.getSecret("mail", "work.password"),
    );
    expect(got).toBe("hunter2");
    expect(await access.hasSecret("mail", "work.password")).toBe(true);
  });

  it("creates a 32-byte master key on first use and reuses it", async () => {
    const { vault, binaryFiles } = fakeVault();
    await createCredentialsAccess(vault, "mail").then((a) => a.getSecret("mail", "x"));
    expect(binaryFiles.get(MASTER_KEY_REL)?.length).toBe(32);
    const first = binaryFiles.get(MASTER_KEY_REL)!;
    await createCredentialsAccess(vault, "mail").then((a) => a.setSecret("mail", "y", "v"));
    expect(binaryFiles.get(MASTER_KEY_REL)!.toString("hex")).toBe(first.toString("hex"));
  });

  it("never stores plaintext in the blob file", async () => {
    const { vault, files } = fakeVault();
    const access = await createCredentialsAccess(vault, "settings");
    await access.setSecret("providers", "DeepSeek.api_key", "sk-super-secret");
    const blob = files.get("secrets/providers.enc.json")!;
    expect(blob).not.toContain("sk-super-secret");
    // Base64 ciphertext is never a plain copy either.
    expect(blob).not.toContain(Buffer.from("sk-super-secret").toString("base64"));
  });

  it("rejects tampered ciphertext (GCM authentication tag)", async () => {
    const { vault, files } = fakeVault();
    const access = await createCredentialsAccess(vault, "mail");
    await access.setSecret("mail", "a", "value");
    const blobPath = "secrets/mail.enc.json";
    const blob = JSON.parse(files.get(blobPath)!);
    const tampered = Buffer.from(blob.entries.a, "base64");
    tampered[0] ^= 0xff;
    blob.entries.a = tampered.toString("base64");
    files.set(blobPath, JSON.stringify(blob));

    await expect(
      createCredentialsAccess(vault, "mail").then((a) => a.getSecret("mail", "a")),
    ).rejects.toThrow();
  });

  it("deleteSecret removes the entry and persists the blob", async () => {
    const { vault } = fakeVault();
    const access = await createCredentialsAccess(vault, "mail");
    await access.setSecret("mail", "gone", "v");
    await access.deleteSecret("mail", "gone");
    expect(await access.getSecret("mail", "gone")).toBeUndefined();
    expect(await access.hasSecret("mail", "gone")).toBe(false);
  });

  it("missing secret returns undefined (legacy plaintext fallback path)", async () => {
    const { vault } = fakeVault();
    const access = await createCredentialsAccess(vault, "mail");
    expect(await access.getSecret("mail", "does-not-exist")).toBeUndefined();
  });

  it("secret reference helpers parse and validate", () => {
    expect(secretRef("mail", "work.password")).toBe("$secret:mail.work.password");
    expect(isSecretRef("$secret:mail.work.password")).toBe(true);
    expect(isSecretRef("plaintext")).toBe(false);
    expect(parseSecretRef("$secret:mail.work.password")).toEqual({ scope: "mail", key: "work.password" });
    expect(parseSecretRef("plain")).toBeNull();
    expect(isSecretRefOrEmpty("")).toBe(true);
    expect(isSecretRefOrEmpty("********")).toBe(true);
    expect(isSecretRefOrEmpty("$secret:a.b")).toBe(true);
    expect(isSecretRefOrEmpty("real")).toBe(false);
  });

  it("rejects invalid scopes (path traversal / empty)", async () => {
    const { vault } = fakeVault();
    const access = await createCredentialsAccess(vault, "mail");
    for (const scope of ["", ".", "..", "a/b", "a\\b", "a.b"]) {
      await expect(access.setSecret(scope, "k", "v")).rejects.toThrow();
    }
  });

  it("encrypts the same plaintext to distinct ciphertexts (fresh nonce)", async () => {
    const { vault, files } = fakeVault();
    const access = await createCredentialsAccess(vault, "mail");
    await access.setSecret("mail", "a", "same");
    await access.setSecret("mail", "b", "same");
    const blob = JSON.parse(files.get("secrets/mail.enc.json")!);
    expect(blob.entries.a).not.toBe(blob.entries.b);
  });

  it("is interoperable with node:crypto AES-256-GCM blob format (nonce||ct||tag)", async () => {
    // Bake a blob with the migration script's exact format and read it back.
    const key = randomBytes(32);
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    const ct = Buffer.concat([cipher.update("from-migration", "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    const blob = Buffer.concat([nonce, ct, tag]).toString("base64");

    const { vault } = fakeVault(
      { "secrets/mail.enc.json": JSON.stringify({ version: 1, entries: { "migrated.password": blob } }) },
      { [MASTER_KEY_REL]: key },
    );
    const got = await createCredentialsAccess(vault, "mail").then((a) =>
      a.getSecret("mail", "migrated.password"),
    );
    expect(got).toBe("from-migration");
  });
});