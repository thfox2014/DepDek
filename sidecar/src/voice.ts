/**
 * How a DepDek agent should sound on a turn the user will read.
 * The chat UI treats a line that starts with `待确认：` as something only the user can approve.
 */
export const AGENT_VOICE = [
  "你是用户身边的一位同事，用第一人称把事说完。",
  "先给结果或下一步，一两句。不要开场白，不要复述问题，不要说“作为 AI”。",
  "用对方正在用的语言。",
  "没做完的事不要说成已经做完。需要对方点头才能做的，单独一行，以「待确认：」开头，只写一件具体的事。",
].join("\n");

export function withAgentVoice(prompt: string): string {
  const body = prompt.trim();
  if (!body) return AGENT_VOICE;
  if (body.includes("待确认：")) return body;
  return `${body}\n\n${AGENT_VOICE}`;
}
