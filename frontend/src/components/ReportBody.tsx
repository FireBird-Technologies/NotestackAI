import { useState } from "react";
import type { Artifact } from "../api/types";
import { ViewButton } from "./cardActions";
import { ShareDialog } from "./ShareDialog";
import { DownloadIcon, MarkdownIcon, PdfIcon, ShareIcon } from "./icons/Icons";
import { artifactsApi } from "../api/endpoints";
import { reportMarkdown } from "./ReportView";
import { FloatingMenu, useMenu } from "./SlideDeck";
import { errorMessage } from "./ui";

/** What a finished report shows in a card: its format and size, and a way in or out to share it. */
export function ReportBody({ artifact }: { artifact: Artifact }) {
  const [sharing, setSharing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const menu = useMenu();
  const name = artifact.title.replace(/[^\w\- ]+/g, "").trim().slice(0, 80) || "Report";
  const save = (blob: Blob, file: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = file;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };
  /** The report as Markdown, made here from its blocks. */
  const downloadMarkdown = () => {
    menu.setOpen(false);
    save(new Blob([reportMarkdown(artifact.content)], { type: "text/markdown" }), `${name}.md`);
  };
  /** The report's text as a PDF (the same one a launch posts; embedded visuals left out), printed by the server. */
  const downloadPdf = async () => {
    menu.setOpen(false);
    setSaving(true);
    setError(null);
    try {
      save(await artifactsApi.reportPdf(artifact.id), `${name}.pdf`);
    } catch (e) {
      setError(errorMessage(e, "The PDF could not be made. Try again."));
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
        <div className="sd-menu-wrap card-act-download" ref={menu.ref}>
          <button type="button" className="btn btn-small btn-icon-only" disabled={saving} aria-haspopup="menu" aria-expanded={menu.open}
                  aria-label={saving ? "Preparing the PDF" : "Download"} onClick={() => menu.setOpen((o) => !o)}>
            {saving ? <span className="nbv-send-spinner" aria-hidden="true" /> : <DownloadIcon size={16} />}
          </button>
          {menu.open && (
            <FloatingMenu menu={menu}>
              <button type="button" role="menuitem" onClick={downloadMarkdown}><MarkdownIcon size={20} /> Markdown (.md)</button>
              <button type="button" role="menuitem" onClick={() => void downloadPdf()}><PdfIcon size={20} /> PDF document (.pdf)</button>
            </FloatingMenu>
          )}
        </div>
      </div>
      {error && <p className="error-text small" role="alert">{error}</p>}
      {sharing && <ShareDialog artifactId={artifact.id} onClose={() => setSharing(false)} />}
    </div>
  );
}
