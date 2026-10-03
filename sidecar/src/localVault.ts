/**
 * Filesystem vault for the standalone sidecar.
 *
 * In the desktop build every agent file operation goes through the Rust vault
 * (sandbox + audit). Standalone mode — the browser preview or a headless
 * appliance — has no Rust process, so this client honours the same contract
 * directly: relative POSIX paths inside a single data-folder root, absolute
 * paths and `..` escapes rejected, UTF-8 text only, 10 MiB per file.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve, sep } from "node:path";

import { RpcError } from "./rpc.js";
import type { VaultClient } from "./tools.js";

const ERR_PATH = -32001;
const ERR_TOO_LARGE = -32003;
const MAX_BYTES = 10 * 1024 * 1024;

/** Credential / private files that agent sessions may not touch. */
const PROTECTED_PATHS = [
  "tasks/history.json",
  "mail/accounts.json",
  "calendar/accounts.json",
  "settings/settings.json",
];

/** First-party sessions (UI + connectors) that may access protected files. */
const TRUSTED_SESSIONS = new Set(["user", "mail", "calendar", "settings"]);

export class LocalVault implements VaultClient {
  private readonly prefix: string;

  constructor(private readonly root: string) {
    this.prefix = root.endsWith(sep) ? root : root + sep;
  }

  async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    const args = (params ?? {}) as { path?: string; content?: string; session_id?: string };
    const sessionId = args.session_id ?? "";
    const rel = String(args.path ?? "")
      .trim()
      .replaceAll("\\", "/")
      .replace(/^\.\/+/, "")
      .replace(/\/+$/, "");
    if (!TRUSTED_SESSIONS.has(sessionId) && PROTECTED_PATHS.includes(rel)) {
      throw new RpcError(ERR_PATH, "access to credential/private files is denied");
    }
    switch (method) {
      case "vault/read_file":
        return (await this.read(args.path)) as T;
      case "vault/write_file":
        return (await this.write(args.path, args.content)) as T;
      default:
        throw new RpcError(-32601, `standalone sidecar does not implement ${method}`);
    }
  }

  private resolvePath(path: string | undefined): string {
    const value = String(path ?? "").trim().replaceAll("\\", "/");
    if (!value) throw new RpcError(ERR_PATH, "path is required");
    if (isAbsolute(value)) throw new RpcError(ERR_PATH, "absolute paths are rejected");
    const target = resolve(this.root, value);
    if (target !== this.root && !target.startsWith(this.prefix)) {
      throw new RpcError(ERR_PATH, "path escapes the data folder");
    }
    return target;
  }

  private async read(path: string | undefined) {
    const target = this.resolvePath(path);
    try {
      const content = await readFile(target, "utf8");
      return { content, size: Buffer.byteLength(content, "utf8") };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new RpcError(ERR_PATH, `file not found: ${path}`);
      }
      throw err;
    }
  }

  private async write(path: string | undefined, content: string | undefined) {
    const text = String(content ?? "");
    const size = Buffer.byteLength(text, "utf8");
    if (size > MAX_BYTES) throw new RpcError(ERR_TOO_LARGE, "file exceeds the 10 MiB cap");
    const target = this.resolvePath(path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, text, "utf8");
    return { size };
  }
}
