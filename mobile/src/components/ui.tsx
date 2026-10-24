import {
  useEffect,
  useRef,
  useId,
  type ReactNode,
  type ButtonHTMLAttributes,
} from "react";
import { X, ArrowRight } from "@phosphor-icons/react";

export function Button({
  children,
  secondary = false,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { secondary?: boolean }) {
  return (
    <button
      {...props}
      className={`button ${secondary ? "secondary" : "primary"} ${props.className || ""}`}
    >
      {children}
    </button>
  );
}
export function Empty({
  icon,
  title,
  children,
  action,
}: {
  icon?: ReactNode;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      {icon}
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}
export function TextLink({
  children,
  onClick,
}: {
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <button className="text-link" onClick={onClick}>
      {children}
      <ArrowRight size={16} />
    </button>
  );
}
export function Sheet({
  open,
  title,
  kicker,
  onClose,
  children,
  className = "",
}: {
  open: boolean;
  title: string;
  kicker?: string;
  onClose: () => void;
  children: ReactNode;
  className?: string;
}) {
  const headingId = useId(),
    ref = useRef<HTMLDialogElement>(null),
    closeCallback = useRef(onClose);
  closeCallback.current = onClose;
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (open && !node.open) node.showModal();
    else if (!open && node.open) node.close();
    return () => {
      if (node.open) node.close();
    };
  }, [open]);
  return (
    <dialog
      className={`sheet ${className}`}
      ref={ref}
      onCancel={(e) => {
        e.preventDefault();
        closeCallback.current();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          const rect = e.currentTarget.getBoundingClientRect();
          if (
            e.clientX < rect.left ||
            e.clientX > rect.right ||
            e.clientY < rect.top ||
            e.clientY > rect.bottom
          )
            closeCallback.current();
        }
      }}
      aria-labelledby={headingId}
    >
      <div className="sheet-grip" aria-hidden="true" />
      <header className="sheet-header">
        <div>
          {kicker && <p className="eyebrow">{kicker}</p>}
          <h2 id={headingId}>{title}</h2>
        </div>
        <button
          className="icon-button"
          onClick={onClose}
          aria-label="关闭，返回刚才的页面"
        >
          <X size={21} />
        </button>
      </header>
      <div className="sheet-content">{children}</div>
    </dialog>
  );
}
