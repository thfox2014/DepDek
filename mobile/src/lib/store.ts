import type { Mode, Resource, StoreState, Task, TaskStatus } from "./types.ts";

const demoResources: Resource[] = [
  {
    id: "invoice",
    name: "洗衣机购买凭证.pdf",
    path: "我的资料/家电/洗衣机/购买凭证.pdf",
    category: "文档",
    kind: "file",
    size: 860000,
    note: "示例凭证记载购买日期 2025-06-10。保修期未确认。",
  },
  {
    id: "registration",
    name: "洗衣机保修登记.pdf",
    path: "我的资料/家电/洗衣机/保修登记.pdf",
    category: "文档",
    kind: "file",
    size: 1200000,
    note: "示例登记日期为 2025-06-12，不一定是购买日期。",
  },
  {
    id: "afternoon",
    name: "客厅的一个午后.jpg",
    path: "我的资料/照片/日常/客厅的一个午后.jpg",
    category: "照片",
    kind: "file",
    size: 3400000,
    note: "虚构示例，无真实照片，不确认人物、地点或时间。",
  },
  {
    id: "bicycle",
    name: "第一次学会骑车.mp4",
    path: "我的资料/视频/片刻/第一次学会骑车.mp4",
    category: "视频",
    kind: "file",
    size: 28000000,
    note: "虚构示例，无真实视频或时间码，不做实际识别。",
  },
];
const makeState = (mode: Mode): StoreState => ({
  messages: [],
  tasks: [],
  resources: mode === "demo" ? structuredClone(demoResources) : [],
  memories:
    mode === "demo"
      ? [
          {
            id: "brief",
            text: "回答简单一点，先给结论。",
            source: "示例原话：“以后先给结论，细节我再问。”",
          },
        ]
      : [],
  light: 42,
  lightBefore: 42,
  lightUnknown: false,
  actualLight: 42,
  lightReceipt: false,
});
export const taskLabel = (status: TaskStatus) =>
  ({
    queued: "等候交接",
    running: "正在办",
    waiting: "需要你选一下",
    done: "已有结果",
    error: "暂未完成",
    unknown: "结果待核实",
    cancelled: "已停止后续步骤",
  })[status];

