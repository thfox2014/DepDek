import { useState } from "react";
import {
  Check,
  WarningCircle,
  LockKey,
  CameraSlash,
  DownloadSimple,
  FilePdf,
  Image,
  FilmStrip,
  FileText,
  Folder,
  ArrowLeft,
  ArrowRight,
  Plus,
} from "@phosphor-icons/react";
import type { ButlerStore } from "../lib/store";
import { formatSize, supportsTextPreview } from "../lib/utils";
import type { Mode, Panel, Profile, Resource, StoreState } from "../lib/types";
import { Button, Empty } from "./ui";

export function ResourceIcon({
  resource,
  size = 23,
}: {
  resource: Resource;
  size?: number;
}) {
  if (resource.kind === "dir") return <Folder size={size} />;
  if (resource.category === "照片") return <Image size={size} />;
  if (resource.category === "视频") return <FilmStrip size={size} />;
  return /\.pdf$/i.test(resource.name) ? (
    <FilePdf size={size} />
  ) : (
    <FileText size={size} />
  );
}
export function Resources({
  resources,
  onSelect,
}: {
  resources: Resource[];
  onSelect: (resource: Resource) => void;
}) {
  return (
    <div className="resource-list">
      {resources.map((resource) => (
        <button
          className="resource-row"
          key={resource.id}
          onClick={() => onSelect(resource)}
        >
          <span className="resource-icon">
            <ResourceIcon resource={resource} />
          </span>
          <span>
            <strong>{resource.name}</strong>
            <small>
              {resource.kind === "dir" ? "文件夹" : resource.category} ·{" "}
              {formatSize(resource.size)}
            </small>
          </span>
          <ArrowRight size={17} />
        </button>
      ))}
    </div>
  );
}

