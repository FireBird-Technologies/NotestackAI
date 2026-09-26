import type { ReactNode } from "react";
import type { Citation } from "../api/types";

/** Small, safe Markdown renderer for generated text. Builds React elements (never raw HTML), and turns
 * [n] citation markers into buttons that open the cited lines.
 * Supports: headings, paragraphs, bullet and numbered lists (one nested level), blockquotes, fenced
 * code, tables, horizontal rules, bold, italic, strikethrough, inline code and links. */

type Cite = { citations?: Citation[]; onCite?: (c: Citation) => void };

const INLINE = /(`[^`]+`)|(\*\*[^*]+\*\*|__[^_]+__)|(\*[^*\s][^*]*\*|_[^_\s][^_]*_)|(~~[^~]+~~)|(\[[^\]]+\]\((https?:\/\/[^)\s]+)\))|(\[\d+\](?:\[\d+\])*)|(https?:\/\/[^\s)]+)/g;

function inline(text: string, cite: Cite, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  const byMarker = new Map((cite.citations ?? []).map((c) => [c.marker, c]));
  let last = 0;
  let i = 0;
  for (const m of text.matchAll(INLINE)) {
    const idx = m.index ?? 0;
    if (idx > last) out.push(text.slice(last, idx));
    const key = `${keyBase}-${i++}`;
    const [whole, code, bold, italic, strike, link, href, markers, bare] = m;
    if (code) out.push(<code key={key}>{code.slice(1, -1)}</code>);
    else if (bold) out.push(<strong key={key}>{inline(bold.slice(2, -2), cite, key)}</strong>);
    else if (italic) out.push(<em key={key}>{inline(italic.slice(1, -1), cite, key)}</em>);
    else if (strike) out.push(<del key={key}>{inline(strike.slice(2, -2), cite, key)}</del>);
    else if (link && href) {
      const label = link.slice(1, link.indexOf("]("));
      out.push(
        <a key={key} href={href} target="_blank" rel="noreferrer">
          {inline(label, cite, key)}
        </a>,
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

type ListItem = { text: string; children: ListItem[] };
type Block =
  | { kind: "h"; level: number; text: string }
  | { kind: "p"; text: string }
  | { kind: "ul" | "ol"; items: ListItem[]; start: number }
  | { kind: "quote"; text: string }
  | { kind: "code"; text: string; lang: string }
  | { kind: "table"; head: string[]; rows: string[][] }
  | { kind: "hr" };

const LIST = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const splitRow = (line: string) =>
  line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());

function parse(src: string): Block[] {
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) {
      i++;
      continue;
    }
    const fence = trimmed.match(/^```(\w*)/);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith("```")) body.push(lines[i++]);
      i++;
      blocks.push({ kind: "code", text: body.join("\n"), lang: fence[1] });
      continue;
    }
    const heading = trimmed.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      blocks.push({ kind: "h", level: heading[1].length, text: heading[2] });
      i++;
      continue;
    }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      blocks.push({ kind: "hr" });
      i++;
      continue;
    }
    if (trimmed.startsWith("|") && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      const head = splitRow(trimmed);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) rows.push(splitRow(lines[i++]));
      blocks.push({ kind: "table", head, rows });
      continue;
    }
    if (trimmed.startsWith(">")) {
      const body: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith(">")) body.push(lines[i++].trim().replace(/^>\s?/, ""));
      blocks.push({ kind: "quote", text: body.join("\n") });
      continue;
    }
    const first = line.match(LIST);
    if (first) {
      const ordered = /\d/.test(first[2]);
      const baseIndent = first[1].length;
      const items: ListItem[] = [];
      while (i < lines.length) {
        const m = lines[i].match(LIST);
        if (m) {
          const item = { text: m[3], children: [] as ListItem[] };
          if (m[1].length > baseIndent && items.length) items[items.length - 1].children.push(item);
          else items.push(item);
          i++;
        } else if (lines[i].trim() && /^\s{2,}/.test(lines[i]) && items.length) {
          // Continuation line of the previous item.
          const target = items[items.length - 1];
          const deepest = target.children.length ? target.children[target.children.length - 1] : target;
          deepest.text += ` ${lines[i].trim()}`;
          i++;
        } else if (!lines[i].trim() && i + 1 < lines.length && LIST.test(lines[i + 1])) {
          i++; // loose list: blank line between items
        } else break;
      }
      blocks.push({ kind: ordered ? "ol" : "ul", items, start: ordered ? parseInt(first[2], 10) || 1 : 1 });
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !LIST.test(lines[i]) && !/^(#{1,4}\s|>|```|\|)/.test(lines[i].trim())) {
      para.push(lines[i++].trim());
    }
    if (para.length === 0) {
      para.push(trimmed);
      i++;
    }
    blocks.push({ kind: "p", text: para.join("\n") });
  }
  return blocks;
}

function withBreaks(text: string, cite: Cite, key: string): ReactNode[] {
  return text.split("\n").flatMap((part, j, all) => [
    ...inline(part, cite, `${key}-${j}`),
    ...(j < all.length - 1 ? [<br key={`${key}-br-${j}`} />] : []),
  ]);
}

function renderItems(items: ListItem[], ordered: boolean, cite: Cite, key: string, start = 1): ReactNode {
  const children = items.map((it, j) => (
    <li key={`${key}-${j}`}>
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

export function Markdown({ text, citations, onCite, className = "" }: { text: string; className?: string } & Cite) {
  const cite = { citations, onCite };
  return (
    <div className={`md ${className}`}>
      {parse(text).map((b, i) => {
        const key = `b${i}`;
        switch (b.kind) {
          case "h": {
            const Tag = (["h3", "h3", "h4", "h5"] as const)[b.level - 1];
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
            return (
              <pre key={key} data-lang={b.lang || undefined}>
                <code>{b.text}</code>
              </pre>
            );
          case "table":
            return (
              <div key={key} className="md-table">
                <table>
                  <thead>
                    <tr>
                      {b.head.map((h, j) => (
                        <th key={j}>{inline(h, cite, `${key}-h${j}`)}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {b.rows.map((r, j) => (
                      <tr key={j}>
                        {r.map((c, k) => (
                          <td key={k}>{inline(c, cite, `${key}-${j}-${k}`)}</td>
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
