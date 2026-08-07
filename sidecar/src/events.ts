/**
 * Pure conversion from pi-agent-core AgentEvents to contract agent/event
 * notifications (section 2.2). Kept free of any I/O so it can be unit tested
 * without a running agent.
 */

import type { AgentEvent } from "@mariozechner/pi-agent-core";
import type { AssistantMessage } from "@mariozechner/pi-ai";

export const RESULT_PREVIEW_MAX = 500;

export interface AgentEventNotification {
  type: "text_delta" | "tool_call_start" | "tool_call_end" | "message_complete" | "error";
  data: Record<string, unknown>;
}

/** Truncate a preview string to the contract limit of 500 characters. */
export function truncatePreview(text: string): string {
  return text.length > RESULT_PREVIEW_MAX ? text.slice(0, RESULT_PREVIEW_MAX) : text;
}

/** Render an AgentToolResult as a short text preview. */
export function resultPreview(result: unknown): string {
  if (result == null) return "";
  let text: string | undefined;
  if (typeof result === "object" && "content" in result && Array.isArray((result as any).content)) {
    // AgentToolResult shape: { content: (TextContent|ImageContent)[], details }
    const parts = (result as any).content as { type: string; text?: string }[];
    text = parts
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text as string)
      .join("\n");
  }
  if (!text) {
    try {
      text = JSON.stringify(result);
    } catch {
      text = String(result);
    }
  }
  return truncatePreview(text);
}

function lastAssistantMessage(messages: readonly { role: string }[]): AssistantMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "assistant") return messages[i] as unknown as AssistantMessage;
  }
  return undefined;
}

/**
 * Convert one AgentEvent into zero or more contract notifications
 * (session_id is added by the caller).
 */
export function convertAgentEvent(event: AgentEvent): AgentEventNotification[] {
  switch (event.type) {
    case "message_update": {
      const inner = event.assistantMessageEvent;
      if (inner.type === "text_delta") {
        return [{ type: "text_delta", data: { delta: inner.delta } }];
      }
      return [];
    }
    case "tool_execution_start":
      return [
        {
          type: "tool_call_start",
          data: { tool_call_id: event.toolCallId, name: event.toolName, args: event.args ?? {} },
        },
      ];
    case "tool_execution_end":
      return [
        {
          type: "tool_call_end",
          data: {
            tool_call_id: event.toolCallId,
            name: event.toolName,
            ok: !event.isError,
            result_preview: resultPreview(event.result),
          },
        },
      ];
    case "agent_end": {
      const assistant = lastAssistantMessage(event.messages);
      if (assistant && assistant.stopReason === "error") {
        return [
          { type: "error", data: { message: assistant.errorMessage ?? "model request failed" } },
        ];
      }
      return [
        { type: "message_complete", data: { stop_reason: assistant?.stopReason ?? "stop" } },
      ];
    }
    default:
      return [];
  }
}
