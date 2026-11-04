import type { Citation } from "./types";

/** Citations grouped by what they cite: each source once, then every place it was cited, in marker order (web:
 * ArtifactCard's CitationList; mobile: the summary and the report). */
export function groupCitations(citations: Citation[]): { key: string; title: string; cites: Citation[] }[] {
  const groups: { key: string; title: string; cites: Citation[] }[] = [];
  for (const c of [...citations].sort((x, y) => x.marker - y.marker)) {
    const key = c.document_id || c.path || c.title;
    const group = groups.find((g) => g.key === key);
    if (group) group.cites.push(c);
    else groups.push({ key, title: c.title, cites: [c] });
  }
  return groups;
}

/** "lines 4 to 9", or "lines 4". */
export const citedLines = (c: Pick<Citation, "line_start" | "line_end">) => `lines ${c.line_start}${c.line_end > c.line_start ? ` to ${c.line_end}` : ""}`;
