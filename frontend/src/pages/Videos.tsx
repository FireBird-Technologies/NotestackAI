import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { videosApi } from "@notestack/shared/endpoints";
import type { VideoListItem, VideoQuota } from "@notestack/shared/types";
import { TrashIcon } from "../components/icons/Icons";
import { EmptyState, errorMessage, formatDate, Loading, Modal, Pager } from "../components/ui";
import { useUpgrade } from "../hooks/useUpgrade";
import { PostButton } from "../components/launchpad/PostButton";
import { BUSY, shortUrl, statusOf } from "@notestack/shared/video";

const PAGE = 10;

export default function Videos() {
  const [videos, setVideos] = useState<VideoListItem[] | null>(null);
  const [quota, setQuota] = useState<VideoQuota | null>(null);
  // The video in the delete modal, and that delete's progress and error.
  const [deleting, setDeleting] = useState<VideoListItem | null>(null);
  const [busy, setBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { openUpgrade, status } = useUpgrade();
  const notice = (useLocation().state as { notice?: string } | null)?.notice;
  // A page of 10 at a time, from the server.
  const [page, setPage] = useState(0);
  const [total, setTotal] = useState(0);
  const pageRef = useRef(page);
  pageRef.current = page;
  const loadPage = useCallback((at: number) =>
    videosApi.list({ limit: PAGE, offset: at * PAGE }).then((p) => {
      if (pageRef.current !== at) return; // another page was asked for meanwhile
      setTotal(p.total);
      // A page emptied by deletes (the last one): the one before it.
      if (!p.items.length && at > 0) setPage(at - 1);
      else setVideos(p.items);
    }), []);

  useEffect(() => {
    loadPage(page).catch((e) => setError(errorMessage(e)));
  }, [page, loadPage]);

  useEffect(() => {
    videosApi.quota().then(setQuota).catch(() => undefined);
  }, []);

  // Another page: the loader until its videos arrive, never the last page's meanwhile.
  const goTo = (p: number) => {
    setVideos(null);
    setPage(p);
  };

  // While a video is still being made (or rendering, or in an edit job), ask again now and then: the list checks those
  // with blog2video, so one that finishes, or fails and is refunded, updates here without a reload.
  const anyBusy = (videos ?? []).some((v) => BUSY.has(v.status));
  useEffect(() => {
    if (!anyBusy) return;
    const t = setInterval(() => {
      if (document.hidden) return;
      loadPage(pageRef.current).catch(() => undefined);
      videosApi.quota().then(setQuota).catch(() => undefined);
    }, 15000);
    return () => clearInterval(t);
  }, [anyBusy]);

  function askDelete(v: VideoListItem) {
    setDeleteError(null);
    setDeleting(v);
  }

  /** Stays open (and loading) until the delete finishes; a failure shows in the modal so it can be retried. */
  async function confirmDelete() {
    if (!deleting) return;
    const id = deleting.id;
    setBusy(true);
    setDeleteError(null);
    try {
      await videosApi.remove(id);
      setVideos((v) => (v ?? []).filter((x) => x.id !== id));
      setTotal((t) => t - 1);
      setDeleting(null);
      void loadPage(page).catch(() => undefined); // the next video moves up, so the page stays full
    } catch (e) {
      setDeleteError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const out = !!quota && quota.used >= quota.limit;

  return (
    // The Library's Videos tab: the allowance on the left, New video on the right, then the list.
    <div className="stack">
      <div className="row between wrap lib-tab-head">
        <p className="mono muted">
          {quota && <>
            {quota.used} of {quota.limit} video{quota.limit === 1 ? "" : "s"} used
            {quota.resets_at ? ` this period, refills ${formatDate(quota.resets_at)}` : " on your plan"}
          </>}
        </p>
        {out && status?.can_upgrade ? (
          <button className="btn btn-primary" onClick={() => openUpgrade()}>Get more videos</button>
        ) : (
          <Link to="/app/videos/new" className="btn btn-primary">New video</Link>
        )}
      </div>
      {notice && <p className="notice">{notice}</p>}
      {error && <p className="error-text">{error}</p>}
      {!videos && !error && <div className="loading-center"><Loading label="Loading videos" /></div>}
      {videos?.length === 0 && (
        <EmptyState
          title="No videos yet"
          body="Turn a post or any article link into a narrated video, then edit it scene by scene."
          action={<Link to="/app/videos/new" className="btn btn-primary">Make your first video</Link>}
        />
      )}
      {videos && videos.length > 0 && (
        <ul className="vw-list">
          {videos.map((v) => {
            const st = statusOf(v);
            const source = shortUrl(v.source_url);
            return (
              <li key={v.id} className="vw-list-row">
                <Link to={`/app/videos/${v.id}`} className="vw-list-main">
                  <span className="vw-list-title">
                    <strong>{v.title}</strong>
                    <span className={`vw-dot ${st.tone}`} aria-hidden="true" />
                    <span className="muted">{st.label}</span>
                  </span>
                  <span className="vw-list-meta muted">
                    {source && <span>{source}</span>}
                    {v.scenes ? <span>{v.scenes} scene{v.scenes === 1 ? "" : "s"}</span> : null}
                    {v.created_at && <span>{formatDate(v.created_at)}</span>}
                  </span>
                </Link>
                {st.tone === "done" && <PostButton artifactId={v.id} />}
                <button type="button" className="icon-btn vw-list-delete" aria-label={`Delete ${v.title}`} title="Delete"
                        onClick={() => askDelete(v)}>
                  <TrashIcon size={18} />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <Pager page={page} pages={Math.ceil(total / PAGE)} onChange={goTo} />

      {deleting && (
        // While the delete runs, Escape, the backdrop and the close button do nothing.
        <Modal title="Delete this video?" onClose={busy ? () => undefined : () => setDeleting(null)}>
          <div className="stack">
            <p>"<strong>{deleting.title}</strong>" will be deleted permanently. This can't be undone.</p>
            {deleteError && <p className="error-text">{deleteError}</p>}
            <div className="vw-nav">
              <button className="btn" onClick={() => setDeleting(null)} disabled={busy}>Cancel</button>
              <button className="btn btn-danger vw-delete-confirm" onClick={confirmDelete} disabled={busy}>
                {busy ? "Deleting..." : "Delete video"}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