export function PanelBody({
  panel,
  data,
  store,
  mode,
  profile,
  onClose,
  onPanel,
  onSend,
  onNotice,
  onRead,
  onProfile,
  onLogout,
  authenticated,
}: {
  panel: Panel;
  data: StoreState;
  store: ButlerStore;
  mode: Mode;
  profile: Profile | null;
  onClose: () => void;
  onPanel: (panel: Panel) => void;
  onSend: (text: string) => void;
  onNotice: (text: string) => void;
  onRead: (file: Resource) => void;
  onProfile: (profile: Profile) => void;
  onLogout: () => void;
  authenticated: boolean;
}) {
  const demo = mode === "demo";
  const [date, setDate] = useState<"2025-06-10" | "unknown" | "">(""),
    [brightness, setBrightness] = useState(data.light),
    [metadata, setMetadata] = useState<Profile>(
      profile || {
        id: "",
        revision: 1,
        name: "",
        model: "",
        cloud: true,
        engine: "deepseek-harness",
      },
    );
  if (panel.type === "task") {
    const task = data.tasks.find((item) => item.id === panel.id);
    if (!task)
      return (
        <Empty title="这件事已不在当前连接中。">可以回到任务页看看。</Empty>
      );
    return (
      <>
        <span
          className={`tag ${task.status === "waiting" || task.status === "unknown" ? "attention" : ""}`}
        >
          {
            {
              queued: "等候交接",
              running: "正在办",
              waiting: "需要你选一下",
              done: "已有结果",
              error: "暂未完成",
              unknown: "结果待核实",
              cancelled: "已停止后续步骤",
            }[task.status]
          }
          {demo ? " · 示例" : ""}
        </span>
        <p className="panel-intro">{task.phase}</p>
        {task.status === "waiting" && demo ? (
          <>
            <p>
              购买凭证写的是 6 月 10 日，保修登记是 6 月 12
              日。后者可能只是登记时间。
            </p>
            <h3>这次清单采用哪个日期？</h3>
            <label className="choice">
              <input
                type="radio"
                name="date"
                checked={date === "2025-06-10"}
                onChange={() => setDate("2025-06-10")}
              />
              <span>
                2025 年 6 月 10 日<small>购买凭证，第 1 页 · 示例</small>
              </span>
            </label>
            <label className="choice">
              <input
                type="radio"
                name="date"
                checked={date === "unknown"}
                onChange={() => setDate("unknown")}
              />
              <span>
                还不确定<small>标为待核实，继续准备其他材料。</small>
              </span>
            </label>
            <Button
              disabled={!date}
              onClick={() => {
                if (date) store.confirmDate(task.id, date);
              }}
            >
              继续准备
            </Button>
            <p className="caption">只用于当前示例清单，不覆盖原始证据。</p>
          </>
        ) : task.status === "done" && demo && task.kind === "repair" ? (
          <>
            <h3>维修要用的，先备在这里。</h3>
            <ul className="checklist">
              <li>
                <Check />
                购买凭证
              </li>
              <li>
                <Check />
                保修登记
              </li>
              <li>
                <WarningCircle />
                故障说明，等你补一句
              </li>
            </ul>
            <dl>
              <div>
                <dt>购买日期</dt>
                <dd>{task.date === "unknown" ? "待核实" : task.date}</dd>
              </div>
              <div>
                <dt>对外发送</dt>
                <dd>没有发送</dd>
              </div>
            </dl>
            <Button
              onClick={() =>
                downloadText(
                  "家合-虚构示例维修清单.txt",
                  `家合 Jiaho · 虚构示例，不含真实文件\n购买日期：${task.date === "unknown" ? "待核实" : task.date}\n材料：购买凭证；保修登记\n缺项：故障说明\n未对外发送。`,
                )
              }
            >
              <DownloadSimple size={19} />
              下载示例清单
            </Button>
          </>
        ) : task.kind === "organize" && task.status === "done" ? (
          <>
            <h3>东西有归处，原件还在。</h3>
            <Resources
              resources={data.resources}
              onSelect={(file) => onPanel({ type: "file", id: file.id })}
            />
            <div className="callout">
              分类是派生视图；没有移动、改名或删除原件。
            </div>
            <Button
              secondary
              onClick={() => {
                onClose();
                onSend("帮我准备洗衣机维修资料");
              }}
            >
              接着准备维修资料
            </Button>
          </>
        ) : task.kind === "light" ? (
          <Button secondary onClick={() => onPanel({ type: "light" })}>
            查看灯光与回执
          </Button>
        ) : (
          <>
            {task.reply && <div className="document-text">{task.reply}</div>}
            {task.error && (
              <div className="callout attention">{task.error}</div>
            )}
            {!demo && (
              <p className="caption">
                这是模型请求的本次结果，不代表已执行文件整理或设备操作。退出页面后不会在前端继续运行。
              </p>
            )}
            {task.usage && (
              <dl>
                <div>
                  <dt>输入 Token</dt>
                  <dd>{task.usage.input_tokens}</dd>
                </div>
                <div>
                  <dt>输出 Token</dt>
                  <dd>{task.usage.output_tokens}</dd>
                </div>
              </dl>
            )}
          </>
        )}
        {["queued", "running", "waiting"].includes(task.status) && (
          <Button
            secondary
            onClick={() => {
              if (!store.cancel(task.id))
                onNotice(
                  "当前业务接口不支持取消已发送请求；你仍可以继续输入。",
                );
            }}
          >
            停止后续步骤
          </Button>
        )}
      </>
    );
  }
  if (panel.type === "file") {
    const file = data.resources.find((item) => item.id === panel.id);
    if (!file) return <Empty title="当前范围没有这份资料。" />;
    return (
      <>
        <div className="file-heading">
          <ResourceIcon resource={file} size={34} />
          <span className="tag">
            {file.category}
            {demo ? " · 示例" : ""}
          </span>
        </div>
        <dl>
          <div>
            <dt>原始路径</dt>
            <dd>{file.path}</dd>
          </div>
          <div>
            <dt>大小</dt>
            <dd>{formatSize(file.size)}</dd>
          </div>
          <div>
            <dt>内容校验</dt>
            <dd className="hash">
              {file.sha256 ||
                (demo
                  ? "无真实文件，不生成假 SHA"
                  : "读取受控原文后显示实际 SHA")}
            </dd>
          </div>
        </dl>
        {file.note && <p>{file.note}</p>}
        {file.content !== undefined ? (
          <pre className="document-text">{file.content}</pre>
        ) : !demo && supportsTextPreview(file.name) ? (
          <Button onClick={() => onRead(file)}>读取受控原文</Button>
        ) : !demo ? (
          <div className="callout">
            当前业务网关未开放这类原片的预览与大文件下载，不会改用管理员文件接口。
          </div>
        ) : (
          <Button
            secondary
            onClick={() =>
              store.patchResource(file.id, {
                note: "示例 AI 描述候选：用于家庭资料检索。人物、日期和条款仍需来源确认；原件未改动。此结果为预设，不是模型识别。",
              })
            }
          >
            体验 AI 自动标注
          </Button>
        )}
        <p className="caption">
          名称、分类和内容描述不是同一件事。实际识别结果必须带原文证据。
        </p>
      </>
    );
  }
  if (panel.type === "light")
    return !demo ? (
      <Empty icon={<WarningCircle size={34} />} title="家电连接还没有开放。">
        当前手机端没有注册真实灯光接口，不会假装已经调好。
      </Empty>
    ) : (
      <>
        <span className="tag">客厅 · 示例灯光</span>
        <div className="brightness">
          {data.lightUnknown ? "待核实" : data.light}
          <small>{data.lightUnknown ? "" : "%"}</small>
        </div>
        <label className="range-label">
          目标亮度 {brightness}%
          <input
            type="range"
            min="0"
            max="100"
            value={brightness}
            disabled={data.lightUnknown}
            onChange={(event) => setBrightness(Number(event.target.value))}
          />
        </label>
        {data.lightUnknown ? (
          <>
            <div className="callout attention">
              已提交，但回读丢失。不重复发送。
            </div>
            <Button
              secondary
              onClick={() => {
                if (!store.recheckLight())
                  onNotice("仍未取得回读，请先在演示设置关闭模拟故障。");
              }}
            >
              只核实，不重复执行
            </Button>
          </>
        ) : (
          <>
            <Button onClick={() => store.adjustLight(brightness)}>
              调整灯光
            </Button>
            {data.lightReceipt && (
              <Button
                secondary
                onClick={() => store.adjustLight(data.lightBefore)}
              >
                恢复上次亮度
              </Button>
            )}
          </>
        )}
        <p className="caption">
          灯光是明确低风险指令；门锁、相机和付款不沿用这个默认值。
        </p>
      </>
    );
  if (panel.type === "privacy")
    return (
      <>
        <div className="callout">
          <LockKey size={20} /> 家合手机端不保存密码、API Key
          或业务会话到浏览器存储。
        </div>
        <dl>
          <div>
            <dt>镜头与家庭传感器</dt>
            <dd>{demo ? "未连接 · 示例" : "当前接口未提供状态"}</dd>
          </div>
          <div>
            <dt>语音</dt>
            <dd>按需启动，转写先填草稿</dd>
          </div>
          <div>
            <dt>资料与对话</dt>
            <dd>当前页面内存，不做离线缓存</dd>
          </div>
          <div>
            <dt>模型内容</dt>
            <dd>仅本次明确输入，不附带资料或历史</dd>
          </div>
        </dl>
        <p>
          浏览器语音可能把音频发给浏览器提供商，不等同于家合本地
          ASR。使用前会单独说明。家合当前还不支持从手机远程启用本机业务网关。
        </p>
        <p className="caption">
          “不保存到浏览器存储”不代表后端不保存审计或模型服务不处理数据，具体由服务器和
          Provider 的策略决定。
        </p>
      </>
    );
  if (panel.type === "model")
    return (
      <>
        <p>
          选择服务器已经登记的模型；此处不收集或保存 API
          密钥。家庭账户不能代替管理员修改凭据。
        </p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (
              !metadata.id.trim() ||
              !Number.isSafeInteger(metadata.revision) ||
              metadata.revision < 1
            )
              return;
            onProfile({
              ...metadata,
              id: metadata.id.trim(),
              name: metadata.name.trim() || metadata.id.trim(),
            });
            onNotice("已选择模型引用，是否可用仍以真实请求回执为准。");
            onClose();
          }}
        >
          <label>
            Provider ID
            <input
              required
              autoComplete="off"
              value={metadata.id}
              onChange={(e) => setMetadata({ ...metadata, id: e.target.value })}
              maxLength={64}
              pattern="[A-Za-z0-9][A-Za-z0-9_.-]{0,63}"
            />
          </label>
          <label>
            配置版本
            <input
              required
              type="number"
              min="1"
              step="1"
              value={metadata.revision}
              onChange={(e) =>
                setMetadata({ ...metadata, revision: Number(e.target.value) })
              }
            />
          </label>
          <label>
            模型显示名称
            <input
              value={metadata.model}
              onChange={(e) =>
                setMetadata({ ...metadata, model: e.target.value })
              }
              maxLength={80}
            />
          </label>
          <label>
            执行器
            <select
              value={metadata.engine}
              onChange={(e) =>
                setMetadata({
                  ...metadata,
                  engine: e.target.value as Profile["engine"],
                })
              }
            >
              <option value="deepseek-harness">DeepSeek Harness</option>
              <option value="pi">Pi</option>
            </select>
          </label>
          <label className="toggle-line">
            <span>
              需要云端处理<small>开启后，每次发送前展示实际文本。</small>
            </span>
            <input
              type="checkbox"
              checked={metadata.cloud}
              onChange={(e) =>
                setMetadata({ ...metadata, cloud: e.target.checked })
              }
            />
          </label>
          <Button type="submit">选择这个模型</Button>
        </form>
        <p className="caption">
          这只是公开元数据，不会授予新权限。Provider/版本/云端范围仍由核心复验；不是保存密钥的管理入口。
        </p>
      </>
    );
  if (panel.type === "settings")
    return (
      <>
        <p className="panel-intro">少一点设置，多一点安心。</p>
        <button
          className="setting-link"
          onClick={() => onPanel({ type: "privacy" })}
        >
          <LockKey size={22} />
          <span>
            感知与隐私<small>清楚知道什么会离开这个家</small>
          </span>
          <ArrowRight size={17} />
        </button>
        <button
          className="setting-link"
          onClick={() => onPanel({ type: "model" })}
        >
          <CameraSlash size={22} />
          <span>
            模型与执行器
            <small>{profile?.model || profile?.id || "尚未选择主机模型"}</small>
          </span>
          <ArrowRight size={17} />
        </button>
        <div className="callout">
          {demo
            ? "当前为体验模式，全部内容为虚构样本。"
            : "当前为真实连接模式；接口不可用时不会回退样本。"}
        </div>
        {authenticated && !demo && (
          <Button secondary onClick={onLogout}>
            退出私人空间
          </Button>
        )}
        <a
          className="text-link"
          href={
            demo
              ? window.location.pathname
              : `${window.location.pathname}?demo=1`
          }
        >
          {demo ? "切换真实连接" : "进入独立体验模式"}
          <ArrowRight size={16} />
        </a>
        <p className="caption">
          家合手机版 {__APP_VERSION__} ·
          关闭页面会清空本页对话。真实长期记忆、NAS 上传和远程 TLS
          接入仍需后端继续开放。
        </p>
      </>
    );
  return (
    <Empty
      icon={<Plus size={30} />}
      title="这项功能还在接入。"
      action={
        <Button secondary onClick={onClose}>
          <ArrowLeft size={17} />
          回到悟空
        </Button>
      }
    />
  );
}
export function downloadText(name: string, content: string) {
  const url = URL.createObjectURL(
    new Blob([content], { type: "text/plain;charset=utf-8" }),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  globalThis.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
