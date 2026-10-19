// Explicitly synthetic UI-only fixture; no native auth, networking or model calls.
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import Entry, { type WelcomeServices } from "../../src/components/AiOsEntry";
import type { AiOsStatus, Settings } from "../../src/api";
import "../../src/styles.css";

const params = new URLSearchParams(window.location.search);
const status: AiOsStatus = { enabled:true,initialized:params.has("existing"),authenticated:params.has("authenticated"),configured:false,username:params.has("authenticated")?"preview-user":null,balance:1000,grant_points:1000,chat_cost:10,model_ready:false,connection_mode:"online" };
let online = !params.has("offline"), checks = 0, platformCalls = 0;
let current = structuredClone(status), settings: Settings = {last_root:"/synthetic-home",providers:{"示例云端模型":{kind:"openai-compatible",base_url:"https://example.invalid/v1",model:"preview-cloud",api_key:"$secret:providers.synthetic"},"示例本机模型":{kind:"openai-compatible",base_url:"http://127.0.0.1:11434/v1",model:"preview-local"}},agents:[{id:"depdek-os-assistant",label:"悟空",provider_name:"示例云端模型",enabled_skills:[]}]};
let tests = 0, saves = 0, opens = 0;
function Preview() {
  const [revision, setRevision] = useState(0), [, redraw] = useState(0);
  const services: WelcomeServices = React.useMemo(() => ({
    aiOsStatus:async()=>structuredClone(current),
    aiOsLogin:async()=>{ throw new Error("Preview does not create accounts"); },
    aiOsBitBaySendCode:async()=>{platformCalls++;redraw((n)=>n+1);return {sent:true,retry_after_seconds:60};},
    aiOsBitBayRegister:async(email)=>{platformCalls++;redraw((n)=>n+1);if(params.has("account-error"))throw new Error("BITBAY_CODE_INVALID");current={...current,initialized:true,authenticated:true,username:email,bitbay:{email,user_id:42}};return structuredClone(current);},
    aiOsBitBayLogin:async(email)=>{platformCalls++;redraw((n)=>n+1);if(params.has("account-error"))throw new Error("BITBAY_LOGIN_FAILED");current={...current,initialized:true,authenticated:true,username:email,bitbay:{email,user_id:42}};return structuredClone(current);},
    aiOsSetConnectionMode:async(mode)=>{ current.connection_mode=mode; return structuredClone(current); },
    aiOsNetworkStatus:async()=>{checks++;redraw((n)=>n+1);if(params.has("error"))throw new Error("Synthetic unavailable");return {platform:"synthetic",connectivity:online?"online":params.has("limited")?"limited":"offline",settings_available:!params.has("no-settings"),interfaces:online||params.has("limited")?[{name:"en0 · 示例",addresses:["192.0.2.24"]}]:[]};},
    aiOsOpenNetworkSettings:async()=>{opens++; redraw((n)=>n+1);},
    aiOsComplete:async(displayName,language,purpose)=>{current={...current,configured:true,preferences:{display_name:displayName,language,purpose}}; return structuredClone(current);},
    settingsGet:async()=>structuredClone(settings), settingsSet:async(next)=>{ settings=structuredClone(next); for(const p of Object.values(settings.providers)) if(p.api_key && !p.api_key.startsWith("$secret:")) p.api_key="$secret:providers.synthetic"; saves++;redraw((n)=>n+1);},
    vaultInitHome:async()=>"/synthetic-home",vaultSetRoot:async(path)=>path,
    agentAnalyze:async()=>{tests++;redraw((n)=>n+1);return{text:"连接成功（仅模拟）"};},
  }), [revision]);
  return <div style={{height:"100vh",display:"flex",flexDirection:"column"}}><div style={{padding:"6px 15px",font:"11px sans-serif",background:"#e7e8dc",color:"#5f6d58",display:"flex",justifyContent:"space-between",alignItems:"center",gap:10}}><span>向导验收预览 · 不连接真实网络、账户或模型 · 模拟保存 {saves} 次 / 检测网络 {checks} 次 / 打开设置 {opens} 次</span><button onClick={()=>{online=true;window.dispatchEvent(new Event("online"));}}>模拟联网</button><button onClick={()=>{current=structuredClone(status);tests=saves=opens=checks=0;setRevision((n)=>n+1);}}>重置预览</button></div><div style={{flex:1,minHeight:0}}><Entry key={revision} services={services}><div style={{padding:60,fontSize:22}}>已完成四步配置（模拟），实际应用将进入悟空。</div></Entry></div></div>;
}
createRoot(document.getElementById("root")!).render(<Preview/>);
