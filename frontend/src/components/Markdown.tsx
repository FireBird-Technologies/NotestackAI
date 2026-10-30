import { useState, type ReactNode } from "react";
import type { Citation } from "@notestack/shared/types";
import { highlight, languageLabel } from "../lib/highlight";
import { INLINE, type ListItem, parse, safeHref, safeSrc } from "@notestack/shared/markdown";

/** Small, safe Markdown renderer for generated text. Builds React elements (never raw HTML), and turns
 * [n] citation markers into buttons that open the cited lines.
 * Supports: headings, paragraphs, bullet, numbered and task lists (one nested level), blockquotes,
 * fenced code (highlighted, copyable, collapsible), tables with alignment, images, horizontal rules,
 * bold, italic, strikethrough, inline code, links and bare URLs. */

type Cite = { citations?: Citation[]; onCite?: (c: Citation) => void };


function Img({ src, alt, title }: { src: string; alt: string; title?: string }) {
  const [broken, setBroken] = useState(false);
  if (broken) return <span className="md-img-broken mono">[image: {alt || src}]</span>;
  return (
    <a className="md-img" href={src} target="_blank" rel="noreferrer" title={title || alt || "Open image"}>
      <img src={src} alt={alt} loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setBroken(true)} />
    </a>
  );
}

const COLLAPSE_AT = 24; // lines

function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const [copied, setCopied] = useState(false);
  const lines = code.split("\n");
  const long = lines.length > COLLAPSE_AT;
  const [open, setOpen] = useState(!long);
  const shown = open ? code : lines.slice(0, COLLAPSE_AT).join("\n");
  return (
    <div className={"md-code" + (open ? "" : " collapsed")}>
      <div className="md-code-bar">
        <span className="mono">{languageLabel(lang)}</span>
        <button
          type="button"
          className="md-code-copy mono"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(code);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            } catch {
              /* clipboard blocked */
            }
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre data-lang={lang || undefined}>
        <code>{highlight(shown, lang)}</code>
      </pre>
      {long && (
        <button type="button" className="md-code-more mono" onClick={() => setOpen((o) => !o)}>
          {open ? "Show less" : "Show all " + lines.length + " lines"}
        </button>
      )}
    </div>
  );
}

function inline(text: string, cite: Cite, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  const byMarker = new Map((cite.citations ?? []).map((c) => [c.marker, c]));
  let last = 0;
  let i = 0;
  for (const m of text.matchAll(INLINE)) {
    const idx = m.index ?? 0;
    if (idx > last) out.push(text.slice(last, idx));
    const key = `${keyBase}-${i++}`;
    const [whole, code, bold, italic, strike, image, alt, src, title, link, label, href, markers, bare] = m;
    if (code) out.push(<code key={key}>{code.slice(1, -1)}</code>);
    else if (bold) out.push(<strong key={key}>{inline(bold.slice(2, -2), cite, key)}</strong>);
    else if (italic) out.push(<em key={key}>{inline(italic.slice(1, -1), cite, key)}</em>);
    else if (strike) out.push(<del key={key}>{inline(strike.slice(2, -2), cite, key)}</del>);
    else if (image) {
      const url = safeSrc(src);
      out.push(url ? <Img key={key} src={url} alt={alt} title={title} /> : alt);
    } else if (link) {
      const url = safeHref(href);
      const external = url ? /^https?:/i.test(url) : false;
      out.push(
        url ? (
          <a key={key} href={url} {...(external ? { target: "_blank", rel: "noreferrer" } : {})}>
            {inline(label, cite, key)}
          </a>
        ) : (
          <span key={key}>{inline(label, cite, key)}</span>
        ),
      );
    } else if (markers) {
      for (const n of markers.matchAll(/\[(\d+)\]/g)) {
        const c = byMarker.get(Number(n[1]));
        out.push(
          c ? (
            <button key={`${key}-${n[1]}`} type="button" className="cite-marker mono" title={c.title} onClick={() => cite.onCite?.(c)}>
              {c.marker}
            </button>
          ) : (
            <sup key={`${key}-${n[1]}`} className="mono muted">
              {n[1]}
            </sup>
          ),
        );
      }
    } else if (bare) {
      out.push(
        <a key={key} href={bare} target="_blank" rel="noreferrer">
          {bare}
        </a>,
      );
    } else out.push(whole);
    last = idx + whole.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}


function withBreaks(text: string, cite: Cite, key: string): ReactNode[] {
  return text.split("\n").flatMap((part, j, all) => [
    ...inline(part, cite, `${key}-${j}`),
    ...(j < all.length - 1 ? [<br key={`${key}-br-${j}`} />] : []),
  ]);
}

function renderItems(items: ListItem[], ordered: boolean, cite: Cite, key: string, start = 1): ReactNode {
  const children = items.map((it, j) => (
    <li key={`${key}-${j}`} className={it.task ? `md-task${it.done ? " done" : ""}` : undefined}>
      {it.task && <input type="checkbox" checked={it.done} readOnly tabIndex={-1} aria-label={it.done ? "Done" : "Not done"} />}
      {inline(it.text, cite, `${key}-${j}`)}
      {it.children.length > 0 && renderItems(it.children, ordered, cite, `${key}-${j}-c`)}
    </li>
  ));
  return ordered ? (
    <ol key={key} start={start}>
      {children}
    </ol>
  ) : (
    <ul key={key}>{children}</ul>
  );
}

export function Markdown({ text, citations, onCite, className = "", reportHeadings = false }: {
  text: string;
  className?: string;
  /** A report page: "#" and "##" are page sections (h2), not the chat's small headings. */
  reportHeadings?: boolean;
} & Cite) {
  const cite = { citations, onCite };
  return (
    <div className={`md ${className}`}>
      {parse(text).map((b, i) => {
        const key = `b${i}`;
        switch (b.kind) {
          case "h": {
            const Tag = (reportHeadings ? (["h2", "h2", "h3", "h4", "h5", "h5"] as const) : (["h3", "h3", "h4", "h5", "h5", "h5"] as const))[b.level - 1];
            return <Tag key={key}>{inline(b.text, cite, key)}</Tag>;
          }
          case "p":
            return <p key={key}>{withBreaks(b.text, cite, key)}</p>;
          case "ul":
          case "ol":
            return renderItems(b.items, b.kind === "ol", cite, key, b.start);
          case "quote":
            return <blockquote key={key}>{withBreaks(b.text, cite, key)}</blockquote>;
          case "code":
            return <CodeBlock key={key} code={b.text} lang={b.lang} />;
          case "img":
            return (
              <figure key={key} className="md-figure">
                <Img src={b.src} alt={b.alt} title={b.title} />
                {(b.title || b.alt) && <figcaption className="muted">{b.title || b.alt}</figcaption>}
              </figure>
            );
          case "table":
            return (
              <div key={key} className="md-table">
                <table>
                  <thead>
                    <tr>
                      {b.head.map((h, j) => (
                        <th key={j} style={b.align[j] ? { textAlign: b.align[j] } : undefined}>
                          {inline(h, cite, `${key}-h${j}`)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {b.rows.map((r, j) => (
                      <tr key={j}>
                        {r.map((c, k) => (
                          <td key={k} style={b.align[k] ? { textAlign: b.align[k] } : undefined}>
                            {inline(c, cite, `${key}-${j}-${k}`)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          case "hr":
            return <hr key={key} />;
          default:
            return null;
        }
      })}
    </div>
  );
}
