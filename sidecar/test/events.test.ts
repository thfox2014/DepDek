import { describe, expect, it } from "vitest";
import { convertAgentEvent, resultPreview, truncatePreview } from "../src/events.js";
import { fauxAssistantMessage } from "@mariozechner/pi-ai";

describe("convertAgentEvent", () => {
  it("converts streamed text deltas", () => {
    const notifications = convertAgentEvent({
      type: "message_update",
      message: {} as any,
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "abc", partial: {} as any },
    });
    expect(notifications).toEqual([{ type: "text_delta", data: { delta: "abc" } }]);
  });

  it("ignores non-text message updates", () => {
    const notifications = convertAgentEvent({
      type: "message_update",
      message: {} as any,
      assistantMessageEvent: { type: "text_start", contentIndex: 0, partial: {} as any },
    });
    expect(notifications).toEqual([]);
  });

  it("converts tool_execution_start", () => {
    const notifications = convertAgentEvent({
      type: "tool_execution_start",
      toolCallId: "tc1",
      toolName: "read_file",
      args: { path: "a.txt" },
    });
    expect(notifications).toEqual([
      {
        type: "tool_call_start",
        data: { tool_call_id: "tc1", name: "read_file", args: { path: "a.txt" } },
      },
    ]);
  });

  it("converts tool_execution_end with ok flag and preview", () => {
    const notifications = convertAgentEvent({
      type: "tool_execution_end",
      toolCallId: "tc1",
      toolName: "read_file",
      result: { content: [{ type: "text", text: "file body" }], details: {} },
      isError: false,
    });
    expect(notifications).toEqual([
      {
        type: "tool_call_end",
        data: { tool_call_id: "tc1", name: "read_file", ok: true, result_preview: "file body" },
      },
    ]);
  });

  it("marks failed tool executions as not ok", () => {
    const notifications = convertAgentEvent({
      type: "tool_execution_end",
      toolCallId: "tc1",
      toolName: "read_file",
      result: { content: [{ type: "text", text: "E32002 not found" }] },
      isError: true,
    });
    expect(notifications[0]).toMatchObject({ type: "tool_call_end", data: { ok: false } });
  });

  it("converts agent_end to message_complete with the stop reason", () => {
    const notifications = convertAgentEvent({
      type: "agent_end",
      messages: [fauxAssistantMessage("done", { stopReason: "stop" })],
    });
    expect(notifications).toEqual([{ type: "message_complete", data: { stop_reason: "stop" } }]);
  });

  it("converts an errored final assistant message to an error notification", () => {
    const notifications = convertAgentEvent({
      type: "agent_end",
      messages: [fauxAssistantMessage("", { stopReason: "error", errorMessage: "401 unauthorized" })],
    });
    expect(notifications).toEqual([{ type: "error", data: { message: "401 unauthorized" } }]);
  });

  it("reports aborts as message_complete with stop_reason aborted", () => {
    const notifications = convertAgentEvent({
      type: "agent_end",
      messages: [fauxAssistantMessage("partial", { stopReason: "aborted" })],
    });
    expect(notifications).toEqual([{ type: "message_complete", data: { stop_reason: "aborted" } }]);
  });

  it("ignores unrelated events", () => {
    expect(convertAgentEvent({ type: "agent_start" })).toEqual([]);
    expect(convertAgentEvent({ type: "turn_start" })).toEqual([]);
  });
});

describe("resultPreview", () => {
  it("truncates to 500 characters", () => {
    const long = "x".repeat(600);
    expect(truncatePreview(long)).toHaveLength(500);
    expect(resultPreview({ content: [{ type: "text", text: long }] })).toHaveLength(500);
  });

  it("falls back to JSON for non-tool-result shapes", () => {
    expect(resultPreview({ plain: true })).toBe('{"plain":true}');
  });
});
