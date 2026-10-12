import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { ChatSummary, Doc, NotebookSummary } from "../../api/types";
import { DocPicker } from "../DocPicker";
import { Dropdown } from "../Dropdown";
import { Loading } from "../ui";
import { ChatsMenu, PostsMenu } from "./PostsMenu";
import { freshlySeeded, loadDocs, loadNotebooks, sourceCache } from "./sourceCache";

/** What a video is made from: a notebook's (or the whole archive's) ticked posts, combined into one video, or one
 * post. */
export type VideoSource = { kind: "notebook"; id: string } | { kind: "post"; id: string };

const ONE_POST = "__post";
/** Most posts one video can combine. */
export const MAX_VIDEO_POSTS = 5;

/** Step 1's source: a notebook (its first MAX_VIDEO_POSTS indexed posts ticked, retick to change) or a single post. */
export function SourcePicker({
  source,
  onSource,
  postIds,
  onPostIds,
  max = MAX_VIDEO_POSTS,
  what = "video",
  compact = false,
  notebookTitle,
  chats,
  chatIds = [],
  onChatIds,
  autoSelect = true,
  autoCount,
}: {
  source: VideoSource | null;
  onSource: (s: VideoSource | null) => void;
  postIds: string[];
  onPostIds: (ids: string[]) => void;
  /** Most posts that can be ticked. */
  max?: number;
  /** What is being made, for the wording ("video", "quiz"). */
  what?: string;
  /** Under a heading that already says "made from": no repeated labels or hints. */
  compact?: boolean;
  /** With compact: the name of the fixed notebook. */
  notebookTitle?: string;
  /** With compact: the notebook's chats, to pick from beside the posts (posts and chats can be combined). */
  chats?: ChatSummary[];
  chatIds?: string[];
  onChatIds?: (ids: string[]) => void;
  /** Tick the first posts when the list loads. Off when the dialog was opened from a chat. */
  autoSelect?: boolean;
  /** How many posts to tick to start with (default: as many as can be ticked). */
  autoCount?: number;
}) {
  const [notebooks, setNotebooks] = useState<NotebookSummary[] | null>(sourceCache.notebooks);
  const [docs, setDocs] = useState<Doc[] | null>(null);
  const ticks = useRef(postIds);
  ticks.current = postIds;
  // "Create a video on a single post" picked in the menu: the archive is listed, and stays listed once a post is
  // chosen (its radio ticked), so another can be picked from the same list.
  const [choosing, setChoosing] = useState(false);

  useEffect(() => {
    loadNotebooks().then(setNotebooks).catch(() => setNotebooks((n) => n ?? []));
  }, []);

  const notebookId = source?.kind === "notebook" ? source.id : null;
  const postId = source?.kind === "post" ? source.id : null;

  useEffect(() => {
    if (!notebookId) return;
    let live = true;
    const tickable = (list: Doc[]) => list.filter((d) => !d.locked).map((d) => d.id);
    const firstFew = (list: Doc[]) => tickable(list).slice(0, Math.min(autoCount ?? max, max));
    // A cached list shows at once, the first few posts ticked; the refresh below then only updates it.
    const cached = sourceCache.docs.get(notebookId);
    setDocs(cached ?? null);
    if (cached && autoSelect) onPostIds(firstFew(cached));
    // Just handed over by the page that holds them (the notebook page): already current, no need to load them again.
    if (cached && freshlySeeded(notebookId)) return;
    loadDocs(notebookId).then((fresh) => {
      if (!live) return;
      setDocs(fresh);
      if (!cached) return autoSelect ? onPostIds(firstFew(fresh)) : undefined; // the first few in by default
      // Keep the user's ticks through the refresh: drop posts that are gone, tick new ones while there is room.
      const now = new Set(tickable(fresh));
      const before = new Set(cached.map((d) => d.id));
      onPostIds([...ticks.current.filter((id) => now.has(id)), ...[...now].filter((id) => !before.has(id))]
        .slice(0, max));
    }).catch(() => undefined);
    return () => {
      live = false;
    };
  }, [notebookId, onPostIds, max, autoSelect, autoCount]);

  const ticked = docs ? postIds.length : 0;
  const pickable = docs?.filter((d) => !d.locked).length ?? 0;

  // Compact (the quiz, flashcard and report dialogs): the notebook the dialog was opened from, shown and fixed, and one
  // dropdown to pick its posts from. No notebook choice and no list.
  if (compact) {
    return (
      <div className="sp-fixed">
        <div className="sp-notebook" title="What this is made from">
          <strong>{notebookTitle || "This notebook"}</strong>
          {(docs || chatIds.length > 0) && (
            <span className="muted">
              {[docs && postIds.length ? `${postIds.length} post${postIds.length === 1 ? "" : "s"}` : "",
                chatIds.length ? `${chatIds.length} chat${chatIds.length === 1 ? "" : "s"}` : ""].filter(Boolean).join(" + ")
                || (docs ? `${docs.length} post${docs.length === 1 ? "" : "s"}` : "")}
            </span>
          )}
        </div>
        <div className="sp-menus">
          {chats && onChatIds && <ChatsMenu chats={chats} selected={chatIds} onChange={onChatIds} max={5} />}
          {notebookId && docs && docs.length === 0 ? (
            <p className="muted small">
              No posts yet. <Link to="/app/sources">Connect a source</Link>
            </p>
          ) : notebookId ? (
            <PostsMenu docs={docs} loading={!docs} selected={postIds} onChange={onPostIds} max={max} />
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="field">
        {!compact && <span className="vw-label">Made from</span>}
        <Dropdown
          label="Made from"
          value={choosing || postId ? ONE_POST : notebookId ?? ONE_POST}
          onChange={(v) => {
            if (v === ONE_POST) {
              setChoosing(true);
              onSource(null);
            } else {
              setChoosing(false);
              onSource({ kind: "notebook", id: v });
            }
          }}
          options={[
            // The API lists the "All posts" notebook first, so the sections come out in order.
            ...(notebooks ?? []).map((n) => ({ value: n.id, label: n.is_archive ? "My whole archive" : n.title,
                                               hint: `${n.document_count} posts`, group: n.is_archive ? "Archive" : "Notebooks" })),
            { value: ONE_POST, label: `Create a ${what} on a single post`, group: "Single post" },
          ]}
        />
        {!compact && <small className="muted vw-hint">Choose a notebook, your whole archive or a single post.</small>}
      </div>

      {(choosing || postId) && (
        <DocPicker selected={postId ? [postId] : []} onChange={(ids) => onSource({ kind: "post", id: ids[0] })} single />
      )}

      {notebookId && !choosing && (
        !docs ? (
          // Same shape as the loaded list, so the form does not jump when the posts arrive.
          <div className="field">
            {!compact && <span className="vw-label">Posts</span>}
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
            {!compact && <span className="vw-label">Posts</span>}
            <DocPicker docs={docs} selected={postIds} onChange={onPostIds} max={max} count={false} />
            <small className="muted vw-hint">
              {ticked === 0
                ? "Tick at least one post."
                : `You can select up to ${Math.min(max, pickable)} (${ticked} selected). They are combined into one ${what}.`}
            </small>
          </div>
        )
      )}
    </>
  );
}
