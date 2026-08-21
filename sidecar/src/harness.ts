/**
 * Optional DeepSeek Harness bridge.
 *
 * DepDek keeps the Rust Vault and its audit log as the trust boundary. The
 * harness is therefore launched as a text-only, read-only child process in a
 * throw-away working directory. It never receives a Home path and its local
 * filesystem, shell, web and sub-agent tools are disabled by a patch overlay.
 * The bridge intentionally uses the public `dsh --profile headless` surface:
 * that surface is one-shot, so this class folds a small bounded conversation
 * history into each request to provide session-like continuity.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import type { ProviderConfig } from "./providers.js";

export const HARNESS_ENGINE = "deepseek-harness" as const;
export type HarnessEngine = typeof HARNESS_ENGINE;

const DEFAULT_MODEL = "deepseek-v4-flash";
const REQUEST_TIMEOUT_MS = 120_000;
const MAX_HISTORY_CHARS = 18_000;
const DSH_INSTALL_HINT = "未找到 dsh 可执行文件。请先执行 `npm install -g @deepseek-ai/dsh@0.1.0-rc.6`，或设置 DEPDEK_DSH_COMMAND 为 dsh 的绝对路径。";

// The stock dsh-base profile contains powerful local tools. DepDek must not
// let an external harness bypass its Vault boundary, even when the user has
// configured a local or read-only Home. These rows are all capability/tool
// plugins in the current dsh profile; unknown rows are harmlessly ignored by
// the loader's patch semantics.
const RESTRICTED_ROWS = [
  "subprocess", "sandbox", "sandbox-policy", "fs-sandbox", "bash-sandbox", "pwsh-sandbox",
  "approval", "permission", "shell-env", "tool-bash", "tool-pwsh", "jobs",
  "tool-jobs", "fs-observation-policy", "tool-fs", "tool-fs-search",
  "agent-instructions", "skill", "skill-filesystem", "tool-skill", "web",
  "web-search-deepseek", "tool-web", "code-runtime", "subagent",
  "subagent-spawn-in-process", "subagent-fork-in-process", "tool-subagent-control",
  "tool-subagent-list-agents", "tool-subagent", "tool-subagent-fork",
  "tool-subagent-report", "workflow-worker-thread", "tool-workflow", "tool-todo",
  "tool-goal", "tool-ralph", "tool-str-replace-editor", "tool-pwsh",
];

export class HarnessAbortedError extends Error {
  constructor() {
    super("DeepSeek Harness run aborted");
    this.name = "HarnessAbortedError";
  }
}

export interface HarnessSpawnOptions {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export type HarnessSpawn = (options: HarnessSpawnOptions) => ChildProcessWithoutNullStreams;

function defaultSpawn(options: HarnessSpawnOptions): ChildProcessWithoutNullStreams {
  return spawn(options.command, options.args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function safeModel(model: string | undefined): string {
  const candidate = (model ?? DEFAULT_MODEL).trim();
  return /^[A-Za-z0-9._-]+$/.test(candidate) ? candidate : DEFAULT_MODEL;
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Finder-launched macOS apps do not inherit the user's interactive shell PATH
 * (in particular, paths managed by nvm). Resolve the binary before spawning so
 * a globally installed dsh works from the desktop app as well as a terminal.
 * We deliberately do not invoke npx here: downloading code at analysis time
 * would cross the user's data/consent boundary and make runs non-reproducible.
 */
async function resolveDshCommand(configured: string): Promise<string> {
  if (configured !== "dsh") return configured;

  const candidates: string[] = [];
  const add = (candidate: string) => {
    if (candidate && !candidates.includes(candidate)) candidates.push(candidate);
  };

  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (directory) add(join(directory, "dsh"));
  }

  const nvmRoot = join(homedir(), ".nvm", "versions", "node");
  try {
    const versions = (await readdir(nvmRoot)).sort().reverse();
    for (const version of versions) add(join(nvmRoot, version, "bin", "dsh"));
  } catch {
    // nvm is optional; continue with the other conventional install paths.
  }

  for (const candidate of [
    join(homedir(), ".local", "bin", "dsh"),
    join(homedir(), ".npm-global", "bin", "dsh"),
    "/opt/homebrew/bin/dsh",
    "/usr/local/bin/dsh",
    "/usr/bin/dsh",
  ]) add(candidate);

  for (const candidate of candidates) {
    if (await isExecutable(candidate)) return candidate;
  }
  return "dsh";
}

