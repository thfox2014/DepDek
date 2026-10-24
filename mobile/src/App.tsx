import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  ArrowRight,
  House,
  Leaf,
  Folder,
  CheckCircle,
  SlidersHorizontal,
  Moon,
  Sun,
  LockKey,
  User,
} from "@phosphor-icons/react";
import WukongHead from "./components/WukongHead";
import MainScreens from "./components/MainScreens";
import { PanelBody } from "./components/Panels";
import PackagePanel from "./components/PackagePanel";
import { Button, Empty, Sheet } from "./components/ui";
import { MobileApi, ApiError, requiresLogin } from "./lib/api";
import { environmentProfile } from "./lib/config";
import { ButlerStore } from "./lib/store";
import {
  supportsTextPreview,
  validProfile,
  withinPromptLimit,
} from "./lib/utils";
import type {
  Category,
  Household,
  Mode,
  Panel,
  Profile,
  Resource,
  Tab,
} from "./lib/types";
import { useVoice } from "./hooks/useVoice";
import { useViewport } from "./hooks/useViewport";
import logo from "./assets/jiaho-logo.png";

const tabs: Array<{ id: Tab; label: string; icon: typeof House }> = [
  { id: "chat", label: "悟空", icon: House },
  { id: "tasks", label: "交给我的事", icon: CheckCircle },
  { id: "home", label: "我的家", icon: House },
  { id: "memory", label: "家的记忆", icon: Leaf },
  { id: "files", label: "我的资料", icon: Folder },
];
type Identity = { principal_id: string; workspace_id: string };
export default function App() {
  const mode: Mode = useMemo(
      () =>
        new URLSearchParams(window.location.search).get("demo") === "1"
          ? "demo"
          : "live",
      [],
    ),
    demo = mode === "demo";
  const store = useMemo(() => new ButlerStore(mode), [mode]),
    api = useMemo(() => new MobileApi(), []);
  const data = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [tab, setTab] = useState<Tab>("chat"),
    [panel, setPanel] = useState<Panel | null>(null),
    [draft, setDraft] = useState(""),
    [notice, setNotice] = useState("");
  const [identity, setIdentity] = useState<Identity | null>(null),
    [connection, setConnection] = useState<
      "checking" | "ready" | "signed-out" | "unavailable"
    >(demo ? "ready" : "checking");
  const [profile, setProfile] = useState<Profile | null>(environmentProfile),
    [profiles, setProfiles] = useState<Profile[]>([]),
    [verifiedProfile, setVerifiedProfile] = useState<string | null>(null);
  const [loginOpen, setLoginOpen] = useState(false),
    [username, setUsername] = useState(""),
    [password, setPassword] = useState(""),
    [authBusy, setAuthBusy] = useState(false),
    [authError, setAuthError] = useState("");
  const [cloudRequest, setCloudRequest] = useState<{
      text: string;
      profile: Profile;
    } | null>(null),
    [voiceConsent, setVoiceConsent] = useState(false),
    [voiceApproved, setVoiceApproved] = useState(false);
  const [theme, setTheme] = useState<"light" | "dark">("light"),
    [density, setDensity] = useState("comfortable"),
    [motion, setMotion] = useState(true),
    [diagnostics, setDiagnostics] = useState(false);
  const [query, setQuery] = useState(""),
    [category, setCategory] = useState<Category>("全部"),
    [readRoot, setReadRoot] = useState(
      import.meta.env.VITE_MOBILE_READ_PATH || "",
    ),
    [readPath, setReadPath] = useState(
      import.meta.env.VITE_MOBILE_READ_PATH || "",
    );
  const [reading, setReading] = useState(false),
    [fileError, setFileError] = useState(""),
    [truncated, setTruncated] = useState(false),
    [family, setFamily] = useState<Household | null>(null),
    [familyError, setFamilyError] = useState(""),
    [familyBusy, setFamilyBusy] = useState(false);
  const [unseen, setUnseen] = useState(false);
  const transcript = useRef<HTMLElement>(null),
    input = useRef<HTMLTextAreaElement>(null),
    following = useRef(true),
    authEpoch = useRef(0),
    previousPrincipal = useRef<string | null>(null),
    alive = useRef(true);
  const queue = useRef<
      Array<{
        id: string;
        text: string;
        profile: Profile;
        consent: boolean;
        epoch: number;
      }>
    >([]),
    draining = useRef(false),
    readEpoch = useRef(0),
    familyEpoch = useRef(0);
  const authenticated = demo || Boolean(identity),
    activeTasks = data.tasks.filter((task) =>
      ["queued", "running", "waiting", "unknown"].includes(task.status),
    );
  const verified = Boolean(
    profile &&
      verifiedProfile === `${profile.id}@${profile.revision}@${profile.engine}`,
  );
  const latestTaskMessage = new Map(
    data.messages
      .filter((message) => message.taskId)
      .map((message) => [message.taskId, message.id]),
  );
  const voice = useVoice(
    demo,
    (text) => {
      setDraft((old) => (old.trim() ? `${old}\n${text}` : text));
      input.current?.focus({ preventScroll: true });
    },
    setNotice,
  );
  useViewport();

  const unlock = () => {
    voice.cancel();
    setPanel(null);
    setAuthError("");
    setLoginOpen(true);
  };
  function authFailure(error: unknown) {
    if (requiresLogin(error)) {
      authEpoch.current++;
      readEpoch.current++;
      familyEpoch.current++;
      queue.current = [];
      store
        .getSnapshot()
        .tasks.filter((task) => task.status === "queued")
        .forEach((task) => store.cancel(task.id));
      setIdentity(null);
      setConnection("signed-out");
      setPanel(null);
      setCloudRequest(null);
      setVoiceConsent(false);
      setLoginOpen(true);
      voice.cancel();
      setNotice("登录已失效。登录后可继续查看，不会自动重发刚才的请求。");
    } else
      setNotice(error instanceof Error ? error.message : "暂未完成这项操作。");
  }
  async function restore() {
    const epoch = authEpoch.current;
    setConnection("checking");
    try {
      const value = await api.restore();
      if (!alive.current || epoch !== authEpoch.current) return;
      if (
        previousPrincipal.current &&
        previousPrincipal.current !==
          `${value.principal_id}/${value.workspace_id}`
      ) {
        authEpoch.current++;
        readEpoch.current++;
        familyEpoch.current++;
        queue.current = [];
        store.clear();
        setDraft("");
        setFamily(null);
        setPanel(null);
        setCloudRequest(null);
        setTab("chat");
      }
      previousPrincipal.current = `${value.principal_id}/${value.workspace_id}`;
      setIdentity(value);
      setConnection("ready");
    } catch (error) {
      if (!alive.current || epoch !== authEpoch.current) return;
      setConnection(requiresLogin(error) ? "signed-out" : "unavailable");
    }
  }
  useEffect(() => {
    alive.current = true;
    if (!demo) void restore();
    return () => {
      alive.current = false;
      authEpoch.current++;
      readEpoch.current++;
      familyEpoch.current++;
      queue.current = [];
      api.clearSession();
      store.dispose();
    };
  }, [api, store, demo]);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.density = density;
    document.documentElement.dataset.motion = String(motion);
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute("content", theme === "light" ? "#fbf8f0" : "#18251f");
  }, [theme, density, motion]);
  useEffect(() => {
    if (!notice) return;
    const timer = globalThis.setTimeout(() => setNotice(""), 6500);
    return () => globalThis.clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    const node = transcript.current;
    if (!node) return;
    if (!data.messages.length || !authenticated) {
      node.scrollTop = 0;
      setUnseen(false);
      return;
    }
    if (following.current) {
      node.scrollTop = node.scrollHeight;
      setUnseen(false);
    } else setUnseen(true);
  }, [data.messages, data.tasks, tab, authenticated]);

  async function login() {
    if (authBusy || !username.trim() || !password) return;
    authEpoch.current++;
    readEpoch.current++;
    familyEpoch.current++;
    queue.current = [];
    setCloudRequest(null);
    setAuthBusy(true);
    setAuthError("");
    try {
      const value = await api.login(username.trim(), password);
      if (!alive.current) return;
      if (
        previousPrincipal.current &&
        previousPrincipal.current !==
          `${value.principal_id}/${value.workspace_id}`
      ) {
        authEpoch.current++;
        queue.current = [];
        store.clear();
        setDraft("");
        setFamily(null);
        setQuery("");
        setTab("chat");
      }
      previousPrincipal.current = `${value.principal_id}/${value.workspace_id}`;
      setIdentity(value);
      setConnection("ready");
      setLoginOpen(false);
      setNotice("已进入私人空间。没有自动重发任何请求。");
    } catch (error) {
      if (alive.current)
        setAuthError(error instanceof Error ? error.message : "登录没有完成。");
    } finally {
      if (alive.current) {
        setPassword("");
        setAuthBusy(false);
      }
    }
  }
  async function logout() {
    if (authBusy) return;
    setAuthBusy(true);
    voice.cancel();
    setCloudRequest(null);
    setVoiceConsent(false);
    authEpoch.current++;
    readEpoch.current++;
    familyEpoch.current++;
    queue.current = [];
    try {
      await api.logout();
      setNotice("已退出私人空间。");
    } catch {
      setNotice(
        "本页已清空；服务端退出回执未取得，请关闭此页面并检查主机会话。",
      );
    } finally {
      store.clear();
      setIdentity(null);
      setConnection("signed-out");
      setDraft("");
      setFamily(null);
      setPanel(null);
      setVerifiedProfile(null);
      previousPrincipal.current = null;
      setAuthBusy(false);
    }
  }
  async function drainQueue() {
    if (draining.current) return;
    draining.current = true;
    try {
      while (queue.current.length) {
        const work = queue.current.shift()!;
        const task = store
          .getSnapshot()
          .tasks.find((item) => item.id === work.id);
        if (task?.status !== "queued" || work.epoch !== authEpoch.current)
          continue;
        store.patchTask(work.id, {
          status: "running",
          phase: "已交给当前执行器，等待模型回执",
        });
        try {
          const answer = await api.chat(work.text, work.profile, work.consent);
          if (!alive.current || work.epoch !== authEpoch.current) continue;
          store.patchTask(work.id, {
            status: "done",
            phase: "已收到模型回复；不代表已执行文件或设备动作",
            reply: answer.result.result.text,
            usage: answer.result.result.usage,
          });
          store.addMessage("assistant", answer.result.result.text, work.id);
          setVerifiedProfile(
            `${work.profile.id}@${work.profile.revision}@${work.profile.engine}`,
          );
        } catch (error) {
          if (!alive.current || work.epoch !== authEpoch.current) continue;
          const unknown =
            error instanceof ApiError &&
            ["UNKNOWN_RESPONSE", "MODEL_OUTCOME_UNKNOWN"].includes(error.code);
          store.patchTask(work.id, {
            status: unknown ? "unknown" : "error",
            phase: unknown ? "尚未取得明确结果，不自动重试" : "这次请求未完成",
            error: error instanceof Error ? error.message : "请求未完成",
          });
          setVerifiedProfile(null);
          authFailure(error);
          if (requiresLogin(error)) break;
        }
      }
    } finally {
      draining.current = false;
    }
  }
  function enqueue(text: string, target: Profile, consent: boolean) {
    store.addMessage("user", text);
    const id = store.addTask(
      text.length > 22 ? `${text.slice(0, 22)}…` : text,
      "model",
    );
    store.addMessage("assistant", "我来看看。你可以继续交代其他事。", id);
    queue.current.push({
      id,
      text,
      profile: { ...target },
      consent,
      epoch: authEpoch.current,
    });
    setDraft((current) => (current.trim() === text ? "" : current));
    void drainQueue();
  }
  function send(text = draft) {
    const value = text.trim();
    if (!value) return;
    if (!withinPromptLimit(value)) {
      setNotice("本次输入超过 16 KiB，请缩短后再发。");
      return;
    }
    if (voice.status === "listening") {
      setNotice("先结束语音，再确认发送草稿。");
      return;
    }
    setTab("chat");
    following.current = true;
    if (demo) {
      setDraft("");
      store.sendDemo(value);
      return;
    }
    if (!identity) {
      if (connection === "unavailable")
        setNotice("家合服务尚未连接。可以在设置查看连接说明，不会回退演示。");
      unlock();
      return;
    }
    if (!validProfile(profile)) {
      setPanel({ type: "model" });
      setNotice("先选择主机已登记的模型引用，不需要在手机输入 API Key。");
      return;
    }
    if (profile.cloud) {
      setCloudRequest({ text: value, profile: { ...profile } });
      return;
    }
    enqueue(value, profile, false);
  }
  async function loadFiles(path = readPath) {
    if (demo) return;
    if (!identity) {
      unlock();
      return;
    }
    if (!path.trim()) {
      setFileError(
        "尚未设置可读目录，请在设置里填写管理员已经授权的相对目录。",
      );
      return;
    }
    const request = ++readEpoch.current;
    setReading(true);
    setFileError("");
    try {
      const result = await api.listFiles(path.trim());
      if (!alive.current || request !== readEpoch.current) return;
      store.setResources(result.resources);
      setReadPath(path.trim());
      setTruncated(result.truncated);
    } catch (error) {
      if (request === readEpoch.current) {
        store.setResources([]);
        setFileError(error instanceof Error ? error.message : "资料暂不可读。");
        authFailure(error);
      }
    } finally {
      if (request === readEpoch.current) setReading(false);
    }
  }
  async function readFile(file: Resource) {
    if (demo) return;
    if (!supportsTextPreview(file.name)) return;
    const request = readEpoch.current,
      epoch = authEpoch.current;
    setReading(true);
    try {
      const result = await api.readFile(file.path);
      if (
        !alive.current ||
        epoch !== authEpoch.current ||
        request !== readEpoch.current
      )
        return;
      store.patchResource(file.id, {
        content: result.content,
        sha256: result.sha256,
        size: result.size,
      });
    } catch (error) {
      if (
        alive.current &&
        epoch === authEpoch.current &&
        request === readEpoch.current
      )
        authFailure(error);
    } finally {
      if (
        alive.current &&
        epoch === authEpoch.current &&
        request === readEpoch.current
      )
        setReading(false);
    }
  }
  function selectFile(file: Resource) {
    if (file.kind === "dir") {
      setQuery("");
      void loadFiles(file.path);
    } else setPanel({ type: "file", id: file.id });
  }
  async function loadFamily() {
    if (demo) return;
    if (!identity) {
      unlock();
      return;
    }
    const request = ++familyEpoch.current;
    setFamilyBusy(true);
    setFamilyError("");
    try {
      const result = await api.family();
      if (alive.current && request === familyEpoch.current) setFamily(result);
    } catch (error) {
      if (request === familyEpoch.current) {
        setFamily(null);
        setFamilyError(
          error instanceof Error ? error.message : "家庭资料未能读取。",
        );
        authFailure(error);
      }
    } finally {
      if (request === familyEpoch.current) setFamilyBusy(false);
    }
  }
  async function discoverProfiles() {
    try {
      const values = await api.discoverProfiles();
      if (!alive.current) return;
      setProfiles(values);
      if (!profile && values[0]) setProfile(values[0]);
      setNotice(
        values.length
          ? "已读取模型元数据；是否连接以请求回执为准。"
          : "主机还没有可用的模型配置。",
      );
    } catch (error) {
      setNotice(
        error instanceof Error ? error.message : "未能取得模型元数据。",
      );
    }
  }
  function changeTab(next: Tab) {
    voice.cancel();
    setTab(next);
    setPanel(null);
    if (next === "files" && !demo && identity && readPath) void loadFiles();
    if (next === "home" && !demo && identity) void loadFamily();
  }
  function startVoice() {
    if (!authenticated) {
      unlock();
      return;
    }
    if (draft.trim()) {
      setNotice("先发送或清空当前草稿，再使用语音，避免覆盖。");
      return;
    }
    if (demo || voiceApproved) voice.start();
    else setVoiceConsent(true);
  }
  const currentTask =
    panel?.type === "task"
      ? data.tasks.find((task) => task.id === panel.id)
      : null;
  const panelTitle =
    panel?.type === "task"
      ? currentTask?.title || "这件事的进展"
      : panel?.type === "file"
        ? data.resources.find((file) => file.id === panel.id)?.name ||
          "资料与来处"
        : (
            {
              light: "让灯光，刚刚好。",
              settings: "安心与设置",
              privacy: "照看好，也守得住。",
              model: "模型与执行器",
              package: "维修资料包",
            } as Record<string, string>
          )[panel?.type || ""] || "";
  const locked = !authenticated;

  return (
    <div className={`mobile-app ${demo ? "is-demo" : ""}`}>
      {demo && (
        <div className="demo-banner">
          <span>独立体验 · 示例资料，不连接家庭设备</span>
          <a href={window.location.pathname}>
            连接我的家
            <ArrowRight size={12} />
          </a>
        </div>
      )}
      <header className="app-header">
        <button
          className="brand-button"
          onClick={() => changeTab("chat")}
          aria-label="家合首页"
        >
          <img src={logo} alt="家合 Jiaho" />
        </button>
        <div className="header-identity">
          <strong>悟空</strong>
          <span>
            {demo
              ? "在家，慢慢说。"
              : connection === "checking"
                ? "正在连接家合…"
                : identity
                  ? `${identity.principal_id} 的私人空间`
                  : connection === "unavailable"
                    ? "尚未连接你的家"
                    : "登录你的私人空间"}
          </span>
        </div>
        <button
          className="icon-button"
          aria-label={theme === "light" ? "切换深色模式" : "切换浅色模式"}
          onClick={() => setTheme(theme === "light" ? "dark" : "light")}
        >
          {theme === "light" ? <Moon size={21} /> : <Sun size={21} />}
        </button>
        <button
          className="icon-button account-button"
          aria-label="私人空间与设置"
          onClick={() => (locked ? unlock() : setPanel({ type: "settings" }))}
        >
          {locked ? <User size={21} /> : <SlidersHorizontal size={21} />}
        </button>
      </header>
      <MainScreens
        {...{
          tab,
          demo,
          locked,
          identity,
          connection,
          profile,
          verified,
          data,
          store,
          activeTasks,
          voice,
          latestTaskMessage,
          following,
          transcript,
          input,
          draft,
          setDraft,
          send,
          setPanel,
          setNotice,
          unlock,
          changeTab,
          unseen,
          setUnseen,
          reading,
          fileError,
          readRoot,
          readPath,
          loadFiles,
          query,
          setQuery,
          category,
          setCategory,
          truncated,
          selectFile,
          familyBusy,
          familyError,
          family,
          loadFamily,
          startVoice,
        }}
      />
      <nav className="bottom-nav" aria-label="主导航">
        {tabs.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            className={tab === id ? "selected" : ""}
            aria-current={tab === id ? "page" : undefined}
            onClick={() => changeTab(id)}
          >
            {id === "chat" ? (
              <WukongHead />
            ) : (
              <Icon size={22} weight={tab === id ? "fill" : "regular"} />
            )}
            <span>{label}</span>
            {id === "tasks" && activeTasks.length > 0 && authenticated && (
              <i
                className="nav-dot"
                aria-label={`${activeTasks.length} 件有进展的事`}
              />
            )}
          </button>
        ))}
      </nav>
      <Sheet
        open={Boolean(panel)}
        title={panelTitle}
        kicker={demo ? "体验模式 · 所有内容为示例" : "家合 · 当前工作区"}
        onClose={() => setPanel(null)}
      >
        {panel &&
        (!locked || ["privacy", "model", "settings"].includes(panel.type)) ? (
          panel.type === "package" ? (
            <PackagePanel
              pack={family?.packages.find((pack) => pack.id === panel.id)}
            />
          ) : (
            <>
              <PanelBody
                key={`${panel.type}-${panel.id || ""}`}
                panel={panel}
                data={data}
                store={store}
                mode={mode}
                profile={profile}
                onClose={() => setPanel(null)}
                onPanel={setPanel}
                onSend={send}
                onNotice={setNotice}
                onRead={(file) => void readFile(file)}
                onProfile={(value) => {
                  setProfile(value);
                  setVerifiedProfile(null);
                }}
                onLogout={() => void logout()}
                authenticated={Boolean(identity)}
              />
              {panel.type === "model" && !demo && (
                <>
                  <Button secondary onClick={() => void discoverProfiles()}>
                    读取主机模型元数据
                  </Button>
                  {profiles.map((value) => (
                    <button
                      className="profile-choice"
                      key={value.id}
                      onClick={() => {
                        setProfile(value);
                        setVerifiedProfile(null);
                        setNotice("已选择模型引用，未发出测试请求。");
                      }}
                    >
                      {value.name || value.id}
                      <small>
                        {value.model} · v{value.revision}
                      </small>
                    </button>
                  ))}
                </>
              )}
              {panel.type === "settings" && (
                <div className="appearance-settings">
                  <h3>用起来，舒服一点。</h3>
                  <label className="toggle-line">
                    深色模式
                    <input
                      type="checkbox"
                      checked={theme === "dark"}
                      onChange={(e) =>
                        setTheme(e.target.checked ? "dark" : "light")
                      }
                    />
                  </label>
                  <label>
                    阅读方式
                    <select
                      value={density}
                      onChange={(e) => setDensity(e.target.value)}
                    >
                      <option value="comfortable">日常管家</option>
                      <option value="large">大字陪伴</option>
                      <option value="compact">专注办事</option>
                    </select>
                  </label>
                  <label className="toggle-line">
                    悟空轻动效
                    <input
                      type="checkbox"
                      checked={motion}
                      onChange={(e) => setMotion(e.target.checked)}
                    />
                  </label>
                  {!demo && (
                    <details>
                      <summary>连接与目录</summary>
                      <p className="caption">
                        同源业务代理。开发时将 business_origin 明确配置为当前
                        loopback 来源，不能通过伪造 Origin 绕过。
                      </p>
                      <p className="caption">
                        本页来源：{window.location.origin}
                      </p>
                      <label>
                        已授权相对目录
                        <input
                          value={readRoot}
                          onChange={(e) => {
                            setReadRoot(e.target.value);
                            setReadPath(e.target.value);
                            store.setResources([]);
                            readEpoch.current++;
                          }}
                          placeholder="由主机管理员提供"
                        />
                      </label>
                      <Button
                        secondary
                        onClick={() => {
                          setPanel(null);
                          void restore();
                        }}
                      >
                        重新检测连接
                      </Button>
                    </details>
                  )}
                  {demo && (
                    <details
                      open={diagnostics}
                      onToggle={(e) => setDiagnostics(e.currentTarget.open)}
                    >
                      <summary>演示设置 · Tweaks</summary>
                      <label className="toggle-line">
                        模拟设备回读丢失
                        <input
                          type="checkbox"
                          defaultChecked={store.failure}
                          onChange={(e) => {
                            store.failure = e.target.checked;
                            setNotice("已更改模拟故障，不操作真实设备。");
                          }}
                        />
                      </label>
                      <Button
                        secondary
                        onClick={() => {
                          store.setDemoEmpty(true);
                          setNotice("已切换空资料库，后续不会报告整理成功。");
                        }}
                      >
                        模拟空资料库
                      </Button>
                      <Button
                        secondary
                        onClick={() => {
                          store.clear();
                          setDraft("");
                          setPanel(null);
                          setTab("chat");
                        }}
                      >
                        重置当前演示
                      </Button>
                    </details>
                  )}
                </div>
              )}
            </>
          )
        ) : (
          <Empty
            icon={<LockKey size={36} />}
            title="先登录私人空间。"
            action={<Button onClick={unlock}>登录</Button>}
          />
        )}
      </Sheet>
      <Sheet
        open={loginOpen}
        title="欢迎回家。"
        kicker="家合 · 私人空间"
        onClose={() => {
          if (!authBusy) {
            setLoginOpen(false);
            setPassword("");
          }
        }}
        className="login-sheet"
      >
        <p>使用主机已创建的家庭账户。管理员密码不自动等于家庭账户密码。</p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void login();
          }}
        >
          <label>
            用户名
            <input
              autoComplete="username"
              autoFocus
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
              disabled={authBusy}
            />
          </label>
          <label>
            密码
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              disabled={authBusy}
            />
          </label>
          {authError && (
            <p className="form-error" role="alert">
              {authError}
            </p>
          )}
          <Button
            type="submit"
            disabled={authBusy || !username.trim() || !password}
          >
            {authBusy ? "正在进入…" : "进入我的家"}
            <ArrowRight size={19} />
          </Button>
        </form>
        <p className="caption">
          密码不写入浏览器存储。登录成功后不会自动重发之前的请求。
        </p>
      </Sheet>
      <Sheet
        open={Boolean(cloudRequest)}
        title="这次，云端帮什么？"
        kicker="只发送你确认的内容"
        onClose={() => setCloudRequest(null)}
      >
        <p>
          下面的文字会发送给主机配置的云端模型。不会自动附带聊天历史、家庭文件或记忆。
        </p>
        <pre className="document-text">{cloudRequest?.text}</pre>
        <dl>
          <div>
            <dt>模型引用</dt>
            <dd>
              {cloudRequest?.profile.id} · v{cloudRequest?.profile.revision}
            </dd>
          </div>
          <div>
            <dt>执行器</dt>
            <dd>{cloudRequest?.profile.engine}</dd>
          </div>
        </dl>
        <Button
          onClick={() => {
            const value = cloudRequest;
            if (!value) return;
            setCloudRequest(null);
            enqueue(value.text, value.profile, true);
          }}
        >
          允许发送这次输入
          <ArrowRight size={18} />
        </Button>
        <Button secondary onClick={() => setCloudRequest(null)}>
          先不发送
        </Button>
      </Sheet>
      <Sheet
        open={voiceConsent}
        title="先说清楚，怎样听。"
        kicker="浏览器语音，不是家合本地识别"
        onClose={() => setVoiceConsent(false)}
      >
        <p>
          浏览器可能把你的音频发送给其语音识别服务。此功能不保证离线，也不适合朗读证件、账户等私密内容。
        </p>
        <p>
          识别结果只填入草稿，由你确认后再发送。你也可以直接用键盘或手机自带的输入法。
        </p>
        <Button
          onClick={() => {
            setVoiceApproved(true);
            setVoiceConsent(false);
            voice.start();
          }}
        >
          了解，本页按需使用语音
        </Button>
        <Button secondary onClick={() => setVoiceConsent(false)}>
          用键盘输入
        </Button>
      </Sheet>
      {notice && (
        <div className="toast" role="status" aria-live="polite">
          {notice}
        </div>
      )}
      <div className="app-version">JIAHO MOBILE · {__APP_VERSION__}</div>
    </div>
  );
}
