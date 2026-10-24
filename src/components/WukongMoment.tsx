import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { createMomentBag, startMomentDirector, type WukongMoment, type WukongMomentId } from "../lib/wukongMoments";
import WukongHead from "./WukongHead";
import "./wukong-moment.css";

const useClientLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

export function WukongMomentArtwork({ kind }: { kind: WukongMomentId }) {
  const staff = kind === "staff" || kind === "bonk";
  return <svg className={`wukong-moment__art is-${kind}`} viewBox="0 0 240 176" aria-hidden="true" focusable="false">
    <ellipse className="wukong-moment__shadow" cx="115" cy="161" rx="42" ry="4" />
    <g className="wukong-moment__actor">
      <path className="wukong-moment__tail" d="M135 129q32 13 35-5q1-10-9-10" fill="none" stroke="#b5683e" strokeWidth="7" strokeLinecap="round" />
      <g className="wukong-moment__legs" fill="none" stroke="#4a302a" strokeWidth="10" strokeLinecap="round">
        <path d="m105 137-7 19-11 1" /><path className="wukong-moment__foot" d="m124 137 9 19 11 1" />
      </g>
      <path d="M98 99q17-9 34 0l7 32q-24 16-48 0Z" fill="#eac06b" />
      <path d="m98 99 17 18 17-18-6 31h-22Z" fill="#ad513a" />
      <path d="m96 128 37 1" stroke="#69422f" strokeWidth="6" strokeLinecap="round" />
      <g className="wukong-moment__scarf" fill="#ad513a"><path d="m105 96 25 1-8 13-20-8Z" /><path d="m105 100-19 4-16-9 21 1Z" /></g>
      <g className="wukong-moment__arm-left" fill="none" strokeLinecap="round"><path d="M99 108 85 119 75 109" stroke="#eac06b" strokeWidth="12" /><path d="m75 109-3-6" stroke="#b5683e" strokeWidth="10" /></g>
      <g className="wukong-moment__head"><svg x="70" y="11" width="91" height="91" viewBox="0 0 96 96"><WukongHead active={false} expression={kind === "doze" ? "sleepy" : kind === "grumpy" ? "grumpy" : kind === "bonk" ? "bold" : "happy"} /></svg></g>
      <g className="wukong-moment__arm-right" fill="none" strokeLinecap="round"><path d="m132 108 15 10 12-14" stroke="#eac06b" strokeWidth="12" /><path d="m159 104 3-6" stroke="#b5683e" strokeWidth="10" /></g>
      {staff && <g className="wukong-moment__staff">
        <path d="M161 25v124" stroke="#ad513a" strokeWidth="7" strokeLinecap="round" /><path d="M161 26v17m0 90v17" stroke="#eac06b" strokeWidth="10" strokeLinecap="round" /><path d="m158 31 6 3m-6 5 6 3m-6 95 6 3m-6 5 6 3" stroke="#a66d36" strokeWidth="1.5" />
      </g>}
      {kind === "tea" && <g className="wukong-moment__cup"><path d="M144 102h24l-3 17q-9 5-18 0Z" fill="var(--room-accent, #a66d36)" /><path d="M167 105q13-3 10 6-2 5-11 3" fill="none" stroke="var(--room-accent, #a66d36)" strokeWidth="3" /><path d="M143 102q13-6 26 0" fill="none" stroke="#eac06b" strokeWidth="3" /><g className="wukong-moment__steam" stroke="var(--room-muted, #77867a)" strokeWidth="2" fill="none" strokeLinecap="round"><path d="M150 94q-6-5 0-10t0-10" /><path d="M161 94q-6-5 0-10t0-10" /></g></g>}
    </g>
    {kind === "cloud" && <g className="wukong-moment__cloud"><path d="M59 148q-9-10 3-17 5-4 14-1 0-16 16-17 12-1 18 10 8-20 27-11 8 4 8 15 15-5 20 7 21-4 22 9 0 13-25 15H78q-20 0-19-10Z" fill="#eac06b" /><path d="M80 141q-3-13 10-13 11 0 9 10m19 5q-4-15 10-15 12 0 12 9m12 9 12-2" fill="none" stroke="#a66d36" strokeWidth="2.5" strokeLinecap="round" /><g className="wukong-moment__wind" fill="none" stroke="#eac06b" strokeWidth="3" strokeLinecap="round"><path d="M31 130H14m23 13H5m29 13H18" /></g></g>}
    {kind === "doze" && <g className="wukong-moment__sleep" fill="var(--room-muted, #77867a)"><text x="164" y="60" fontSize="13">z</text><text x="181" y="41" fontSize="18">z</text><text x="198" y="24" fontSize="24">Z</text></g>}
    {staff && <g className="wukong-moment__swoosh" fill="none" stroke="#eac06b" strokeWidth="3" strokeLinecap="round"><path d="M173 23q40 14 29 55" /><path d="M182 16q35 11 34 41" /></g>}
    {kind === "grumpy" && <g className="wukong-moment__puff" stroke="var(--room-muted, #77867a)" strokeWidth="2.5" fill="none" strokeLinecap="round"><path d="m174 74 12-3m-14 9 10 5m-12-17 7-9" /><path d="m52 47-5-5m5 13-9 2" /></g>}
  </svg>;
}

