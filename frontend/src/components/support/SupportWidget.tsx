import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useLocation } from "react-router-dom";
import { SupportChat } from "./SupportChat";

const DISMISSED_KEY = "ns_help_bubble_dismissed";
const HOME = 20; // the button's resting gap from the bottom right corner (styles/support.css)
const SIZE = 52;
const EDGE = 8; // dragged, it stays this far inside the window
const DRAG_START = 4; // pixels moved before a press counts as a drag, not a click

type Offset = { x: number; y: number };

/** An offset from the resting corner, kept so the whole button stays inside the window. */
function clampOffset(o: Offset): Offset {
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  return {
    x: clamp(o.x, EDGE + SIZE + HOME - window.innerWidth, HOME - EDGE),
    y: clamp(o.y, EDGE + SIZE + HOME - window.innerHeight, HOME - EDGE),
  };
}

function readDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

/** Fired (on window) to open the support chat from anywhere, e.g. a "Contact support" button in an error popup. */
export const OPEN_SUPPORT_EVENT = "ns:open-support";

/** The bottom right help button. Hidden where it would distract from focused or unauthenticated pages (the sign in
 * screens, onboarding, legal pages and shared previews). While the chat is closed it can be dragged anywhere on the
 * screen; opening the chat brings it back to its corner, beside the panel. */
export function SupportWidget() {
  const { pathname } = useLocation();
  const [open, setOpen] = useState(false);
  const [bubbleReady, setBubbleReady] = useState(false);
  const [dismissed, setDismissed] = useState(readDismissed);
  const [offset, setOffset] = useState<Offset>({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  // The press under way: where it started, the offset then, and whether it has moved enough to be a drag.
  const press = useRef<{ id: number; x: number; y: number; from: Offset; moved: boolean } | null>(null);
  const dragged = useRef(false); // the click that ends a drag doesn't open the chat

  // A smaller window keeps a moved button on screen.
  useEffect(() => {
    const onResize = () => setOffset((o) => clampOffset(o));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    const t = window.setTimeout(() => setBubbleReady(true), 2500);
    return () => window.clearTimeout(t);
  }, []);

  // Opened from elsewhere in the app: the chat opens in its corner
  useEffect(() => {
    const openChat = () => {
      setOffset({ x: 0, y: 0 });
      setOpen(true);
    };
    window.addEventListener(OPEN_SUPPORT_EVENT, openChat);
    return () => window.removeEventListener(OPEN_SUPPORT_EVENT, openChat);
  }, []);

  const isLegalPage = pathname === "/privacy" || pathname === "/terms" || pathname === "/support";

  // Not on sign in, onboarding, legal documents, or a shared preview link (/r/…), which is for people without an account.
  if (pathname.startsWith("/auth") || pathname === "/welcome" || isLegalPage || pathname.startsWith("/r/")) return null;

  const onPointerDown = (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (open || e.button !== 0) return; // only the closed button moves
    press.current = { id: e.pointerId, x: e.clientX, y: e.clientY, from: offset, moved: false };
    dragged.current = false;
    e.currentTarget.setPointerCapture(e.pointerId); // a quick drag leaves the button at once: keep its moves
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const p = press.current;
    if (!p || p.id !== e.pointerId) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    if (!p.moved) {
      if (Math.hypot(dx, dy) < DRAG_START) return;
      p.moved = true;
      setDragging(true);
    }
    setOffset(clampOffset({ x: p.from.x + dx, y: p.from.y + dy }));
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const p = press.current;
    if (!p || p.id !== e.pointerId) return;
    dragged.current = p.moved;
    press.current = null;
    setDragging(false);
  };

  const toggle = () => {
    if (dragged.current) {
      dragged.current = false;
      return;
    }
    if (!open) setOffset({ x: 0, y: 0 }); // back to its corner, beside the panel
    setOpen((v) => !v);
    dismiss();
  };

  const moved = offset.x !== 0 || offset.y !== 0;

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
      {bubbleReady && !dismissed && !open && !moved && (
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
        className={`sup-fab${open ? "" : " is-movable"}${dragging ? " is-dragging" : ""}`}
        style={{ ["--sup-dx" as string]: `${offset.x}px`, ["--sup-dy" as string]: `${offset.y}px` }}
        aria-label={open ? "Close help" : "Open help"}
        aria-expanded={open}
        title={open ? undefined : "Open help (drag to move)"}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onClick={toggle}
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
