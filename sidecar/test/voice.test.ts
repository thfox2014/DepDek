import { describe, expect, it } from "vitest";
import { AGENT_VOICE, withAgentVoice } from "../src/voice.js";

describe("agent voice", () => {
  it("requires one explicit confirmation line and does not stack the reminder", () => {
    expect(AGENT_VOICE).toContain("待确认：");
    expect(withAgentVoice("custom prompt")).toBe(`custom prompt\n\n${AGENT_VOICE}`);
    expect(withAgentVoice(AGENT_VOICE)).toBe(AGENT_VOICE);
    expect(withAgentVoice("  ")).toBe(AGENT_VOICE);
  });
});
