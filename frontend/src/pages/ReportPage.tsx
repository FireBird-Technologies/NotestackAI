import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { artifactsApi, notebooksApi, reportsApi } from "../api/endpoints";
import type { Artifact, Citation, ReportSuggestion } from "../api/types";
import { ReportAddDialog } from "../components/ReportAddDialog";
import { ShareDialog } from "../components/ShareDialog";
import { Reader } from "../components/Reader";
import { reportMarkdown, ReportView } from "../components/ReportView";
import { ConfirmButton, errorMessage, JobProgress, Loading } from "../components/ui";
import { useJob } from "../hooks/useJob";

/** One report, full page: /app/reports/:id. */
export default function ReportPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const [artifact, setArtifact] = useState<Artifact | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState<{ suggestion: ReportSuggestion; existing: Artifact[]; loading: boolean } | null>(null);
  const [sharing, setSharing] = useState(false);
  const [addBusy, setAddBusy] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [reading, setReading] = useState<{ id: string; start: number; end: number } | null>(null);

  const load = useCallback(() => artifactsApi.get(id).then(setArtifact, () => setError("Report not found.")), [id]);
  useEffect(() => {
    void load();
  }, [load]);
  const [addingId, setAddingId] = useState<string | null>(null); // the suggestion being built (its card shows a loader)
  const job = useJob(artifact?.job, () => {
    void load();
    setAddingId(null);
  });

  // If the live updates drop, the loader still ends once the job's own state is final.
  useEffect(() => {
    if (addingId && job && job.id === artifact?.job?.id && (job.status === "done" || job.status === "failed")) {
      setAddingId(null);
      void load();
    }
  }, [job, addingId, artifact?.job?.id, load]);

  // An infographic added to the report is drawn after the report page shows it: look again until it is ready.
  const drawing = (artifact?.content.blocks ?? []).some((b: { type: string; status?: string }) =>
    b.type === "infographic" && ["pending", "generating", "rendering"].includes(b.status ?? ""));
  useEffect(() => {
    if (!drawing) return;
    const t = setTimeout(() => void load(), 2500);
    return () => clearTimeout(t);
  }, [drawing, artifact, load]);

  if (error) return <p className="error-text">{error}</p>;
  if (!artifact) return <Loading label="Opening report" />;
  const running = job && (job.status === "queued" || job.status === "running");
  const blockFailed = job?.kind === "report_block" && job.status === "failed" ? job.error : null;
  const back = artifact.notebook_id ? `/app/notebooks/${artifact.notebook_id}` : "/app/archive";

  const download = () => {
    const url = URL.createObjectURL(new Blob([reportMarkdown(artifact.content)], { type: "text/markdown" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${artifact.title.slice(0, 60)}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };
  const startAdd = async (s: ReportSuggestion) => {
    setAddError(null);
    setAdding({ suggestion: s, existing: [], loading: true });
    // The ones already made from this notebook (or, for a report with no notebook, anywhere), to offer as an alternative
    // to making a new one.
    const all = artifact.notebook_id
      ? await notebooksApi.artifacts(artifact.notebook_id).catch(() => [] as Artifact[])
      : await artifactsApi.list({ type: s.kind, status: "ready", limit: 50 }).then((p) => p.items).catch(() => [] as Artifact[]);
    setAdding((cur) => cur && cur.suggestion.id === s.id
      ? { ...cur, loading: false, existing: all.filter((a) => a.type === s.kind && a.status === "ready") } : cur);
  };
  const add = async (existingId: string | null, theme?: string) => {
    if (!adding) return;
    setAddBusy(true);
    setAddError(null);
    try {
      setArtifact(await reportsApi.addBlock(artifact.id, {
        kind: adding.suggestion.kind, after_block_id: adding.suggestion.after_block_id, suggestion_id: adding.suggestion.id,
        brief: adding.suggestion.brief, existing_artifact_id: existingId ?? undefined, theme,
      }));
      setAddingId(adding.suggestion.id);
      setAdding(null);
    } catch (e) {
      setAddError(errorMessage(e));
    } finally {
      setAddBusy(false);
    }
  };
  const remove = async (blockId: string) => {
    try {
      setArtifact(await reportsApi.removeBlock(artifact.id, blockId));
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const cite = (c: Citation) => c.document_id && setReading({ id: c.document_id, start: c.line_start, end: c.line_end });

  return (
    <div className="page-wrap rp-page">
      <Link to={back} className="vw-back">Back</Link>
      <header className="rp-head">
        <p className="eyebrow">{artifact.content.format === "interactive" ? "Interactive report" : "Report"}</p>
        <h1>{artifact.title}</h1>
        {artifact.status === "ready" && (
          <div className="row">
            <button type="button" className="btn btn-small btn-primary" onClick={() => setSharing(true)}>Share</button>
            <button type="button" className="btn btn-small" onClick={download}>Download Markdown</button>
            <ConfirmButton onConfirm={async () => {
              try {
                await artifactsApi.remove(artifact.id);
                navigate(back);
              } catch (e) {
                setError(errorMessage(e));
              }
            }}>Delete</ConfirmButton>
          </div>
        )}
      </header>
      {running && job && <JobProgress job={job} />}
      {artifact.status === "failed" && <p className="error-text">{(artifact.content.error as string | undefined) ?? job?.error ?? "The report could not be made."}</p>}
      {blockFailed && <p className="error-text">{blockFailed}</p>}
      {artifact.status === "ready" && (
        <ReportView content={artifact.content} artifactId={artifact.id} onCite={cite}
                    editor={{ onAdd: startAdd, onRemove: remove, busy: !!running || !!addingId, adding: addingId, addingMessage: job?.message }} />
      )}
      {sharing && <ShareDialog artifactId={artifact.id} onClose={() => setSharing(false)} />}
      {adding && <ReportAddDialog suggestion={adding.suggestion} existing={adding.existing} loading={adding.loading} busy={addBusy} error={addError}
                                  onClose={() => setAdding(null)} onAdd={add} />}
      {reading && <Reader documentId={reading.id} highlight={{ start: reading.start, end: reading.end }} onClose={() => setReading(null)} />}
    </div>
  );
}