function envForCommand(command: string): NodeJS.ProcessEnv {
  // dsh is published with a `#!/usr/bin/env node` launcher. Finder-launched
  // apps often have no nvm directory in PATH, so include the directory that
  // contains a resolved dsh binary before spawning it.
  if (!command.includes("/")) return { ...process.env };
  const commandDir = dirname(command);
  const inheritedPath = process.env.PATH ?? "";
  const path = [commandDir, inheritedPath].filter(Boolean).join(delimiter);
  return { ...process.env, PATH: path };
}

function policyYaml(model: string): string {
  const rows = RESTRICTED_ROWS.map((id) => `- id: ${id}\n  disabled: true`).join("\n");
  return `${rows}\n- id: agent-default-model\n  config:\n    provider: deepseek-official\n    model: ${safeModel(model)}\n`;
}

function composeTask(systemPrompt: string | undefined, history: string[], text: string): string {
  const prior = history.join("\n\n").slice(-MAX_HISTORY_CHARS);
  return [
    "You are the DepDek Agent Team assistant running through DeepSeek Harness.",
    "This is a text-only turn. Do not claim to have changed files, sent mail, or modified external services.",
    systemPrompt?.trim() ? `Agent instructions:\n${systemPrompt.trim()}` : "",
    prior ? `Conversation context (may be truncated):\n${prior}` : "",
    `Current user request:\n${text.trim()}`,
    "Return a concise answer in Markdown.",
  ].filter(Boolean).join("\n\n");
}

export interface HarnessRunnerOptions {
  command?: string;
  spawn?: HarnessSpawn;
  timeoutMs?: number;
  /** Safe, user-facing execution milestones. Never pass raw chain-of-thought here. */
  onProgress?: (event: { phase: string; message: string }) => void;
}

/** A stateful, bounded adapter around dsh's public one-shot headless runner. */
export class DeepSeekHarnessSession {
  private readonly command: string;
  private readonly spawnProcess: HarnessSpawn;
  private readonly timeoutMs: number;
  private readonly history: string[] = [];
  private readonly model: string;
  private readonly onProgress?: HarnessRunnerOptions["onProgress"];
  private active?: ChildProcessWithoutNullStreams;
  private runtimeDir?: string;
  private policyPath?: string;
  private busy = false;
  private abortRequested = false;

  constructor(
    private readonly provider: ProviderConfig,
    private readonly systemPrompt?: string,
    options: HarnessRunnerOptions = {},
    private readonly sessionId = "unknown",
  ) {
    this.command = options.command ?? process.env.DEPDEK_DSH_COMMAND ?? "dsh";
    this.spawnProcess = options.spawn ?? defaultSpawn;
    this.timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
    this.model = safeModel(provider.model);
    this.onProgress = options.onProgress;
  }

  private progress(phase: string, message: string): void {
    this.onProgress?.({ phase, message });
  }

