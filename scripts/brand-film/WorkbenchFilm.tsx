// Film-only rendering of the existing workbench. No live models or user files.
import React from "react";
import { createRoot } from "react-dom/client";
import Home from "../../src/components/DepDekHome";
import { ensureAiOsRoom, ROOM_AGENT_ID } from "../../src/lib/aiOsRoom";
import { BUILTIN_PROVIDER } from "../../src/lib/aiOsSetup";
import "../../src/styles.css";
const settings = ensureAiOsRoom({ providers: { "本机模型（示例）": BUILTIN_PROVIDER } });
settings.agents![0].enabled_skills = ["documents", "photos", "music", "videos", "mail", "memory"];
const noop = () => {}, done = async () => {};
createRoot(document.getElementById("root")!).render(<div style={{ height: "100vh", display: "flex", flexDirection: "column" }}><div style={{ padding: "6px 16px", background: "#f3eee2", color: "#667b6d", fontSize: 12 }}>品牌片素材 · 现有完整工作台 / 虚构配置 · 不连接账号、模型或真实 Home</div><div style={{ flex: 1, minHeight: 0 }}><Home root="/demo/Home" providerCount={1} sessionCount={0} agentMetrics={{}} providers={settings.providers} settings={settings} conversationHistory={{}} onOpenSettings={noop} onPickRoot={noop} onCreateAgent={done} onSaveAgentSettings={done} sessions={[]} activeAgentId={ROOM_AGENT_ID} chats={{}} running={{}} onSelectAgent={noop} onSendAgent={done} onAbortAgent={done} onNewConversation={done} onConversationHistoryChange={noop} onEnterAgent={noop} onCloseAgent={noop} onOpenShell={noop} teamTasks={[]} onCancelTeamTask={done} /></div></div>);
