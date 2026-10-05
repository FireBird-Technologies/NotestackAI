import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { Doc, NotebookSummary, WorkspaceChat } from "../../api/types";
import { DocPicker } from "../DocPicker";
import { Dropdown } from "../Dropdown";
import { formatDate, Loading } from "../ui";
import { freshlySeeded, loadChats, loadDocs, loadNotebooks, sourceCache } from "./sourceCache";

/** What a video is made from: a notebook's ticked posts (combined into one video), one post, or ticked notebook chats
 * (combined too; the ticks are held next to the source, like a notebook's posts). */
export type VideoSource = { kind: "notebook"; id: string } | { kind: "post"; id: string } | { kind: "chats" };

const ONE_POST = "__post";
const CHATS = "__chats";
/** Most posts one video can combine. */
export const MAX_VIDEO_POSTS = 5;

/** Step 1's source: a notebook (its first MAX_VIDEO_POSTS indexed posts ticked, retick to change) or a single post. */
export function SourcePicker({
  source,
  onSource,
  postIds,
  onPostIds,
  chatIds,
  onChatIds,
}: {
  source: VideoSource | null;
  onSource: (s: VideoSource | null) => void;
  postIds: string[];
  onPostIds: (ids: string[]) => void;
  chatIds: string[];
  onChatIds: (ids: string[]) => void;
}) {
  const [notebooks, setNotebooks] = useState<NotebookSummary[] | null>(sourceCache.notebooks);
  const [chats, setChats] = useState<WorkspaceChat[] | null>(sourceCache.chats);
  const [docs, setDocs] = useState<Doc[] | null>(null);
  const ticks = useRef(postIds);
  ticks.current = postIds;
  // "Create a video on a single post" picked in the menu: the archive is listed, and stays listed once a post is
  // chosen (its radio ticked), so another can be picked from the same list.
  const [choosing, setChoosing] = useState(false);

  useEffect(() => {
    loadNotebooks().then(setNotebooks).catch(() => setNotebooks((n) => n ?? []));
    loadChats().then(setChats).catch(() => setChats((c) => c ?? []));
  }, []);

  const notebookId = source?.kind === "notebook" ? source.id : null;
  const postId = source?.kind === "post" ? source.id : null;
  const onChats = source?.kind === "chats";

  useEffect(() => {
    if (!notebookId) return;
    let live = true;
    const tickable = (list: Doc[]) => list.filter((d) => !d.locked).map((d) => d.id);
    const firstFew = (list: Doc[]) => tickable(list).slice(0, MAX_VIDEO_POSTS);
    // A cached list shows at once, the first few posts ticked; the refresh below then only updates it.
    const cached = sourceCache.docs.get(notebookId);
    setDocs(cached ?? null);
    if (cached) onPostIds(firstFew(cached));
    // Just handed over by the page that holds them (the notebook page): already current, no need to load them again.
    if (cached && freshlySeeded(notebookId)) return;
    loadDocs(notebookId).then((fresh) => {
      if (!live) return;
      setDocs(fresh);
      if (!cached) return onPostIds(firstFew(fresh)); // the first few in by default
      // Keep the user's ticks through the refresh: drop posts that are gone, tick new ones while there is room.
      const now = new Set(tickable(fresh));
      const before = new Set(cached.map((d) => d.id));
      onPostIds([...ticks.current.filter((id) => now.has(id)), ...[...now].filter((id) => !before.has(id))]
        .slice(0, MAX_VIDEO_POSTS));
    }).catch(() => undefined);
    return () => {
      live = false;
    };
  }, [notebookId, onPostIds]);

  const ticked = docs ? postIds.length : 0;
  const pickable = docs?.filter((d) => !d.locked).length ?? 0;

  return (
    <>
      <div className="field">
        <span className="vw-label">Made from</span>
        <Dropdown
          label="Made from"
          value={choosing || postId ? ONE_POST : onChats ? CHATS : notebookId ?? ONE_POST}
          onChange={(v) => {
            if (v === ONE_POST) {
              setChoosing(true);
              onSource(null);
            } else if (v === CHATS) {
              setChoosing(false);
              onChatIds([]); // none ticked to start with
              onSource({ kind: "chats" });
            } else {
              setChoosing(false);
              onSource({ kind: "notebook", id: v });
            }
          }}
          options={[
            // The API lists the "All posts" notebook first, so the sections come out in order.
            ...(notebooks ?? []).map((n) => ({ value: n.id, label: n.is_archive ? "My whole archive" : n.title,
                                               hint: `${n.document_count} posts`, group: n.is_archive ? "Archive" : "Notebooks" })),
            ...(chats?.length ? [{ value: CHATS, label: "Chats", hint: `${chats.length} chat${chats.length === 1 ? "" : "s"}`,
                                   group: "Chats" }] : []),
            { value: ONE_POST, label: "Create a video on a single post", group: "Single post" },
          ]}
        />
        <small className="muted vw-hint">
          {onChats
            ? "The video explains what the ticked chats are about."
            : "Choose a notebook, individual posts, a chat or your whole archive."}
        </small>
      </div>

      {onChats && (
        <div className="field">
          <span className="vw-label">Chats</span>
          <ChatPicker chats={chats} selected={chatIds} onChange={onChatIds} />
          {chats && chats.length > 0 && (
            <small className="muted vw-hint">
              {chatIds.length === 0
                ? "Tick at least one chat."
                : `You can select up to ${Math.min(MAX_VIDEO_POSTS, chats.length)} (${chatIds.length} selected). They are combined into one video.`}
            </small>
          )}
        </div>
      )}

      {(choosing || postId) && (
        <DocPicker selected={postId ? [postId] : []} onChange={(ids) => onSource({ kind: "post", id: ids[0] })} single />
      )}

      {notebookId && !choosing && (
        !docs ? (
          // Same shape as the loaded list, so the form does not jump when the posts arrive.
          <div className="field">
            <span className="vw-label">Posts</span>
            <div className="picker">
              <div className="picker-bar">
                <input className="input input-sm" placeholder="Search posts" disabled aria-label="Search posts" />
                <div className="picker-actions mono muted"><span>Loading</span></div>
              </div>
              <div className="picker-list vw-posts-wait"><Loading label="Loading posts" /></div>
            </div>
            <small className="muted">&nbsp;</small>
          </div>
        ) : docs.length === 0 ? (
          <p className="muted">
            This notebook has no posts yet. <Link to="/app/sources">Connect a source</Link> or pick another notebook.
          </p>
        ) : (
          <div className="field">
            <span className="vw-label">Posts</span>
            <DocPicker docs={docs} selected={postIds} onChange={onPostIds} max={MAX_VIDEO_POSTS} count={false} />
            <small className="muted vw-hint">
              {ticked === 0
                ? "Tick at least one post."
                : `You can select up to ${Math.min(MAX_VIDEO_POSTS, pickable)} (${ticked} selected). They are combined into one video.`}
            </small>
          </div>
        )
      )}
    </>
  );
}

