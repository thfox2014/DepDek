import { useId } from "react";

const PIXELS = [
  ".........Y.Y.........",
  "........YYYYY........",
  ".......YYyyyYY.......",
  "......RRYYYYYRR......",
  ".....RRRRYYYYYRR.....",
  "....RRRSSSSSSSRRR....",
  "...RRRSSSSSSSSSRRR...",
  "..RRRRSSSSSSSSSSRRRR..",
  ".RRRRRSSSSSSSSSSSRRRRR.",
  ".RRRRSSbSSSSSbSSSRRRR.",
  "..RRRSSSSSSSSSSSSSRRR..",
  "..RRRSSSSWSSWSSSSSRRR..",
  "...RRSSSSSSSSSSSSSRR...",
  "....RRSSSssssSSSRR....",
  ".....RRRRRRRRRRRR.....",
  "......RRYYYYYRR.......",
  ".....RRYyyYyyYRR......",
  "....RRYYYYYYYYYRR.....",
  "...RRYYRRRRRRRYYRR....",
  "...RYYRRRRRRRRRYYR....",
  "...YYRRRYY..YYRRRYY...",
  "....RRRYY....YYRRR....",
  "....RRR........RRR....",
  "...RRR..........RRR...",
];

const COLORS: Record<string, string> = {
  Y: "#ffe18a", y: "#f9b942", R: "#db572f", r: "#a83b37",
  S: "#f2bd83", s: "#ce875e", b: "#18304b", W: "#fff2c8",
};

/** Purpose-drawn, chunky pixel-art Wukong; `crispEdges` keeps every tile sharp. */
export default function WukongMosaic({ className = "" }: { className?: string }) {
  const id = useId().replace(/:/g, "");
  const cols = 23;
  const tile = 13;
  const originX = 36;
  const originY = 60;

  return (
    <svg className={className} viewBox="0 0 420 470" role="img" aria-label="像素马赛克悟空">
      <defs>
        <radialGradient id={`${id}-aura`} cx="50%" cy="42%" r="58%">
          <stop stopColor="#fac65d" stopOpacity=".2" />
          <stop offset=".65" stopColor="#e58743" stopOpacity=".08" />
          <stop offset="1" stopColor="#18304b" stopOpacity="0" />
        </radialGradient>
        <linearGradient id={`${id}-staff`} x1="0" y1="0" x2="1" y2="1">
          <stop stopColor="#fff0ab" /><stop offset=".48" stopColor="#f3aa42" /><stop offset="1" stopColor="#a84535" />
        </linearGradient>
        <filter id={`${id}-glow`} x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="18" />
        </filter>
      </defs>
      <ellipse cx="210" cy="215" rx="190" ry="190" fill={`url(#${id}-aura)`} />
      <circle cx="210" cy="208" r="139" fill="none" stroke="#f9cd78" strokeOpacity=".12" strokeWidth="1" />
      <circle cx="210" cy="208" r="158" fill="none" stroke="#f9cd78" strokeOpacity=".07" strokeWidth="1" strokeDasharray="2 9" />
      <ellipse cx="206" cy="408" rx="120" ry="24" fill="#efac54" opacity=".25" filter={`url(#${id}-glow)`} />
      <path d="M58 393c11-28 36-31 55-18 7-34 45-43 67-16 12-31 49-37 67-11 25-28 63-17 67 14 25-4 48 8 54 31H58Z" fill="#6ba7a1" opacity=".28" />
      <path d="M75 397c13-21 30-24 47-15 15-21 39-22 55-2 18-22 43-23 59-3 17-19 43-14 51 5 23-7 41 0 53 15H75Z" fill="#bdd6b1" opacity=".5" />
      <path d="M346 118v242" stroke={`url(#${id}-staff)`} strokeWidth="9" strokeLinecap="round" />
      <path d="M339 132h14M339 345h14" stroke="#fff0b1" strokeWidth="5" strokeLinecap="round" />
      <g shapeRendering="crispEdges" transform={`translate(${originX},${originY})`}>
        {PIXELS.flatMap((row, rowIndex) => Array.from(row).flatMap((pixel, colIndex) => {
          const color = COLORS[pixel];
          if (!color) return [];
          const centeredColumn = Math.round((cols - row.length) / 2) + colIndex;
          return [<rect key={`${rowIndex}-${colIndex}`} x={centeredColumn * tile} y={rowIndex * tile} width={tile - 1} height={tile - 1} rx="1.5" fill={color} />];
        }))}
      </g>
      <path d="M119 115c18-24 48-36 84-36m93 27c16 13 26 31 30 52" fill="none" stroke="#fff0bf" strokeOpacity=".42" strokeWidth="2" strokeLinecap="round" />
      <path d="m98 164 4 9 9 4-9 4-4 9-4-9-9-4 9-4 4-9Zm209-41 3 6 6 3-6 3-3 6-3-6-6-3 6-3 3-6Z" fill="#ffe8ad" opacity=".8" />
      <text x="209" y="454" textAnchor="middle" fill="#f4d79b" fillOpacity=".54" fontSize="9" letterSpacing="4">雲端有回音 · 悟空在此</text>
    </svg>
  );
}
