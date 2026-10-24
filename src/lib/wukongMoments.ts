/** Appearance only. These moments are never agent output, history or actions. */
export const WUKONG_MOMENTS = [
  { id: "staff", title: "挥舞金箍棒", line: "活动活动，精神抖擞。", duration: 5000 },
  { id: "doze", title: "打瞌睡", line: "眯一下，马上回来。", duration: 6000 },
  { id: "tea", title: "喝茶", line: "慢慢来，喝口茶。", duration: 5600 },
  { id: "cloud", title: "筋斗云", line: "兜个风，就回来。", duration: 5200 },
  { id: "bonk", title: "吃俺老孙一棒", line: "吃俺老孙一棒！", duration: 4600 },
  { id: "grumpy", title: "烦死了", line: "烦死了，挠挠头。", duration: 5000 },
] as const;
export type WukongMomentId = typeof WUKONG_MOMENTS[number]["id"];
export type WukongMoment = typeof WUKONG_MOMENTS[number];

function unit(random: () => number): number {
  const value = random();
  return Number.isFinite(value) ? Math.min(0.999999, Math.max(0, value)) : 0;
}

/** Shuffle bag: all six play once, with no immediate repeat across rounds. */
export function createMomentBag(random: () => number = Math.random) {
  let remaining: WukongMoment[] = [], previous: WukongMomentId | undefined;
  return () => {
    if (!remaining.length) {
      remaining = [...WUKONG_MOMENTS];
      for (let i = remaining.length - 1; i > 0; i--) {
        const j = Math.floor(unit(random) * (i + 1));
        [remaining[i], remaining[j]] = [remaining[j], remaining[i]];
      }
      if (remaining[remaining.length - 1].id === previous) {
        [remaining[0], remaining[remaining.length - 1]] = [remaining[remaining.length - 1], remaining[0]];
      }
    }
    const moment = remaining.pop()!;
    previous = moment.id;
    return moment;
  };
}

type DirectorPorts = {
  schedule: (callback: () => void, delay: number) => number;
  cancel: (id: number) => void;
  next: () => WukongMoment;
  canPlay: () => boolean;
  show: (moment: WukongMoment | null) => void;
  random?: () => number;
  initialDelay?: number;
};

/** A single finite timer, not a frame loop. Stop is idempotent and terminal. */
export function startMomentDirector(ports: DirectorPorts): () => void {
  const random = ports.random ?? Math.random;
  let stopped = false, timer: number | undefined;
  const later = (callback: () => void, delay: number) => {
    timer = ports.schedule(() => { if (!stopped) callback(); }, delay);
  };
  const rest = () => later(play, 28_000 + Math.round(unit(random) * 24_000));
  const play = () => {
    if (!ports.canPlay()) { rest(); return; }
    const moment = ports.next();
    ports.show(moment);
    later(() => { ports.show(null); rest(); }, moment.duration);
  };
  later(play, Math.max(4000 + Math.round(unit(random) * 4000), Math.min(60_000, ports.initialDelay ?? 0)));
  return () => {
    if (stopped) return;
    stopped = true;
    if (timer !== undefined) ports.cancel(timer);
    ports.show(null);
  };
}
