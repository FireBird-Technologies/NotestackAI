import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { SupportChat } from "./SupportChat";

const DISMISSED_KEY = "ns_help_bubble_dismissed";

function readDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

/** The bottom right help button. Hidden on the sign in screens. */
export function SupportWidget() {
  const { pathname } = useLocation();
  const [open, setOpen] = useState(false);
  const [bubbleReady, setBubbleReady] = useState(false);
  const [dismissed, setDismissed] = useState(readDismissed);

  useEffect(() => {
    const t = window.setTimeout(() => setBubbleReady(true), 2500);
    return () => window.clearTimeout(t);
  }, []);

  if (pathname.startsWith("/auth") || pathname === "/welcome") return null;

  const dismiss = () => {
    setDismissed(true);
    try {
      localStorage.setItem(DISMISSED_KEY, "1");
    } catch {
      /* private mode: hidden for this visit only */
    }
  };

  return (
    <>
      {bubbleReady && !dismissed && !open && (
        <div className="sup-bubble">
          <button type="button" className="sup-bubble-text" onClick={() => { setOpen(true); dismiss(); }}>
            Need help?
          </button>
          <button type="button" className="sup-bubble-x" onClick={dismiss} aria-label="Dismiss">
            ×
          </button>
        </div>
      )}
      <button
        type="button"
        className="sup-fab"
        aria-label={open ? "Close help" : "Open help"}
        aria-expanded={open}
        onClick={() => { setOpen((v) => !v); dismiss(); }}
      >
        {open ? (
          <span aria-hidden="true">×</span>
        ) : (
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z" />
          </svg>
        )}
      </button>
      {open && <SupportChat onClose={() => setOpen(false)} />}
    </>
  );
}