/** Searchable checklist of the workspace's chats (title, notebook, date), up to MAX_VIDEO_POSTS ticked. The posts
 * list's look (DocPicker), so both sources read the same. */
function ChatPicker({ chats, selected, onChange }: {
  chats: WorkspaceChat[] | null;
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  const [q, setQ] = useState("");
  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (chats ?? []).filter((c) => !needle || (c.title ?? "").toLowerCase().includes(needle)
      || c.notebook_title.toLowerCase().includes(needle));
  }, [chats, q]);

  if (!chats) {
    return (
      <div className="picker">
        <div className="picker-bar">
          <input className="input input-sm" placeholder="Search chats" disabled aria-label="Search chats" />
        </div>
        <div className="picker-list vw-posts-wait"><Loading label="Loading chats" /></div>
      </div>
    );
  }
  if (chats.length === 0) return <p className="muted">No chats yet. Ask something in a notebook first.</p>;

  const full = selected.length >= MAX_VIDEO_POSTS;
  const toggle = (id: string) => {
    if (selected.includes(id)) return onChange(selected.filter((x) => x !== id));
    if (!full) onChange([...selected, id]);
  };

  return (
    <div className="picker">
      <div className="picker-bar">
        <input className="input input-sm" placeholder="Search chats" value={q} onChange={(e) => setQ(e.target.value)}
               aria-label="Search chats" />
      </div>
      <ul className="picker-list">
        {visible.map((c) => {
          const on = selected.includes(c.id);
          return (
            <li key={c.id}>
              <label className={`picker-row${on ? " on" : ""}`}>
                <input type="checkbox" checked={on} disabled={!on && full} onChange={() => toggle(c.id)} />
                <span className="picker-title">{c.title || "Untitled chat"}</span>
                <span className="mono muted picker-meta">
                  {c.notebook_title}{c.updated_at ? ` · ${formatDate(c.updated_at)}` : ""}
                </span>
              </label>
            </li>
          );
        })}
        {visible.length === 0 && <li className="muted">No chats match.</li>}
      </ul>
    </div>
  );
}
