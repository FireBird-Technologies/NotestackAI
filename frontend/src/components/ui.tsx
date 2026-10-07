import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useLocation, useNavigate } from "react-router-dom";
import { ApiError } from "../api/client";
import type { Job } from "../api/types";

export function errorMessage(e: unknown, fallback = "Something went wrong. Try again."): string {
  return e instanceof ApiError ? e.message : e instanceof Error && e.message ? e.message : fallback;
}

/** Matches blog2video.NOT_RESPONDING on the backend: the video service is down or redeploying. */
export const VIDEO_UPDATING = "The video service is being updated";

/**
 * An inline error. The "video service is being updated" message is a status, not a mistake: it is shown centered
 * and in bold instead, and with `page` it fills the page under the header.
 */
export function ErrorText({ message, page = false }: { message: string; page?: boolean }) {
  if (message.startsWith(VIDEO_UPDATING)) {
    return (
      <div className={`service-notice${page ? " page" : ""}`} role="status">
        <strong>{message}</strong>
      </div>
    );
  }
  return <p className="error-text">{message}</p>;
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
  actions,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
  /** Buttons for the header's right side, in place of the close button. */
  actions?: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // A modal opened from a modal (a picker over the composer): Escape closes only the top one.
      const open = document.querySelectorAll(".modal-backdrop");
      if (open[open.length - 1] === ref.current?.parentElement) onClose();
    };
    document.addEventListener("keydown", onKey);
    ref.current?.focus();
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  // Rendered into <body>: a parent with backdrop-filter or transform (cards have one) would otherwise become the
  // containing block of this fixed backdrop and trap the modal inside that card.
  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal card${wide ? " modal-wide" : ""}`} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={ref}>
        <div className="modal-head">
          <h2>{title}</h2>
          {actions ?? (
            <button className="icon-btn" onClick={onClose} aria-label="Close">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          )}
        </div>
        {children}
      </div>
    </div>,
    document.body,
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
  label,
  busyLabel = "Working...",
}: {
  /** What the button says while the confirmed action runs. */
  busyLabel?: string;
  onConfirm: () => unknown; // the result (e.g. act's success flag) is awaited, not used
  children: ReactNode;
  confirmLabel?: string;
  className?: string;
  /** Accessible name and tooltip, for an icon-only button. */
  label?: string;
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
      aria-label={label ? (armed ? confirmLabel : label) : undefined}
      title={label ? (armed ? confirmLabel : label) : undefined}
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
      {busy ? <><span className="nbv-send-spinner" aria-hidden="true" /> {busyLabel}</> : armed ? confirmLabel : children}
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

/**
 * Spinner with its label underneath, centered. `center="page"` puts it in the middle of the space under a page
 * header; `center="full"` in the middle of the window, for a page that has no header yet.
 */
export function Loading({ label = "Loading", center }: { label?: string; center?: "page" | "full" }) {
  const loader = (
    <div className="loading mono muted" role="status">
      <div className="orbit-loader">
        <span />
      </div>
      {label}...
    </div>
  );
  return center ? <div className={`loading-center${center === "full" ? " full" : ""}`}>{loader}</div> : loader;
}

export function StatusPill({ status }: { status: string }) {
  const tone = ["ready", "ok", "done", "posted", "reminded", "connected"].includes(status)
    ? "ok"
    : ["failed", "error"].includes(status)
      ? "bad"
      : ["paused", "expired", "revoked", "disconnected"].includes(status)
        ? "warn"
        : "busy";
  return <span className={`pill pill-${tone} mono`}>{status}</span>;
}

/** An arrow back to exactly the page before (browser history); `fallback` when the page was opened directly. */
export function BackArrow({ fallback, label = "Back" }: { fallback: string; label?: string }) {
  const navigate = useNavigate();
  const location = useLocation();
  return (
    <button type="button" className="back-link page-back"
            onClick={() => (location.key !== "default" ? navigate(-1) : navigate(fallback))}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
           strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M19 12H5m6-6-6 6 6 6" />
      </svg>
      {label}
    </button>
  );
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
