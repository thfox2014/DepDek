import { X } from "@phosphor-icons/react";
import { useEffect, useId, useRef, type ReactNode } from "react";

/** Small non-modal controls; outside clicks preserve the user's next focus. */
export default function RoomControlPopover({ label, title = label, trigger, open, onToggle, onClose, children, className = "" }: {
  label: string; title?: string; trigger: ReactNode; open: boolean; onToggle: () => void; onClose: () => void;
  children: ReactNode; className?: string;
}) {
  const id = useId(), root = useRef<HTMLDivElement>(null), button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLElement>(null), close = useRef(onClose); close.current = onClose;
  const dismiss = (restore: boolean) => { close.current(); if (restore) button.current?.focus(); };
  useEffect(() => {
    if (!open) return;
    panel.current?.querySelector<HTMLElement>('button:not(:disabled),select:not(:disabled),input:not(:disabled)')?.focus();
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !root.current?.contains(event.target)) close.current(); };
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); close.current(); button.current?.focus(); }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", keydown);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", keydown); };
  }, [open]);
  return <div ref={root} className={`ai-room__control ${className}`}>
    <button ref={button} type="button" className="ai-room__control-trigger" aria-label={label} title={title} aria-expanded={open} aria-controls={id} onClick={onToggle}>{trigger}</button>
    <section ref={panel} id={id} className="ai-room__control-panel" role="dialog" aria-label={label} hidden={!open}>
      <header><h2>{label}</h2><button type="button" aria-label={`关闭${label}`} onClick={() => dismiss(true)}><X size={16} /></button></header>
      {children}
    </section>
  </div>;
}
