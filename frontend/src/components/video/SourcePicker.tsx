import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { docsApi } from "../../api/endpoints";
import type { Doc, NotebookSummary } from "../../api/types";
import { DocPicker } from "../DocPicker";
import { Dropdown } from "../Dropdown";
import { formatDate, Loading } from "../ui";
import { loadDocs, loadNotebooks, sourceCache } from "./sourceCache";

/** What a video is made from: a notebook's ticked posts (combined into one video), or one post. */
export type VideoSource = { kind: "notebook"; id: string } | { kind: "post"; id: string };

const ONE_POST = "__post";

/** Step 1's source: a notebook (every indexed post ticked, untick to leave out) or a single post. */
export function SourcePicker({
  source,
  onSource,
  postIds,
  onPostIds,
}: {
  source: VideoSource | null;
  onSource: (s: VideoSource | null) => void;
  postIds: string[];
  onPostIds: (ids: string[]) => void;
}) {
  const [notebooks, setNotebooks] = useState<NotebookSummary[] | null>(sourceCache.notebooks);
  const [docs, setDocs] = useState<Doc[] | null>(null);
  const ticks = useRef(postIds);
  ticks.current = postIds;
  const [post, setPost] = useState<Doc | null>(null);
  // "One post..." picked in the select: the archive is listed until a post is chosen.
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
    // A cached list shows at once, every post ticked; the refresh below then only updates it.
    const cached = sourceCache.docs.get(notebookId);
    setDocs(cached ?? null);
    if (cached) onPostIds(tickable(cached));
    loadDocs(notebookId).then((fresh) => {
      if (!live) return;
      setDocs(fresh);
      if (!cached) return onPostIds(tickable(fresh)); // all in by default
      // Keep the user's ticks through the refresh: drop posts that are gone, tick ones that are new.
      const now = new Set(tickable(fresh));
      const before = new Set(cached.map((d) => d.id));
      onPostIds([...ticks.current.filter((id) => now.has(id)), ...[...now].filter((id) => !before.has(id))]);
    }).catch(() => undefined);
    return () => {
      live = false;
    };
  }, [notebookId, onPostIds]);

  useEffect(() => {
    if (postId) docsApi.get(postId).then(setPost).catch(() => setPost(null));
  }, [postId]);

  if (postId && !choosing) {
    return (
      <div className="field">
        <span className="vw-label">Post</span>
        <div className="vw-source-post">
          <div>
            <strong>{post?.title ?? "Loading..."}</strong>
            {post && (
              <span className="mono muted small">
                {formatDate(post.published_at)} · {post.words} words
              </span>
            )}
          </div>
          <button type="button" className="btn btn-small" onClick={() => setChoosing(true)}>
            Change
          </button>
        </div>
      </div>
    );
  }

  const ticked = docs ? postIds.length : 0;
  const pickable = docs?.filter((d) => !d.locked).length ?? 0;

  return (
    <>
      <div className="field">
        <span className="vw-label">Made from</span>
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
            { value: ONE_POST, label: "Create a video on a single post", group: "Single post" },
          ]}
        />
      </div>

      {choosing && (
        <DocPicker
          selected={postId ? [postId] : []}
          onChange={(ids) => {
            setChoosing(false);
            onSource({ kind: "post", id: ids[0] });
          }}
          single
        />
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
            <DocPicker docs={docs} selected={postIds} onChange={onPostIds} count={false} />
            <small className="muted vw-hint">
              {ticked === 0
                ? "Tick at least one post."
                : `${ticked} of ${pickable} post${pickable === 1 ? "" : "s"} ticked. They are combined into one video.`}
            </small>
          </div>
        )
      )}
    </>
  );
}
