// Isolated design fixture: no API, filesystem, persistence or model execution.
export type DemoMode = "local" | "cloud";
export type DemoPanel = "files" | "file" | "memory" | "privacy" | "consent" | null;
export type DemoMessage = { id: number; role: "user" | "assistant"; text: string; file?: boolean };
export type DemoMemory = { text: string; source: string; confirmed: boolean };
export type DemoState = {
  messages: DemoMessage[];
  memory: DemoMemory | null;
  candidate: DemoMemory | null;
  library: boolean;
  returned: boolean;
  mode: DemoMode;
  cloudConsent: boolean;
  panel: DemoPanel;
  notice: string;
};
export const DEMO_FILE = {
  name: "洗衣机购买凭证.txt",
  path: "示例资料/家电/洗衣机购买凭证.txt",
  content: "家电购买凭证 · 演示原文\n\n物品：洗衣机\n用途：演示如何找到并查看一份资料。\n\n这里不包含真实购买日期、价格或保修期限。\n这不是实际发票，也没有读取你的电脑。",
};
export const demoInitial = (): DemoState => ({ messages: [], memory: null, candidate: null, library: false, returned: false, mode: "local", cloudConsent: false, panel: null, notice: "" });
export function rememberedGreeting(state: DemoState): string | null {
  return state.returned && state.memory?.confirmed ? state.memory.text : null;
}
export function canDemoSend(state: DemoState, text: string): boolean {
  return !!text.trim() && (state.mode === "local" || state.cloudConsent);
}
export type DemoAction =
  | { type: "panel"; panel: DemoPanel }
  | { type: "library" }
  | { type: "send"; text: string }
  | { type: "confirm"; text: string; target?: "candidate" | "memory" }
  | { type: "skip" }
  | { type: "forget" }
  | { type: "return" }
  | { type: "mode"; mode: DemoMode }
  | { type: "consent"; allowed: boolean }
  | { type: "reset" };
export function demoReducer(state: DemoState, action: DemoAction): DemoState {
  switch (action.type) {
    case "panel": return { ...state, panel: action.panel, notice: "" };
    case "library": return { ...state, library: true, panel: null, notice: "演示资料已就绪。没有读取或索引你的文件。" };
    case "mode": return { ...state, mode: action.mode, cloudConsent: false, notice: "" };
    case "consent": return { ...state, cloudConsent: action.allowed };
    case "reset": return demoInitial();
    case "confirm": {
      const entry = action.target === "memory" ? state.memory : state.candidate ?? state.memory;
      if (!entry || !action.text.trim()) return state;
      return { ...state, memory: { ...entry, text: action.text.trim(), confirmed: true }, candidate: action.target === "memory" ? state.candidate : null, panel: null, notice: "这条示例记忆已确认，仅保留在本页。可在“悟空记得什么”中修改或忘记。" };
    }
    case "skip": return { ...state, candidate: null, panel: null, notice: "这次就好，不新增长期记忆。" };
    case "forget": return { ...state, memory: null, candidate: null, notice: "已移除本页示例记忆，不再用于欢迎语；对话原文没有一并删除。" };
    case "return": return { ...state, messages: [], returned: true, panel: null, notice: "模拟再次回来：只展示本页中经过确认的示例记忆，不代表重启持久化已完成。" };
    case "send": {
      const text = action.text.trim();
      if (!text) return state;
      if (!canDemoSend(state, text)) return { ...state, panel: "privacy", notice: "请先查看并确认云端发送范围。此预览实际上不会连接云端。" };
      const id = state.messages.length;
      let reply: DemoMessage = { id: id + 1, role: "assistant", text: "这是交互预览，还不能自由对话。可以试试找洗衣机购买凭证，或说“以后回答简单一点，先说重点”。" };
      let panel = state.panel, candidate = state.candidate;
      if (/以后.*(简单|简短|重点)/u.test(text)) {
        reply = { ...reply, text: "好，这次先简短回答。要不要以后也这样，由你决定。" };
        candidate = { text: "回答简单一点，先说重点。", source: text, confirmed: false };
        panel = "consent";
      } else if (/不想干活|不想工作/u.test(text)) {
        reply = { ...reply, text: "好，今天先不安排。想聊两句，还是安静看看东西？" };
        panel = null;
      } else if (/洗衣机|购买凭证/u.test(text)) {
        reply = { ...reply, text: state.library ? "在演示资料中找到一份匹配文档。你可以核对原文；没有移动或修改任何文件。" : "先选一点资料就好。确认查找范围后，再找这份购买凭证。", file: state.library };
        panel = state.library ? "file" : "files";
      } else if (/找|资料|文件|照片/u.test(text)) {
        reply = { ...reply, text: state.library ? "演示资料中没有找到匹配项。可以换个文件名，或检查右侧的查找范围。" : "从一个小文件夹开始就好。不需要先把所有资料交给我。" };
        panel = "files";
      }
      return { ...state, candidate, panel, cloudConsent: false, notice: "", messages: [...state.messages, { id, role: "user", text }, reply] };
    }
  }
}
