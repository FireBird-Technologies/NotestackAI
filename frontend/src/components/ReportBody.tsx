import { useState } from "react";
import type { Artifact } from "../api/types";
import { ViewButton } from "./cardActions";
import { ShareDialog } from "./ShareDialog";
import { DownloadIcon, ShareIcon } from "./icons/Icons";
import { artifactsApi } from "../api/endpoints";

/** What a finished report shows in a card: its format and size, and a way in or out to share it. */
export function ReportBody({ artifact }: { artifact: Artifact }) {
  const [sharing, setSharing] = useState(false);
  const [saving, setSaving] = useState(false);
  /** The report as its PDF (the same one a launch posts), saved as a file. */
  const download = async () => {
    setSaving(true);
    try {
      const blob = await artifactsApi.reportPdf(artifact.id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${artifact.title.replace(/[^\w\- ]+/g, "").trim().slice(0, 80) || "Report"}.pdf`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch {
      /* the PDF could not be made right now: the button comes back to try again */
    } finally {
      setSaving(false);
    }
  };
  const c = artifact.content;
  const blocks = (c.blocks ?? []) as { type: string }[];
  const visuals = blocks.filter((b) => b.type !== "prose").length;
  return (
    <div className="artifact-body">
      <p className="muted">
        {c.format === "interactive" ? "Interactive" : "Document"} · {blocks.length} sections
        {visuals > 0 ? ` · ${visuals} visual${visuals === 1 ? "" : "s"}` : ""}
      </p>
      <div className="row">
        <ViewButton label="View" to={`/app/reports/${artifact.id}`} />
        <button type="button" className="btn btn-small btn-icon-only card-act-share" onClick={() => setSharing(true)} aria-label="Share">
          <ShareIcon size={16} />
        </button>
        <button type="button" className="btn btn-small btn-icon-only card-act-download" disabled={saving} onClick={download}
                aria-label={saving ? "Preparing the PDF" : "Download PDF"}>
          {saving ? <span className="nbv-send-spinner" aria-hidden="true" /> : <DownloadIcon size={16} />}
        </button>
      </div>
      {sharing && <ShareDialog artifactId={artifact.id} onClose={() => setSharing(false)} />}
    </div>
  );
}
