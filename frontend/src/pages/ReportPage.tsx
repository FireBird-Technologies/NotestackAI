import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { artifactsApi, notebooksApi, reportsApi } from "../api/endpoints";
import type { Artifact, Citation, ReportSuggestion } from "../api/types";
import { CardFeedback } from "../components/CardFeedback";
import { ReportAddDialog } from "../components/ReportAddDialog";
import { ShareDialog } from "../components/ShareDialog";
import { Reader } from "../components/Reader";
import { reportMarkdown, ReportView } from "../components/ReportView";
import { ConfirmDeleteModal, errorMessage, JobProgress, Loading } from "../components/ui";
import { useJob } from "../hooks/useJob";
import { ArrowLeftIcon, DownloadIcon, MarkdownIcon, PdfIcon, ShareIcon } from "../components/icons/Icons";
import { FloatingMenu, useMenu } from "../components/SlideDeck";

/** One report, full page: /app/reports/:id. */
export default function ReportPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const [artifact, setArtifact] = useState<Artifact | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState<{ suggestion: ReportSuggestion; existing: Artifact[]; loading: boolean } | null>(null);
  const [sharing, setSharing] = useState(false);
  const [addFailed, setAddFailed] = useState<string | null>(null);
  const [reading, setReading] = useState<{ id: string; start: number; end: number } | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const downloads = useMenu();
  const [savingPdf, setSavingPdf] = useState(false);
  const [pdfError, setPdfError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false); // the "Delete report?" warning is open

  const load = useCallback(() => artifactsApi.get(id).then(setArtifact, () => setError("Report not found.")), [id]);
  useEffect(() => {
    void load();
  }, [load]);
  // Suggestions whose Add was just clicked and that the server has not listed yet (the card shows its loader at once).
  const [pending, setPending] = useState<string[]>([]);
  const job = useJob(artifact?.job, () => void load());

  // Visuals are added one job each and several can run together: while any is queued or running, look again every
  // couple of seconds. A finished one shows up in the report and drops off the list.
  const building = (artifact?.adding ?? []).filter((a) => a.status !== "failed");
  const buildingKey = building.map((a) => a.suggestion_id).join(",");
  useEffect(() => {
    if (!buildingKey) return;
    const t = setTimeout(() => void load(), 2000);
    return () => clearTimeout(t);
  }, [buildingKey, artifact, load]);

  // An infographic added to the report is drawn after the report page shows it: look again until it is ready.
  const drawing = (artifact?.content.blocks ?? []).some((b: { type: string; status?: string }) =>
    b.type === "infographic" && ["pending", "generating", "rendering"].includes(b.status ?? ""));
  useEffect(() => {
    if (!drawing) return;
    const t = setTimeout(() => void load(), 2500);
    return () => clearTimeout(t);
  }, [drawing, artifact, load]);

  if (error) return <p className="error-text">{error}</p>;
  if (!artifact) return <Loading label="Opening report" center="full" />;
  const running = job && (job.status === "queued" || job.status === "running");
  // Each suggestion card that is being built shows its own loader: the ones the server lists, and the ones just clicked.
  const addingNow: Record<string, { message?: string | null }> = Object.fromEntries(pending.map((id) => [id, {}]));
  for (const a of building) addingNow[a.suggestion_id] = { message: a.message };
  const blockFailed = (artifact.adding ?? []).find((a) => a.status === "failed")?.error ?? null;
  const back = artifact.notebook_id ? `/app/notebooks/${artifact.notebook_id}` : "/app/archive";

  const save = (blob: Blob, name: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };
  const downloadMarkdown = () => {
    downloads.setOpen(false);
    save(new Blob([reportMarkdown(artifact.content)], { type: "text/markdown" }), `${artifact.title.slice(0, 60)}.md`);
  };
  /** The report's text as a PDF, printed by the server (its embedded visuals are left out). */
  const downloadPdf = async () => {
    downloads.setOpen(false);
    setSavingPdf(true);
    setPdfError(null);
    try {
      const name = artifact.title.replace(/[^\w\- ]+/g, "").trim().slice(0, 80) || "Report";
      save(await artifactsApi.reportPdf(artifact.id), `${name}.pdf`);
    } catch (e) {
      setPdfError(errorMessage(e, "The PDF could not be made. Try again."));
    } finally {
      setSavingPdf(false);
    }
  };
  const startAdd = async (s: ReportSuggestion) => {
    setAddFailed(null);
    if (!["mind_map", "infographic"].includes(s.kind)) {
      setAdding({ suggestion: s, existing: [], loading: false });
      return;
    }
    setAdding({ suggestion: s, existing: [], loading: true });
    // The ones already made from this notebook (or, for a report with no notebook, anywhere), to offer as an alternative
    // to making a new one.
    const all = artifact.notebook_id
      ? await notebooksApi.artifacts(artifact.notebook_id).catch(() => [] as Artifact[])
      : await artifactsApi.list({ type: s.kind, status: "ready", limit: 50 }).then((p) => p.items).catch(() => [] as Artifact[]);
    setAdding((cur) => cur && cur.suggestion.id === s.id
      ? { ...cur, loading: false, existing: all.filter((a) => a.type === s.kind && a.status === "ready") } : cur);
  };
  // Add closes the dialog at once and the suggestion's own card shows the loader, down in the report where the visual will appear.
  const add = async (existingId: string | null, theme?: string) => {
    if (!adding) return;
    const { suggestion } = adding;
    setAddFailed(null);
    setPending((p) => [...p, suggestion.id]);
    setAdding(null);
    try {
      setArtifact(await reportsApi.addBlock(artifact.id, {
        kind: suggestion.kind, after_block_id: suggestion.after_block_id, suggestion_id: suggestion.id,
        brief: suggestion.brief, existing_artifact_id: existingId ?? undefined, theme,
      }));
    } catch (e) {
      setAddFailed(errorMessage(e));
    } finally {
      setPending((p) => p.filter((id) => id !== suggestion.id)); // the server's own list takes over from here
    }
  };
  const remove = async (blockId: string) => {
    setRemovingId(blockId);
    try {
      setArtifact(await reportsApi.removeBlock(artifact.id, blockId));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setRemovingId(null);
    }
  };

  const cite = (c: Citation) => c.document_id && setReading({ id: c.document_id, start: c.line_start, end: c.line_end });

  return (
    <div className="page-wrap rp-page">
      <Link to={back} className="vw-back"><ArrowLeftIcon size={16} /> Back</Link>
      <header className="rp-head">
        <p className="eyebrow">{artifact.content.format === "interactive" ? "Interactive report" : "Report"}</p>
        <h1>{artifact.title}</h1>
        {artifact.status === "ready" && (
          <div className="row">
            <button type="button" className="btn btn-small" onClick={() => setSharing(true)}><ShareIcon size={16} /> Share</button>
            <div className="sd-menu-wrap" ref={downloads.ref}>
              <button type="button" className="btn btn-small" aria-haspopup="menu" aria-expanded={downloads.open}
                      disabled={savingPdf} onClick={() => downloads.setOpen((o) => !o)}>
                {savingPdf ? <span className="nbv-send-spinner" aria-hidden="true" /> : <DownloadIcon size={16} />}
                {savingPdf ? " Preparing the PDF..." : " Download"}
              </button>
              {downloads.open && (
                <FloatingMenu menu={downloads}>
                  <button type="button" role="menuitem" onClick={downloadMarkdown}><MarkdownIcon size={20} /> Markdown (.md)</button>
                  <button type="button" role="menuitem" onClick={() => void downloadPdf()}><PdfIcon size={20} /> PDF document (.pdf)</button>
                </FloatingMenu>
              )}
              {pdfError && <span className="sd-menu-error error-text small" role="alert">{pdfError}</span>}
            </div>
            {/* A thumb opens the review in a popup (the same as on the notebook's cards) */}
            <span className="rp-rate">
              <span className="muted small">How is this report?</span>
              <CardFeedback artifact={artifact} />
            </span>
            <button type="button" className="btn btn-small btn-danger" onClick={() => setDeleting(true)}>Delete</button>
            {deleting && (
              <ConfirmDeleteModal heading="Delete report?" name={artifact.title} onCancel={() => setDeleting(false)}
                                  onConfirm={async () => {
                                    await artifactsApi.remove(artifact.id); // a failure shows in the warning
                                    navigate(back);
                                  }} />
            )}
          </div>
        )}
      </header>
      {running && job && job.kind !== "report_block" && <JobProgress job={job} />}
      {artifact.status === "failed" && <p className="error-text">{(artifact.content.error as string | undefined) ?? job?.error ?? "The report could not be made."}</p>}
      {(addFailed ?? blockFailed) && <p className="error-text">{addFailed ?? blockFailed}</p>}
      {artifact.status === "ready" && (
        <ReportView content={artifact.content} artifactId={artifact.id} onCite={cite}
                    editor={{ onAdd: startAdd, onRemove: remove, adding: addingNow, removing: removingId }} />
      )}
      {sharing && <ShareDialog artifactId={artifact.id} onClose={() => setSharing(false)} />}
      {adding && <ReportAddDialog suggestion={adding.suggestion} existing={adding.existing} loading={adding.loading} busy={false} error={null}
                                  onClose={() => setAdding(null)} onAdd={add} />}
      {reading && <Reader documentId={reading.id} highlight={{ start: reading.start, end: reading.end }} onClose={() => setReading(null)} />}
    </div>
  );
}
