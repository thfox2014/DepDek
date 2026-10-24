// Isolated visual QA fixture. No Tauri impersonation, model calls or user data.
import React, { useCallback, useState } from "react";
import type { ModelConnection } from "../../src/api";
import { createRoot } from "react-dom/client";
import Room from "../../src/components/DepDekAiOsShell";
import { ensureAiOsRoom, ROOM_AGENT_ID } from "../../src/lib/aiOsRoom";
import { BUILTIN_PROVIDER } from "../../src/lib/aiOsSetup";
import { WukongMomentSticker } from "../../src/components/WukongMoment";
import { WUKONG_MOMENTS } from "../../src/lib/wukongMoments";
import "../../src/styles.css";
import "../../src/components/depdek-home.css";

function Preview() {
  const [settings, setSettings] = useState(ensureAiOsRoom({ providers: { "本地助手": BUILTIN_PROVIDER, "公域模型（模拟）": { kind: "openai-compatible", base_url: "https://models.example.test/v1", model: "synthetic-model" } } }));
  const [modelState, setModelState] = useState("cloud");
  const modelStatus = useCallback(async (name: string): Promise<ModelConnection> => name === "本地助手"
    ? { state: modelState === "local" ? "available" : "unavailable", reason: "synthetic" }
    : { state: modelState === "failure" ? "unavailable" : "available", reason: modelState === "failure" ? "unauthorized" : "synthetic" }, [modelState]);
  const [active, setActive] = useState(ROOM_AGENT_ID), [sample, setSample] = useState(false);
  const [gallery, setGallery] = useState(false), [take, setTake] = useState(0);
  return <div style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
    <style>{`.moment-preview .wukong-moment { animation: none; }`}</style>
    <div style={{ font: "11px sans-serif", background: "#e9e6df", color: "#676058", padding: "4px 12px", display: "flex", justifyContent: "space-between", flexShrink: 0 }}><span>界面预览 · 不连接模型或家庭数据</span><div><select aria-label="模拟模型状态" value={modelState} onChange={(event) => setModelState(event.target.value)}><option value="cloud">公域可用 · 本地不可用</option><option value="local">本地可用</option><option value="failure">公域密钥无效</option></select><button onClick={() => setGallery(true)} style={{ fontSize: 11 }}>六种悟空动效</button><button onClick={() => setSample(!sample)} style={{ fontSize: 11 }}>切换示例对话</button></div></div>
    <div style={{ flex: 1, minHeight: 0 }}><Room key={modelState} preview modelStatusService={modelStatus} root="/home/family/DepDek-Home" settings={settings} sessions={[]} activeAgentId={active} onSelectAgent={setActive} running={{}} chats={sample ? { [ROOM_AGENT_ID]: [
      { id: 1, kind: "user", text: "帮我整理空调维修需要的资料" },
      { id: 2, kind: "assistant", text: "## 我们先把资料理清\n维修资料可以按下面的顺序准备：\n\n- 确认空调型号和购买日期\n- 找到发票与保修条款\n- 补充以前的维修记录\n\n你想先从哪一项开始？\n\n我还没有读取你的文件，先帮你列一个清单。" },
    ] } : {}} onSend={async () => {}} onAbort={async () => {}} onCreateAgent={async () => {}} onSaveSettings={async (next) => setSettings(next)} onOpenHome={() => {}} /></div>
    {gallery && <div role="dialog" aria-label="悟空小剧场预览" style={{ position: "fixed", inset: 0, zIndex: 200, background: "#23463c66", display: "grid", placeItems: "center", padding: 24 }}><section className="moment-preview" style={{ background: "#fbf8f0", color: "#23463c", border: "1px solid #e2e4d9", borderRadius: 18, maxWidth: 900, width: "100%", maxHeight: "90vh", overflowY: "auto", padding: 24 }}><header style={{ display: "flex", alignItems: "center", gap: 16 }}><div style={{ flex: 1 }}><small>WUKONG · LITTLE MOMENTS</small><h2 style={{ margin: "7px 0" }}>有点本领，也有点可爱。</h2><p style={{ margin: "0 0 16px", fontSize: 13 }}>仅动效预览，不是模型回复。正式界面低频随机播放。</p></div><button onClick={() => setTake((value) => value + 1)}>重新播放</button><button onClick={() => setGallery(false)}>回到聊天</button></header><div key={take} style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(340px, 100%), 1fr))", gap: 16 }}>{WUKONG_MOMENTS.map((moment) => <div key={moment.id} style={{ borderTop: "1px solid #e2e4d9", pointerEvents: "none" }}><WukongMomentSticker moment={moment} /></div>)}</div></section></div>}
  </div>;
}
createRoot(document.getElementById("root")!).render(<Preview />);
