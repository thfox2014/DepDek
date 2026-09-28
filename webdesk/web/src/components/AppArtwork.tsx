import { useId } from "react";

export type AppArtworkKind = "overview" | "performance" | "processes" | "storage" | "files" | "system";

/** Shared glossy cobalt-and-amber artwork for the Webdesk app launcher and windows. */
export default function AppArtwork({ kind, className = "" }: { kind: AppArtworkKind; className?: string }) {
  const id = useId().replace(/:/g, "");
  const fill = (name: string) => `url(#${id}-${name})`;

  return (
    <svg className={`app-art ${className}`} viewBox="0 0 96 96" fill="none" aria-hidden="true">
      <defs>
        <linearGradient id={`${id}-shell`} x1="14" y1="7" x2="83" y2="91" gradientUnits="userSpaceOnUse">
          <stop stopColor="#071d54" /><stop offset=".48" stopColor="#034cc8" /><stop offset="1" stopColor="#111a50" />
        </linearGradient>
        <linearGradient id={`${id}-rim`} x1="11" y1="7" x2="83" y2="90" gradientUnits="userSpaceOnUse">
          <stop stopColor="#fff28a" /><stop offset=".19" stopColor="#04efff" /><stop offset=".52" stopColor="#2586ff" /><stop offset=".78" stopColor="#ff8a22" /><stop offset="1" stopColor="#fa4f97" />
        </linearGradient>
        <linearGradient id={`${id}-blue`} x1="20" y1="17" x2="75" y2="77" gradientUnits="userSpaceOnUse">
          <stop stopColor="#41edff" /><stop offset=".38" stopColor="#1687ff" /><stop offset=".72" stopColor="#1451df" /><stop offset="1" stopColor="#101d7a" />
        </linearGradient>
        <linearGradient id={`${id}-metal`} x1="26" y1="22" x2="71" y2="74" gradientUnits="userSpaceOnUse">
          <stop stopColor="#faffff" /><stop offset=".23" stopColor="#73eaff" /><stop offset=".49" stopColor="#3278dc" /><stop offset=".71" stopColor="#d8faff" /><stop offset="1" stopColor="#4b78ce" />
        </linearGradient>
        <linearGradient id={`${id}-amber`} x1="26" y1="23" x2="68" y2="75" gradientUnits="userSpaceOnUse">
          <stop stopColor="#fff58a" /><stop offset=".3" stopColor="#ffbd2d" /><stop offset=".68" stopColor="#ff7626" /><stop offset="1" stopColor="#df3e4e" />
        </linearGradient>
        <linearGradient id={`${id}-cyan`} x1="23" y1="27" x2="76" y2="74" gradientUnits="userSpaceOnUse">
          <stop stopColor="#e3ffff" /><stop offset=".25" stopColor="#36f9ff" /><stop offset=".68" stopColor="#00a9ff" /><stop offset="1" stopColor="#1662ec" />
        </linearGradient>
        <radialGradient id={`${id}-shine`} cx="0" cy="0" r="1" gradientTransform="matrix(0 40 -46 0 28 10)" gradientUnits="userSpaceOnUse">
          <stop stopColor="#60f6ff" stopOpacity=".38" /><stop offset="1" stopColor="#60f6ff" stopOpacity="0" />
        </radialGradient>
        <filter id={`${id}-glow`} x="-30%" y="-30%" width="160%" height="160%" colorInterpolationFilters="sRGB">
          <feGaussianBlur stdDeviation="2.4" result="blur" /><feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
        <filter id={`${id}-shadow`} x="-30%" y="-30%" width="160%" height="170%" colorInterpolationFilters="sRGB">
          <feGaussianBlur in="SourceAlpha" stdDeviation="2.5" /><feOffset dy="3" /><feComponentTransfer><feFuncA type="linear" slope=".58" /></feComponentTransfer><feMerge><feMergeNode /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
      </defs>

      <rect x="3" y="3" width="90" height="90" rx="24" fill={fill("shell")} />
      <rect x="3.7" y="3.7" width="88.6" height="88.6" rx="23.3" stroke={fill("rim")} strokeWidth="1.4" opacity=".94" filter={fill("glow")} />
      <path d="M12 27C18 11 31 7 48 7h22c-17 4-33 20-39 43-6 22-4 29 0 39C16 85 7 72 7 55V42c0-5 1-10 5-15Z" fill={fill("shine")} />
      <path d="M13 24c7-12 19-16 34-16h20" stroke="white" strokeOpacity=".42" strokeWidth="1.1" strokeLinecap="round" />
      <ellipse cx="49" cy="82" rx="27" ry="4" fill="#030c2a" opacity=".5" />

      {kind === "overview" && (
        <g filter={fill("shadow")}>
          <path d="m19 34 47-8 13 8v37l-47 8-13-8V34Z" fill={fill("blue")} stroke={fill("cyan")} strokeWidth="1.1" />
          <path d="m19 34 47-8v37l-47 8V34Z" fill="#101f59" stroke="#81f7ff" strokeOpacity=".78" />
          <path d="m66 26 13 8v37l-13-8V26Z" fill="#132c78" stroke="#28dfff" strokeOpacity=".7" />
          {[0, 1, 2, 3].map((slot) => <g key={slot}>
            <rect x={24 + slot * 10} y="39" width="7.2" height="31" rx="2" fill="#07153d" stroke="#44dfff" strokeOpacity=".9" />
            <path d={`M${26 + slot * 10} 42h3v19h-3z`} fill={fill("amber")} />
            <circle cx={27.6 + slot * 10} cy="66" r="1.15" fill={fill("cyan")} filter={fill("glow")} />
          </g>)}
          <path d="m69 43 6 3v3l-6-3v-3Zm0 8 6 3v3l-6-3v-3Z" fill={fill("amber")} />
          <path d="m22 35 42-7" stroke="white" strokeOpacity=".65" strokeWidth="1.1" />
        </g>
      )}

      {kind === "performance" && (
        <g filter={fill("shadow")}>
          <path d="M22 24h51a5 5 0 0 1 5 5v35H17V29a5 5 0 0 1 5-5Z" fill="#071b4d" stroke={fill("metal")} strokeWidth="2" />
          <path d="M23 30h49v27H23z" fill="#081941" />
          <path d="M27 49c5-1 6-12 11-11s5 14 11 12 5-16 10-16 5 15 10 12" stroke={fill("cyan")} strokeWidth="3.2" strokeLinecap="round" filter={fill("glow")} />
          <path d="M20 66h55l-5 8H26l-6-8Z" fill={fill("metal")} stroke="#d8ffff" strokeOpacity=".65" />
          <path d="M32 78h31" stroke={fill("amber")} strokeWidth="3" strokeLinecap="round" />
          <circle cx="69" cy="29" r="2" fill={fill("amber")} />
        </g>
      )}

      {kind === "processes" && (
        <g filter={fill("shadow")}>
          <path d="M48 27c10 0 18 8 18 18 0 8-5 14-12 17v9H42v-9c-7-3-12-9-12-17 0-10 8-18 18-18Z" fill={fill("blue")} stroke={fill("cyan")} strokeWidth="1.5" />
          <path d="M39 72h18v5H39z" rx="2" fill={fill("metal")} />
          <path d="M42 80h12" stroke={fill("amber")} strokeWidth="3" strokeLinecap="round" />
          <path d="M48 34v20m-9-11h18" stroke="#c8ffff" strokeOpacity=".9" strokeWidth="2" strokeLinecap="round" />
          <circle cx="48" cy="43" r="5" fill={fill("amber")} stroke="#fff0a4" strokeWidth="1" />
          <circle cx="25" cy="27" r="6" fill={fill("blue")} stroke={fill("cyan")} strokeWidth="1.5" />
          <circle cx="71" cy="27" r="6" fill={fill("blue")} stroke={fill("cyan")} strokeWidth="1.5" />
          <circle cx="25" cy="66" r="6" fill={fill("blue")} stroke={fill("cyan")} strokeWidth="1.5" />
          <circle cx="71" cy="66" r="6" fill={fill("blue")} stroke={fill("cyan")} strokeWidth="1.5" />
          <path d="m29 31 8 7m22 0 8-7M29 62l8-7m22 0 8 7" stroke={fill("amber")} strokeWidth="2.4" strokeLinecap="round" />
          <circle cx="48" cy="43" r="1.7" fill="#fff" />
        </g>
      )}

      {kind === "storage" && (
        <g filter={fill("shadow")}>
          <path d="M48 23c17 0 30 7 30 16v18c0 9-13 17-30 17s-30-8-30-17V39c0-9 13-16 30-16Z" fill="#07173e" stroke={fill("cyan")} strokeWidth="1.2" />
          <ellipse cx="48" cy="39" rx="30" ry="16" fill={fill("metal")} stroke="#d4ffff" strokeWidth="1.2" />
          <ellipse cx="48" cy="39" rx="22" ry="11" fill={fill("blue")} stroke="#69eaff" strokeWidth="1" />
          <ellipse cx="48" cy="39" rx="12" ry="6" fill={fill("amber")} stroke="#fff2a3" strokeWidth="1" />
          <circle cx="48" cy="39" r="3.1" fill={fill("metal")} stroke="#fff" strokeWidth=".8" />
          <path d="m48 42 16 20-3 2-20-15 7-7Z" fill={fill("metal")} stroke="#c8faff" strokeWidth=".9" />
          <circle cx="46" cy="42" r="2.4" fill="#fff" />
          <path d="M21 54c3 7 14 12 27 12s24-5 27-12" stroke={fill("amber")} strokeWidth="1.6" opacity=".9" />
          <circle cx="49" cy="67" r="1.8" fill={fill("cyan")} filter={fill("glow")} />
        </g>
      )}

      {kind === "files" && (
        <g filter={fill("shadow")}>
          <path d="M20 37c0-3 2-5 5-5h17l8 8h21c3 0 5 2 5 5v22c0 3-2 5-5 5H25c-3 0-5-2-5-5V37Z" fill={fill("amber")} stroke="#fff1a2" strokeWidth="1.2" />
          <path d="M20 47h56v20c0 3-2 5-5 5H25c-3 0-5-2-5-5V47Z" fill="#ffad27" stroke="#ffe17c" strokeWidth="1" />
          <path d="M29 56c6-7 13-8 20-3m0 0-1-7m1 7-7 1m21 8c-6 7-13 8-20 3m0 0 1 7m-1-7 7-1" stroke={fill("cyan")} strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round" filter={fill("glow")} />
          <path d="M25 48h46" stroke="#fff6c8" strokeOpacity=".9" strokeWidth="1.1" />
          <path d="M25 37h14l5 5H25v-5Z" fill={fill("metal")} />
        </g>
      )}

      {kind === "system" && (
        <g filter={fill("shadow")}>
          <path d="m48 21 25 9v17c0 15-10 25-25 32-15-7-25-17-25-32V30l25-9Z" fill={fill("blue")} stroke={fill("metal")} strokeWidth="2" />
          <path d="m48 28 18 6v13c0 11-7 19-18 25-11-6-18-14-18-25V34l18-6Z" fill="#09266c" stroke={fill("cyan")} strokeWidth="1.4" />
          <path d="m38 48 7 7 14-16" stroke={fill("amber")} strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" filter={fill("glow")} />
          <path d="m69 58 6 2-2 5-6-2m-37-5-6 2 2 5 6-2" fill={fill("amber")} stroke="#ffe49b" strokeWidth="1" />
          <path d="m48 16 3 5h-6l3-5Z" fill={fill("amber")} />
        </g>
      )}
    </svg>
  );
}
