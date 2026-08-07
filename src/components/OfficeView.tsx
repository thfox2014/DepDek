import { useState, type ReactNode } from "react";
import type { ProviderConfig } from "../api";
import type { ChatBlock, SessionInfo } from "../App";

interface Props {
  sessions: SessionInfo[];
  running: Record<string, boolean>;
  chats: Record<string, ChatBlock[]>;
  providers: Record<string, ProviderConfig>;
  onEnter: (id: string) => void;
  onCreate: (label: string, providerName: string) => Promise<void>;
  onOpenSettings: () => void;
}

// Body colors rotate per session index (matches the reference artwork).
const COLLARS = ["#34a853", "#ea4335", "#9b51e0", "#2f6bff", "#fbbc04", "#12b5cb"];

// Static code-line widths used on idle screens and as the running loop content.
const LINE_WIDTHS = [72, 48, 88, 60, 40, 78, 55, 68];

// Darken a #rrggbb hex color for the shade pixels (tentacle tips, head edge).
const darken = (hex: string, f = 0.72) => {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.round(((n >> 16) & 255) * f);
  const g = Math.round(((n >> 8) & 255) * f);
  const b = Math.round((n & 255) * f);
  return `rgb(${r},${g},${b})`;
};

// ---------------------------------------------------------------------------
// Pixel octopus on a 16x14 grid. Characters: B=body, S=shade, W=eye white,
// P=pupil/outline. Each group is a list of rows drawn at y0+i.
// ---------------------------------------------------------------------------

const BODY_ROWS = [
  ".....BBBBBB.....",
  "...BBBBBBBBBB...",
  "..BBBBBBBBBBBB..",
  "..BBBBBBBBBBBB..",
  "..BBBBBBBBBBBB..", // eyes render on top of this row
  "..BBBBBBBBBBBB..",
  "..BBBBBBBBBBBB..",
  "..BBBBBBBBBBBB..",
  "...SSSSSSSSSS...",
];

const EYES_OPEN_ROWS = [
  "....WW....WW....",
  "....WP....PW....", // pupils look slightly inward
];

const EYES_CLOSED_ROWS = ["....PP....PP...."]; // closed = dark horizontal line

// Frame A: all four tentacles hang straight down.
const TENTACLES_A_ROWS = [
  "..BB..BBBB..BB..",
  "..BB..BBBB..BB..",
  "..BB..BBBB..BB..",
  "..BB..BBBB..BB..",
  "..SS..SSSS..SS..",
];

// Frame B: outer tentacles swing outward, inner pair stays down.
const TENTACLES_B_ROWS = [
  "..BB..BBBB..BB..",
  ".BB...BBBB...BB.",
  "BB....BBBB....BB",
  "BB....BBBB....BB",
  "SS....SSSS....SS",
];

function Pixels({
  rows,
  y0,
  colors,
}: {
  rows: string[];
  y0: number;
  colors: Record<string, string>;
}) {
  const rects: ReactNode[] = [];
  rows.forEach((row, dy) => {
    [...row].forEach((ch, x) => {
      const fill = colors[ch];
      if (fill) {
        rects.push(<rect key={`${x}-${y0 + dy}`} x={x} y={y0 + dy} width={1} height={1} fill={fill} />);
      }
    });
  });
  return <>{rects}</>;
}

function PixelOctopus({ colorIndex, running }: { colorIndex: number; running: boolean }) {
  const body = COLLARS[colorIndex % COLLARS.length];
  const colors = { B: body, S: darken(body), W: "#ffffff", P: "#1d2129" };
  return (
    <svg
      width={96}
      height={84}
      viewBox="0 0 16 14"
      shapeRendering="crispEdges"
      className={`octopus ${running ? "octopus--running" : ""}`}
      aria-hidden="true"
    >
      <g className="octopus__tentacles octopus__tentacles--frame-a">
        <Pixels rows={TENTACLES_A_ROWS} y0={9} colors={colors} />
      </g>
      <g className="octopus__tentacles octopus__tentacles--frame-b">
        <Pixels rows={TENTACLES_B_ROWS} y0={9} colors={colors} />
      </g>
      <g className="octopus__head">
        <Pixels rows={BODY_ROWS} y0={0} colors={colors} />
      </g>
      <g className="octopus__eyes octopus__eyes--open">
        <Pixels rows={EYES_OPEN_ROWS} y0={4} colors={colors} />
      </g>
      <g className="octopus__eyes octopus__eyes--closed">
        <Pixels rows={EYES_CLOSED_ROWS} y0={5} colors={colors} />
      </g>
    </svg>
  );
}

