/** A report's pure helpers, shared by the web and mobile report views (web: frontend/src/components/ReportView.tsx). */
import type { Citation, ReportBlock } from "./types";

/** A report as Markdown text, for downloading. Visual blocks are written out as plain lists. */
export function reportMarkdown(content: Record<string, any>): string {
  const lines = [`# ${content.title ?? "Report"}`, ""];
  for (const b of (content.blocks ?? []) as ReportBlock[]) {
    if (b.type === "prose") lines.push(b.text, "");
    else if (b.type === "callout") lines.push(`> ${b.title ? `**${b.title}** ` : ""}${b.text}`, "");
    else if (b.type === "key_terms") lines.push(`## ${b.title || "Key terms"}`, ...b.terms.map((t) => `- **${t.term}**: ${t.definition}`), "");
    else if (b.type === "table") {
      lines.push(...(b.title ? [`## ${b.title}`, ""] : []), `| ${b.headers.join(" | ")} |`, `| ${b.headers.map(() => "---").join(" | ")} |`,
        ...b.rows.map((r) => `| ${r.join(" | ")} |`), "");
    } else if (b.type === "timeline") lines.push(`## ${b.title || "Timeline"}`, ...b.events.map((e) => `- **${e.when}** ${e.title}${e.detail ? `: ${e.detail}` : ""}`), "");
    else if (b.type === "plot") {
      lines.push(`## ${b.title || "Plot"}`, `| ${b.x_label || "Label"} | ${b.y_label || "Value"}${b.unit ? ` (${b.unit})` : ""} |`, "| --- | --- |",
        ...b.points.map((p) => `| ${p.label} | ${p.display_value || p.value} |`), "");
    }
    else if (b.type === "flashcards") lines.push(`## ${b.title || "Flashcards"}`, ...b.cards.map((c) => `- **${c.front}**: ${c.back}`), "");
    else if (b.type === "infographic") lines.push(`## ${b.title || "Infographic"}`, "");
    else if (b.type === "quiz") lines.push(`## ${b.title || "Quiz"}`, ...b.questions.map((q, i) => `${i + 1}. ${q.question}`), "");
  }
  const cites = (content.citations ?? []) as Citation[];
  if (cites.length) lines.push("## Sources", ...cites.map((c) => `[${c.marker}] ${c.title}, lines ${c.line_start} to ${c.line_end}`), "");
  return lines.join("\n");
}

/** What each kind of visual is called (Remove this X, Suggested: X). */
export const KIND_LABEL = {
  mind_map: "Mind Constellation", flashcards: "Flashcards", quiz: "Quiz", plot: "Plot", table: "Data table", timeline: "Timeline",
  key_terms: "Key terms", infographic: "Infographic",
} as const;

/** A timeline's labels compared loosely (a year used as both its date and its title shows once). */
export const timelineKey = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "");

/** The sections of a report, for its contents list: each prose block that opens with a heading. */
export function contents(blocks: ReportBlock[], withSources: boolean): { id: string; title: string }[] {
  const list = blocks.flatMap((b) => {
    const title = b.type === "prose" ? b.text.match(/^#{1,3}\s+(.+)/)?.[1]?.trim() : undefined;
    return title ? [{ id: b.id, title }] : [];
  });
  return withSources && list.length ? [...list, { id: "sources", title: "Sources" }] : list;
}

type PlotBlock = Extract<ReportBlock, { type: "plot" }>;

const GENERIC_TITLES = new Set(["source data", "data", "plot", "chart"]);

/** A plot's title: its own, unless it is a generic one ("Data"), then what it compares. */
export function displayTitle(block: PlotBlock) {
  const title = block.title?.trim();
  if (title && !GENERIC_TITLES.has(title.toLowerCase())) return title;
  const category = block.x_label?.trim();
  return category && category.toLowerCase() !== "category" ? `${category} comparison` : "Data comparison";
}

/** A category label short enough for an axis. */
export function shortLabel(label: string, limit = 36) {
  const clean = label.replace(/\s+/g, " ").trim();
  return clean.length > limit ? `${clean.slice(0, limit - 1).trimEnd()}…` : clean;
}

/** A value as the chart shows it: the source's own wording when short, else the number. */
export function visibleValue(point: PlotBlock["points"][number]) {
  const supplied = point.display_value?.trim();
  if (supplied && supplied.length <= 18) return supplied;
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2, notation: Math.abs(point.value) >= 10_000 ? "compact" : "standard" }).format(point.value);
}
