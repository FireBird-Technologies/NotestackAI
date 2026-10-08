import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from "react";

/** The notebook's side panels, resized by dragging the line between a panel and the chat. Widths are kept per browser;
 * nothing set means the stylesheet's default width. A panel never goes under its minimum, and the chat always keeps
 * room, so a narrower window simply takes the extra width back. */

export const PANE_MIN = { left: 220, right: 300 } as const;
const CHAT_MIN = 440;
const GUTTER = 16; // the space between the chat and the right panel (.nbv-side's margin)
const KEYS = { left: "ns_nbv_left", right: "ns_nbv_right" } as const;

type Side = "left" | "right";
type Widths = { left: number | null; right: number | null };

function read(side: Side): number | null {
  try {
    const v = Number(localStorage.getItem(KEYS[side]));
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}

function write(side: Side, value: number | null) {
  try {
    if (value === null) localStorage.removeItem(KEYS[side]);
    else localStorage.setItem(KEYS[side], String(Math.round(value)));
  } catch {
    /* Private browsing can prevent persistence; resizing still works for this visit. */
  }
}

function useMedia(query: string): boolean {
  const [on, setOn] = useState(() => typeof window !== "undefined" && window.matchMedia(query).matches);
  useEffect(() => {
    const m = window.matchMedia(query);
    const change = () => setOn(m.matches);
    change();
    m.addEventListener("change", change);
    return () => m.removeEventListener("change", change);
  }, [query]);
  return on;
}

/** Where the panes are now: the container's width and the two boundaries (px from its left edge). */
type Frame = { width: number; leftEdge: number | null; rightEdge: number | null };

export function usePaneWidths(container: RefObject<HTMLElement | null>, opts: { leftOpen: boolean }) {
  const [saved, setSaved] = useState<Widths>(() => ({ left: read("left"), right: read("right") }));
  const [frame, setFrame] = useState<Frame>({ width: 0, leftEdge: null, rightEdge: null });
  // The left panel sits beside the chat from 900px; the right one from 1350px (below that it stacks under the chat).
  const leftActive = useMedia("(min-width: 900px)") && opts.leftOpen;
  const rightActive = useMedia("(min-width: 1350px)");

  // Measure the real boundaries after layout changes, so the handles sit exactly on them (state only changes when a
  // number does, so this cannot loop).
  const measure = useCallback(() => {
    const el = container.current;
    if (!el) return;
    const box = el.getBoundingClientRect();
    const history = el.querySelector<HTMLElement>(":scope > .nbv-history");
    const side = el.querySelector<HTMLElement>(":scope > .nbv-side");
    const next: Frame = {
      width: Math.round(box.width),
      leftEdge: history ? Math.round(history.getBoundingClientRect().right - box.left) : null,
      rightEdge: side ? Math.round(side.getBoundingClientRect().left - box.left - GUTTER / 2) : null,
    };
    setFrame((cur) => (cur.width === next.width && cur.leftEdge === next.leftEdge && cur.rightEdge === next.rightEdge ? cur : next));
  }, [container]);
  useLayoutEffect(() => {
    measure();
  });
  useEffect(() => {
    const el = container.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    el.querySelectorAll(":scope > .nbv-history, :scope > .nbv-side").forEach((p) => ro.observe(p));
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [container, measure, leftActive, rightActive]);

  const { width } = frame;
  // What each panel measures by default (the stylesheet's width), when nothing is saved for it.
  const measuredLeft = frame.leftEdge ?? 0;
  const measuredRight = frame.rightEdge !== null ? width - frame.rightEdge - GUTTER / 2 : 0;
  const wantLeft = leftActive ? (saved.left ?? measuredLeft) : 0;
  const wantRight = rightActive ? (saved.right ?? measuredRight) : 0;
  // Each panel: at least its minimum, and never so wide that the chat gets less than CHAT_MIN.
  const maxLeft = Math.max(PANE_MIN.left, width - CHAT_MIN - (rightActive ? wantRight + GUTTER : 0));
  const maxRight = Math.max(PANE_MIN.right, width - CHAT_MIN - GUTTER - (leftActive ? wantLeft : 0));
  const fit = (v: number, max: number, min: number) => Math.max(min, Math.min(v, max));
  const left = leftActive && saved.left !== null && width ? fit(saved.left, maxLeft, PANE_MIN.left) : null;
  const right = rightActive && saved.right !== null && width ? fit(saved.right, maxRight, PANE_MIN.right) : null;

  const set = useCallback((side: Side, value: number | null, persist = false) => {
    setSaved((cur) => ({ ...cur, [side]: value }));
    if (persist) write(side, value);
  }, []);

  const style: CSSProperties = {
    ...(left !== null ? { ["--nbv-left" as string]: `${Math.round(left)}px` } : {}),
    ...(right !== null ? { ["--nbv-right" as string]: `${Math.round(right + GUTTER)}px` } : {}),
  };

  return {
    style,
    frame,
    active: { left: leftActive && frame.leftEdge !== null, right: rightActive && frame.rightEdge !== null },
    current: { left: left ?? measuredLeft, right: right ?? measuredRight },
    bounds: { left: { min: PANE_MIN.left, max: maxLeft }, right: { min: PANE_MIN.right, max: maxRight } },
    set,
  };
}

type Panes = ReturnType<typeof usePaneWidths>;

/** The line between a side panel and the chat: drag it (or focus it and use the arrow keys) to resize the panel;
 * double click puts the panel back to its default width. */
export function PaneResizer({ side, panes, container, label }: {
  side: Side;
  panes: Panes;
  container: RefObject<HTMLElement | null>;
  label: string;
}) {
  const [dragging, setDragging] = useState(false);
  const frameReq = useRef(0);
  const { min, max } = panes.bounds[side];
  const value = Math.round(panes.current[side]);
  const clamp = (v: number) => Math.max(min, Math.min(max, v));
  const at = side === "left" ? panes.frame.leftEdge : panes.frame.rightEdge;

  const fromPointer = (clientX: number) => {
    const box = container.current?.getBoundingClientRect();
    if (!box) return value;
    return clamp(side === "left" ? clientX - box.left : box.right - clientX - GUTTER / 2);
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
    document.body.classList.add("nbv-resizing");
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    const x = e.clientX;
    cancelAnimationFrame(frameReq.current);
    frameReq.current = requestAnimationFrame(() => panes.set(side, fromPointer(x)));
  };
  const end = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    cancelAnimationFrame(frameReq.current);
    setDragging(false);
    document.body.classList.remove("nbv-resizing");
    panes.set(side, fromPointer(e.clientX), true);
  };
  useEffect(() => () => document.body.classList.remove("nbv-resizing"), []);

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 64 : 16;
    // The left panel grows to the right; the right panel grows to the left.
    const grow = side === "left" ? "ArrowRight" : "ArrowLeft";
    const shrink = side === "left" ? "ArrowLeft" : "ArrowRight";
    let next: number | null = null;
    if (e.key === grow) next = value + step;
    else if (e.key === shrink) next = value - step;
    else if (e.key === "Home") next = min;
    else if (e.key === "End") next = max;
    else return;
    e.preventDefault();
    panes.set(side, clamp(next), true);
  };

  if (!panes.active[side] || at === null) return null;
  return (
    <div className={`nbv-resizer nbv-resizer-${side}${dragging ? " dragging" : ""}`} style={{ left: at }}
         role="separator" aria-orientation="vertical" aria-label={label} tabIndex={0}
         aria-valuenow={value} aria-valuemin={min} aria-valuemax={Math.round(max)}
         title="Drag to resize. Double click to reset."
         onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={end} onPointerCancel={end}
         onDoubleClick={() => panes.set(side, null, true)} onKeyDown={onKeyDown} />
  );
}
