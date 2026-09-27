import { useCallback, useEffect, useRef, useState, type PointerEventHandler, type ReactNode } from "react";

export interface DragHandleProps {
  role: "button";
  tabIndex: number;
  "aria-label": string;
  onPointerDown: PointerEventHandler<HTMLDivElement>;
  onPointerMove: PointerEventHandler<HTMLDivElement>;
  onPointerUp: PointerEventHandler<HTMLDivElement>;
  onPointerCancel: PointerEventHandler<HTMLDivElement>;
  onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => void;
}

interface Props {
  stageRef: React.RefObject<HTMLElement>;
  storageKey: string;
  className?: string;
  children: (handleProps: DragHandleProps) => ReactNode;
}

interface Point { x: number; y: number }

const DOCK_CLEARANCE = 78;

/** A low-overhead, keyboard-accessible floating desktop window. */
export default function FloatingWindow({ stageRef, storageKey, className = "", children }: Props) {
  const windowRef = useRef<HTMLDivElement>(null);
  const positionRef = useRef<Point>({ x: 0, y: 0 });
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; origin: Point } | null>(null);
  const frameRef = useRef<number | null>(null);
  const pendingPointRef = useRef<Point | null>(null);
  const [position, setPosition] = useState<Point | null>(null);

  const clamp = useCallback((point: Point): Point => {
    const stage = stageRef.current;
    const floating = windowRef.current;
    if (!stage || !floating) return point;
    const maxX = Math.max(12, stage.clientWidth - floating.offsetWidth - 12);
    const maxY = Math.max(12, stage.clientHeight - Math.min(DOCK_CLEARANCE, stage.clientHeight / 3) - floating.offsetHeight);
    return {
      x: Math.min(maxX, Math.max(12, point.x)),
      y: Math.min(maxY, Math.max(12, point.y)),
    };
  }, [stageRef]);

  const paint = useCallback((point: Point) => {
    positionRef.current = point;
    const floating = windowRef.current;
    if (floating) floating.style.transform = `translate3d(${point.x}px, ${point.y}px, 0)`;
  }, []);

  useEffect(() => {
    let frame = 0;
    const initialize = () => {
      const stage = stageRef.current;
      const floating = windowRef.current;
      if (!stage || !floating) return;
      let saved: Point | null = null;
      try {
        const value: unknown = JSON.parse(localStorage.getItem(storageKey) ?? "null");
        if (value && typeof value === "object" && "x" in value && "y" in value) {
          const candidate = value as { x: unknown; y: unknown };
          if (typeof candidate.x === "number" && Number.isFinite(candidate.x) && typeof candidate.y === "number" && Number.isFinite(candidate.y)) {
            saved = { x: candidate.x, y: candidate.y };
          }
        }
      } catch {
        // Ignore unavailable or malformed browser storage and use the default.
      }
      const defaultPoint = { x: stage.clientWidth - floating.offsetWidth - 28, y: 26 };
      // Keep the desktop launcher rail visible when migrating from the old
      // default position, which could place this widget over every shortcut.
      const overlapsShortcutRail = Boolean(saved && stage.clientWidth > 620 && saved.x < 140 && saved.y < 540);
      const initial = clamp(saved && !overlapsShortcutRail ? saved : defaultPoint);
      positionRef.current = initial;
      setPosition(initial);
      if (overlapsShortcutRail) {
        try { localStorage.setItem(storageKey, JSON.stringify(initial)); } catch { /* storage is optional */ }
      }
    };
    frame = window.requestAnimationFrame(initialize);
    return () => window.cancelAnimationFrame(frame);
  }, [clamp, stageRef, storageKey]);

  useEffect(() => {
    if (!position) return;
    const onResize = () => {
      const next = clamp(positionRef.current);
      paint(next);
      setPosition(next);
      try { localStorage.setItem(storageKey, JSON.stringify(next)); } catch { /* storage is optional */ }
    };
    window.addEventListener("resize", onResize);
    const observer = windowRef.current && typeof ResizeObserver !== "undefined"
      ? new ResizeObserver(onResize)
      : null;
    if (observer && windowRef.current) observer.observe(windowRef.current);
    return () => {
      window.removeEventListener("resize", onResize);
      observer?.disconnect();
    };
  }, [clamp, paint, position, storageKey]);

  useEffect(() => () => {
    if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current);
  }, []);

  const onPointerDown: PointerEventHandler<HTMLDivElement> = (event) => {
    if ((event.target as HTMLElement).closest("button, a, input, select, textarea")) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      origin: positionRef.current,
    };
    windowRef.current?.classList.add("floating-window--dragging");
  };

  const onPointerMove: PointerEventHandler<HTMLDivElement> = (event) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    pendingPointRef.current = clamp({
      x: drag.origin.x + event.clientX - drag.startX,
      y: drag.origin.y + event.clientY - drag.startY,
    });
    if (frameRef.current === null) {
      frameRef.current = window.requestAnimationFrame(() => {
        frameRef.current = null;
        if (pendingPointRef.current) paint(pendingPointRef.current);
      });
    }
  };

  const finishDrag: PointerEventHandler<HTMLDivElement> = (event) => {
    if (!dragRef.current || dragRef.current.pointerId !== event.pointerId) return;
    if (frameRef.current !== null) {
      window.cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
    const finalPoint = pendingPointRef.current ?? positionRef.current;
    pendingPointRef.current = null;
    dragRef.current = null;
    paint(finalPoint);
    setPosition(finalPoint);
    windowRef.current?.classList.remove("floating-window--dragging");
    try { localStorage.setItem(storageKey, JSON.stringify(finalPoint)); } catch { /* storage is optional */ }
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!event.altKey || !["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) return;
    event.preventDefault();
    const delta = event.shiftKey ? 32 : 12;
    const next = clamp({
      x: positionRef.current.x + (event.key === "ArrowLeft" ? -delta : event.key === "ArrowRight" ? delta : 0),
      y: positionRef.current.y + (event.key === "ArrowUp" ? -delta : event.key === "ArrowDown" ? delta : 0),
    });
    paint(next);
    setPosition(next);
    try { localStorage.setItem(storageKey, JSON.stringify(next)); } catch { /* storage is optional */ }
  };

  const handleProps: DragHandleProps = {
    role: "button",
    tabIndex: 0,
    "aria-label": "拖动性能监控窗口；按住 Alt 和方向键移动，Shift 可加速",
    onPointerDown,
    onPointerMove,
    onPointerUp: finishDrag,
    onPointerCancel: finishDrag,
    onKeyDown,
  };

  return (
    <div
      ref={windowRef}
      className={`floating-window ${className}`.trim()}
      style={{ transform: `translate3d(${position?.x ?? 0}px, ${position?.y ?? 0}px, 0)`, visibility: position ? "visible" : "hidden" }}
    >
      {children(handleProps)}
    </div>
  );
}
