// Isolated visual QA fixture. No Tauri impersonation, model calls or user data.
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import Room from "../../src/components/DepDekAiOsShell";
import { ensureAiOsRoom, ROOM_AGENT_ID } from "../../src/lib/aiOsRoom";
import { BUILTIN_PROVIDER } from "../../src/lib/aiOsSetup";
import "../../src/styles.css";
import "../../src/components/depdek-home.css";

function Preview() {
  const [settings, setSettings] = useState(ensureAiOsRoom({ providers: { "本地助手": BUILTIN_PROVIDER } }));
  const [active, setActive] = useState(ROOM_AGENT_ID), [sample, setSample] = useState(false);
  return <div style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
    <div style={{ font: "11px sans-serif", background: "#e9e6df", color: "#676058", padding: "4px 12px", display: "flex", justifyContent: "space-between", flexShrink: 0 }}>界面验收预览 · 不连接模型或家庭数据<button onClick={() => setSample(!sample)} style={{ fontSize: 10 }}>切换示例对话</button></div>
    <div style={{ flex: 1, minHeight: 0 }}><Room root="/home/family/DepDek-Home" settings={settings} sessions={[]} activeAgentId={active} onSelectAgent={setActive} running={{}} chats={sample ? { [ROOM_AGENT_ID]: [
      { id: 1, kind: "user", text: "帮我整理空调维修需要的资料" },
      { id: 2, kind: "assistant", text: "## 我们先把资料理清\n维修资料可以按下面的顺序准备：\n\n- 确认空调型号和购买日期\n- 找到发票与保修条款\n- 补充以前的维修记录\n\n你想先从哪一项开始？\n\n我还没有读取你的文件，先帮你列一个清单。" },
    ] } : {}} onSend={async () => {}} onAbort={async () => {}} onCreateAgent={async () => {}} onSaveSettings={async (next) => setSettings(next)} onOpenHome={() => {}} /></div>
  </div>;
}
createRoot(document.getElementById("root")!).render(<Preview />);
