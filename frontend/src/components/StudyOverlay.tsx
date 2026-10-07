import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

/** A full-screen study space (a quiz, a flashcard deck) that opens like the Mind Constellation does, and can be
 * minimised to a small pill in the corner and brought back, keeping its place. Escape minimises. */
export function StudyOverlay({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const [minimized, setMinimized] = useState(false);

  useEffect(() => {
    if (minimized) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMinimized(true);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [minimized]);

  return createPortal(
    <>
      {/* Stays mounted while minimised, so the answers given so far are kept */}
      <div className="so-overlay" role="dialog" aria-modal="true" aria-label={title} hidden={minimized}>
        <header className="so-top">
          <h2 className="so-title">{title}</h2>
          <div className="so-actions">
            <button type="button" className="icon-btn" onClick={() => setMinimized(true)} aria-label="Minimise" title="Minimise">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                <path d="M5 19h14" />
              </svg>
            </button>
            <button type="button" className="icon-btn" onClick={onClose} aria-label="Close" title="Close">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          </div>
        </header>
        <div className="so-body">
          <div className="so-card">{children}</div>
        </div>
      </div>
      {minimized && (
        <div className="so-pill">
          <button type="button" className="so-pill-open" onClick={() => setMinimized(false)} title="Open again">
            <span className="so-pill-dot" aria-hidden="true" />
            <span className="so-pill-title">{title}</span>
            <span className="link-btn">Open</span>
          </button>
          <button type="button" className="icon-btn so-pill-close" onClick={onClose} aria-label="Close" title="Close">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>
      )}
    </>,
    document.body,
  );
}
