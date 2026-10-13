import { useEffect, useRef, useState } from "react";
import { DownloadIcon } from "./icons/Icons";
import { Loading } from "./ui";

type PdfDoc = { numPages: number; getPage: (n: number) => Promise<PdfPage>; destroy: () => Promise<void> };
type PdfPage = {
  getViewport: (o: { scale: number }) => { width: number; height: number };
  render: (o: { canvasContext: CanvasRenderingContext2D; viewport: { width: number; height: number } }) => { promise: Promise<void> };
};

/** pdf.js, loaded only when a PDF is previewed (it is large). */
async function loadPdf(data: ArrayBuffer): Promise<PdfDoc> {
  const pdfjs = await import("pdfjs-dist");
  const worker = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  return (await pdfjs.getDocument({ data }).promise) as unknown as PdfDoc;
}

/** One page drawn into a canvas `width` CSS pixels wide (sharp on high-density screens). */
function PageCanvas({ doc, n, width, className }: { doc: PdfDoc; n: number; width: number; className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let live = true;
    (async () => {
      const page = await doc.getPage(n);
      const base = page.getViewport({ scale: 1 });
      const dpr = window.devicePixelRatio || 1;
      const viewport = page.getViewport({ scale: (width / base.width) * dpr });
      const canvas = ref.current;
      if (!live || !canvas) return;
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${viewport.height / dpr}px`;
      await page.render({ canvasContext: canvas.getContext("2d")!, viewport }).promise;
    })().catch(() => undefined);
    return () => {
      live = false;
    };
  }, [doc, n, width]);
  return <canvas ref={ref} className={className} />;
}

/** A PDF to look at, nothing more: page thumbnails on the left (15%), the pages on the right, and a Download PDF button.
 * No zoom, rotate, annotate or print tools. */
export function PdfPreview({ blob, fileName }: { blob: Blob; fileName: string }) {
  const [doc, setDoc] = useState<PdfDoc | null>(null);
  const [error, setError] = useState(false);
  const [current, setCurrent] = useState(1);
  const [widths, setWidths] = useState({ thumb: 0, page: 0 });
  const thumbs = useRef<HTMLDivElement>(null);
  const pages = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    let loaded: PdfDoc | null = null;
    blob.arrayBuffer().then(loadPdf).then((d) => {
      loaded = d;
      if (live) setDoc(d);
      else void d.destroy();
    }).catch(() => live && setError(true));
    return () => {
      live = false;
      void loaded?.destroy();
    };
  }, [blob]);

  // The columns' widths decide how wide pages are drawn; they follow the modal's size.
  useEffect(() => {
    const measure = () => setWidths({
      thumb: Math.max(40, (thumbs.current?.clientWidth ?? 0) - 20),
      page: Math.max(200, (pages.current?.clientWidth ?? 0) - 32),
    });
    measure();
    const ro = new ResizeObserver(measure);
    if (thumbs.current) ro.observe(thumbs.current);
    if (pages.current) ro.observe(pages.current);
    return () => ro.disconnect();
  }, [doc]);

  // Which page is in view, as the pages scroll.
  const onScroll = () => {
    const box = pages.current;
    if (!box) return;
    const items = Array.from(box.querySelectorAll<HTMLElement>("[data-page]"));
    const mid = box.scrollTop + box.clientHeight / 3;
    const seen = items.filter((el) => el.offsetTop <= mid).pop();
    if (seen) setCurrent(Number(seen.dataset.page));
  };
  const goTo = (n: number) => {
    const el = pages.current?.querySelector<HTMLElement>(`[data-page="${n}"]`);
    if (el && pages.current) pages.current.scrollTo({ top: el.offsetTop - 12, behavior: "smooth" });
    setCurrent(n);
  };

  const download = () => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName.endsWith(".pdf") ? fileName : `${fileName}.pdf`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  if (error) return <p className="error-text">This PDF could not be shown. Download it to read it.</p>;
  const numbers = doc ? Array.from({ length: doc.numPages }, (_, i) => i + 1) : [];
  return (
    <div className="pdfv">
      <div className="pdfv-bar">
        <span className="mono muted small">{doc ? `Page ${current} / ${doc.numPages}` : "Loading"}</span>
        <button type="button" className="btn btn-small" onClick={download}><DownloadIcon size={16} /> Download PDF</button>
      </div>
      <div className="pdfv-body">
        <div className="pdfv-thumbs" ref={thumbs}>
          {doc && widths.thumb > 0 && numbers.map((n) => (
            <button key={n} type="button" className={`pdfv-thumb${n === current ? " on" : ""}`} onClick={() => goTo(n)}
                    aria-label={`Page ${n}`} aria-current={n === current}>
              <PageCanvas doc={doc} n={n} width={widths.thumb} />
              <span className="mono small">{n}</span>
            </button>
          ))}
        </div>
        <div className="pdfv-pages" ref={pages} onScroll={onScroll}>
          {!doc && <div className="loading-center inline"><Loading label="Opening the PDF" /></div>}
          {doc && widths.page > 0 && numbers.map((n) => (
            <div key={n} data-page={n} className="pdfv-page">
              <PageCanvas doc={doc} n={n} width={widths.page} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
