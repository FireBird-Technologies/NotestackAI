import { useEffect, useState } from "react";
import { artifactsApi, videosApi } from "../../api/endpoints";
import type { Artifact, PostableArtifact } from "../../api/types";
import { InfographicFrame } from "../Infographic";
import { ReportView } from "../ReportView";
import { SlideFrame } from "../SlideDeck";
import { errorMessage, Loading, Modal } from "../ui";
import { PreviewFrame } from "../video/VideoCard";
import { PdfPreview } from "../PdfPreview";

/** What a post's attachment looks like, in a modal: shown as the app shows that kind of thing (a report read through, an
 * infographic, the deck's slides, a video playing, the images), so it can be checked before it goes out. */
export function AttachmentPreviewModal({ a, onClose }: { a: PostableArtifact; onClose: () => void }) {
  const [art, setArt] = useState<Artifact | null>(null);
  const [video, setVideo] = useState<string | null>(null);
  // A report goes out as a PDF: it is previewed as that PDF.
  const asPdf = a.type === "report";
  const [pdf, setPdf] = useState<Blob | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    // A blog2video video plays in its live player (its link is made the first time it is asked for).
    const load = a.editable_video
      ? videosApi.get(a.id).then((v) => live && setVideo((v as { preview_url?: string | null }).preview_url ?? null))
      : asPdf
        ? artifactsApi.reportPdf(a.id).then((b) => live && setPdf(b))
        : artifactsApi.get(a.id).then((x) => live && setArt(x));
    load.catch((e) => live && setError(errorMessage(e)));
    return () => {
      live = false;
    };
  }, [a.id, a.editable_video, asPdf]);

  const body = () => {
    if (error) return <p className="error-text">{error}</p>;
    if (a.type === "upload" && a.view_url) {
      return a.media === "video"
        ? <video className="pub-video" src={a.view_url} controls playsInline />
        : <img className="lp-preview-img" src={a.view_url} alt={a.title} />;
    }
    if (asPdf) {
      return pdf ? <PdfPreview blob={pdf} fileName={a.title} />
        : <div className="loading-center inline"><Loading label="Making the PDF" /></div>;
    }
    if (a.editable_video) {
      return video ? <PreviewFrame src={video} title={a.title} />
        : <div className="loading-center inline"><Loading label="Loading the video" /></div>;
    }
    if (!art) return <div className="loading-center inline"><Loading label="Loading the preview" /></div>;
    const c = art.content;
    if (art.type === "report") return <div className="lp-preview-report"><ReportView content={c} artifactId={art.id} /></div>;
    if (art.type === "infographic" && typeof c.html === "string") {
      const wide = typeof c.html_landscape === "string" && c.html_landscape;
      return <InfographicFrame html={wide || c.html} title={art.title} layout={wide ? "landscape" : "portrait"} />;
    }
    if (art.type === "slide_deck" && Array.isArray(c.slides_html)) {
      return (
        <div className="stack lp-preview-slides">
          {(c.slides_html as string[]).map((html, i) => <SlideFrame key={i} html={html} title={`Slide ${i + 1}`} />)}
        </div>
      );
    }
    if (art.type === "video" && art.url) return <video className="pub-video" src={art.url} controls playsInline />;
    if (art.type === "carousel" && art.slide_urls.length) {
      return <div className="stack">{art.slide_urls.map((u, i) => <img key={i} className="lp-preview-img" src={u} alt={`Slide ${i + 1}`} />)}</div>;
    }
    if (art.url && art.type === "quote_card") return <img className="lp-preview-img" src={art.url} alt={art.title} />;
    // Text (a summary, a mind map, a short report's words): what the post starts with
    const text = a.prefill?.linkedin;
    return text ? <p className="lp-preview-text">{text}</p> : <p className="muted">There's nothing to preview for this one.</p>;
  };

  return (
    <Modal title={a.title} onClose={onClose} wide>
      <div className="lp-preview-body">{body()}</div>
    </Modal>
  );
}
