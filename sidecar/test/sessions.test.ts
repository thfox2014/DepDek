import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  fauxAssistantMessage,
  fauxToolCall,
  registerFauxProvider,
  type FauxProviderRegistration,
} from "@mariozechner/pi-ai";
import { SessionManager, DEFAULT_SYSTEM_PROMPT } from "../src/sessions.js";
import type { VaultClient } from "../src/tools.js";

let faux: FauxProviderRegistration;

beforeAll(() => {
  // A fast, offline provider registered under api/provider "faux".
  faux = registerFauxProvider({ models: [{ id: "faux-1" }], tokensPerSecond: 0 });
});

afterAll(() => {
  faux.unregister();
});

interface CapturedNotification {
  method: string;
  params: any;
}

function makeHarness(vaultResult: unknown = {}, vaultError?: Error) {
  const notifications: CapturedNotification[] = [];
  const vault: VaultClient = {
    request: vi.fn(async () => {
      if (vaultError) throw vaultError;
      return vaultResult;
    }),
  };
  const sink = { notify: (method: string, params?: unknown) => notifications.push({ method, params }) };
  const manager = new SessionManager(vault, sink);
  return { manager, vault: vault as VaultClient & { request: ReturnType<typeof vi.fn> }, notifications };
}

async function waitFor(
  notifications: CapturedNotification[],
  predicate: (n: CapturedNotification) => boolean,
  timeoutMs = 5000,
): Promise<CapturedNotification> {
  const start = Date.now();
  for (;;) {
    const hit = notifications.find(predicate);
    if (hit) return hit;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timed out waiting for notification; got: ${JSON.stringify(notifications)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const isEvent = (type: string) => (n: CapturedNotification) =>
  n.method === "agent/event" && n.params.type === type;

describe("SessionManager", () => {
  it("streams a simple reply as text_delta + message_complete", async () => {
    faux.setResponses([fauxAssistantMessage("Hello, workbench!")]);
    const { manager, notifications } = makeHarness();
    manager.createSessionWithModel("s1", faux.getModel());
    manager.send("s1", "hi");

    const complete = await waitFor(notifications, isEvent("message_complete"));
    expect(complete.params.session_id).toBe("s1");
    expect(complete.params.data.stop_reason).toBe("stop");

    const deltas = notifications.filter(isEvent("text_delta")).map((n) => n.params.data.delta);
    expect(deltas.join("")).toBe("Hello, workbench!");
  });

  it("runs one analysis with read-only tools and returns the answer without a persistent session", async () => {
    faux.setResponses([fauxAssistantMessage("{\"suggestions\":[\"整理这份记录\"]}")]);
    const { manager, vault } = makeHarness();
    const result = await manager.runOnceWithModel(
      faux.getModel(),
      undefined,
      "分析这份内容，只给建议",
      "只读分析，不要修改任何数据。",
    );
    expect(result.text).toContain("整理这份记录");
    expect(manager.has("analysis")).toBe(false);
    expect(vault.request).not.toHaveBeenCalledWith("vault/write_file", expect.anything());
  });

  it("runs vault tool calls through the RPC client and reports start/end", async () => {
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("read_file", { path: "a.txt" }, { id: "tc1" }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("read it"),
    ]);
    const { manager, vault, notifications } = makeHarness({
      content: "file body",
      size: 9,
      sha256: "abc123",
    });
    manager.createSessionWithModel("s2", faux.getModel());
    manager.send("s2", "read a.txt");

    await waitFor(notifications, isEvent("message_complete"));

    expect(vault.request).toHaveBeenCalledWith("vault/read_file", {
      session_id: "s2",
      path: "a.txt",
    });

    const start = notifications.find(isEvent("tool_call_start"));
    expect(start?.params.data).toEqual({
      tool_call_id: "tc1",
      name: "read_file",
      args: { path: "a.txt" },
      engine: "pi",
    });

    const end = notifications.find(isEvent("tool_call_end"));
    expect(end?.params.data).toEqual({
      tool_call_id: "tc1",
      name: "read_file",
      ok: true,
      result_preview: "file body",
      engine: "pi",
    });
  });

  it("reports tool failures as tool_call_end with ok=false", async () => {
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("delete_file", { path: "nope.txt" }, { id: "tc9" }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("failed"),
    ]);
    const { manager, notifications } = makeHarness({}, new Error("E32002 not found"));
    manager.createSessionWithModel("s3", faux.getModel());
    manager.send("s3", "delete nope.txt");

    await waitFor(notifications, isEvent("message_complete"));
    const end = notifications.find(isEvent("tool_call_end"));
    expect(end?.params.data.ok).toBe(false);
    expect(end?.params.data.tool_call_id).toBe("tc9");
  });

  it("uses the default sandbox system prompt unless overridden", async () => {
    let capturedSystemPrompt: string | undefined;
    faux.setResponses([
      (context) => {
        capturedSystemPrompt = context.systemPrompt;
        return fauxAssistantMessage("ok");
      },
    ]);
    const { manager, notifications } = makeHarness();
    manager.createSessionWithModel("s4", faux.getModel());
    manager.send("s4", "hi");
    await waitFor(notifications, isEvent("message_complete"));
    expect(capturedSystemPrompt).toBe(DEFAULT_SYSTEM_PROMPT);

    faux.setResponses([
      (context) => {
        capturedSystemPrompt = context.systemPrompt;
        return fauxAssistantMessage("ok");
      },
    ]);
    manager.createSessionWithModel("s5", faux.getModel(), { systemPrompt: "custom prompt" });
    manager.send("s5", "hi");
    await waitFor(notifications, (n) => isEvent("message_complete")(n) && n.params.session_id === "s5");
    expect(capturedSystemPrompt).toBe("custom prompt");
  });

  it("keeps sessions isolated and rejects duplicates", () => {
    const { manager } = makeHarness();
    manager.createSessionWithModel("dup", faux.getModel());
    expect(() => manager.createSessionWithModel("dup", faux.getModel())).toThrowError(
      /already exists/,
    );
  });

  it("rejects send/abort/close for unknown sessions", () => {
    const { manager } = makeHarness();
    expect(() => manager.send("ghost", "hi")).toThrowError(/unknown session/);
    expect(() => manager.abort("ghost")).toThrowError(/unknown session/);
    expect(() => manager.closeSession("ghost")).toThrowError(/unknown session/);
  });

  it("close_session removes the session and aborts it", () => {
    const { manager } = makeHarness();
    manager.createSessionWithModel("s6", faux.getModel());
    expect(manager.has("s6")).toBe(true);
    manager.closeSession("s6");
    expect(manager.has("s6")).toBe(false);
  });

  it("converts provider-level errors into error notifications", async () => {
    faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "boom" })]);
    const { manager, notifications } = makeHarness();
    manager.createSessionWithModel("s7", faux.getModel());
    manager.send("s7", "hi");
    const error = await waitFor(notifications, isEvent("error"));
    expect(error.params.session_id).toBe("s7");
    expect(error.params.data.message).toBe("boom");
  });
});
