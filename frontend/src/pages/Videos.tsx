import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { videosApi } from "../api/endpoints";
import type { VideoListItem, VideoQuota } from "../api/types";
import { TrashIcon } from "../components/icons/Icons";
import { EmptyState, errorMessage, formatDate, Loading, Modal, PageHeader } from "../components/ui";
import { useUpgrade } from "../hooks/useUpgrade";

const JOB_LABELS: Record<string, string> = {
  regenerating: "Changing template",
  voice_regenerating: "Changing voice",
  language_regenerating: "Translating",
  script_regenerating: "Refreshing script",
};

/** blog2video's status, as a label and a dot color. */
function statusOf(v: VideoListItem): { label: string; tone: "done" | "ready" | "busy" | "review" | "failed" } {
  const raw = v.b2v_status ?? "";
  if (v.status === "failed" || raw === "failed" || raw === "error") return { label: "Failed", tone: "failed" };
  // An edit job on a finished video (blog2video's status, kept on the artifact too). Before "Complete": a video
  // rendered earlier keeps its MP4 link while it is being changed.
  const job = JOB_LABELS[raw] ?? JOB_LABELS[v.status];
  if (job) return { label: job, tone: "busy" };
  if (raw === "done" || v.url) return { label: "Complete", tone: "done" };
  if (raw === "generated" || v.status === "ready") return { label: "Generated", tone: "ready" };
  if (raw === "awaiting_script_review") return { label: "Review script", tone: "review" };
  if (raw === "awaiting_stock_footage_review") return { label: "Review footage", tone: "review" };
  if (raw === "rendering" || v.status === "rendering") return { label: "Rendering", tone: "busy" };
  return { label: "Generating", tone: "busy" };
}

function shortUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const s = url.replace(/^https?:\/\//, "");
  return s.length > 34 ? `${s.slice(0, 34)}…` : s;
}

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

  useEffect(() => {
    videosApi.list().then(setVideos).catch((e) => setError(errorMessage(e)));
    videosApi.quota().then(setQuota).catch(() => undefined);
  }, []);

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
      setDeleting(null);
    } catch (e) {
      setDeleteError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const out = !!quota && quota.used >= quota.limit;

  return (
    <div className="page-wrap">
      <PageHeader eyebrow="Videos" title="Your videos">
        {out && status?.can_upgrade ? (
          <button className="btn btn-primary" onClick={() => openUpgrade()}>Get more videos</button>
        ) : (
          <Link to="/app/videos/new" className="btn btn-primary">New video</Link>
        )}
      </PageHeader>

      {quota && (
        <p className="mono muted">
          {quota.used} of {quota.limit} video{quota.limit === 1 ? "" : "s"} used
          {quota.resets_at ? ` this period, refills ${formatDate(quota.resets_at)}` : " on your plan"}
        </p>
      )}
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
                <button type="button" className="icon-btn vw-list-delete" aria-label={`Delete ${v.title}`} title="Delete"
                        onClick={() => askDelete(v)}>
                  <TrashIcon size={18} />
                </button>
              </li>
            );
          })}
        </ul>
      )}

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
