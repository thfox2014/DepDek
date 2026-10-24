import type { MutableRefObject, RefObject } from "react";
import {
  ArrowUp,
  ArrowRight,
  ArrowLeft,
  Microphone,
  Keyboard,
  Stop,
  House,
  Leaf,
  Folder,
  CheckCircle,
  LockKey,
  WarningCircle,
  Plus,
  MagnifyingGlass,
  ArrowCounterClockwise,
  FileText,
} from "@phosphor-icons/react";
import WukongHead from "./WukongHead";
import TaskCard from "./TaskCard";
import { Resources } from "./Panels";
import { Button, Empty } from "./ui";
import { filterResources } from "../lib/utils";
import type { ButlerStore } from "../lib/store";
import type {
  Category,
  Household,
  Panel,
  Profile,
  Resource,
  StoreState,
  Tab,
  Task,
} from "../lib/types";

interface MainScreenProps {
  tab: Tab;
  demo: boolean;
  locked: boolean;
  identity: { principal_id: string; workspace_id: string } | null;
  connection: "checking" | "ready" | "signed-out" | "unavailable";
  profile: Profile | null;
  verified: boolean;
  data: StoreState;
  store: ButlerStore;
  activeTasks: Task[];
  voice: { status: "idle" | "listening"; cancel: () => void };
  latestTaskMessage: Map<string | undefined, string>;
  following: MutableRefObject<boolean>;
  transcript: RefObject<HTMLElement>;
  input: RefObject<HTMLTextAreaElement>;
  draft: string;
  setDraft: (value: string) => void;
  send: (text?: string) => void;
  setPanel: (panel: Panel | null) => void;
  setNotice: (text: string) => void;
  unlock: () => void;
  changeTab: (tab: Tab) => void;
  unseen: boolean;
  setUnseen: (value: boolean) => void;
  reading: boolean;
  fileError: string;
  readRoot: string;
  readPath: string;
  loadFiles: (path?: string) => Promise<void>;
  query: string;
  setQuery: (query: string) => void;
  category: Category;
  setCategory: (category: Category) => void;
  truncated: boolean;
  selectFile: (file: Resource) => void;
  familyBusy: boolean;
  familyError: string;
  family: Household | null;
  loadFamily: () => Promise<void>;
  startVoice: () => void;
}
const categories: Category[] = ["全部", "照片", "视频", "文档", "邮件", "其他"];
export default function MainScreens(props: MainScreenProps) {
  const {
    tab,
    demo,
    locked,
    identity,
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
  } = props;
  return (
    <main className={`main-content view-${tab}`}>
      {tab === "chat" ? (
        <>
          <section
            ref={transcript}
            className="transcript"
            aria-label="和悟空的持续对话"
            onScroll={() => {
              const node = transcript.current;
              if (node) {
                following.current =
                  node.scrollHeight - node.scrollTop - node.clientHeight < 80;
                if (following.current) setUnseen(false);
              }
            }}
          >
            {!data.messages.length || locked ? (
              <div className="welcome">
                <div className="hero-avatar">
                  <WukongHead
                    listening={voice.status === "listening"}
                    busy={activeTasks.some((task) => task.status === "running")}
                  />
                </div>
                <p className="eyebrow">悟空在 · 你的家庭管家</p>
                <h1>
                  我在，慢慢说。
                  <br />
                  家里的事，交给我。
                </h1>
                <p className="welcome-copy">
                  收好一份资料，找回一个片刻，
                  <br />
                  把一件没空处理的小事交给我。
                </p>
                <div className="welcome-starts">
                  <button onClick={() => send("帮我整理照片、视频和文档")}>
                    <Folder size={19} />
                    <span>整理这些资料</span>
                    <ArrowRight size={17} />
                  </button>
                  <button onClick={() => send("帮我准备洗衣机维修资料")}>
                    <FileText size={19} />
                    <span>准备维修资料</span>
                    <ArrowRight size={17} />
                  </button>
                </div>
                {!demo && (
                  <p className="connection-note">
                    {identity
                      ? verified
                        ? "已取得模型回执；家庭动作仍需独立结果。"
                        : profile
                          ? "已选择主机模型，连接尚待实际回执。"
                          : "先登录，再选择主机已有模型。"
                      : "你的资料属于你。登录后再开始私人对话。"}{" "}
                    <button
                      onClick={() =>
                        locked ? unlock() : setPanel({ type: "model" })
                      }
                    >
                      {locked ? "登录" : "连接设置"}
                    </button>
                  </p>
                )}
              </div>
            ) : (
              <div className="message-list">
                {data.messages.map((message) => (
                  <article
                    className={`chat-message ${message.role}`}
                    key={message.id}
                  >
                    {message.role === "assistant" && (
                      <div className="message-avatar">
                        <WukongHead />
                      </div>
                    )}
                    <div className="message-content">
                      {message.role === "assistant" && (
                        <span className="speaker">
                          悟空{demo ? " · 示例" : ""}
                        </span>
                      )}
                      <p
                        className={`bubble ${message.error ? "attention" : ""}`}
                      >
                        {message.text}
                      </p>
                      {message.taskId &&
                        latestTaskMessage.get(message.taskId) === message.id &&
                        (() => {
                          const task = data.tasks.find(
                            (item) => item.id === message.taskId,
                          );
                          return task ? (
                            <TaskCard
                              task={task}
                              demo={demo}
                              onOpen={() =>
                                setPanel({ type: "task", id: task.id })
                              }
                              onCancel={() => {
                                if (!store.cancel(task.id))
                                  setNotice("已发送的请求不能由当前接口取消。");
                              }}
                            />
                          ) : null;
                        })()}
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>
          {unseen && !locked && (
            <button
              className="new-progress"
              onClick={() => {
                following.current = true;
                if (transcript.current)
                  transcript.current.scrollTop =
                    transcript.current.scrollHeight;
                setUnseen(false);
              }}
            >
              有新进展，回到最新消息 ↓
            </button>
          )}
          <div className="composer-wrap">
            <form
              className={`composer ${voice.status === "listening" ? "listening" : ""}`}
              onSubmit={(event) => {
                event.preventDefault();
                send();
              }}
            >
              {voice.status === "listening" ? (
                <div className="voice-state" role="status">
                  <span className="voice-wave" aria-hidden="true">
                    <i />
                    <i />
                    <i />
                    <i />
                    <i />
                  </span>
                  <span>
                    {demo ? "体验：悟空在听" : "正在识别，请说话"}
                    <small>
                      {demo ? "未启用麦克风" : "转写只填入草稿，不会自动发送"}
                    </small>
                  </span>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label="取消语音输入"
                    onClick={voice.cancel}
                  >
                    <Stop size={20} />
                  </button>
                </div>
              ) : (
                <textarea
                  ref={input}
                  rows={2}
                  value={locked && !demo ? "" : draft}
                  onChange={(event) => setDraft(event.target.value)}
                  onFocus={() => {
                    if (locked && !demo) unlock();
                  }}
                  onKeyDown={(event) => {
                    if (
                      event.key === "Enter" &&
                      !event.shiftKey &&
                      !event.nativeEvent.isComposing
                    ) {
                      event.preventDefault();
                      send();
                    }
                  }}
                  aria-label="和悟空说话"
                  placeholder={
                    locked && !demo
                      ? "登录后，接着和悟空说…"
                      : "交给我吧，或者说一句…"
                  }
                />
              )}
              <div className="composer-actions">
                <button
                  className="icon-button microphone"
                  type="button"
                  aria-label="语音输入"
                  onClick={
                    voice.status === "listening" ? voice.cancel : startVoice
                  }
                >
                  <Microphone size={23} />
                </button>
                <button
                  className="icon-button"
                  type="button"
                  aria-label="使用键盘输入"
                  onClick={() => {
                    voice.cancel();
                    input.current?.focus({ preventScroll: true });
                  }}
                >
                  <Keyboard size={22} />
                </button>
                <span>
                  {activeTasks.some((task) => task.status === "running") &&
                  !locked
                    ? "我继续办，你接着说。"
                    : "语音或文字，都可以。"}
                </span>
                <button
                  className="send-button"
                  type="submit"
                  aria-label="发送消息"
                  disabled={
                    !draft.trim() ||
                    voice.status === "listening" ||
                    (locked && !demo)
                  }
                >
                  <ArrowUp size={22} weight="bold" />
                </button>
              </div>
            </form>
            <div className="composer-caption">
              <LockKey size={12} />
              {demo
                ? "只在本页体验，不发送你的内容。"
                : "只发送本次输入，不自动附带家庭资料。"}
            </div>
          </div>
        </>
      ) : locked ? (
        <div className="page">
          <Empty
            icon={<LockKey size={38} />}
            title="先进入你的私人空间。"
            action={<Button onClick={unlock}>登录，接着往下看</Button>}
          >
            家庭账户与设备管理员是两套权限。没有默认账户，不会把管理权限当成私人身份。
          </Empty>
        </div>
      ) : tab === "tasks" ? (
        <div className="page">
          <div className="page-heading">
            <p className="eyebrow">有始有终</p>
            <h1>交给我的事</h1>
            <p>
              {demo
                ? "我会继续照看，你不必等在这里。"
                : "本次连接的模型请求。持久任务恢复需由后端继续开放。"}
            </p>
          </div>
          {data.tasks.length ? (
            data.tasks
              .slice()
              .reverse()
              .map((task) => (
                <TaskCard
                  key={task.id}
                  task={task}
                  demo={demo}
                  onOpen={() => setPanel({ type: "task", id: task.id })}
                  onCancel={() => {
                    if (!store.cancel(task.id))
                      setNotice("当前接口不支持取消已发送请求。");
                  }}
                />
              ))
          ) : (
            <Empty
              icon={<CheckCircle size={40} />}
              title="还没有交接的事。"
              action={
                <Button secondary onClick={() => changeTab("chat")}>
                  把一件小事交给悟空
                </Button>
              }
            >
              有事再来，也可以只是说两句。
            </Empty>
          )}
        </div>
      ) : tab === "files" ? (
        <div className="page files-page">
          <div className="page-heading heading-with-action">
            <div>
              <p className="eyebrow">东西有归处</p>
              <h1>我的资料</h1>
            </div>
            <button
              className="icon-button"
              aria-label="刷新资料"
              disabled={reading}
              onClick={() =>
                demo
                  ? setNotice("当前是明确的示例资料，没有扫描你的磁盘。")
                  : void loadFiles()
              }
            >
              <ArrowCounterClockwise size={23} />
            </button>
          </div>
          <label className="search-field">
            <MagnifyingGlass size={20} />
            <input
              type="search"
              aria-label="搜索文件名、路径或 SHA"
              placeholder="名字、路径，或记得的一点线索"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          <div className="category-tabs" aria-label="资料分类">
            {categories.map((item) => (
              <button
                key={item}
                className={category === item ? "selected" : ""}
                aria-pressed={category === item}
                onClick={() => setCategory(item)}
              >
                {item}
              </button>
            ))}
          </div>
          {!demo && (
            <div className="directory-bar">
              <span>{readPath || "尚未选择服务器授权目录"}</span>
              {readRoot && readPath !== readRoot && (
                <button
                  onClick={() => {
                    const parent = readPath.split("/").slice(0, -1).join("/");
                    void loadFiles(parent || readRoot);
                  }}
                >
                  <ArrowLeft size={15} />
                  上一级
                </button>
              )}
            </div>
          )}
          {reading && (
            <p className="status-line" role="status">
              正在读取授权资料…
            </p>
          )}
          {fileError && (
            <div className="callout attention" role="alert">
              {fileError}
            </div>
          )}
          {filterResources(data.resources, category, query).length ? (
            <Resources
              resources={filterResources(data.resources, category, query)}
              onSelect={selectFile}
            />
          ) : (
            <Empty
              icon={<Folder size={39} />}
              title={
                query ? "没有找到这份资料。" : "把第一份资料，安放在这里。"
              }
            >
              {demo
                ? "可以试试“洗衣机”，或在演示设置恢复样本。"
                : "当前只读取已授权目录；尚未开放手机端 NAS 大文件上传。"}
            </Empty>
          )}
          {truncated && (
            <p className="caption">
              目录结果已截断，不代表全部文件。请进入更具体的目录读取。
            </p>
          )}
          <button
            className="add-resource"
            onClick={() =>
              demo
                ? store.setDemoEmpty(false)
                : setNotice(
                    "当前网关仅开放受控读取；大文件上传不在这一批接口中，不会使用管理员文件接口代替。",
                  )
            }
          >
            <Plus size={22} />
            {demo ? "恢复示例资料" : "添加资料"}
            <small>{demo ? "不读取你的磁盘" : "上传接口待开放"}</small>
          </button>
        </div>
      ) : tab === "memory" ? (
        <div className="page">
          <div className="page-heading">
            <p className="eyebrow">熟悉，有分寸</p>
            <h1>家的记忆</h1>
            <p>记住什么，由你决定。</p>
          </div>
          {demo ? (
            data.memories.length ? (
              data.memories.map((memory) => (
                <article className="memory-card" key={memory.id}>
                  <span className="tag">明确表达 · 示例</span>
                  <h3>{memory.text}</h3>
                  <p>{memory.source}</p>
                  <button
                    className="text-link"
                    onClick={() => {
                      store.forget(memory.id);
                      setNotice(
                        "已停止使用这条示例记忆，不会根据原来源自动恢复。",
                      );
                    }}
                  >
                    忘记这条
                    <ArrowRight size={17} />
                  </button>
                </article>
              ))
            ) : (
              <Empty icon={<Leaf size={39} />} title="现在没有保留的偏好。">
                你可以说“请记住，回答简单一点”。
              </Empty>
            )
          ) : (
            <Empty icon={<LockKey size={38} />} title="记忆接口还在接入。">
              桌面端的长期记忆仍在原处；当前业务网关尚未开放，手机端不会编造“已记住”。
            </Empty>
          )}
        </div>
      ) : (
        <div className="page">
          <div className="page-heading heading-with-action">
            <div>
              <p className="eyebrow">家是背景，不是监控台</p>
              <h1>我的家</h1>
            </div>
            {!demo && (
              <button
                className="icon-button"
                disabled={familyBusy}
                aria-label="刷新家庭资料"
                onClick={() => void loadFamily()}
              >
                <ArrowCounterClockwise size={23} />
              </button>
            )}
          </div>
          {demo ? (
            <>
              <button
                className="home-device"
                onClick={() => setPanel({ type: "light" })}
              >
                <House size={29} />
                <span>
                  <strong>客厅</strong>
                  <small>
                    灯光 {data.lightUnknown ? "待核实" : `${data.light}%`} ·
                    示例
                  </small>
                </span>
                <ArrowRight size={19} />
              </button>
              <div className="home-note">
                <CameraSlashMark />
                <span>
                  不展示监控墙。<small>没有传感器的房间，保持未知。</small>
                </span>
              </div>
              <div className="section-heading">
                <h2>家里的资料</h2>
                <button onClick={() => changeTab("files")}>
                  看看全部
                  <ArrowRight size={15} />
                </button>
              </div>
              <Resources
                resources={data.resources.filter(
                  (file) => file.category === "文档",
                )}
                onSelect={selectFile}
              />
            </>
          ) : (
            <>
              {familyBusy && (
                <p role="status" className="status-line">
                  正在读取家庭档案…
                </p>
              )}
              {familyError && (
                <div className="callout attention">{familyError}</div>
              )}
              {family?.items.length
                ? family.items.map((item) => (
                    <article className="family-item" key={item.id}>
                      <h3>{item.name}</h3>
                      <small>
                        版本 {item.revision} · {item.sources.length} 份原件引用
                      </small>
                      <p>
                        {item.assertions.length}{" "}
                        条有来源的断言；未确认不当作事实。
                      </p>
                      {family.packages
                        .filter((pack) => pack.item_id === item.id)
                        .map((pack) => (
                          <button
                            className="text-link"
                            key={pack.id}
                            onClick={() =>
                              setPanel({ type: "package", id: pack.id })
                            }
                          >
                            {pack.stale ? "资料需要更新" : "查看维修资料包"}
                            <ArrowRight size={16} />
                          </button>
                        ))}
                    </article>
                  ))
                : !familyBusy && (
                    <Empty
                      icon={<House size={39} />}
                      title="家庭档案还没有出现。"
                    >
                      只展示当前账户有权查看的家庭物品和资料包，不从管理员数据目录读取。
                    </Empty>
                  )}
            </>
          )}
          <button
            className="privacy-note"
            onClick={() => setPanel({ type: "privacy" })}
          >
            <LockKey size={18} />
            <span>照看好，也守得住。</span>
            <ArrowRight size={15} />
          </button>
        </div>
      )}
    </main>
  );
}
function CameraSlashMark() {
  return <WarningCircle size={25} />;
}
