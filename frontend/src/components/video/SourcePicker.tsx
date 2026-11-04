import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { ChatSummary, Doc, NotebookSummary } from "@notestack/shared/types";
import { DocPicker } from "../DocPicker";
import { Dropdown } from "../Dropdown";
import { SourcesMenu } from "./PostsMenu";
import { freshlySeeded, loadDocs, loadNotebooks, sourceCache } from "./sourceCache";

/** What a video is made from: a whole notebook (or the whole archive), searched for the video's topic, or one post.
 * The other create dialogs (compact) use a notebook's ticked posts. */
export type VideoSource = { kind: "notebook"; id: string } | { kind: "post"; id: string };

const ONE_POST = "__post";
/** Most posts one video can combine. */
export const MAX_VIDEO_POSTS = 5;

const NO_TICKS: string[] = [];
const ignoreTicks = () => undefined;

/** Step 1's source: a notebook or the archive as a whole (the video wizard), or a single post. Compact (the other create
 * dialogs): the notebook's posts and chats to tick (its first MAX_VIDEO_POSTS indexed posts ticked to start with). */
export function SourcePicker({
  source,
  onSource,
  postIds = NO_TICKS,
  onPostIds = ignoreTicks,
  onPostCount,
  max = MAX_VIDEO_POSTS,
  what = "video",
  compact = false,
  chats,
  chatIds = [],
  onChatIds,
  maxChats = 5,
  autoSelect = true,
  autoCount,
}: {
  source: VideoSource | null;
  onSource: (s: VideoSource | null) => void;
  /** Compact: the ticked posts. */
  postIds?: string[];
  onPostIds?: (ids: string[]) => void;
  /** Not compact: how many posts the chosen notebook has (null until known, or for a single post). */
  onPostCount?: (n: number | null) => void;
  /** Most posts that can be ticked. */
  max?: number;
  /** What is being made, for the wording ("video", "quiz"). */
  what?: string;
  /** Under a heading that already says "made from": no repeated labels or hints. */
  compact?: boolean;
  /** With compact: the notebook's chats, to pick from beside the posts (posts and chats can be combined). */
  chats?: ChatSummary[];
  chatIds?: string[];
  onChatIds?: (ids: string[]) => void;
  /** With compact: most chats that can be ticked. */
  maxChats?: number;
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

  // The wizard's notebook is read whole on the server: only its post count is needed (an empty one cannot make a video).
  const count = notebookId ? notebooks?.find((n) => n.id === notebookId)?.document_count ?? null : null;
  const reportCount = useRef(onPostCount);
  reportCount.current = onPostCount;
  useEffect(() => {
    if (!compact) reportCount.current?.(count);
  }, [count, compact]);

  useEffect(() => {
    if (!notebookId || !compact) return;
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
  }, [notebookId, onPostIds, max, autoSelect, autoCount, compact]);

  // Compact (the quiz, flashcard, report and other create dialogs): the notebook is fixed by where the dialog was opened,
  // so there is no notebook choice, just one dropdown with its posts and chats.
  if (compact) {
    const chatList = chats ?? [];
    return (
      <div className="sp-fixed">
        {notebookId && docs && docs.length === 0 && chatList.length === 0 ? (
          <p className="muted small">
            No posts yet. <Link to="/app/sources">Connect a source</Link>
          </p>
        ) : (
          <SourcesMenu docs={docs} loading={!!notebookId && !docs} postIds={postIds} onPostIds={onPostIds} maxPosts={max}
                       chats={chatList} chatIds={chatIds} onChatIds={onChatIds ?? (() => undefined)} maxChats={maxChats} />
        )}
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
            // The API keeps every notebook in latest-activity order; groups retain that order.
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

      {notebookId && !choosing && count === 0 && (
        <p className="muted">
          This notebook has no posts yet. <Link to="/app/sources">Connect a source</Link> or pick another notebook.
        </p>
      )}
    </>
  );
}
