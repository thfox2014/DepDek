/** Tiny dependency-free SVG charts (no chart library in the bundle). */

interface SparklineProps {
  values: number[];
  max?: number;
  height?: number;
  stroke?: string;
  fill?: string;
}

export function Sparkline({ values, max = 100, height = 48, stroke = "#c6ef6c", fill = "rgba(198,239,108,.16)" }: SparklineProps) {
  const width = 240;
  // preserveAspectRatio="none" + width:100% would scale the intrinsic ratio into
  // a huge box, so the rendered height is pinned explicitly.
  const style = { height: `${height}px` };
  if (values.length < 2) {
    return <svg className="chart" style={style} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" />;
  }
  const ceiling = Math.max(max, ...values, 1);
  const step = width / (values.length - 1);
  const points = values.map((value, index) => {
    const x = index * step;
    const y = height - Math.min(1, Math.max(0, value / ceiling)) * (height - 4) - 2;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const line = `M${points.join(" L")}`;
  const area = `${line} L${width},${height} L0,${height} Z`;
  return (
    <svg className="chart" style={style} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
      <path d={area} fill={fill} />
      <path d={line} fill="none" stroke={stroke} strokeWidth={1.8} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

interface RingProps {
  value: number;
  label: string;
  caption?: string;
  tone?: "lime" | "blue" | "amber" | "rose";
  size?: number;
}

export function Ring({ value, label, caption, tone = "lime", size = 116 }: RingProps) {
  const clamped = Math.min(100, Math.max(0, value));
  const radius = size / 2 - 9;
  const circumference = 2 * Math.PI * radius;
  const dash = (clamped / 100) * circumference;
  return (
    <div className={`ring ring--${tone}`} style={{ width: size }}>
      <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size}>
        <circle cx={size / 2} cy={size / 2} r={radius} className="ring__track" strokeWidth={8} fill="none" />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          className="ring__value"
          strokeWidth={8}
          fill="none"
          strokeDasharray={`${dash} ${circumference}`}
          strokeLinecap="round"
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </svg>
      <div className="ring__center">
        <strong>{clamped.toFixed(0)}%</strong>
        <span>{label}</span>
      </div>
      {caption && <small className="ring__caption">{caption}</small>}
    </div>
  );
}

export function Meter({ value, tone = "lime" }: { value: number; tone?: "lime" | "blue" | "amber" | "rose" }) {
  const clamped = Math.min(100, Math.max(0, value));
  return (
    <div className={`meter meter--${tone}`}>
      <i style={{ width: `${clamped}%` }} />
    </div>
  );
}

export function toneFor(value: number): "lime" | "amber" | "rose" {
  if (value >= 88) return "rose";
  if (value >= 68) return "amber";
  return "lime";
}