  async prompt(text: string): Promise<string> {
    if (this.busy) throw new Error("DeepSeek Harness session is busy");
    this.busy = true;
    this.abortRequested = false;
    this.progress("started", "DeepSeek Harness 已启动");
    if (this.provider.kind === "anthropic") {
      this.busy = false;
      throw new Error("DeepSeek Harness 当前只支持 DeepSeek/OpenAI 兼容 provider；请为该 Agent 选择 DeepSeek provider");
    }
    if (this.provider.kind === "openai-compatible") {
      try {
        const host = new URL(this.provider.base_url).hostname.toLowerCase();
        if (["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
          this.busy = false;
          throw new Error("DeepSeek Harness 不会调用本地 Ollama/兼容端点；请切换为 DeepSeek provider，或使用 Pi Agent Core");
        }
      } catch (error) {
        if (error instanceof Error && error.message.includes("不会调用本地")) throw error;
        throw new Error("DeepSeek Harness 的 OpenAI-compatible provider 地址无效");
      }
    }
    const command = await resolveDshCommand(this.command);
    let runtimeDir: string;
    try {
      runtimeDir = await this.ensureRuntimeDir();
      this.progress("policy", "已加载 Harness 只读策略");
    } catch (error) {
      this.busy = false;
      throw error;
    }
    if (this.abortRequested) {
      this.busy = false;
      throw new HarnessAbortedError();
    }
    const task = composeTask(this.systemPrompt, this.history, text);
    this.progress("thinking", "DeepSeek Harness 正在分析当前上下文");
    let child: ChildProcessWithoutNullStreams;
    try {
      child = this.spawnProcess({
        command,
        args: ["--profile", "headless", "--patch", this.policyPath!, task],
        cwd: runtimeDir,
        env: {
          ...envForCommand(command),
          // Do not inherit a telemetry opt-in from a developer shell.
          DSH_TELEMETRY_DISABLED: "1",
          DSH_PERMISSION_MODE: "read-only",
          DSH_HOME: runtimeDir,
          ...(this.provider.api_key ? { DEEPSEEK_API_KEY: this.provider.api_key } : {}),
        },
      });
      this.progress("generating", "DeepSeek Harness 正在生成回答");
      console.error(`[depdek-harness] session=${this.sessionId} engine=deepseek-harness profile=headless model=${this.model} command=${command}`);
    } catch (error) {
      this.busy = false;
      throw error;
    }
    this.active = child;
    try {
      const answer = await this.collect(child, command);
      const trimmed = answer.trim();
      if (!trimmed) throw new Error("DeepSeek Harness 返回了空响应");
      this.progress("complete", "DeepSeek Harness 已完成分析");
      this.history.push(`用户：${text.trim()}`, `助手：${trimmed}`);
      while (this.history.join("\n\n").length > MAX_HISTORY_CHARS) this.history.splice(0, 2);
      return trimmed;
    } finally {
      if (this.active === child) this.active = undefined;
      this.busy = false;
    }
  }

  abort(): void {
    this.abortRequested = true;
    const child = this.active;
    if (!child) return;
    child.kill("SIGTERM");
    this.active = undefined;
    this.busy = false;
  }

  async dispose(): Promise<void> {
    this.abort();
    if (this.runtimeDir) await rm(this.runtimeDir, { recursive: true, force: true }).catch(() => {});
    this.runtimeDir = undefined;
    this.policyPath = undefined;
  }

  private async ensureRuntimeDir(): Promise<string> {
    if (this.runtimeDir && this.policyPath) return this.runtimeDir;
    this.runtimeDir = await mkdtemp(join(tmpdir(), "depdek-harness-"));
    this.policyPath = join(this.runtimeDir, "depdek-restricted.patch.yml");
    await writeFile(this.policyPath, policyYaml(this.model), "utf8");
    return this.runtimeDir;
  }

  private collect(child: ChildProcessWithoutNullStreams, command: string): Promise<string> {
    return new Promise((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill("SIGTERM");
        reject(new Error(`DeepSeek Harness 超时（${Math.round(this.timeoutMs / 1000)} 秒）`));
      }, this.timeoutMs);
      child.stdout.on("data", (chunk: Buffer | string) => { stdout += String(chunk); });
      child.stderr.on("data", (chunk: Buffer | string) => { stderr += String(chunk); });
      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const code = (error as NodeJS.ErrnoException).code;
        reject(new Error(code === "ENOENT"
          ? DSH_INSTALL_HINT
          : `无法启动 DeepSeek Harness「${command}」：${error.message}`));
      });
      child.once("close", (code, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (signal || code === null) {
          reject(new HarnessAbortedError());
          return;
        }
        if (code !== 0) {
          const detail = stderr.trim().split("\n").filter(Boolean).slice(-3).join("\n");
          reject(new Error(detail || `DeepSeek Harness 退出码 ${code}`));
          return;
        }
        console.error(`[depdek-harness] session=${this.sessionId} completed exit=0`);
        resolve(stdout);
      });
    });
  }
}
