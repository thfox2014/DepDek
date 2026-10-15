import { useEffect, useRef, useState } from "react";
import {
  api,
  type RoomConfig,
  type BusinessSession,
  type RoomAnswer,
  type ComputerState,
  type ComputerAction,
  type ProviderProbe,
} from "../api";
import WukongHead from "../components/WukongHead";
import ComputerPanel from "./ComputerPanel";
import Markdown from "../components/Markdown";
import HouseholdPanel from "./HouseholdPanel";
import "./agent-core.css";
import "./agent-flat.css";

const PEOPLE = [
  { id: "wukong", name: "悟空", role: "探索与统筹", mark: "悟" },
  { id: "bajie", name: "八戒", role: "资料与执行", mark: "戒" },
  { id: "master", name: "师傅", role: "分析与指引", mark: "师" },
  { id: "shaseng", name: "沙僧", role: "整理与守护", mark: "僧" },
];
type Message = {
  role: "user" | "assistant";
  text: string;
  error?: boolean;
  answer?: RoomAnswer;
};
const op = () => crypto.randomUUID();
function Mark({
  id,
  active = true,
  busy = false,
  listening = false,
}: {
  id: string;
  active?: boolean;
  busy?: boolean;
  listening?: boolean;
}) {
  return id === "wukong" ? (
    <span className="agent-room__wukong is-small">
      <WukongHead active={active} busy={busy} listening={listening} />
    </span>
  ) : (
    <span className={`agent-room__mark agent-room__mark--${id} is-small`}>
      {PEOPLE.find((p) => p.id === id)?.mark}
    </span>
  );
}
function preference(id: string): { engine: string; provider: string } {
  try {
    const p = JSON.parse(localStorage.getItem(`depdek.agent.${id}`) || "{}");
    return {
      engine: ["pi", "deepseek-harness"].includes(p.engine)
        ? p.engine
        : "deepseek-harness",
      provider: typeof p.provider === "string" ? p.provider : "",
    };
  } catch {
    return { engine: "deepseek-harness", provider: "" };
  }
}
function savedTheme() {
  try {
    return localStorage.getItem("depdek.room.theme") === "light"
      ? "light"
      : "dark";
  } catch {
    return "dark";
  }
}
function configError(error: unknown) {
  const code = error instanceof Error ? error.message : String(error);
  return (
    (
      {
        SECRET_STORE_LOCKED:
          "凭据库已自动锁定，请输入主密码后继续。尚未保存的 API Key 已保留。",
        SECRET_STORE_NOT_INITIALIZED: "请先设置凭据库主密码。",
        UNLOCK_FAILED: "主密码不正确。你填写的 Provider 和 API Key 已保留。",
        PROVIDER_AUTH_FAILED:
          "Provider 拒绝了 API Key，请检查密钥或模型访问权限。",
        PROVIDER_REQUEST_REJECTED:
          "Provider 拒绝模型请求，请检查模型 ID 和 API 基础 URL。",
        PROVIDER_QUOTA_LIMITED:
          "Provider 额度不足或请求过于频繁，请检查余额和限额。",
        PROVIDER_UNAVAILABLE: "Provider 服务暂不可用。",
        MODEL_OUTCOME_UNKNOWN: "未收到有效的模型回复，请检查网络和服务地址。",
        CONFLICT: "配置版本已变化，请重新选择已有 Provider 再保存。",
        INVALID_INPUT: "配置格式不正确，请检查 ID、模型和 URL。",
        ADMIN_AUTH_REQUIRED: "管理员登录已过期，请重新登录。",
      } as Record<string, string>
    )[code] || code
  );
}

