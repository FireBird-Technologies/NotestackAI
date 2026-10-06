import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { artifactsApi, videosApi } from "../api/endpoints";
import type { Artifact, Citation } from "../api/types";
import { useJob } from "../hooks/useJob";
import { Body } from "./ArtifactCard";
import { TrashIcon } from "./icons/Icons";
import { errorMessage, formatDate, formatDuration, JobProgress } from "./ui";

function statusOf(a: Artifact, running: boolean): { label: string; tone: "done" | "busy" | "failed" } {
  if (a.status === "failed") return { label: "Failed", tone: "failed" };
  if (running || a.status !== "ready") return { label: "Generating", tone: "busy" };
  return { label: "Ready", tone: "done" };
}

/** One generated item as a full-width row (like the Videos list): its type, title, status and date. A video opens its
 * editor; anything else expands in place to its player or image. */
export function ArtifactRow({
  artifact: initial,
  onCite,
  onRemoved,
  onChanged,
  actions,
}: {
  artifact: Artifact;
  onCite?: (c: Citation) => void;
  onRemoved?: (id: string) => void;
  onChanged?: (a: Artifact) => void;
  actions?: (a: Artifact) => ReactNode;
}) {
  const [artifact, setArtifact] = useState(initial);
  const [openRow, setOpenRow] = useState(false);
  const [armed, setArmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const job = useJob(artifact.job, () => {
    artifactsApi.get(artifact.id).then((a) => {
      setArtifact(a);
      onChanged?.(a);
    });
  });
  const running = !!job && (job.status === "queued" || job.status === "running");
  const st = statusOf(artifact, running);
  const isEditorVideo = artifact.provider === "blog2video";

  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(t);
  }, [armed]);

  async function remove() {
    if (!armed) return setArmed(true);
    setArmed(false);
    try {
      // A blog2video video is also removed from blog2video.
      await (isEditorVideo ? videosApi.remove(artifact.id) : artifactsApi.remove(artifact.id));
      onRemoved?.(artifact.id);
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  async function retry() {
    setError(null);
    try {
      setArtifact(await artifactsApi.retry(artifact.id));
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  const main = (
    <>
      <span className="vw-list-title">
        <span className={`type-chip ${artifact.type}`}>{artifact.type_label}</span>
        <strong>{artifact.title}</strong>
        <span className={`vw-dot ${st.tone}`} aria-hidden="true" />
        <span className="muted">{st.label}</span>
      </span>
      <span className="vw-list-meta muted">
        {artifact.created_at && <span>{formatDate(artifact.created_at, true)}</span>}
        {artifact.content.duration_s ? <span>{formatDuration(artifact.content.duration_s)}</span> : null}
        {artifact.content.aspect_ratio && <span>{artifact.content.aspect_ratio === "portrait" ? "Portrait" : "Landscape"}</span>}
      </span>
    </>
  );

  return (
    <li className={`vw-list-row artifact-row${openRow ? " open" : ""}`}>
      <div className="artifact-row-head">
        {isEditorVideo ? (
          <Link to={`/app/videos/${artifact.id}`} className="vw-list-main">{main}</Link>
        ) : (
          <button type="button" className="vw-list-main artifact-row-toggle" aria-expanded={openRow}
                  onClick={() => setOpenRow((o) => !o)}>
            {main}
          </button>
        )}
        {artifact.status === "failed" && (
          <button type="button" className="btn btn-small" onClick={retry}>Retry</button>
        )}
        {onRemoved && (
          <button type="button" className={`icon-btn vw-list-delete${armed ? " armed" : ""}`}
                  aria-label={armed ? "Click again to delete" : `Delete ${artifact.title}`}
                  title={armed ? "Click again to delete" : "Delete"} onClick={remove}>
            {armed ? <span className="small">Delete?</span> : <TrashIcon size={18} />}
          </button>
        )}
      </div>
      {running && job && <JobProgress job={job} compact />}
      {error && <p className="error-text">{error}</p>}
      {openRow && !isEditorVideo && (
        <div className="artifact-row-body">
          {artifact.status === "failed" && artifact.content.error && <p className="error-text">{artifact.content.error}</p>}
          <Body artifact={artifact} onCite={onCite} />
          <div className="artifact-actions">
            {actions?.(artifact)}
            {artifact.download_url && <a className="btn btn-small" href={artifact.download_url}>Download</a>}
          </div>
        </div>
      )}
    </li>
  );
}