/** Local UI projection. Only explicit demo mode owns timers and fabricated resources. */
export class ButlerStore {
  private state: StoreState;
  private listeners = new Set<() => void>();
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private serial = 0;
  private generation = 0;
  private mode: Mode;
  failure = false;
  constructor(mode: Mode) {
    this.mode = mode;
    this.state = makeState(mode);
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private update(patch: Partial<StoreState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((fn) => fn());
  }
  private id(prefix: string) {
    return `${prefix}-${++this.serial}`;
  }
  private later(fn: () => void, ms: number) {
    const generation = this.generation;
    const handle = globalThis.setTimeout(() => {
      this.timers.delete(handle);
      if (generation === this.generation) fn();
    }, ms);
    this.timers.add(handle);
  }
  clear() {
    this.generation++;
    this.timers.forEach((timer) => globalThis.clearTimeout(timer));
    this.timers.clear();
    this.update(makeState(this.mode));
  }
  dispose() {
    this.generation++;
    this.timers.forEach((timer) => globalThis.clearTimeout(timer));
    this.timers.clear();
    this.listeners.clear();
  }
  addMessage(
    role: "user" | "assistant",
    text: string,
    taskId?: string,
    error = false,
  ) {
    this.update({
      messages: [
        ...this.state.messages,
        { id: this.id("message"), role, text, taskId, error },
      ],
    });
  }
  addTask(title: string, kind: Task["kind"], status: TaskStatus = "queued") {
    const task: Task = {
      id: this.id("task"),
      title,
      kind,
      status,
      phase: "等候处理",
      step: 0,
    };
    this.update({ tasks: [...this.state.tasks, task] });
    return task.id;
  }
  patchTask(id: string, patch: Partial<Omit<Task, "id">>) {
    this.update({
      tasks: this.state.tasks.map((task) =>
        task.id === id ? { ...task, ...patch } : task,
      ),
    });
  }
  setResources(resources: Resource[]) {
    this.update({ resources });
  }
  patchResource(id: string, patch: Partial<Resource>) {
    this.update({
      resources: this.state.resources.map((file) =>
        file.id === id ? { ...file, ...patch } : file,
      ),
    });
  }
  forget(id: string) {
    this.update({
      memories: this.state.memories.filter((item) => item.id !== id),
    });
  }
  cancel(id: string) {
    const task = this.state.tasks.find((item) => item.id === id);
    if (!task) return false;
    if (this.mode === "live" && task.status !== "queued") return false;
    if (!["queued", "running", "waiting"].includes(task.status)) return false;
    this.patchTask(id, {
      status: "cancelled",
      phase: "停止尚未执行的步骤，不承诺回滚已完成操作",
    });
    return true;
  }
  setDemoEmpty(empty: boolean) {
    if (this.mode !== "demo") return;
    for (const task of this.state.tasks.filter((item) =>
      ["running", "waiting"].includes(item.status),
    ))
      this.cancel(task.id);
    this.update({ resources: empty ? [] : structuredClone(demoResources) });
  }
  private demoJob(kind: "organize" | "repair") {
    const current = this.state.tasks.find(
      (item) =>
        item.kind === kind && ["running", "waiting"].includes(item.status),
    );
    if (current) {
      this.addMessage(
        "assistant",
        "这件事已经在办，没有重复创建。",
        current.id,
      );
      return current.id;
    }
    if (!this.state.resources.length) {
      this.addMessage(
        "assistant",
        "当前是空资料库演示，没有可整理或准备的材料。",
      );
      return;
    }
    const id = this.addTask(
      kind === "organize" ? "整理照片、视频和文档" : "准备洗衣机维修资料",
      kind,
      "running",
    );
    this.patchTask(id, { phase: "核对已有示例资料", step: 1 });
    this.addMessage(
      "assistant",
      kind === "organize"
        ? "好。我先分好类，原件不动。你可以接着说别的事。"
        : "好。先把凭证和登记备好，需要核对的地方我再一起问你。",
      id,
    );
    [1300, 2800, 4300].forEach((ms, index) =>
      this.later(() => {
        if (
          this.state.tasks.find((item) => item.id === id)?.status !== "running"
        )
          return;
        if (index < 2) {
          this.patchTask(id, {
            step: index + 2,
            phase: index === 0 ? "生成内容描述候选" : "检查来处与缺项",
          });
          return;
        }
        this.patchTask(id, {
          status: kind === "repair" ? "waiting" : "done",
          phase:
            kind === "repair"
              ? "购买日期与登记日期需要核对"
              : "形成分组视图，原件没有移动",
        });
        this.addMessage(
          "assistant",
          kind === "repair"
            ? "有两种日期含义需要分清。你不确定也没关系，其余材料可以先准备。"
            : "这几份示例资料已经有了归处。照片、视频、文档分别收好，原件没有动。",
          id,
        );
      }, ms),
    );
    return id;
  }
  confirmDate(id: string, date: "2025-06-10" | "unknown") {
    if (
      this.mode !== "demo" ||
      this.state.tasks.find((item) => item.id === id)?.status !== "waiting"
    )
      return;
    this.patchTask(id, {
      date,
      status: "running",
      phase: "准备资料清单",
      step: 3,
    });
    this.later(() => {
      if (this.state.tasks.find((item) => item.id === id)?.status !== "running")
        return;
      this.patchTask(id, {
        status: "done",
        phase: "已有两份材料，故障说明待补充",
      });
      this.addMessage(
        "assistant",
        date === "unknown"
          ? "示例清单备好了，购买日期保留待核实，没有覆盖原始材料，也没有外发。"
          : "示例清单备好了，采用凭证日期，登记日期仍保留。没有对外发送。",
        id,
      );
    }, 600);
  }
  adjustLight(value: number) {
    if (
      this.mode !== "demo" ||
      !Number.isFinite(value) ||
      value < 0 ||
      value > 100 ||
      this.state.lightUnknown
    )
      return;
    if (
      this.state.tasks.some(
        (item) => item.kind === "light" && item.status === "running",
      )
    )
      return;
    const id = this.addTask("让客厅灯刚刚好", "light", "running");
    const before = this.state.light;
    this.update({ lightBefore: before, lightReceipt: false });
    this.patchTask(id, { phase: "等待示例设备回读", step: 1 });
    this.later(() => {
      if (this.state.tasks.find((item) => item.id === id)?.status !== "running")
        return;
      this.update({ actualLight: value });
      if (this.failure) {
        this.update({ lightUnknown: true });
        this.patchTask(id, {
          status: "unknown",
          phase: "已提交，回读丢失；不重复执行",
        });
        this.addMessage(
          "assistant",
          "没有取得灯光回读，我先核实，不会重复发送指令。",
          id,
        );
      } else {
        this.update({ light: value, lightReceipt: true });
        this.patchTask(id, { status: "done", phase: `示例回读 ${value}%` });
        this.addMessage(
          "assistant",
          `客厅灯已调到 ${value}%，示例回读一致。不合适可以恢复上次亮度。`,
          id,
        );
      }
    }, 700);
    return id;
  }
  recheckLight() {
    if (this.mode !== "demo" || !this.state.lightUnknown || this.failure)
      return false;
    this.update({
      light: this.state.actualLight,
      lightUnknown: false,
      lightReceipt: true,
    });
    this.update({
      tasks: this.state.tasks.map((item) =>
        item.kind === "light" && item.status === "unknown"
          ? { ...item, status: "done", phase: "仅核实回读，没有重复执行" }
          : item,
      ),
    });
    return true;
  }
  sendDemo(text: string) {
    if (this.mode !== "demo") throw new Error("Demo cannot run in live mode");
    this.addMessage("user", text);
    if (/记住/.test(text) && /简单|结论|简短/.test(text)) {
      this.update({
        memories: [
          ...this.state.memories.filter((item) => item.id !== "brief"),
          {
            id: "brief",
            text: "回答简单一点，先给结论。",
            source: `本页明确原话：“${text}”`,
          },
        ],
      });
      this.addMessage(
        "assistant",
        "记住了。先给结论，细节你需要时再说；这条偏好可以随时忘记。",
      );
      return;
    }
    if (/整理|分类|收好/.test(text)) return this.demoJob("organize");
    if (/维修|保修|资料包/.test(text)) return this.demoJob("repair");
    if (/灯|亮度/.test(text))
      return this.adjustLight(/暗|低/.test(text) ? 25 : 65);
    this.addMessage(
      "assistant",
      "我在。这是独立体验模式，可以试试整理资料、准备维修清单或调好灯光；没有调用真实模型。",
    );
  }
}