export default function AgentCore({ initial }: { initial: RoomConfig }) {
  const [config, setConfig] = useState(initial),
    [person, setPerson] = useState("wukong"),
    [engine, setEngine] = useState(preference("wukong").engine),
    [provider, setProvider] = useState(
      initial.profiles.some((p) => p.id === preference("wukong").provider)
        ? preference("wukong").provider
        : initial.profiles.find((p) => p.id === "deepseek")?.id ||
            initial.profiles[0]?.id ||
            "",
    );
  const [theme, setTheme] = useState(savedTheme),
    [computerMode, setComputerMode] = useState(false),
    [computer, setComputer] = useState<ComputerState | null>(null),
    [computerBusy, setComputerBusy] = useState(false),
    [proposed, setProposed] = useState<ComputerAction | null>(null),
    [inspector, setInspector] = useState<"computer" | "family">("computer"),
    [panelWidth, setPanelWidth] = useState(380);
  const stop = useRef(false);
  const [session, setSession] = useState<BusinessSession | null>(null),
    [username, setUsername] = useState("admin"),
    [password, setPassword] = useState(""),
    [authBusy, setAuthBusy] = useState(false);
  const [draft, setDraft] = useState(""),
    [consent, setConsent] = useState(false),
    [history, setHistory] = useState(false),
    [messages, setMessages] = useState<Record<string, Message[]>>({}),
    [busy, setBusy] = useState("");
  const [notice, setNotice] = useState(""),
    [settings, setSettings] = useState(false),
    [panel, setPanel] = useState(false),
    [tab, setTab] = useState<"runtime" | "migration">("runtime");
  const [passphrase, setPassphrase] = useState(""),
    [controlBusy, setControlBusy] = useState(false);
  const [probeResult, setProbeResult] = useState<ProviderProbe | null>(null),
    [unlockNeeded, setUnlockNeeded] = useState(initial.store.locked);
  const [form, setForm] = useState({
      id: "",
      name: "",
      base_url: "https://api.deepseek.com",
      model: "deepseek-flash",
      api_key: "",
    }),
    [expected, setExpected] = useState(0);
  const [migration, setMigration] = useState(""),
    [migrationPreview, setMigrationPreview] = useState<unknown>(null),
    [migrationOperation, setMigrationOperation] = useState(op());
  const [stats, setStats] = useState<
    Record<
      string,
      { runs: number; input: number; output: number; unknown: number }
    >
  >({});
  const scroll = useRef<HTMLDivElement>(null),
    recognition = useRef<{ stop: () => void } | null>(null),
    [recording, setRecording] = useState(false);
  const selected = PEOPLE.find((p) => p.id === person)!;
  const profile = config.profiles.find((p) => p.id === provider);
  const chat = messages[person] || [];
  useEffect(() => {
    try {
      localStorage.setItem("depdek.room.theme", theme);
    } catch {}
  }, [theme]);
  useEffect(() => {
    try {
      localStorage.setItem(
        `depdek.agent.${person}`,
        JSON.stringify({ engine, provider }),
      );
    } catch {}
  }, [person, engine, provider]);
  const choosePerson = (id: string) => {
    if (busy || computerBusy) return;
    const pref = preference(id);
    setPerson(id);
    setEngine(pref.engine);
    setProvider(
      config.profiles.some((p) => p.id === pref.provider)
        ? pref.provider
        : config.profiles[0]?.id || "",
    );
    setComputerMode(false);
  };
  const computerAction = async (action: object) => {
    if (!session) {
      setNotice("请先登录私人空间。");
      return;
    }
    setComputerBusy(true);
    setNotice("");
    setPanel(true);
    setInspector("computer");
    try {
      const next = await api.computer(
        session.csrf_token,
        session.workspace_id,
        action,
      );
      setComputer((old) => ({
        ...next,
        screenshot: next.running
          ? next.screenshot || old?.screenshot || null
          : null,
      }));
      setProposed(null);
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    } finally {
      setComputerBusy(false);
    }
  };
  useEffect(() => {
    if (!session) {
      setComputer(null);
      setProposed(null);
      return;
    }
    if (config.computer_enabled)
      void api
        .computer(session.csrf_token, session.workspace_id, { kind: "status" })
        .then(setComputer)
        .catch(() => {});
  }, [session?.principal_id, config.computer_enabled]);
  useEffect(() => {
    let live = true;
    api
      .businessSession()
      .then((s) => {
        if (live) setSession(s);
      })
      .catch(() => {});
    return () => {
      live = false;
      recognition.current?.stop();
    };
  }, []);
  useEffect(() => {
    scroll.current?.scrollTo({
      top: scroll.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages, busy]);
  useEffect(() => {
    setConsent(false);
  }, [draft, person, engine, provider, history, computerMode]);
  const refresh = async () => {
    const c = await api.roomConfig();
    setConfig(c);
    setUnlockNeeded(c.store.locked);
    setProvider((id) =>
      c.profiles.some((p) => p.id === id) ? id : c.profiles[0]?.id || "",
    );
    return c;
  };
  const closeSettings = () => {
    setSettings(false);
    setPassphrase("");
    setForm((f) => ({ ...f, api_key: "" }));
    setMigration("");
    setMigrationPreview(null);
  };
  useEffect(() => {
    if (!settings) return;
    const handle = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeSettings();
    };
    window.addEventListener("keydown", handle);
    return () => window.removeEventListener("keydown", handle);
  }, [settings]);
  const perform = async (fn: () => Promise<unknown>) => {
    setControlBusy(true);
    setNotice("");
    try {
      await fn();
      await refresh();
      setNotice("操作已完成。你尚未保存的 Provider 内容会保留。");
    } catch (e) {
      setNotice(configError(e));
    } finally {
      setControlBusy(false);
      setPassphrase("");
    }
  };
  useEffect(() => {
    if (settings) void refresh().catch((e) => setNotice(configError(e)));
  }, [settings]);
  const saveProvider = async () => {
    if (controlBusy) return;
    setControlBusy(true);
    setNotice("");
    setProbeResult(null);
    let saved = false;
    try {
      let latest = await api.roomConfig();
      setConfig(latest);
      setUnlockNeeded(latest.store.locked);
      if (latest.store.locked) {
        if (!passphrase) {
          setUnlockNeeded(true);
          setNotice(
            "凭据库已锁定。请在下方输入主密码，随后可一次完成解锁、保存和测试。",
          );
          return;
        }
        await api.roomStore(
          config.workspace_id,
          latest.store.initialized ? "unlock" : "init",
          latest.store.initialized
            ? { passphrase }
            : { passphrase, operation_id: op() },
        );
        latest = await refresh();
      }
      const receipt = (await api.roomSaveProvider(config.workspace_id, {
        ...form,
        expected_revision: expected,
        operation_id: op(),
      })) as {
        data: {
          profile: { id: string; profile_revision: number; base_url: string };
        };
      };
      saved = true;
      setForm((f) => ({ ...f, api_key: "" }));
      setExpected(receipt.data.profile.profile_revision);
      setProvider(receipt.data.profile.id);
      await refresh();
      setNotice("配置已保存，正在发送固定测试短句验证连接…");
      const verified = await api.roomTestProvider(config.workspace_id, {
        provider_id: receipt.data.profile.id,
        profile_revision: receipt.data.profile.profile_revision,
        cloud_consent: receipt.data.profile.base_url.startsWith("https:"),
      });
      setProbeResult(verified);
      setNotice(`已保存并验证连接，${selected.name}已选用此 Provider。`);
    } catch (e) {
      setNotice(
        `${saved ? "配置已保存，但连接测试未通过：" : ""}${configError(e)}`,
      );
      if (!saved) void refresh().catch(() => {});
    } finally {
      setControlBusy(false);
      setPassphrase("");
    }
  };
  const testProvider = async () => {
    if (controlBusy || !profile) return;
    setControlBusy(true);
    setNotice("");
    setProbeResult(null);
    try {
      const latest = await refresh();
      const p = latest.profiles.find((p) => p.id === profile.id);
      if (latest.store.locked || !p) {
        setUnlockNeeded(true);
        setNotice("凭据库已锁定，请先输入主密码解锁。测试不需要私人空间登录。");
        return;
      }
      const result = await api.roomTestProvider(config.workspace_id, {
        provider_id: p.id,
        profile_revision: p.profile_revision,
        cloud_consent: p.base_url.startsWith("https:"),
      });
      setProbeResult(result);
      setNotice("模型连接测试通过。");
    } catch (e) {
      setNotice(configError(e));
    } finally {
      setControlBusy(false);
    }
  };
  const login = async () => {
    setAuthBusy(true);
    try {
      const s = await api.businessLogin(username, password);
      setSession(s);
      setNotice("");
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    } finally {
      setPassword("");
      setAuthBusy(false);
    }
  };
  const historyText = history
    ? chat
        .filter((m) => !m.error)
        .slice(-4)
        .map((m) => `${m.role}: ${m.text}`)
        .join("\n")
    : "";
  const outgoing = `你是${selected.name}，负责${selected.role}。用简洁、自然的中文回答；事实与未知分开，不宣称没有执行过的动作。\n${historyText ? `用户选择的最近对话：\n${historyText}\n` : ""}本次问题：${draft.trim()}`;
  const send = async () => {
    if (busy || computerBusy || !draft.trim()) return;
    if (!session) {
      setNotice("请先用家庭账号登录，管理员登录不代表私人资料权限。");
      return;
    }
    if (!consent || !profile?.configured) {
      setNotice("请选择可用 Provider，并确认这次发送的内容。");
      return;
    }
    if (new TextEncoder().encode(outgoing).length > 16384) {
      setNotice("发送内容超过 16 KiB，请减少所选历史或资料。");
      return;
    }
    const target = person;
    const text = draft.trim();
    setBusy(target);
    stop.current = false;
    setNotice("");
    setDraft("");
    setConsent(false);
    setMessages((m) => ({
      ...m,
      [target]: [...(m[target] || []), { role: "user", text }],
    }));
    try {
      for (let step = 0; step < (computerMode ? 6 : 1); step++) {
        if (stop.current) break;
        const answer = await api.roomChat(session.csrf_token, {
          workspace_id: config.workspace_id,
          provider_id: profile.id,
          profile_revision: profile.profile_revision,
          engine,
          prompt: outgoing,
          max_tokens: 1024,
          cloud_consent: profile.base_url.startsWith("https:"),
          agent_id: target,
          computer: computerMode,
        });
        if (answer.computer) {
          setComputer((old) => ({
            ...answer.computer!,
            screenshot: answer.computer!.screenshot || old?.screenshot || null,
          }));
          setPanel(true);
          setInspector("computer");
        }
        if (answer.proposed_action) setProposed(answer.proposed_action);
        setMessages((m) => ({
          ...m,
          [target]: [
            ...(m[target] || []),
            { role: "assistant", text: answer.result.result.text, answer },
          ],
        }));
        const usage = answer.result.result.usage;
        setStats((s) => {
          const old = s[target] || { runs: 0, input: 0, output: 0, unknown: 0 };
          return {
            ...s,
            [target]: {
              runs: old.runs + 1,
              input: old.input + (usage?.input_tokens || 0),
              output: old.output + (usage?.output_tokens || 0),
              unknown: old.unknown + (usage ? 0 : 1),
            },
          };
        });
        if (
          !answer.continuation ||
          answer.computer?.request ||
          answer.proposed_action ||
          stop.current
        )
          break;
        if (step === 5)
          setNotice("已完成本次 6 步浏览器操作。检查右侧结果后可继续。");
      }
    } catch (e) {
      setMessages((m) => ({
        ...m,
        [target]: [
          ...(m[target] || []),
          {
            role: "assistant",
            text: `${e instanceof Error ? e.message : String(e)}。本次授权可能已消耗；不会自动重试。`,
            error: true,
          },
        ],
      }));
      void refresh().catch(() => {});
    } finally {
      setBusy("");
    }
  };
  const voice = () => {
    if (recording) {
      recognition.current?.stop();
      setRecording(false);
      return;
    }
    // Browser recognition only fills the draft, never sends or acts automatically.
    type Speech = {
      lang: string;
      continuous: boolean;
      interimResults: boolean;
      onresult:
        | ((e: {
            results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>;
            resultIndex: number;
          }) => void)
        | null;
      onend: (() => void) | null;
      onerror: (() => void) | null;
      start: () => void;
      stop: () => void;
    };
    const w = window as Window & {
      SpeechRecognition?: new () => Speech;
      webkitSpeechRecognition?: new () => Speech;
    };
    const R = w.SpeechRecognition || w.webkitSpeechRecognition;
    if (!R) {
      setNotice("当前浏览器不支持语音识别，请使用键盘。");
      return;
    }
    const r = new R();
    r.lang = "zh-CN";
    r.continuous = true;
    r.interimResults = false;
    r.onresult = (e) => {
      const text = Array.from(e.results)
        .slice(e.resultIndex)
        .filter((r) => r.isFinal)
        .map((r) => r[0].transcript)
        .join("");
      setDraft((d) => d + text);
    };
    r.onend = () => setRecording(false);
    r.onerror = () => {
      setRecording(false);
      setNotice("语音服务不可用，请检查浏览器权限。");
    };
    recognition.current = r;
    try {
      r.start();
      setRecording(true);
    } catch {
      setNotice("无法启动麦克风");
    }
  };
  return (
    <div
      className={`agent-room agent-core agent-flat ${panel ? "" : "is-panel-collapsed"}`}
      data-theme={theme}
      style={
        { "--agent-panel-width": `${panelWidth}px` } as React.CSSProperties
      }
    >
      <aside className="agent-room__sidebar">
        <header className="agent-room__brand">
          <span className="agent-flat__brandmark">D</span>
          <div>
            <b>DepDek</b>
            <small>你的 Agent 团队</small>
          </div>
        </header>
        <div className="agent-room__members-heading">
          <span>房间成员</span>
          <b>04</b>
        </div>
        <nav className="agent-room__members" aria-label="选择 Agent">
          {PEOPLE.map((p) => (
            <button
              key={p.id}
              className={`agent-room__member ${person === p.id ? "is-selected" : ""} ${busy === p.id ? "is-busy" : ""}`}
              onClick={() => choosePerson(p.id)}
              aria-pressed={person === p.id}
            >
              <Mark
                id={p.id}
                active={person === p.id}
                busy={busy === p.id}
                listening={recording && person === p.id}
              />
              <span className="agent-room__member-copy">
                <b>{p.name}</b>
                <small>{p.role}</small>
                <em>
                  <i />
                  {busy === p.id
                    ? "执行中"
                    : person === p.id
                      ? "正在等你"
                      : "随时待命"}
                </em>
                <small>
                  本页 {stats[p.id]?.runs || 0} 次完成 ·{" "}
                  {stats[p.id]
                    ? `${stats[p.id].input + stats[p.id].output} token${stats[p.id].unknown ? " + 未知" : ""}`
                    : "尚无用量"}
                </small>
              </span>
            </button>
          ))}
        </nav>
        <div className="agent-core__login">
          {session ? (
            <>
              <b>{session.principal_id} · 私人空间</b>
              <button
                onClick={() => {
                  if (busy) return;
                  void api
                    .businessLogout(session.csrf_token)
                    .then(() => {
                      setSession(null);
                      setMessages({});
                      setStats({});
                      setDraft("");
                    })
                    .catch((e) => setNotice(String(e)));
                }}
                disabled={!!busy}
              >
                退出空间
              </button>
            </>
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void login();
              }}
            >
              <b>登录私人空间</b>
              <input
                aria-label="家庭用户名"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
                placeholder="用户名"
              />
              <input
                aria-label="家庭密码"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                placeholder="密码"
              />
              <button disabled={authBusy || !username || !password}>
                {authBusy ? "登录中…" : "登录"}
              </button>
              <small>浏览器和个人资料需要此登录</small>
            </form>
          )}
        </div>
        <div className="agent-room__sidebar-foot">
          <div>
            <b>{config.store.locked ? "凭据已锁定" : "受控核心已连接"}</b>
            <small>
              {engine} · {profile?.model || "待选模型"}
            </small>
          </div>
        </div>
        <div className="agent-room__config-actions">
          <button onClick={() => setSettings(true)}>⚙ 执行器与模型</button>
        </div>
      </aside>
      <main className="agent-room__conversation">
        <header className="agent-room__conversation-head">
          <div className="agent-room__conversation-person">
            <Mark id={person} busy={busy === person} listening={recording} />
            <div>
              <span className="agent-room__eyebrow">
                {engine === "deepseek-harness"
                  ? "DeepSeek Harness"
                  : "Pi Agent"}{" "}
                · {profile?.name || "选择模型"}
              </span>
              <h2>
                {selected.name} <small>{selected.role}</small>
              </h2>
            </div>
          </div>
          <div className="agent-flat__head-actions">
            <button
              className="agent-core__panel-toggle"
              aria-label={theme === "dark" ? "切换浅色模式" : "切换深色模式"}
              onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
            >
              {theme === "dark" ? "☼" : "☾"}
            </button>
            <button
              className="agent-core__panel-toggle"
              onClick={() => setPanel((p) => !p)}
              aria-expanded={panel}
            >
              {panel ? "收起面板" : "交互面板"}
            </button>
          </div>
        </header>
        <div className="agent-room__messages" ref={scroll}>
          {!chat.length && (
            <div className="agent-room__empty">
              <div className="agent-flat__hero">
                <Mark id={person} listening={recording} />
              </div>
              <h3>
                {person === "wukong"
                  ? "悟空在，交给我吧。"
                  : `${selected.name}在这里。`}
              </h3>
              <p>说说你想做什么，我们一起把它办好。</p>
              <div className="agent-flat__starters">
                <button
                  onClick={() => setDraft("帮我把这件事整理成一个清楚的计划")}
                >
                  理清一件事 ↗
                </button>
                <button
                  onClick={() => {
                    setComputerMode(true);
                    setInspector("computer");
                    setPanel(true);
                    setDraft("打开登录演示网页，帮我完成登录并截图。");
                  }}
                  disabled={person !== "wukong" || !config.computer_enabled}
                >
                  登录网页并截图 ↗
                </button>
                <button
                  onClick={() => {
                    setInspector("family");
                    setPanel(true);
                  }}
                >
                  整理家庭资料 ↗
                </button>
              </div>
            </div>
          )}
          {chat.map((m, i) => (
            <article
              key={i}
              className={`agent-room__message is-${m.role} ${m.error ? "is-error" : ""}`}
            >
              <div className="agent-room__message-content">
                <Markdown>{m.text}</Markdown>
                {m.answer && (
                  <details className="agent-core__receipt">
                    <summary>
                      {m.answer.result.result.usage
                        ? `${m.answer.result.result.usage.input_tokens + m.answer.result.result.usage.output_tokens} tokens`
                        : "用量未知"}{" "}
                      · 查看运行记录
                    </summary>
                    {m.answer.runtime.engine} · {m.answer.runtime.package}@
                    {m.answer.runtime.version}
                    <br />
                    请求 {m.answer.result.result.model} · 返回{" "}
                    {m.answer.result.result.reported_model || "模型标识未提供"}{" "}
                    · {m.answer.result.result.source} ·{" "}
                    {m.answer.result.result.usage
                      ? `${m.answer.result.result.usage.input_tokens} 输入 / ${m.answer.result.result.usage.output_tokens} 输出 token`
                      : "token 未提供"}
                  </details>
                )}
              </div>
            </article>
          ))}
          {busy === person && (
            <div className="agent-core__progress" role="status">
              <i />
              <div>
                {computerMode
                  ? "正在查看网页、安排下一步…"
                  : `${selected.name}正在想…`}
                <button
                  onClick={() => {
                    stop.current = true;
                    setNotice("将在当前步骤结束后停止。");
                  }}
                >
                  停止
                </button>
              </div>
            </div>
          )}
        </div>
        {notice && (
          <p className="agent-core__notice" role="alert">
            {notice}
          </p>
        )}
        <form
          className="agent-room__composer"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <div className="agent-core__selectors">
            <select
              aria-label="执行框架"
              value={engine}
              onChange={(e) => setEngine(e.target.value)}
              disabled={!!busy}
            >
              <option value="deepseek-harness">DeepSeek Harness</option>
              <option value="pi">Pi Agent</option>
            </select>
            <select
              aria-label="本次模型"
              value={provider}
              onChange={(e) => setProvider(e.target.value)}
              disabled={!!busy}
            >
              <option value="">选择 Provider</option>
              {config.profiles.map((p) => (
                <option key={p.id} value={p.id} disabled={!p.configured}>
                  {p.name} · {p.model}
                  {p.configured ? "" : " · 凭据不可用"}
                </option>
              ))}
            </select>
          </div>
          <div className="agent-room__input">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
              placeholder={`和${selected.name}说说话…`}
              aria-label="本次问题"
              rows={2}
            />
            <div className="agent-room__input-actions">
              <button
                type="button"
                onClick={voice}
                className={`agent-room__mic ${recording ? "is-recording" : ""}`}
                title="语音可能经浏览器服务处理，只填草稿"
                aria-label={recording ? "停止语音" : "语音输入"}
              >
                ♩
              </button>
              <button
                className="agent-room__send"
                disabled={
                  !!busy ||
                  !draft.trim() ||
                  !session ||
                  !consent ||
                  !profile?.configured
                }
              >
                ➤
              </button>
            </div>
          </div>
          <div className="agent-core__consent">
            {person === "wukong" && config.computer_enabled && (
              <label>
                <input
                  type="checkbox"
                  checked={computerMode}
                  disabled={!!busy}
                  onChange={(e) => {
                    setComputerMode(e.target.checked);
                    if (e.target.checked) {
                      setPanel(true);
                      setInspector("computer");
                    }
                  }}
                />
                浏览器电脑 · 最多 6 步
              </label>
            )}
            <label>
              <input
                type="checkbox"
                checked={history}
                onChange={(e) => setHistory(e.target.checked)}
              />
              附带最近 4 条对话
            </label>
            <label>
              <input
                type="checkbox"
                checked={consent}
                onChange={(e) => setConsent(e.target.checked)}
              />
              {computerMode ? "允许本次目标和脱敏页面摘录发送给" : "同意发送给"}{" "}
              {profile?.name || "所选模型"}
            </label>
          </div>
          <details className="agent-core__outgoing">
            <summary>
              {computerMode
                ? "查看目标 · 浏览器模式附加脱敏页面摘录"
                : "查看本次发送内容"}
            </summary>
            <pre>{outgoing}</pre>
          </details>
        </form>
      </main>
      {panel && (
        <aside className="agent-room__inspector">
          <div
            className="agent-flat__resize"
            role="separator"
            aria-label="调整交互面板宽度"
            aria-orientation="vertical"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === "ArrowLeft")
                setPanelWidth((w) => Math.min(600, w + 20));
              if (e.key === "ArrowRight")
                setPanelWidth((w) => Math.max(300, w - 20));
            }}
            onPointerDown={(e) => {
              const el = e.currentTarget;
              el.setPointerCapture(e.pointerId);
              const x = e.clientX,
                w = panelWidth;
              el.onpointermove = (move) =>
                setPanelWidth(
                  Math.max(300, Math.min(600, w + x - move.clientX)),
                );
              el.onpointerup = () => {
                el.onpointermove = null;
                el.onpointerup = null;
              };
            }}
          />
          <header className="agent-room__inspector-head">
            <div>
              <span className="agent-room__eyebrow">LIVE CONTEXT</span>
              <h2>交互面板</h2>
            </div>
            <button onClick={() => setPanel(false)} aria-label="关闭交互面板">
              ×
            </button>
          </header>
          <nav className="agent-flat__panel-tabs">
            <button
              className={inspector === "computer" ? "is-active" : ""}
              onClick={() => setInspector("computer")}
            >
              浏览器电脑
            </button>
            <button
              className={inspector === "family" ? "is-active" : ""}
              onClick={() => setInspector("family")}
            >
              家庭资料
            </button>
          </nav>
          {inspector === "computer" && session ? (
            <ComputerPanel
              state={computer}
              enabled={!!config.computer_enabled}
              hosts={config.computer_hosts || []}
              busy={!!busy || computerBusy}
              proposed={proposed}
              onAction={computerAction}
              onContinue={() => {
                setComputerMode(true);
                setDraft("根据当前网页继续刚才的工作；完成时汇报结果。");
                setConsent(false);
              }}
            />
          ) : inspector === "computer" ? (
            <p>登录私人空间后即可打开电脑。</p>
          ) : session && config.household_enabled ? (
            <HouseholdPanel
              session={session}
              onDraft={(text) => {
                setDraft(text);
                setConsent(false);
              }}
            />
          ) : (
            <div className="agent-core__empty-panel">
              {!session
                ? "登录家庭账号后查看私人凭证。"
                : "家庭凭证模块尚未启用。"}
              <p>原件是证据，确认后的事实才能进入维修资料包。</p>
            </div>
          )}
        </aside>
      )}
      {settings && (
        <div className="agent-config__scrim">
          <section
            className="agent-config"
            role="dialog"
            aria-modal="true"
            aria-labelledby="core-settings"
          >
            <header className="agent-config__head">
              <div>
                <span className="agent-room__eyebrow">ENCRYPTED CONTROL</span>
                <h2 id="core-settings">执行与模型配置</h2>
                <p>同一核心 · 两种执行器 · 密钥只写</p>
              </div>
              <button
                className="agent-config__close"
                onClick={closeSettings}
                aria-label="关闭配置"
              >
                ×
              </button>
            </header>
            <div className="agent-config__tabs">
              <button
                onClick={() => setTab("runtime")}
                className={tab === "runtime" ? "is-active" : ""}
              >
                模型与凭据
              </button>
              <button
                onClick={() => setTab("migration")}
                className={tab === "migration" ? "is-active" : ""}
              >
                显式迁移
              </button>
            </div>
            <div className="agent-config__content">
              {notice && (
                <p role="status" className="agent-core__notice">
                  {notice}
                </p>
              )}
              <section className="agent-core__store">
                <b>
                  加密凭据库 ·{" "}
                  {config.store.initialized
                    ? config.store.locked
                      ? "已锁定"
                      : "已解锁"
                    : "尚未初始化"}
                </b>
                {config.store.locked ? (
                  <>
                    <input
                      aria-label="凭据库主密码"
                      type="password"
                      value={passphrase}
                      onChange={(e) => setPassphrase(e.target.value)}
                      autoComplete="new-password"
                      placeholder={
                        config.store.initialized
                          ? "输入主密码解锁"
                          : "设置至少 12 字符的主密码"
                      }
                    />
                    <button
                      disabled={controlBusy || !passphrase}
                      onClick={() =>
                        void perform(() =>
                          api.roomStore(
                            config.workspace_id,
                            config.store.initialized ? "unlock" : "init",
                            config.store.initialized
                              ? { passphrase }
                              : { passphrase, operation_id: op() },
                          ),
                        )
                      }
                    >
                      {config.store.initialized ? "解锁" : "初始化"}
                    </button>
                  </>
                ) : (
                  <button
                    disabled={controlBusy}
                    onClick={() =>
                      void perform(() =>
                        api.roomStore(config.workspace_id, "lock", {}),
                      )
                    }
                  >
                    立即锁定
                  </button>
                )}
                <small>主密码不会存入浏览器；锁定后模型调用停止。</small>
              </section>
              {tab === "runtime" ? (
                <>
                  <p className="agent-config__note">
                    云端允许主机：{config.cloud_hosts.join("、") || "尚未配置"}
                    。保存仅表示配置有效，回到对话页发送测试短句验证实际模型。
                  </p>
                  <div className="agent-provider-list">
                    {config.profiles.map((p) => (
                      <button
                        key={p.id}
                        className="agent-provider-item"
                        onClick={() => {
                          setExpected(p.profile_revision);
                          setForm({
                            id: p.id,
                            name: p.name,
                            base_url: p.base_url,
                            model: p.model,
                            api_key: "",
                          });
                          setProvider(p.id);
                        }}
                      >
                        <span className="agent-provider-item__copy">
                          <b>{p.name}</b>
                          <small>
                            {p.model} · revision {p.profile_revision}
                          </small>
                        </span>
                        <span>{p.configured ? "可用" : "需解锁/更新凭据"}</span>
                      </button>
                    ))}
                  </div>
                  <button
                    onClick={() => {
                      setExpected(0);
                      setForm({
                        id: "",
                        name: "",
                        base_url: "https://api.deepseek.com",
                        model: "deepseek-flash",
                        api_key: "",
                      });
                    }}
                  >
                    ＋ 新 Provider
                  </button>
                  <form
                    className="agent-provider-form"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void saveProvider();
                    }}
                  >
                    <h3>{expected ? "编辑 Provider" : "新增 Provider"}</h3>
                    <div className="agent-provider-form__grid">
                      {(
                        ["id", "name", "base_url", "model", "api_key"] as const
                      ).map((field) => (
                        <label key={field} className="agent-config__field">
                          <span>
                            {
                              {
                                id: "Provider ID",
                                name: "显示名称",
                                base_url: "API 基础 URL（HTTPS）",
                                model: "模型 ID",
                                api_key: "API Key · 留空保留旧密钥",
                              }[field]
                            }
                          </span>
                          <input
                            aria-label={field}
                            type={field === "api_key" ? "password" : "text"}
                            value={form[field]}
                            disabled={field === "id" && expected > 0}
                            autoComplete="off"
                            onChange={(e) =>
                              setForm((f) => ({
                                ...f,
                                [field]: e.target.value,
                              }))
                            }
                          />
                        </label>
                      ))}
                    </div>
                    {(config.store.locked || unlockNeeded) && (
                      <section className="agent-provider-unlock">
                        <b>
                          {config.store.initialized
                            ? "凭据库已锁定"
                            : "先设置凭据库密码"}
                        </b>
                        <p>
                          {config.store.initialized
                            ? "输入主密码即可解锁并保存，不会清空你填写的 API Key。"
                            : "设置至少 12 字符的主密码，加密保存模型密钥。"}
                        </p>
                        <label className="agent-config__field">
                          <span>凭据库主密码</span>
                          <input
                            type="password"
                            aria-label="保存时的凭据库主密码"
                            autoComplete="off"
                            value={passphrase}
                            onChange={(e) => setPassphrase(e.target.value)}
                            placeholder={
                              config.store.initialized
                                ? "输入主密码"
                                : "设置至少 12 字符的主密码"
                            }
                          />
                        </label>
                      </section>
                    )}
                    <p>
                      支持 OpenAI Chat
                      Completions。保存后发送一条固定测试短句，不包含聊天记录或私人资料。
                    </p>
                    <button
                      disabled={
                        controlBusy ||
                        !form.id ||
                        !form.model ||
                        (!expected && !form.api_key)
                      }
                    >
                      {controlBusy
                        ? "正在保存 / 验证…"
                        : config.store.locked
                          ? "解锁、保存并测试"
                          : "保存并测试"}
                    </button>
                  </form>
                  <button
                    onClick={() => void testProvider()}
                    disabled={controlBusy || !profile?.configured}
                  >
                    测试当前模型（管理员）
                  </button>
                  {probeResult && (
                    <section className="agent-provider-probe" role="status">
                      <b>✓ 模型连接正常</b>
                      <p>{probeResult.result.text}</p>
                      <small>
                        请求模型：{probeResult.result.model} · 返回标识：
                        {probeResult.result.reported_model || "Provider 未提供"}{" "}
                        ·{" "}
                        {probeResult.result.usage
                          ? `${probeResult.result.usage.input_tokens + probeResult.result.usage.output_tokens} tokens`
                          : "用量未提供"}
                      </small>
                    </section>
                  )}
                </>
              ) : (
                <>
                  <p>
                    只上传你指定的迁移文件。接受 settings/mail/calendar JSON
                    bundle 和 agent_env 字段；先预览、再导入，最后显式激活
                    Provider。旧文件不会被删除；邮件/日历 Connector
                    切换另需维护窗。
                  </p>
                  <input
                    aria-label="选择迁移 JSON"
                    type="file"
                    accept=".json"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (!f) return;
                      if (f.size > 48000) {
                        setNotice("迁移 JSON 超过 48 KiB，请分批");
                        return;
                      }
                      void f.text().then((t) => {
                        setMigration(t);
                        setMigrationPreview(null);
                        setMigrationOperation(op());
                      });
                    }}
                  />
                  <button
                    disabled={controlBusy || config.store.locked || !migration}
                    onClick={() =>
                      void perform(async () => {
                        const r = await api.roomMigration(
                          config.workspace_id,
                          "preview",
                          JSON.parse(migration),
                        );
                        setMigrationPreview(r.data);
                      })
                    }
                  >
                    预览（不写入）
                  </button>
                  {migrationPreview !== null && (
                    <>
                      <pre className="agent-core__migration-result">
                        {JSON.stringify(migrationPreview, null, 2)}
                      </pre>
                      <button
                        disabled={controlBusy}
                        onClick={() =>
                          void perform(async () => {
                            await api.roomMigration(
                              config.workspace_id,
                              "apply",
                              {
                                operation_id: migrationOperation,
                                sources: JSON.parse(migration),
                              },
                            );
                            setMigration("");
                          })
                        }
                      >
                        确认导入到加密凭据库
                      </button>
                      <button
                        disabled={controlBusy || !form.id || !form.model}
                        onClick={() =>
                          void perform(() =>
                            api.roomMigration(config.workspace_id, "activate", {
                              operation_id: op(),
                              id: form.id,
                              name: form.name,
                              base_url: form.base_url,
                              model: form.model,
                              expected_revision: expected,
                            }),
                          )
                        }
                      >
                        激活模型页所填写的 Provider（不再提交 Key）
                      </button>
                    </>
                  )}
                </>
              )}
              <small>
                执行模式：{config.worker_mode}；这不是生产 OS
                沙箱证明。凭据不通过旧 agent.env 分发。
              </small>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
