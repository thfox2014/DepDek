import type {
  BusinessSession,
  Household,
  PackagePlan,
  Profile,
  Resource,
  RoomAnswer,
  RoomConfig,
} from "./types.ts";
import {
  categoryOf,
  joinResourcePath,
  validProfile,
  withinPromptLimit,
} from "./utils.ts";

const messages: Record<string, string> = {
  AUTH_REQUIRED: "请先登录你的家庭空间。",
  SESSION_EXPIRED: "登录已过期，请重新登录。",
  ADMIN_AUTH_REQUIRED:
    "模型元数据需要管理员配置；家庭登录不会自动获得管理权限。",
  FORBIDDEN: "当前账户没有这项权限。",
  NOT_FOUND: "当前范围没有这份资料。",
  CSRF_REQUIRED: "会话校验已失效，请重新登录。",
  ORIGIN_REJECTED: "服务端尚未允许这个前端来源，请检查 business_origin。",
  CAPABILITY_UNAVAILABLE: "这台家合尚未开放此能力。",
  BUSINESS_AUTH_DISABLED: "当前服务以无认证模式运行，不能访问私人业务。",
  CORE_UNAVAILABLE: "家合核心暂时没有连接。",
  NETWORK_UNAVAILABLE: "暂时连不上家合，请检查连接后重试。",
  PROVIDER_AUTH_FAILED: "模型凭据未通过验证，请管理员检查。",
  PROVIDER_REQUEST_REJECTED: "模型配置或请求未被接受。",
  PROVIDER_QUOTA_LIMITED: "模型额度不足或请求过于频繁。",
  PROVIDER_UNAVAILABLE: "模型服务暂时不可用。",
  SECRET_STORE_LOCKED: "模型凭据库已锁定，需要管理员在主机上解锁。",
  SECRET_STORE_NOT_INITIALIZED: "主机尚未配置安全凭据库。",
  MODEL_OUTCOME_UNKNOWN: "未取得明确的模型结果，不会自动重试。",
  ENGINE_RUN_FAILED: "执行器未能完成请求。",
  INVALID_INPUT: "输入格式不正确。",
  LIMIT_EXCEEDED: "内容超过当前接口限制。",
  CONFLICT: "资料或配置版本已变化，请刷新后核对。",
  RATE_LIMITED: "操作过于频繁，请稍后再试。",
  SECURE_TRANSPORT_REQUIRED: "当前传输不满足安全要求。",
  INVALID_RESPONSE: "服务器返回了无法识别的响应。",
  PROFILE_REQUIRED: "请先在模型连接中选择主机发布的 Provider。",
  AUDIT_UNAVAILABLE: "审计暂不可用，系统没有继续操作。",
  UNKNOWN_RESPONSE: "没有取得明确回执，不会自动重复提交。",
};
export class ApiError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(messages[code] || "请求未能完成，请检查服务配置。");
    this.name = "ApiError";
    this.code = code;
  }
}
export const requiresLogin = (error: unknown) =>
  error instanceof ApiError &&
  ["AUTH_REQUIRED", "SESSION_EXPIRED", "CSRF_REQUIRED"].includes(error.code);

