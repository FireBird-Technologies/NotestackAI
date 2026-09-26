import { useEffect, useRef, useState, type ReactNode } from "react";
import { ApiError } from "../api/client";
import type { Job } from "../api/types";

export function errorMessage(e: unknown, fallback = "Something went wrong. Try again."): string {
  return e instanceof ApiError ? e.message : e instanceof Error && e.message ? e.message : fallback;
}

/** Launch progress bar for a job. */
export function JobProgress({ job, compact = false }: { job: Job; compact?: boolean }) {
  const pct = Math.round((job.status === "done" ? 1 : job.progress) * 100);
  const failed = job.status === "failed";
  const label = failed
    ? job.error ?? "Failed"
    : job.status === "queued"
      ? job.message ?? "Queued for launch"
      : job.message ?? "Working";
  return (
    <div
      className={`ascent${failed ? " ascent-failed" : ""}${compact ? " ascent-compact" : ""}`}
      role="progressbar"
      aria-valuenow={pct}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div className="ascent-track">
        <div className="ascent-fill" style={{ width: `${failed ? 100 : pct}%` }} />
      </div>
      <div className="ascent-meta mono">
        <span>{label}</span>
        {!failed && <span>{pct}%</span>}
      </div>
    </div>
  );
}

export function Modal({
  title,
  onClose,
  children,
  wide = false,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    ref.current?.focus();
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal card${wide ? " modal-wide" : ""}`} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={ref}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Drawer({ onClose, children, label }: { onClose: () => void; children: ReactNode; label: string }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="drawer-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside className="drawer" role="dialog" aria-modal="true" aria-label={label}>
        <button className="icon-btn drawer-close" onClick={onClose} aria-label="Close">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
        {children}
      </aside>
    </div>
  );
}

export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
}: {
  tabs: { id: T; label: string; count?: number }[];
  value: T;
  onChange: (id: T) => void;
}) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          aria-selected={value === t.id}
          className={`tab${value === t.id ? " active" : ""}`}
          onClick={() => onChange(t.id)}
        >
          {t.label}
          {t.count !== undefined && <span className="tab-count mono">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="btn btn-small"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          /* clipboard blocked */
        }
      }}
    >
      {copied ? "Copied" : label}
    </button>
  );
}

/** Two step destructive button: first click arms it, second confirms. No browser dialogs. */
export function ConfirmButton({
  onConfirm,
  children,
  confirmLabel = "Click again to confirm",
  className = "btn btn-small btn-danger",
}: {
  onConfirm: () => void | Promise<void>;
  children: ReactNode;
  confirmLabel?: string;
  className?: string;
}) {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(t);
  }, [armed]);
  return (
    <button
      type="button"
      className={`${className}${armed ? " armed" : ""}`}
      disabled={busy}
      onClick={async () => {
        if (!armed) return setArmed(true);
        setBusy(true);
        try {
          await onConfirm();
        } finally {
          setBusy(false);
          setArmed(false);
        }
      }}
    >
      {busy ? "Working..." : armed ? confirmLabel : children}
    </button>
  );
}

export function EmptyState({ title, body, action }: { title: string; body?: string; action?: ReactNode }) {
  return (
    <div className="empty-state small">
      <svg width="96" height="72" viewBox="0 0 120 90" fill="none" aria-hidden="true" className="empty-art">
        <circle cx="84" cy="30" r="16" stroke="currentColor" strokeWidth="1.5" />
        <circle cx="78" cy="26" r="3" stroke="currentColor" strokeWidth="1.5" opacity="0.5" />
        <path d="M20 70l14-8 6 10-14 8z" stroke="currentColor" strokeWidth="1.5" />
        <path d="M34 62l10-6M26 80l-6 6" stroke="currentColor" strokeWidth="1.5" />
        <circle cx="12" cy="20" r="1" fill="currentColor" />
        <circle cx="50" cy="12" r="1" fill="currentColor" />
        <circle cx="108" cy="72" r="1" fill="currentColor" />
      </svg>
      <h3>{title}</h3>
      {body && <p className="muted">{body}</p>}
      {action}
    </div>
  );
}

export function Loading({ label = "Loading" }: { label?: string }) {
  return (
    <div className="loading mono muted" role="status">
      <div className="orbit-loader">
        <span />
      </div>
      {label}...
    </div>
  );
}

export function StatusPill({ status }: { status: string }) {
  const tone = ["ready", "ok", "done", "posted", "reminded"].includes(status)
    ? "ok"
    : ["failed", "error"].includes(status)
      ? "bad"
      : "busy";
  return <span className={`pill pill-${tone} mono`}>{status}</span>;
}

export function PageHeader({ eyebrow, title, children }: { eyebrow: string; title: string; children?: ReactNode }) {
  return (
    <header className="page-head">
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
      </div>
      {children && <div className="page-actions">{children}</div>}
    </header>
  );
}

export function formatDate(iso: string | null | undefined, withTime = false): string {
  if (!iso) return "Undated";
  const d = new Date(iso);
  return withTime
    ? d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
    : d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export function formatDuration(seconds: number | undefined): string {
  if (!seconds) return "";
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}
