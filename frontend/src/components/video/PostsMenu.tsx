import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { ChatSummary, Doc } from "../../api/types";
import { ChevronIcon } from "../icons/Icons";
import { formatDate } from "../ui";

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

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Posts and chats in one dropdown: a button that says how many of each are chosen, and a panel with one search box, one
 * "Select All" and a single list of the posts and then the chats, each row tagged with its kind. */
export function SourcesMenu({ docs, loading = false, postIds, onPostIds, maxPosts = Infinity, chats, chatIds, onChatIds, maxChats }: {
  docs: Doc[] | null;
  loading?: boolean;
  postIds: string[];
  onPostIds: (ids: string[]) => void;
  maxPosts?: number;
  chats: ChatSummary[];
  chatIds: string[];
  onChatIds: (ids: string[]) => void;
  maxChats: number;
}) {
  const [q, setQ] = useState("");
  const needle = q.trim().toLowerCase();
  const chatTitle = (c: ChatSummary) => c.title?.trim() || "Untitled chat";
  const posts = useMemo(() => (docs ?? []).filter((d) => !needle || d.title.toLowerCase().includes(needle)
    || (d.source_title ?? "").toLowerCase().includes(needle)), [docs, needle]);
  const chatRows = useMemo(() => chats.filter((c) => !needle || chatTitle(c).toLowerCase().includes(needle)), [chats, needle]);

  // Select All ticks as many of the posts and chats in view as can be ticked; it reads as ticked once those are all in.
  const allPosts = posts.filter((d) => !d.locked).slice(0, maxPosts).map((d) => d.id);
  const allChats = chatRows.slice(0, maxChats).map((c) => c.id);
  const allOn = allPosts.length + allChats.length > 0
    && allPosts.every((id) => postIds.includes(id)) && allChats.every((id) => chatIds.includes(id));
  const selectAll = () => {
    if (allOn) {
      onPostIds(postIds.filter((id) => !allPosts.includes(id)));
      onChatIds(chatIds.filter((id) => !allChats.includes(id)));
    } else {
      onPostIds([...new Set([...postIds, ...allPosts])].slice(0, maxPosts));
      onChatIds([...new Set([...chatIds, ...allChats])].slice(0, maxChats));
    }
  };
  const toggle = (ids: string[], id: string, max: number, set: (ids: string[]) => void) =>
    set(ids.includes(id) ? ids.filter((x) => x !== id) : ids.length < max ? [...ids, id] : ids);

  const label = loading ? "Loading posts"
    : [postIds.length ? plural(postIds.length, "post") : "", chatIds.length ? plural(chatIds.length, "chat") : ""]
      .filter(Boolean).join(" + ") || "Nothing selected";
  const limits = [Number.isFinite(maxPosts) ? `${maxPosts} posts` : "", chats.length ? `${maxChats} chats` : ""].filter(Boolean);
  return (
    <MenuPanel label={label} ariaLabel="Choose posts and chats" disabled={loading || (!docs?.length && chats.length === 0)}>
      <div className="picker">
        <div className="picker-bar">
          <input className="input input-sm" placeholder={chats.length ? "Search posts and chats" : "Search posts"} value={q}
                 onChange={(e) => setQ(e.target.value)} aria-label="Search posts and chats" />
          <div className="picker-actions mono muted">
            <label className="picker-all">
              <input type="checkbox" checked={allOn} disabled={allPosts.length + allChats.length === 0} onChange={selectAll} />
              Select All
            </label>
          </div>
        </div>
        <ul className="picker-list">
          {posts.map((d) => {
            const on = postIds.includes(d.id);
            return (
              <li key={`p:${d.id}`}>
                <label className={`picker-row${on ? " on" : ""}${d.locked ? " locked" : ""}`}>
                  <input type="checkbox" checked={on} disabled={d.locked || (!on && postIds.length >= maxPosts)}
                         onChange={() => toggle(postIds, d.id, maxPosts, onPostIds)} />
                  <span className="picker-title"><span className="picker-tag">Post</span>{d.title}</span>
                  <span className="mono muted picker-meta">
                    {formatDate(d.published_at)} · {d.locked ? "Not indexed on your plan" : `${d.words} words`}
                  </span>
                </label>
              </li>
            );
          })}
          {chatRows.map((c) => {
            const on = chatIds.includes(c.id);
            return (
              <li key={`c:${c.id}`}>
                <label className={`picker-row${on ? " on" : ""}`}>
                  <input type="checkbox" checked={on} disabled={!on && chatIds.length >= maxChats}
                         onChange={() => toggle(chatIds, c.id, maxChats, onChatIds)} />
                  <span className="picker-title"><span className="picker-tag">Chat</span>{chatTitle(c)}</span>
                </label>
              </li>
            );
          })}
          {posts.length + chatRows.length === 0 && <li className="muted">Nothing matches.</li>}
        </ul>
      </div>
      {limits.length > 0 && <p className="muted small sp-note">Up to {limits.join(" and ")}. They are combined into one.</p>}
    </MenuPanel>
  );
}
