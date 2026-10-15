import { useEffect, useState } from "react";
import { type ComputerState, type ComputerAction } from "../api";
export default function ComputerPanel({
  state,
  enabled,
  hosts,
  busy,
  proposed,
  onAction,
  onContinue,
}: {
  state: ComputerState | null;
  enabled: boolean;
  hosts: string[];
  busy: boolean;
  proposed: ComputerAction | null;
  onAction: (a: object) => Promise<void>;
  onContinue: () => void;
}) {
  const [url, setUrl] = useState("https://example.com"),
    [values, setValues] = useState<Record<string, string>>({});
  useEffect(() => {
    setValues({});
  }, [state?.request?.id, state?.revision]);
  const call = async (a: object) => {
    try {
      await onAction(a);
    } finally {
      setValues({});
    }
  };
  return (
    <section className="computer-panel">
      <div className="computer-panel__status">
        <i className={state?.running ? "is-online" : ""} />
        <span>{state?.running ? "电脑已连接" : "浏览器电脑"}</span>
        <small>Docker · Chromium</small>
      </div>
      {!enabled ? (
        <p>请先在服务端配置浏览器电脑。</p>
      ) : (
        <>
          <form
            className="computer-panel__address"
            onSubmit={(e) => {
              e.preventDefault();
              void call({ kind: "open", url });
            }}
          >
            <input
              aria-label="网页地址"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://…"
            />
            <button disabled={busy}>打开</button>
          </form>
          <small className="computer-panel__hosts">
            可访问：{hosts.join("、")}
          </small>
          <div className="computer-panel__screen">
            {state?.screenshot ? (
              <img
                src={`data:image/jpeg;base64,${state.screenshot}`}
                alt={`浏览器截图：${state.title || "当前网页"}`}
              />
            ) : (
              <div className="computer-panel__idle">
                <span>▣</span>
                <h3>一台给悟空的电脑</h3>
                <p>
                  打开网页、查看页面、完成登录。需要你时，输入框会出现在这里。
                </p>
                <button
                  disabled={busy}
                  onClick={() =>
                    void call({ kind: "open", url: "depdek:demo-login" })
                  }
                >
                  试试网页登录
                </button>
              </div>
            )}
          </div>
          {state?.url && (
            <div className="computer-panel__caption">
              <b>{state.title}</b>
              <small>{state.url}</small>
            </div>
          )}
          {state?.request && (
            <form
              className="computer-panel__request"
              onSubmit={(e) => {
                e.preventDefault();
                void call({
                  kind: "respond",
                  page_revision: state.revision,
                  values,
                });
              }}
            >
              <span className="computer-panel__tag">需要你的输入</span>
              <h3>请填写网页中的信息</h3>
              <p>内容直接填写到网页，悟空看不到你的密码。</p>
              {state.request.fields.map((f) => (
                <label key={f.target}>
                  <span>{f.label}</span>
                  <input
                    type={f.type === "password" ? "password" : "text"}
                    autoComplete="off"
                    required
                    value={values[f.target] || ""}
                    onChange={(e) =>
                      setValues((v) => ({ ...v, [f.target]: e.target.value }))
                    }
                  />
                </label>
              ))}
              <button disabled={busy || !state.request.fields.length}>
                填写到网页
              </button>
            </form>
          )}
          {proposed && (
            <div className="computer-panel__request">
              <span className="computer-panel__tag">待确认操作</span>
              <p>
                点击「
                {state?.elements.find((e) => e.target === proposed.target)
                  ?.label || proposed.target}
                」
              </p>
              <button disabled={busy} onClick={() => void call(proposed)}>
                确认点击
              </button>
            </div>
          )}
          {state?.running && (
            <>
              <div className="computer-panel__tools">
                <button
                  disabled={busy}
                  onClick={() => void call({ kind: "screenshot" })}
                >
                  更新截图
                </button>
                <button
                  disabled={busy}
                  onClick={() => void call({ kind: "request_input" })}
                >
                  填写网页
                </button>
                <button
                  disabled={busy}
                  onClick={() => void call({ kind: "stop" })}
                >
                  关闭电脑
                </button>
              </div>
              <details>
                <summary>网页操作</summary>
                <div className="computer-panel__elements">
                  {state.elements
                    .filter((e) => !e.input && !e.disabled)
                    .map((e) => (
                      <button
                        key={e.target}
                        disabled={busy}
                        onClick={() =>
                          void call({
                            kind: "click",
                            target: e.target,
                            page_revision: state.revision,
                          })
                        }
                      >
                        {e.label}
                      </button>
                    ))}
                </div>
              </details>
              <button
                className="computer-panel__continue"
                disabled={busy || !!state.request}
                onClick={onContinue}
              >
                交给悟空继续 →
              </button>
            </>
          )}
        </>
      )}
    </section>
  );
}