export function WukongMomentSticker({ moment }: { moment: WukongMoment }) {
  return <figure className="wukong-moment" data-moment={moment.id} aria-hidden="true" style={{ "--moment-duration": `${moment.duration}ms` } as CSSProperties}>
    <WukongMomentArtwork kind={moment.id} />
    <figcaption><small>悟空小剧场 · {moment.title}</small><span>{moment.line}</span></figcaption>
  </figure>;
}

export default function WukongMomentPlayer({ enabled, paused, contextKey, timeline, welcome }: {
  enabled: boolean; paused: boolean; contextKey: string; timeline: RefObject<HTMLDivElement>; welcome?: ReactNode;
}) {
  const [moment, setMoment] = useState<WukongMoment | null>(null);
  const [visible, setVisible] = useState(() => typeof document === "undefined" || !document.hidden);
  const [reduced, setReduced] = useState(() => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
  const next = useRef(createMomentBag());
  const follow = useRef(false);
  const nextAt = useRef(0);
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const updateMotion = () => setReduced(query.matches);
    const updateVisibility = () => setVisible(!document.hidden);
    query.addEventListener("change", updateMotion);
    document.addEventListener("visibilitychange", updateVisibility);
    return () => { query.removeEventListener("change", updateMotion); document.removeEventListener("visibilitychange", updateVisibility); };
  }, []);
  useEffect(() => {
    if (!enabled || paused || reduced || !visible) { setMoment(null); return; }
    const canPlay = () => {
      const element = timeline.current;
      return !!element && !document.hidden && (window.getSelection()?.isCollapsed ?? true)
        && element.scrollHeight - element.scrollTop - element.clientHeight < 80;
    };
    const stop = startMomentDirector({
      // DOM timer methods require their Window receiver; never pass clearTimeout unbound.
      schedule: (callback, delay) => window.setTimeout(callback, delay), cancel: (id) => window.clearTimeout(id),
      next: () => next.current(), canPlay,
      initialDelay: nextAt.current - Date.now(),
      show: (value) => {
        follow.current = !!value && canPlay();
        if (value) nextAt.current = Date.now() + value.duration + 28_000 + Math.round(Math.random() * 24_000);
        setMoment(value);
      },
    });
    const onScroll = () => { if (!canPlay()) setMoment(null); };
    timeline.current?.addEventListener("scroll", onScroll, { passive: true });
    document.addEventListener("selectionchange", onScroll);
    const element = timeline.current;
    return () => { stop(); element?.removeEventListener("scroll", onScroll); document.removeEventListener("selectionchange", onScroll); };
  }, [enabled, paused, reduced, visible, contextKey, timeline]);
  useClientLayoutEffect(() => {
    if (moment && follow.current && timeline.current) timeline.current.scrollTop = timeline.current.scrollHeight;
  }, [moment, timeline]);
  const sticker = enabled && !paused && !reduced && visible && moment ? <WukongMomentSticker key={moment.id} moment={moment} /> : null;
  return welcome ? <div className="wukong-moment-welcome">{sticker ?? welcome}</div> : sticker;
}
