/** The safe Markdown subset generated text uses, parsed without the DOM: the web (components/Markdown.tsx) and the
 * mobile app each draw these blocks with their own elements. Never raw HTML. */

export const INLINE =
  /(`[^`]+`)|(\*\*[^*]+\*\*|__[^_]+__)|(\*[^*\s][^*]*\*|_[^_\s][^_]*_)|(~~[^~]+~~)|(!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\))|(\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\))|(\[\d+\](?:\[\d+\])*)|(https?:\/\/[^\s)<]+[^\s)<.,;:!?'"])/g;

/** Links: web, mail and in app paths only (no javascript: and friends). Images: web and app paths. */
export const safeHref = (url: string) => (/^(https?:\/\/|mailto:|\/(?!\/)|#)/i.test(url) ? url : null);
export const safeSrc = (url: string) => (/^(https?:\/\/|\/(?!\/))/i.test(url) ? url : null);

export type ListItem = { text: string; children: ListItem[]; task?: boolean; done?: boolean };
export type Align = "left" | "center" | "right" | undefined;
export type Block =
  | { kind: "h"; level: number; text: string }
  | { kind: "p"; text: string }
  | { kind: "ul" | "ol"; items: ListItem[]; start: number }
  | { kind: "quote"; text: string }
  | { kind: "code"; text: string; lang: string }
  | { kind: "table"; head: string[]; rows: string[][]; align: Align[] }
  | { kind: "img"; src: string; alt: string; title?: string }
  | { kind: "hr" };

const LIST = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const splitRow = (line: string) =>
  line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());

export function parse(src: string): Block[] {
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
    const image = trimmed.match(/^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)$/);
    if (image && safeSrc(image[2])) {
      blocks.push({ kind: "img", alt: image[1], src: image[2], title: image[3] });
      i++;
      continue;
    }
    const heading = trimmed.match(/^(#{1,6})\s+(.*)$/);
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
      const align: Align[] = splitRow(lines[i + 1]).map((c) =>
        c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : c.startsWith(":") ? "left" : undefined,
      );
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) rows.push(splitRow(lines[i++]));
      blocks.push({ kind: "table", head, rows, align });
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
          const task = m[3].match(/^\[([ xX])\]\s+(.*)$/);
          const item: ListItem = task
            ? { text: task[2], children: [], task: true, done: task[1] !== " " }
            : { text: m[3], children: [] };
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
    while (i < lines.length && lines[i].trim() && !LIST.test(lines[i]) && !/^(#{1,6}\s|>|```|\||!\[)/.test(lines[i].trim())) {
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

/** One run of inline text: plain words, or a mark with what is inside it. */
export type InlineToken =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "bold" | "italic" | "strike"; text: string }
  | { kind: "image"; alt: string; src: string | null; title?: string }
  | { kind: "link"; label: string; href: string | null }
  | { kind: "cite"; markers: number[] }
  | { kind: "url"; href: string };

/** A line's inline marks, in order (the same rules the web's renderer applies). Marks nest: render a bold's text
 * through this again. */
export function inlineTokens(text: string): InlineToken[] {
  const out: InlineToken[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    const idx = m.index ?? 0;
    if (idx > last) out.push({ kind: "text", text: text.slice(last, idx) });
    const [whole, code, bold, italic, strike, image, alt, src, title, link, label, href, markers, bare] = m;
    if (code) out.push({ kind: "code", text: code.slice(1, -1) });
    else if (bold) out.push({ kind: "bold", text: bold.slice(2, -2) });
    else if (italic) out.push({ kind: "italic", text: italic.slice(1, -1) });
    else if (strike) out.push({ kind: "strike", text: strike.slice(2, -2) });
    else if (image) out.push({ kind: "image", alt, src: safeSrc(src), title });
    else if (link) out.push({ kind: "link", label, href: safeHref(href) });
    else if (markers) out.push({ kind: "cite", markers: [...markers.matchAll(/\[(\d+)\]/g)].map((n) => Number(n[1])) });
    else if (bare) out.push({ kind: "url", href: bare });
    else out.push({ kind: "text", text: whole });
    last = idx + whole.length;
  }
  if (last < text.length) out.push({ kind: "text", text: text.slice(last) });
  return out;
}