function CodeCopy({ running }: { running: boolean }) {
  return (
    <div className="code-copy">
      {LINE_WIDTHS.map((w, i) => (
        <div
          key={i}
          className={`code-line ${running ? "code-line--bright" : ""}`}
          style={{ width: `${w}%` }}
        />
      ))}
    </div>
  );
}

function Screen({ running }: { running: boolean }) {
  if (running) {
    // Two identical copies + translateY(-50%) gives a seamless scroll loop.
    return (
      <div className="workstation__screen workstation__screen--running">
        <div className="code-track">
          <CodeCopy running />
          <CodeCopy running />
        </div>
      </div>
    );
  }
  return (
    <div className="workstation__screen workstation__screen--idle">
      <div className="code-track code-track--static">
        <CodeCopy running={false} />
      </div>
    </div>
  );
}

// Current activity for the speech bubble: the name of the tool call still in
// flight (last tool block with ok === undefined), otherwise "思考中…".
function activityOf(blocks: ChatBlock[] | undefined): string {
  if (!blocks) return "思考中…";
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (b.kind === "tool") {
      return b.ok === undefined ? `正在调用 ${b.name}` : "思考中…";
    }
  }
  return "思考中…";
}

export default function OfficeView({
  sessions,
  running,
  chats,
  providers,
  onEnter,
  onCreate,
  onOpenSettings,
}: Props) {
  const [creating, setCreating] = useState(false);
  const [label, setLabel] = useState("");
  const [providerName, setProviderName] = useState("");
  const [error, setError] = useState<string | null>(null);

  const providerNames = Object.keys(providers);

  const submit = async () => {
    const name = providerName || providerNames[0];
    if (!name) {
      setError("请先在设置中配置 provider");
      return;
    }
    setError(null);
    try {
      await onCreate(label.trim(), name);
      setCreating(false);
      setLabel("");
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <div className="office">
      <h1 className="office__title">Agent 办公室</h1>
      <p className="office__subtitle">每个工位是一个 agent 会话，点进去即可开始协作。</p>
      <div className="office__grid">
        {sessions.map((s, i) => {
          const isRunning = Boolean(running[s.id]);
          return (
            <div key={s.id} className="workstation" onClick={() => onEnter(s.id)}>
              {isRunning && (
                <div className="workstation__bubble">{activityOf(chats[s.id])}</div>
              )}
              <div className="workstation__scene">
                <div className="workstation__monitor">
                  <Screen running={isRunning} />
                  <div className="workstation__stand" />
                  <div className="workstation__stand-base" />
                </div>
                <div className="workstation__desk" />
                <div
                  className={`workstation__octopus ${isRunning ? "workstation__octopus--running" : ""}`}
                >
                  <PixelOctopus colorIndex={i} running={isRunning} />
                </div>
                <div className="workstation__floor" />
              </div>
              <div className="workstation__label">{s.label}</div>
              <div className="workstation__provider">{s.providerName}</div>
            </div>
          );
        })}

        <div
          className="workstation workstation--empty"
          onClick={() => !creating && setCreating(true)}
        >
          {creating ? (
            <div className="workstation__form" onClick={(e) => e.stopPropagation()}>
              <input
                autoFocus
                placeholder="会话名称"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
              />
              {providerNames.length > 0 ? (
                <select
                  value={providerName || providerNames[0]}
                  onChange={(e) => setProviderName(e.target.value)}
                >
                  {providerNames.map((n) => (
                    <option key={n} value={n}>
                      {n}（{providers[n].model}）
                    </option>
                  ))}
                </select>
              ) : (
                <p className="hint">
                  尚无 provider，请先
                  <button className="link" onClick={onOpenSettings}>
                    配置
                  </button>
                </p>
              )}
              <div className="workstation__form-actions">
                <button onClick={() => setCreating(false)}>取消</button>
                <button className="primary" onClick={submit}>
                  创建
                </button>
              </div>
              {error && <p className="error-text">{error}</p>}
            </div>
          ) : (
            <>
              <div className="workstation__plus">+</div>
              <div className="workstation__label">新建 agent</div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