/** Only fixed existing business routes. No raw RPC, administrator identity or arbitrary endpoint. */
export class MobileApi {
  private session: BusinessSession | null = null;
  private generation = 0;
  private fetcher: typeof fetch;
  constructor(fetcher: typeof fetch = globalThis.fetch.bind(globalThis)) {
    this.fetcher = fetcher;
  }
  clearSession() {
    this.session = null;
    this.generation++;
  }
  private async request<T>(
    path: string,
    body?: object,
    authenticated = false,
    timeout = 60000,
  ): Promise<T> {
    if (authenticated && !this.session) throw new ApiError("AUTH_REQUIRED");
    const generation = this.generation;
    const controller = new AbortController();
    const timer = globalThis.setTimeout(() => controller.abort(), timeout);
    try {
      const headers: Record<string, string> = { accept: "application/json" };
      if (body) headers["content-type"] = "application/json";
      if (authenticated && body && this.session)
        headers["x-depdek-business-csrf"] = this.session.csrf_token;
      const response = await this.fetcher(path, {
        method: body ? "POST" : "GET",
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      const value: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const candidate = (value as { error?: { code?: unknown } })?.error
          ?.code;
        const code =
          typeof candidate === "string" && Object.hasOwn(messages, candidate)
            ? candidate
            : response.status === 401
              ? "AUTH_REQUIRED"
              : "UNKNOWN_RESPONSE";
        if (
          ["AUTH_REQUIRED", "SESSION_EXPIRED", "CSRF_REQUIRED"].includes(
            code,
          ) &&
          generation === this.generation
        )
          this.clearSession();
        throw new ApiError(code);
      }
      if (authenticated && generation !== this.generation)
        throw new ApiError("SESSION_EXPIRED");
      if (!value || typeof value !== "object" || !("data" in value))
        throw new ApiError("INVALID_RESPONSE");
      return (value as { data: T }).data;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(body ? "UNKNOWN_RESPONSE" : "NETWORK_UNAVAILABLE");
    } finally {
      globalThis.clearTimeout(timer);
    }
  }
  private acceptSession(value: BusinessSession) {
    if (
      !value ||
      typeof value.principal_id !== "string" ||
      typeof value.workspace_id !== "string" ||
      typeof value.csrf_token !== "string" ||
      !/^csrf_[a-f0-9]{64}$/.test(value.csrf_token)
    )
      throw new ApiError("INVALID_RESPONSE");
    if (
      this.session &&
      (this.session.principal_id !== value.principal_id ||
        this.session.workspace_id !== value.workspace_id)
    )
      this.clearSession();
    this.session = value;
    return {
      principal_id: value.principal_id,
      workspace_id: value.workspace_id,
    };
  }
  async restore() {
    const generation = this.generation;
    const value = await this.request<BusinessSession>("/api/v2/auth/session");
    if (generation !== this.generation) throw new ApiError("SESSION_EXPIRED");
    return this.acceptSession(value);
  }
  async login(username: string, password: string) {
    this.clearSession();
    const generation = this.generation;
    const result = await this.request<BusinessSession>("/api/v2/auth/login", {
      username,
      password,
    });
    if (generation !== this.generation) throw new ApiError("SESSION_EXPIRED");
    return this.acceptSession(result);
  }
  async logout() {
    try {
      return await this.request("/api/v2/auth/logout", {}, true);
    } finally {
      this.clearSession();
    }
  }
  async discoverProfiles() {
    const config = await this.request<RoomConfig>("/api/v2/room/config");
    if (!config?.enabled || !Array.isArray(config.profiles))
      throw new ApiError("CAPABILITY_UNAVAILABLE");
    return config.profiles
      .filter((p) => p.configured)
      .map(
        (p): Profile => ({
          id: p.id,
          revision: p.profile_revision,
          name: p.name,
          model: p.model,
          cloud: p.base_url.startsWith("https:"),
          engine: "deepseek-harness",
        }),
      );
  }
  async chat(prompt: string, profile: Profile, cloudConsent: boolean) {
    if (!validProfile(profile)) throw new ApiError("PROFILE_REQUIRED");
    if (!withinPromptLimit(prompt)) throw new ApiError("LIMIT_EXCEEDED");
    if (profile.cloud && !cloudConsent) throw new ApiError("FORBIDDEN");
    const result = await this.request<RoomAnswer>(
      "/api/v2/room/chat",
      {
        workspace_id: this.session?.workspace_id,
        provider_id: profile.id,
        profile_revision: profile.revision,
        engine: profile.engine,
        prompt,
        max_tokens: 1024,
        cloud_consent: cloudConsent,
        agent_id: "wukong",
        computer: false,
      },
      true,
      135000,
    );
    if (
      typeof result?.result?.result?.text !== "string" ||
      !result.result.result.text.trim() ||
      result.result.status !== "completed" ||
      result.runtime?.engine !== profile.engine
    )
      throw new ApiError("MODEL_OUTCOME_UNKNOWN");
    return result;
  }
  private invoke<T>(command: "file.list" | "file.read", input: object) {
    return this.request<{ status: string; result: T }>(
      "/api/v2/commands/invoke",
      {
        workspace_id: this.session?.workspace_id,
        command,
        command_version: "1.0",
        input,
      },
      true,
    ).then((v) => {
      if (v?.status !== "completed" || !v.result)
        throw new ApiError("INVALID_RESPONSE");
      return v.result;
    });
  }
  async listFiles(
    path: string,
  ): Promise<{ resources: Resource[]; truncated: boolean }> {
    const result = await this.invoke<{
      entries: Array<{ name: string; kind: "file" | "dir"; size: number }>;
      truncated: boolean;
    }>("file.list", { path, limit: 200 });
    if (!Array.isArray(result.entries)) throw new ApiError("INVALID_RESPONSE");
    return {
      resources: result.entries.map((file) => ({
        id: joinResourcePath(path, file.name),
        name: file.name,
        path: joinResourcePath(path, file.name),
        category: categoryOf(file.name),
        kind: file.kind,
        size: file.size,
      })),
      truncated: result.truncated,
    };
  }
  async readFile(path: string) {
    const result = await this.invoke<{
      content: string;
      sha256: string;
      size: number;
    }>("file.read", { path });
    if (
      typeof result.content !== "string" ||
      !/^[a-f0-9]{64}$/.test(result.sha256)
    )
      throw new ApiError("INVALID_RESPONSE");
    return result;
  }
  private household<T>(command: "list" | "get" | "prepare", input: object) {
    return this.request<T>(
      "/api/v2/household",
      { workspace_id: this.session?.workspace_id, command, input },
      true,
    );
  }
  async family() {
    const value = await this.household<Household>("list", {});
    if (
      !Array.isArray(value?.items) ||
      !Array.isArray(value?.packages) ||
      !Array.isArray(value?.tasks)
    )
      throw new ApiError("INVALID_RESPONSE");
    return value;
  }
  async prepare(
    itemId: string,
    revision: number,
    operationId: string,
    apply = false,
  ) {
    return this.household<{ plan?: PackagePlan }>("prepare", {
      operation_id: operationId,
      item_id: itemId,
      expected_revision: revision,
      apply,
    });
  }
}
