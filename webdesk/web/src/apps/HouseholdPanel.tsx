import { useEffect, useRef, useState } from "react";
import { api, type BusinessSession } from "../api";
import Markdown from "../components/Markdown";
type Assertion = {
  id: string;
  field: string;
  value: string;
  source_id: string;
  evidence: string;
};
type Item = {
  id: string;
  name: string;
  revision: number;
  sources: string[];
  assertions: Assertion[];
  selected: Record<string, string>;
};
type Pack = { id: string; item_id: string; markdown: string; stale: boolean };
type Task = {
  id: string;
  title: string;
  completed: boolean;
  package_id: string;
};
type State = { items: Item[]; packages: Pack[]; tasks: Task[] };
type Plan = {
  item_id: string;
  revision: number;
  markdown: string;
  effects: string[];
};
const fieldNames: Record<string, string> = {
  model: "型号",
  purchase_date: "购买日期",
  serial: "序列号",
  location: "位置",
  warranty_until: "保修截止",
};
const op = () => crypto.randomUUID();
function download(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export default function HouseholdPanel({
  session,
  onDraft,
}: {
  session: BusinessSession;
  onDraft: (v: string) => void;
}) {
  const [state, setState] = useState<State>({
      items: [],
      packages: [],
      tasks: [],
    }),
    [selected, setSelected] = useState(""),
    [name, setName] = useState("客厅空调"),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false);
  const [field, setField] = useState("model"),
    [value, setValue] = useState(""),
    [evidence, setEvidence] = useState(""),
    [source, setSource] = useState(""),
    [plan, setPlan] = useState<Plan | null>(null);
  const file = useRef<HTMLInputElement>(null),
    applyId = useRef(op());
  const current = state.items.find((i) => i.id === selected);
  const call = (command: string, input: object) =>
    api.household(session.csrf_token, session.workspace_id, command, input);
  const refresh = async () => {
    const next = (await call("list", {})) as State;
    setState(next);
    setSelected((id) =>
      next.items.some((i) => i.id === id) ? id : next.items[0]?.id || "",
    );
  };
  const perform = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setNotice("");
    try {
      await fn();
      await refresh();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
      setPlan(null);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    let live = true;
    call("list", {})
      .then((v) => {
        if (live) {
          const next = v as State;
          setState(next);
          setSelected(next.items[0]?.id || "");
        }
      })
      .catch((e) => {
        if (live) setNotice(String(e));
      });
    return () => {
      live = false;
    };
  }, [session.principal_id, session.csrf_token, session.workspace_id]);
  useEffect(() => {
    setSource(current?.sources[0] || "");
    setPlan(null);
  }, [selected, current?.revision]);
  const upload = async (f: File) => {
    if (f.size > 24576 || !f.size) {
      setNotice("当前受控闭环支持单个 24 KiB 原件；大文件接入暂未开放。");
      return;
    }
    await perform(async () => {
      const bytes = new Uint8Array(await f.arrayBuffer());
      let binary = "";
      for (const b of bytes) binary += String.fromCharCode(b);
      const result = (await call("import", {
        operation_id: op(),
        name,
        filename: f.name,
        content_base64: btoa(binary),
        ...(selected ? { item_id: selected } : {}),
      })) as { item: Item };
      setSelected(result.item.id);
      setNotice("原件已封存。尚未自动 OCR，请填写带来源位置的摘录并确认。");
    });
  };
  return (
    <div className="household-panel">
      {notice && (
        <p className="agent-core__notice" role="status">
          {notice}
        </p>
      )}
      <section>
        <h3>
          物品与原件{" "}
          <button
            disabled={busy}
            onClick={() => void perform(refresh)}
            aria-label="刷新家庭资料"
          >
            ↻
          </button>
        </h3>
        <label>
          物品
          <select
            aria-label="选择家庭物品"
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
          >
            <option value="">＋ 新建物品</option>
            {state.items.map((i) => (
              <option key={i.id} value={i.id}>
                {i.name}
              </option>
            ))}
          </select>
        </label>
        {!selected && (
          <label>
            名称
            <input
              aria-label="物品名称"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={80}
            />
          </label>
        )}
        <input
          ref={file}
          aria-label="导入凭证原件"
          type="file"
          accept=".txt,.md,.csv,.pdf,.png,.jpg,.jpeg"
          disabled={busy || (!selected && !name.trim())}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void upload(f);
            e.target.value = "";
          }}
        />
        <small>原件不自动外发 · ≤ 24 KiB · 无自动 OCR</small>
        {current?.sources.map((s, i) => (
          <button
            key={s}
            disabled={busy}
            onClick={() =>
              void perform(async () => {
                const r = (await call("get", { id: s })) as {
                  source: {
                    filename: string;
                    content_base64: string;
                    sha256: string;
                  };
                };
                const bytes = Uint8Array.from(
                  atob(r.source.content_base64),
                  (c) => c.charCodeAt(0),
                );
                download(
                  r.source.filename,
                  new Blob([bytes], { type: "application/octet-stream" }),
                );
                setNotice(`原件 SHA256 ${r.source.sha256}`);
              })
            }
          >
            导出原件 {i + 1}
          </button>
        ))}
      </section>
      {current && (
        <>
          <section>
            <h3>
              事实与确认 <small>版本 {current.revision}</small>
            </h3>
            <p>候选不是事实。同一字段冲突全部保留，选择一条作为当前确认值。</p>
            {current.assertions.map((a) => (
              <article key={a.id} className="household-assertion">
                <b>
                  {fieldNames[a.field]} · {a.value}
                </b>
                <small>
                  {a.evidence} · 原件 {current.sources.indexOf(a.source_id) + 1}
                </small>
                <button
                  disabled={busy || current.selected[a.field] === a.id}
                  onClick={() =>
                    void perform(async () => {
                      await call("confirm", {
                        operation_id: op(),
                        item_id: current.id,
                        expected_revision: current.revision,
                        assertion_id: a.id,
                      });
                    })
                  }
                >
                  {current.selected[a.field] === a.id ? "已确认" : "选定这条"}
                </button>
              </article>
            ))}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void perform(async () => {
                  await call("assert", {
                    operation_id: op(),
                    item_id: current.id,
                    expected_revision: current.revision,
                    source_id: source,
                    field,
                    value,
                    evidence,
                  });
                  setValue("");
                  setEvidence("");
                });
              }}
            >
              <label>
                字段
                <select
                  aria-label="摘录字段"
                  value={field}
                  onChange={(e) => setField(e.target.value)}
                >
                  {Object.entries(fieldNames).map(([id, name]) => (
                    <option key={id} value={id}>
                      {name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                值
                <input
                  aria-label="摘录值"
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  maxLength={150}
                />
              </label>
              <label>
                证据原件
                <select
                  aria-label="证据原件"
                  value={source}
                  onChange={(e) => setSource(e.target.value)}
                >
                  {current.sources.map((s, i) => (
                    <option key={s} value={s}>
                      原件 {i + 1}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                来源位置
                <input
                  aria-label="来源位置"
                  value={evidence}
                  onChange={(e) => setEvidence(e.target.value)}
                  placeholder="例如：第 1 页发票日期栏"
                  maxLength={150}
                />
              </label>
              <button disabled={busy || !value.trim() || !evidence.trim()}>
                保存候选（不自动确认）
              </button>
            </form>
          </section>
          <section>
            <h3>准备维修资料</h3>
            <button
              disabled={busy}
              onClick={() =>
                void perform(async () => {
                  const r = (await call("prepare", {
                    operation_id: op(),
                    item_id: current.id,
                    expected_revision: current.revision,
                    apply: false,
                  })) as { plan: Plan };
                  applyId.current = op();
                  setPlan(r.plan);
                })
              }
            >
              预览资料包与待办
            </button>
            {plan && plan.item_id === current.id && (
              <div className="household-plan">
                <Markdown>{plan.markdown}</Markdown>
                <p>将执行：{plan.effects.join(" + ")}。不发送给售后。</p>
                <button
                  disabled={busy}
                  onClick={() =>
                    void perform(async () => {
                      await call("prepare", {
                        operation_id: applyId.current,
                        item_id: plan.item_id,
                        expected_revision: plan.revision,
                        apply: true,
                      });
                      setPlan(null);
                      setNotice("资料包与待办已保存，重复提交不会重复创建。");
                    })
                  }
                >
                  确认创建两项本地结果
                </button>
                <button
                  onClick={() =>
                    onDraft(
                      `请分析这份维修资料，分清已确认与未知，不执行任何外部动作：\n${plan.markdown}`,
                    )
                  }
                >
                  填入对话草稿（未发送）
                </button>
              </div>
            )}
            {state.packages
              .filter((p) => p.item_id === current.id)
              .map((p) => (
                <article key={p.id}>
                  <b>
                    维修资料包 {p.stale ? "· 已过期，请重新准备" : "· 当前版本"}
                  </b>
                  <button
                    onClick={() =>
                      download(
                        `${current.name}-维修资料.md`,
                        new Blob([p.markdown], {
                          type: "text/markdown;charset=utf-8",
                        }),
                      )
                    }
                  >
                    导出 Markdown
                  </button>
                </article>
              ))}
          </section>
        </>
      )}
      <section>
        <h3>维修待办</h3>
        {!state.tasks.length && (
          <small>生成资料包后，这里会出现对应待办。</small>
        )}
        {state.tasks.map((t) => (
          <label key={t.id} className="household-task">
            <input
              type="checkbox"
              checked={t.completed}
              disabled={busy}
              onChange={(e) =>
                void perform(async () => {
                  await call("complete", {
                    operation_id: op(),
                    id: t.id,
                    completed: e.target.checked,
                  });
                })
              }
            />
            {t.title}
            {state.packages.find((p) => p.id === t.package_id)?.stale
              ? " · 资料需更新"
              : ""}
          </label>
        ))}
      </section>
    </div>
  );
}
