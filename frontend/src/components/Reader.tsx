import { useEffect, useRef, useState } from "react";
import { docsApi } from "../api/endpoints";
import type { DocDetail } from "../api/types";
import { Drawer, formatDate, Loading } from "./ui";

/** Reads a post from the corpus with the exact line numbers citations point at. */
export function Reader({
  documentId,
  highlight,
  onClose,
}: {
  documentId: string;
  highlight?: { start: number; end: number };
  onClose: () => void;
}) {
  const [doc, setDoc] = useState<DocDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const first = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setDoc(null);
    docsApi.get(documentId).then(setDoc, () => setError("Could not open this post."));
  }, [documentId]);

  useEffect(() => {
    first.current?.scrollIntoView({ block: "center" });
  }, [doc, highlight]);

  // Skip the front matter block for display, but keep real line numbers.
  let bodyStart = 0;
  if (doc?.lines[0] === "---") {
    const close = doc.lines.indexOf("---", 1);
    bodyStart = close > 0 ? close + 1 : 0;
  }

  return (
    <Drawer onClose={onClose} label="Post reader">
      {!doc && !error && <Loading label="Opening post" />}
      {error && <p className="error-text">{error}</p>}
      {doc && (
        <article className="reader">
          <p className="eyebrow">{doc.source_title ?? "Post"}</p>
          <p className="mono muted">
            {formatDate(doc.published_at)} · {doc.words} words
            {doc.url.startsWith("http") && (
              <>
                {" · "}
                <a href={doc.url} target="_blank" rel="noreferrer">
                  Open original
                </a>
              </>
            )}
          </p>
          <div className="reader-lines">
            {doc.lines.slice(bodyStart).map((line, i) => {
              const n = i + bodyStart + 1;
              const hit = highlight && n >= highlight.start && n <= highlight.end;
              if (!line.trim() && !hit) return <div key={n} className="reader-gap" />;
              const heading = line.match(/^(#{1,3})\s+(.*)/);
              return (
                <div key={n} ref={hit && n === highlight?.start ? first : undefined} className={`reader-line${hit ? " hit" : ""}`}>
                  <span className="reader-n mono">{n}</span>
                  {heading ? (
                    <span className={`reader-h h${heading[1].length}`}>{heading[2]}</span>
                  ) : (
                    <span>{line}</span>
                  )}
                </div>
              );
            })}
          </div>
        </article>
      )}
    </Drawer>
  );
}
