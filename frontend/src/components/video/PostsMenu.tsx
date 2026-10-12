import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { ChatSummary, Doc } from "../../api/types";
import { DocPicker } from "../DocPicker";
import { ChevronIcon } from "../icons/Icons";

/** Pick posts from a dropdown: a button that says how many are chosen, and a panel under it with the search box and the
 * ticks. Replaces the list that would otherwise sit under the source dropdown. `single` picks one post from the whole
 * archive (the picker loads the list itself). */
/** A button that opens a panel under it (or above it when the window is short below). Used by the posts and chats menus. */
export function MenuPanel({ label, disabled = false, ariaLabel, children }: {
  label: string;
  disabled?: boolean;
  ariaLabel: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState<CSSProperties>({});
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);

  // Under the button, as wide as it (at least 440px), or above it when the window is short below.
  useLayoutEffect(() => {
    if (!open || !button.current) return;
    const r = button.current.getBoundingClientRect();
    const width = Math.min(Math.max(r.width, 440), window.innerWidth - 24);
    const left = Math.min(Math.max(12, r.left), window.innerWidth - width - 12);
    const below = window.innerHeight - r.bottom;
    setPlace(below >= 360 || below >= r.top
      ? { top: r.bottom + 6, left, width, maxHeight: Math.max(240, below - 18) }
      : { bottom: window.innerHeight - r.top + 6, left, width, maxHeight: Math.max(240, r.top - 18) });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!panel.current?.contains(t) && !button.current?.contains(t)) setOpen(false);
    };
    const close = () => setOpen(false);
    document.addEventListener("mousedown", away);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("mousedown", away);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  return (
    <>
      <button type="button" ref={button} className={`sp-trigger${open ? " open" : ""}`} aria-haspopup="dialog" aria-expanded={open}
              disabled={disabled} onClick={() => setOpen((o) => !o)}>
        <span className="sp-trigger-text">{label}</span>
        <ChevronIcon size={16} className={`chevron${open ? " open" : ""}`} />
      </button>
      {open && createPortal(
        <div ref={panel} className="sp-panel" role="dialog" aria-label={ariaLabel} style={place}>
          {children}
        </div>,
        document.body,
      )}
    </>
  );
}

/** Pick posts from a dropdown: a button that says how many are chosen, and a panel under it with the search box and the
 * ticks. `single` picks one post from the whole archive (the picker loads the list itself). */
export function PostsMenu({ docs, selected, onChange, max, single = false, loading = false }: {
  docs?: Doc[] | null;
  selected: string[];
  onChange: (ids: string[]) => void;
  max?: number;
  single?: boolean;
  loading?: boolean;
}) {
  const total = docs?.length ?? 0;
  const label = loading ? "Loading posts"
    : single ? (selected.length ? "1 post selected" : "Pick a post")
    : selected.length === 0 ? "Posts: none"
    : `Posts: ${selected.length} of ${total}`;
  return (
    <MenuPanel label={label} ariaLabel="Choose posts" disabled={loading || (!single && total === 0)}>
      {single
        ? <DocPicker selected={selected} onChange={onChange} single />
        : <DocPicker docs={docs ?? []} selected={selected} onChange={onChange} max={max} count={false} />}
      {!single && max && Number.isFinite(max) && <p className="muted small sp-note">Up to {max} posts. They are combined into one.</p>}
    </MenuPanel>
  );
}

/** Pick notebook chats from a dropdown, the same way: a button with the count, and the chats to tick in a panel. */
export function ChatsMenu({ chats, selected, onChange, max }: {
  chats: ChatSummary[];
  selected: string[];
  onChange: (ids: string[]) => void;
  max: number;
}) {
  const toggle = (id: string) =>
    onChange(selected.includes(id) ? selected.filter((x) => x !== id) : selected.length < max ? [...selected, id] : selected);
  const label = chats.length === 0 ? "Chats: none yet" : selected.length === 0 ? "Chats: none" : `Chats: ${selected.length} of ${chats.length}`;
  return (
    <MenuPanel label={label} ariaLabel="Choose chats" disabled={chats.length === 0}>
      <div className="picker">
        <ul className="picker-list">
          {chats.map((c) => (
            <li key={c.id}>
              <label className={`picker-row${selected.includes(c.id) ? " on" : ""}`}>
                <input type="checkbox" checked={selected.includes(c.id)} disabled={!selected.includes(c.id) && selected.length >= max}
                       onChange={() => toggle(c.id)} />
                <span className="picker-title">{c.title?.trim() || "Untitled chat"}</span>
              </label>
            </li>
          ))}
        </ul>
      </div>
      <p className="muted small sp-note">Up to {max} chats. Questions come from what was said in them.</p>
    </MenuPanel>
  );
}
